# Gated

A smart bastion host / access gateway for SSH, HTTPS, MySQL, PostgreSQL, and Kubernetes.

Based on [Warpgate](https://github.com/warp-tech/warpgate) by Warpgate contributors.

## Features

- SSH, HTTPS, MySQL, PostgreSQL, Kubernetes proxying
- Centralized authentication with 2FA (TOTP) and SSO (OpenID Connect)
- LDAP / Active Directory integration
- Role-based access control (RBAC)
- Session recording and replay
- Web admin UI with live terminal
- Single binary, no dependencies
- Written in 100% safe Rust

## Build

```bash
# Prerequisites: Rust, Bun, just
just bun install --frozen-lockfile
just bun run build
cargo build --release

# Feature flags for database backends
cargo build --features mysql,postgres
```

## License

Licensed under the [Apache License 2.0](LICENSE).

Gated is a derivative work of [Warpgate](https://github.com/warp-tech/warpgate) by Warpgate contributors. The original Warpgate project and its branding remain the property of their respective authors. See [NOTICE](NOTICE) for full attribution.
