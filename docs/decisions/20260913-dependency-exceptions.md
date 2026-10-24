# Temporary dependency exceptions

Status: accepted for the dependency security upgrade authorized on 2026-09-13.
Review deadline: 2026-12-13.

## SQLCipher storage encryption

Keep `libsqlite3-sys = 0.30.1` and its bundled SQLCipher engine to preserve the
existing encrypted database format. Its vendored OpenSSL implementation is
allowed only through the `libsqlite3-sys` wrapper in `deny.toml`. Other paths to
`openssl-sys` remain banned; network TLS continues to use rustls/aws-lc-rs.
No new advisory exceptions are introduced.

The narrow wrapper rule uses the supported
[cargo-deny configuration](https://embarkstudios.github.io/cargo-deny/checks/bans/cfg.html#the-wrappers-field-optional).
Review a supported alternative at the deadline; do not silently remove the ban.

## Poem XML dependency

The latest published Poem 3.1.12 and poem-openapi 5.1.16 require quick-xml 0.36,
which is affected by RUSTSEC-2026-0194 and RUSTSEC-2026-0195. Their upstream
manifests still have this constraint as of 2026-09-13.

`vendor/poem` and `vendor/poem-openapi` contain the corresponding crates.io
release sources, including their licenses. Registry cache metadata and nested
lockfiles are omitted. Only the quick-xml requirement (0.41) and the renamed
serialization error type (`SeError`) are changed. The root manifest patches
both packages locally; no old XML implementation is hidden behind an alias.

Original crates.io archive SHA-256 checksums (from the pre-upgrade lockfile):

- poem 3.1.12: `9f977080932c87287147dca052951c3e2696f8759863f6b4e4c0c9ffe7a4cc8b`
- poem-openapi 5.1.16: `1ccbcc395bf4dd03df1da32da351b6b6732e4074ce27ddec315650e52a2be44c`

Verify XML response fallback tests, workspace/API contracts and supply-chain
checks. Remove both patches once a released upstream version supports a fixed
quick-xml version; reassess by the deadline above.

## Resolution (2026-10-14)

The Poem exception is closed. The HTTP stack moved to axum and utoipa, which do
not depend on quick-xml; `vendor/poem`, `vendor/poem-openapi` and the
`[patch.crates-io]` entries are removed. XML response bodies, which only
poem-openapi offered, are no longer served. The SQLCipher exception above is
unchanged.

## Early review (2026-09-13)

The reconciled review task was executed immediately at the user's request. Registry API checks confirm Poem 3.1.12 and poem-openapi 5.1.16 remain the latest stable releases and still require quick-xml ^0.36.1. Keep the minimal local patches until upstream supports a fixed version. The latest libsqlite3-sys 0.38.2 still uses openssl-sys for bundled SQLCipher; moving to it does not eliminate the exception and conflicts with the current SQLx SQLite link dependency. Retain 0.30.1 for compatibility. The existing 2026-12-13 sunset remains the next operational review boundary; no advisory ban is relaxed.

Sources: crates.io API `/api/v1/crates/{poem,poem-openapi,libsqlite3-sys}` and the corresponding version dependency endpoints, inspected on 2026-09-13. This records a reviewed retention decision, not removal of the upstream limitations.
