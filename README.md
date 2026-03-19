# Gated

A smart bastion host / access gateway for SSH, HTTPS, MySQL, and PostgreSQL.

Based on [Warpgate](https://github.com/warp-tech/warpgate) by Warpgate contributors.

## Features

- SSH, HTTPS, MySQL, PostgreSQL proxying
- Centralized authentication with 2FA (TOTP) and SSO (OpenID Connect)
- Session recording and replay
- Web admin UI
- Single binary, no dependencies
- Written in 100% safe Rust

## Build

```bash
# Prerequisites: Rust, Node.js, npm, just
just npm ci
just npm run build
cargo build --release
```

## License

Licensed under the [Apache License 2.0](LICENSE).

Gated is a derivative work of [Warpgate](https://github.com/warp-tech/warpgate) by Warpgate contributors. The original Warpgate project and its branding remain the property of their respective authors. See [NOTICE](NOTICE) for full attribution.
