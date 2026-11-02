# Dependency exceptions

Status: accepted. Review deadline: 2026-12-13.

## SQLCipher storage encryption

Keep `libsqlite3-sys = 0.30.1` and its bundled SQLCipher engine to preserve the
existing encrypted database format. Its vendored OpenSSL implementation is
allowed only through the `libsqlite3-sys` wrapper in `deny.toml`. Other paths to
`openssl-sys` remain banned; network TLS uses rustls/aws-lc-rs.

The narrow wrapper rule uses the supported
[cargo-deny configuration](https://embarkstudios.github.io/cargo-deny/checks/bans/cfg.html#the-wrappers-field-optional).
Newer `libsqlite3-sys` releases still use `openssl-sys` for bundled SQLCipher
and conflict with the SQLx SQLite link dependency, so upgrading does not remove
the exception. Review a supported alternative at the deadline; do not silently
remove the ban.

## Ignored advisories

`deny.toml` ignores these advisories; the reason is kept next to each entry:

- RUSTSEC-2023-0071 (`rsa` timing side channel): RSA decryption is not used
  directly; SSH goes through russh.
- RUSTSEC-2021-0139 (`ansi_term` unmaintained).
- RUSTSEC-2025-0134 (`rustls-pemfile` deprecated): still required by tonic.
- RUSTSEC-2026-0387 (`crypto-bigint` 0.5 timing): reached only through
  openidconnect verifying IdP ID-token signatures with public keys; no fixed
  0.5.x release.

Remove an entry once the dependency path is gone or a fixed release exists.
