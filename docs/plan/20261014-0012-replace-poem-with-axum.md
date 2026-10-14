# 20261014-0012-replace-poem-with-axum Replace poem with axum and utoipa

- **status**: implementing
- **createdAt**: 2026-10-14 00:12
- **approvedAt**: 2026-10-14 00:13
- **relatedTask**: 20261014-0012-replace-poem-with-axum

## Context

poem is the HTTP framework of the whole gateway, not only of the admin API:

- `gated-admin`: 58 files (about 16k lines) use poem. 50 `#[OpenApi]` impl blocks expose 90 admin and 37 user operations with 177 schemas; 21 plain `#[handler]` endpoints, 9 middleware and 6 custom `Endpoint` implementations, cookie sessions, WebSocket endpoints, the embedded SPA and the API-token/session security schemes.
- `gated-protocol-http`: the reverse-proxy engine, the Kubernetes proxy and its listeners are written against poem requests, responses and the rustls listener with SNI certificates.
- `gated-common`, `gated-core`, `gated-db-entities`, `gated-tls`: 126 `Object`, 12 `Enum` and 5 `Union` derives plus error conversions (`ResponseError`).
- `gated`: the pre-unlock and observability servers.
- The frontend types are generated from `web/scripts/openapi/{admin,user}.snapshot.json`; CI fails on a snapshot difference and runs `oasdiff breaking` on pull requests.

## Proposal

Target stack: axum 0.8 with tower/tower-http, utoipa 5 with `utoipa-axum` for the OpenAPI documents, `tower-sessions` for cookie sessions, `tokio-rustls` for the TLS listeners (latest stable versions verified at crates.io when added).

Work on a branch, one commit per phase, each phase compiling and passing the Rust gates:

1. Schema types: replace the `poem_openapi` derives in `gated-common`, `gated-db-entities`, `gated-tls` and `gated-core` with `utoipa::ToSchema` on the existing serde types; replace `ResponseError` with `IntoResponse`.
2. Server plumbing: listeners (TCP, TLS with SNI), sessions, authentication extractors for session/user-token/admin-token, the existing middleware as tower layers, SPA embedding.
3. Admin and user API: port the 127 operations to `#[utoipa::path]` handlers, keeping paths, operation ids, schema names and status codes; regenerate the snapshots and review every difference.
4. HTTP and Kubernetes proxy engine, WebSocket endpoints, recording playback streams.
5. `gated` binary servers; remove `poem*`, `vendor/`, the patch section and the related entries in `deny.toml` and `docs/decisions`.

## Risks

- OpenAPI output: utoipa emits OpenAPI 3.1 and represents nullable and union types differently from poem-openapi. The generated frontend types will change even where the wire format does not; each difference must be classified as representation-only or breaking.
- Behaviour parity outside the specification: error bodies, status codes for validation failures, cookie attributes, and session storage format (existing browser sessions may be invalidated by the upgrade).
- The proxy engine has little unit-test coverage; the `tests/` integration suite, which only runs in CI, is the main safety net.
- Until the last phase lands, `cargo deny` keeps failing on RUSTSEC-2024-0449, so the CI Quality gates job stays red.
- Size: roughly 20k lines touched across seven crates.

## Scope

All seven crates listed above, the root manifest, `vendor/`, `deny.toml`, `docs/decisions`, `docs/architecture`, the OpenAPI snapshots and generated frontend types.

## Alternatives

- Patch only `serde_yaml` out of the vendored crates: about ten call sites, but it widens the local fork of an upstream that is not keeping its dependencies current.
- Keep poem for the proxy engine and move only the API to axum: smaller, but both frameworks and the vendored copies stay.
- A different OpenAPI approach on axum (`aide`, or a hand-maintained specification with contract tests) instead of utoipa.

## Annotations

Approved through decision event pxsdlnmi (option A: all five phases on a branch, merged to main once everything passes).

### Phase 1 findings (2026-10-14)

- utoipa 6.0 is the current release; its derive and `utoipa-axum` APIs match 5.x.
- poem-openapi kept two independent codecs: its own `Object`/`Union` JSON for the API and serde for storage. They disagree for the target and credential-policy configuration types (`Target`, `TargetOptions` and the option structs, `SSHTargetAuth`, `UpstreamAuth`, `Tls`, `TlsMode`, `CredentialKind`, `UserRequireCredentialsPolicy`, `User`): tagged by `kind` on the wire, untagged or externally tagged with lowercase names in the database. With a single serde codec the stored format must not move, so the wire format lives in dedicated types in `gated_common::api::types` with conversions to the stored ones; tests pin both representations.
- Phases 1 and 2 are additive (utoipa derives next to the poem ones) so every commit builds; the poem derives are removed in phase 5.
- Response documentation will be driven by the handler return type, as with poem: a derive generates both `IntoResponse` and the response metadata, and the route registration merges it into the operation.

### Phase 2 and 3 findings (2026-10-14)

- Deviations from the proposal, each to keep the dependency set and the behaviour change small: sessions use a small in-process layer ported from poem's `ServerSession` instead of `tower-sessions` (the handlers need synchronous access); the playground page is the same Stoplight Elements template poem served instead of `utoipa-scalar`; the handful of middlewares are `axum::middleware::from_fn` functions instead of `tower-http` layers; response documentation uses declarative macros (`api_response!`, `api_routes!`) instead of a derive crate.
- utoipa only documents `IntoParams` query structs that are listed in `params(...)`; listing them is enough, `parameter_in` is resolved from the `Query` extractor.
- The regenerated specification is OpenAPI 3.1. The differences from the previous snapshots are representation-only: optional fields are now also marked nullable (the API always emitted `null` for them), unsigned integers are `int32`/`int64` with `minimum: 0`, unions are inline `oneOf` members instead of named `*_Variant` components, `AccountDetail` is an `allOf` of `AccountSummary`, and the form body of `POST /sso/return` is now documented. `oasdiff breaking` reports all of them, so the pull-request-only "API schema compatibility" job would fail against the old baseline.
- The generated frontend types changed accordingly; a few helpers that only accepted `undefined` now also accept `null`.
- The `None` variant of the wire `UpstreamAuth` is a unit variant so that its schema is just the `kind` tag.
- `tests/xml_compatibility.rs` only covered the vendored poem `Xml` payload, which the product never used; it is removed.
- The shared server gained graceful shutdown: the pre-unlock listener must finish answering the unlock request before the full listener takes over the port.

### Phase 4 and 5 findings (2026-10-14)

- The proxy listener keeps its TLS configuration without ALPN, so it still speaks HTTP/1.1 only; target routing by `Host` and the `channel.k8s.io` upgrade rely on that.
- `WebSocketUpgrade::protocols` picks by the order of the server's list and keeps the requested protocols in a sorted set. The Kubernetes bridge therefore selects from the raw `Sec-WebSocket-Protocol` header, in the client's order, as before.
- poem's default `Cors` middleware is replaced by an equivalent function in `gated-protocol-http` (any origin echoed, preflights answered locally) instead of adding `tower-http`.
- The client certificate reaches the handler through `ConnectionInfo::peer_certificate`; the custom acceptor that smuggled it through the remote address is gone.
- `rustls-pemfile` and the `ring` feature of rustls are still pulled in by tonic 0.12 (OTLP exporter), so the `RUSTSEC-2025-0134` ignore and the disabled `ring` feature ban stay, with corrected reasons. `RUSTSEC-2024-0449` (`serde_yaml`) and the quick-xml advisories no longer apply.
- The integration suite needs `sshpass`, `expect`, `mysql`, `psql` and `kubectl` next to the runner; without them the affected cases fail on a missing executable.
