# HTTP Reverse Proxy (`crates/gated-protocol-http`)

The HTTP proxy is a dedicated HTTPS listener that forwards requests to
HTTP targets. It is separate from the admin/portal HTTP server in
`gated-admin` (see [management-plane.md](management-plane.md)); the proxy
listener serves **only** proxying, with no UI or login pages.

Targets of kind `http` carry a `flavor` field
(`crates/gated-common/src/config/target.rs:229-233`): `generic` for plain
HTTP services and `kubernetes` for Kubernetes API servers. The flavor is also
surfaced in the admin UI target list.

## Listener

`run_server` (`crates/gated-protocol-http/src/server.rs:45`) is spawned from
the run command (`crates/gated/src/commands/run.rs:314`) when
`http.enable = true`. Unlike the other proxies it does not implement
`ProtocolServer`; it is an axum app with a single catch-all route.

TLS termination:

- the certificate/key come from `http.certificate` / `http.key`
  (`server.rs:70-102`);
- the rustls `ServerConfig` installs `AcceptAnyClientCert`
  (`crates/gated-protocol-http/src/kubernetes/client_certs.rs:15`) so clients
  *may* present a certificate during the handshake without being rejected;
  actual validation happens later at the application layer;
- the acceptor is wrapped in a `CertificateCapturingAcceptor`
  (`client_certs.rs:78`) which extracts the peer certificate DER after the
  handshake and smuggles it to request handlers, where
  `CertificateExtractorMiddleware` (`client_certs.rs:160`) places it in the
  request extensions.

## Routing: request to target

Resolution is two-tier (`crates/gated-protocol-http/src/resolver.rs`):

1. an explicit `X-Gated-Target: <name>` header wins (`resolver.rs:21`);
2. otherwise the `Host` header must look like `<target>.<base_domain>`, where
   `base_domain` is `http.base_domain` from config. Exactly one extra DNS
   label is accepted; ports are stripped; matching is case-insensitive.

Resolution failures and unknown target names return a bare `401` without a
`WWW-Authenticate` challenge, deliberately not revealing whether a target
exists. There are no session cookies on this listener; each request resolves
its target independently.

## Authentication and authorization

`authenticate_request` (`server.rs:177`) accepts exactly two credentials:

- **Bearer API token** — `Authorization: Bearer <token>` validated via
  `ConfigProvider::validate_api_token`
  (`crates/gated-core/src/config_providers/db.rs:507`);
- **mTLS client certificate** — the captured handshake certificate is checked
  by `validate_client_certificate`
  (`crates/gated-protocol-http/src/kubernetes/auth.rs:19`): the serial number
  is looked up in the `certificate_revocations` table, then the PEM is
  matched byte-for-byte (after normalization) against stored
  `CertificateCredential` rows, resolving to a user and bumping `last_used`.
  See [tls-and-ca.md](tls-and-ca.md) for issuance.

There is no password/SSO login and no ticket support on this listener. After
authentication, `ConfigProvider::authorize_target` is enforced
(`server.rs:147`).

## Target connection

A `reqwest` client is built per target by `build_http_client`
(`crates/gated-protocol-http/src/engine.rs:77`):

- redirects are never followed (`Policy::none()`, `engine.rs:103`) — they are
  passed back to the client;
- TLS verification is controlled by the target's `tls.verify` flag, and an
  optional per-target `ca_certificate` PEM bundle is added as a root;
- upstream authentication (`UpstreamAuth` in
  `crates/gated-common/src/config/target.rs`) is injected as default
  headers: custom `headers`, a `bearer_token`, or an mTLS
  `client_certificate` identity.

URL construction (`construct_target_url`, `engine.rs:182`) joins the request
path/query to the target base URL; the generic flavor rejects `..` path
segments (path-traversal guard) while the Kubernetes flavor skips that check
(the API server needs them for certain subresources and performs its own
validation).

Header handling (`collect_forwarded_headers`, `engine.rs:224`):

- a global strip list `DONT_FORWARD_HEADERS`
  (`crates/gated-common/src/http_headers.rs:7`) removes hop-by-hop and
  websocket negotiation headers;
- `Authorization`, `X-Gated-Target`, and `X-Gated-Token` are always removed;
- headers that would shadow configured upstream-auth headers are removed;
- response `content-encoding`/`content-length`/`transfer-encoding` are
  stripped on the way back (the server re-frames the body).

Request and response bodies are buffered with a 100 MiB cap
(`API_PROXY_MAX_BODY_SIZE`, `crates/gated-common/src/http_headers.rs:31`),
except for streamed responses (below).

## Kubernetes flavor specifics

| Concern | Behavior |
|---|---|
| Session model | Requests are correlated into one logical session per (user, target, client IP) by `RequestCorrelator` (`crates/gated-protocol-http/src/kubernetes/correlator.rs:16`), vacuumed on a 60-second cycle (`correlator.rs:88`); the generic flavor creates a session per request. |
| WebSockets | `kubectl exec`/`attach`/`port-forward` upgrade requests are proxied with support for `channel.k8s.io` and `v2`-`v5` variants (`crates/gated-protocol-http/src/kubernetes/websocket.rs:172`); the upstream websocket client is forced to HTTP/1.1. |
| Watch streaming | Responses that are chunked or requested with `watch=true` are streamed instead of buffered (`engine.rs:347`). |
| Accept header | `application/vnd.kubernetes.protobuf` is filtered out of `Accept` so responses stay in JSON. |
| Exec/attach recording | The URL pattern `/api/v1/namespaces/<ns>/pods/<pod>/(exec|attach)` is recognized; namespace, pod, container, and command are stored as recording metadata, and the websocket byte streams are decoded into a `TerminalRecorder` (stdout/stderr frames, PTY resize frames) (`crates/gated-protocol-http/src/kubernetes/recording.rs`, `websocket.rs`). |
| Impersonation | Not used — gated authenticates to the API server with the target's own credentials (bearer token, headers, or client cert); no `Impersonate-*` headers are injected. |

## Recording hooks

When recordings are enabled, each proxy session records an
`HttpProxyRecordingItem` per request — timestamp, method, path, forwarded
headers, request body, response status, and response body (None when
streamed) — via the recordings subsystem
(`crates/gated-protocol-http/src/recording.rs`, written from
`build_downstream_response`, `engine.rs:316`). Kubernetes exec/attach
sessions additionally produce terminal recordings as described above.

Independent of recordings, every proxied request emits a structured log entry
(method, URL, status, client IP) into the session log
(`server.rs`, `log_request_result`; see
[sessions-recordings-audit.md](sessions-recordings-audit.md)).
