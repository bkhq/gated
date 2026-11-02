# Database Protocol Proxies (MySQL and PostgreSQL)

English | [简体中文](protocol-database.zh-CN.md)

Both database proxies speak the native wire protocol to the client,
authenticate the user against gated's credential store, then open a second
native-protocol connection to the real server using credentials from the
target configuration. After the handshakes, traffic is relayed packet-by-
packet, with query packets parsed out for SQL audit recording.

## MySQL proxy (`crates/gated-protocol-mysql`)

### Listener

`MySQLProtocolServer` (`crates/gated-protocol-mysql/src/lib.rs`)
implements `ProtocolServer` (`lib.rs`). It loads the listener TLS
certificate from `mysql.certificate`/`mysql.key`, accepts TCP connections
with `TCP_NODELAY`, and runs one `Session` per connection.

**TLS is mandatory for clients.** The proxy advertises the `SSL` capability
in its handshake (`crates/gated-protocol-mysql/src/session.rs`) and, if
the client does not request the TLS upgrade, rejects the connection with
error 1002: "Gated requires TLS" (`session.rs`). The client's
`SSL_REQUEST` packet triggers a rustls upgrade on the wrapped stream, then
the handshake continues encrypted.

### Client auth handshake

- Initial handshake offers `mysql_native_password`; once the username is
  known the proxy switches the client to `mysql_clear_password` so it can
  obtain the actual password (safe because the connection is already TLS).
- The username encodes the target with the same `user#target` / `user:target`
  syntax as SSH, and `ticket-<secret>` selects ticket auth
  (`crates/gated-common/src/auth/selector.rs`).
- The password is checked via `ConfigProvider::validate_credential`, then the
  credential policy and `authorize_target` are applied; tickets go through
  `authorize_ticket`/`consume_ticket`
  (`crates/gated-core/src/config_providers/mod.rs`).

### Target connection

`crates/gated-protocol-mysql/src/client.rs` connects with credentials from
`TargetMySqlOptions`; if the target has a bound account it is resolved with
`resolve_db_account` (`crates/gated-core/src/account_credentials.rs`) and
overrides the inline username/password. Outbound TLS follows the target's
`tls.mode` — `disabled`, `preferred` (fall back to plaintext), or `required`
(`client.rs`) — with certificate verification governed by
`tls.verify`. The upstream auth plugins supported include
`mysql_native_password`, `caching_sha2_password` (full RSA flow),
`sha256_password`, and `mysql_clear_password`.

### Stream model and recording

Packets are framed with `mysql_common`'s `PacketCodec` wrapped in a generic
`MySqlStream` over a `MaybeTlsStream`. Relay is *parsed but transparent*:
`COM_QUERY` packets are decoded to capture SQL text and classify the
statement kind; response headers (OK/ERR/EOF) are inspected to time the query
and capture error messages; all other commands pass through unmodified
(`session.rs`).

Each query is written as a `SqlAuditRecordingItem::Query`
(`crates/gated-core/src/recordings/structured.rs`) through a
`StructuredRecorder` (`structured.rs`) with timestamp, target, database,
SQL text, statement kind, elapsed milliseconds, success flag, and error
message; session metadata is `SqlAuditSessionMetadata::MySqlProxySession`.

## PostgreSQL proxy (`crates/gated-protocol-postgres`)

### Listener

`PostgresProtocolServer` (`crates/gated-protocol-postgres/src/lib.rs`)
implements `ProtocolServer` (`lib.rs`). It sets TCP keepalives and
`TCP_NODELAY` on accepted sockets. TLS toward the client is **negotiated, not
forced**: if the client opens with `SSLRequest`, the proxy answers `Accept`
and upgrades; otherwise the startup continues in plaintext
(`src/session.rs`).

### Client auth handshake

- The username (with the same `user#target` / `ticket-` selector syntax)
  comes from the startup message's `user` parameter.
- The proxy requests `CleartextPassword` from the client for password
  checks; web-approval second factors are supported by directing the user to
  the browser, mirroring the SSH flow.
- Validation, policy, target authorization, and tickets use the same core
  paths as MySQL.

### Target connection

`crates/gated-protocol-postgres/src/client.rs` authenticates upstream with
whatever the server demands: cleartext password, MD5, or SASL (SCRAM via the
`rsasl` crate). Outbound TLS follows `tls.mode`
(`client.rs`) with `tls.verify` controlling certificate checks. Bound
accounts are resolved with the same `resolve_db_account` helper.

### Stream model and recording

Messages are encoded/decoded with the `pgwire` crate over a custom
`PostgresStream` (also `MaybeTlsStream`-based). The relay parses the extended
query protocol: `Parse` caches prepared SQL, `Bind` maps portals to
statements, `Execute`/`Query` start a pending audit record, and
`CommandComplete`/`ErrorResponse` close it with success or error detail; all
other messages are forwarded untouched (`src/session.rs`). A per-target idle
timeout (default 10 minutes) tears down inactive sessions.

Audit items are the same `SqlAuditRecordingItem::Query` written through
`StructuredRecorder`, with `SqlAuditSessionMetadata::PostgresProxySession`
metadata.

## Shared crate: `gated-database-protocols`

An extract of sqlx-core's MySQL wire-protocol layer with `Encode`/`Decode`
implemented for the server side of the conversation: capability flags, the
handshake/auth-switch packets, OK/ERR/EOF responses, text-protocol query
packets, and generic buffer traits (`crates/gated-database-protocols/src`).
The MySQL proxy consumes these types; the PostgreSQL proxy relies on `pgwire`
instead and does not use this crate. TLS helpers live in `gated-tls`, not
here.

## Side-by-side summary

| Aspect | MySQL | PostgreSQL |
|---|---|---|
| Client TLS | Required (rejected otherwise) | Optional (negotiated) |
| Client auth | native-password handshake, then clear-password over TLS | CleartextPassword; web-approval supported |
| Target selection | `user#target` / `user:target` / `ticket-` | same |
| Upstream auth | native, caching_sha2, sha256, clear | cleartext, MD5, SASL/SCRAM |
| Upstream TLS | disabled / preferred / required + verify flag | same |
| Codec | `mysql_common` PacketCodec + `gated-database-protocols` types | `pgwire` |
| Recording | per-query SQL audit (StructuredRecorder) | per-query SQL audit, prepared statements resolved |
