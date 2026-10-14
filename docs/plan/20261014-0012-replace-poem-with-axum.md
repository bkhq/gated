# 20261014-0012-replace-poem-with-axum Replace poem with axum and utoipa

- **status**: draft
- **createdAt**: 2026-10-14 00:12
- **approvedAt**: (pending)
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

(pending)
