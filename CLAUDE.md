# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Gated is a smart bastion host / access gateway written in 100% safe Rust. It proxies SSH, HTTPS, MySQL, PostgreSQL, and Kubernetes connections with centralized auth, RBAC, session recording, and a web admin UI. Ships as a single binary with the frontend embedded via `rust-embed`.

## Build & Run

```bash
# Prerequisites: Rust 1.93+, Bun, just

# Backend
cargo build --release                         # Release binary at target/release/gated
cargo build --features mysql,postgres         # With database backend feature flags
cargo run --all-features -- --config config.yaml run  # Run locally (or: just run)

# Frontend (gated-web/)
just bun install --frozen-lockfile            # Install deps
just bun run build                            # Production build → gated-web/dist/
just bun run dev                              # Dev server on 0.0.0.0:8889

# OpenAPI client regeneration (after changing admin or gateway API endpoints)
just openapi                                  # Regenerate TypeScript API clients from Rust schemas
```

## Lint & Check

```bash
just clippy                   # Rust linting (cargo cranky, per-crate, all features)
just fmt                      # Rust formatting (per-crate)
just lint                     # Frontend ESLint (@antfu config)
just typecheck                # Frontend tsc --noEmit
just cleanup                  # All of the above: fix + clippy + fmt + typecheck + lint
```

## Testing

```bash
# Rust unit tests
just test                                     # All crates
cargo test --all-features -p gated-core       # Single crate

# Frontend tests (Vitest)
cd gated-web && bun run test                  # All frontend tests
cd gated-web && bun run test:watch            # Watch mode

# Integration tests (Bun, in tests/ directory)
cd tests && bun test                          # All integration tests
cd tests && bun test api/                     # Test category (api, ssh, http, db, kubernetes, misc)
cd tests && bun test api/users.test.ts        # Single test file
```

Integration tests spawn a real `gated` binary via `ProcessManager`, create test fixtures (users, roles, targets) via `AdminClient`, and validate behavior end-to-end. Test timeout is 300s.

## Architecture

### Workspace (19 crates)

The `gated` binary crate is the entry point. It wires together protocol servers that all implement the `ProtocolServer` trait. Central dependency injection is via the `Services` struct in `gated-core/src/services.rs`, which holds `Arc<Mutex<T>>` references to shared state (DB, config, sessions, recordings, rate limiters).

Key crate groups:
- **Core**: `gated-common` (config, auth types, shared helpers), `gated-core` (runtime state, services, session management), `gated-db-entities` + `gated-db-migrations` (Sea-ORM models + migrations)
- **Protocols**: `gated-protocol-{ssh,http,mysql,postgres,kubernetes}` — each implements `ProtocolServer`
- **Auth integrations**: `gated-ldap`, `gated-sso` (OIDC), `gated-ca` (client cert issuance), `gated-tls`
- **Web**: `gated-admin` (REST API with poem-openapi), `gated-web` (React SPA, embedded into binary), `gated-mcp` (AI agent MCP server)

### Frontend (gated-web/)

React 19 SPA using React Router v7 with lazy-loaded routes. Three route hierarchies under `/ui`:
- `/ui` — **Gateway**: user self-service (targets, profile, credentials, API tokens)
- `/ui/admin` — **Admin**: management dashboard (sessions, recordings, config)
- `/ui/client` — **Client**: client access interface

State management: TanStack Query for server state, Zustand for client state. UI: shadcn/ui (Base UI) + Tailwind CSS v4. i18n via i18next (en, zh-CN).

### API Type Flow

Rust backend (poem-openapi) → `cargo run -p gated-admin` outputs OpenAPI JSON → `openapi-generator-cli` generates TypeScript-fetch client → frontend imports typed API client. Two separate API surfaces: admin (`/admin/api`) and gateway (`/api`).

### Auth Pipeline

Multi-credential, multi-backend auth: Password/PubKey/TOTP/SSO/Certificate credentials validated against configurable policies (any-single, all-required, per-protocol). Auth state tracked per-session with 10-min TTL and broadcast channels for state changes.

### Database

Sea-ORM 1.0 + sqlx. SQLite default; PostgreSQL and MySQL via feature flags. 22 entity models, 31 sequential migrations.

## Key Conventions

- All Rust code is 100% safe (no `unsafe`)
- Async-first with Tokio runtime
- `anyhow::Result<T>` for error propagation; `thiserror` for typed errors in libraries
- `enum_dispatch` for trait-based polymorphism
- Poem framework for HTTP/API; poem-openapi for auto-generated OpenAPI specs
- `clippy.toml`: `avoid-breaking-exported-api = false`, `allow-unwrap-in-tests = true`
- Frontend uses `@antfu/eslint-config` for linting
- Vite base path is `/ui/`; dev server runs on port 8889

## Database Migrations

```bash
just migrate up                # Run pending migrations
just migrate down              # Rollback last migration
just migrate status            # Check migration status
```

Migrations are in `gated-db-migrations/src/`. Uses Sea-ORM migration framework.

## Project Development

This project uses the **PMA (Project Management Assistant)** workflow for development task management.

### Workflow: Investigate -> Proposal -> Implement

1. **Investigate**: Trace call chains, search related code/config/tests, read `docs/changelog.md` for context
2. **Proposal**: Output current state, proposal, risks, scope, alternatives; wait for approval
3. **Implement**: Execute approved changes, verify, update task/plan status and changelog

### Documentation Structure

```
docs/
├── architecture.md        # System architecture
├── changelog.md           # Development changelog
├── task/
│   ├── index.md           # Task tracking index
│   └── PREFIX-NNN.md      # Task detail files
└── plan/
    ├── index.md           # Plan tracking index
    └── PLAN-NNN.md        # Plan detail files
```

### Task Prefixes

- `FEAT` - New features
- `BUG` - Bug fixes
- `REFACTOR` - Code refactoring
- `PERF` - Performance improvements
- `AUTH` - Authentication related
- `UI` - Frontend/UI changes
- `API` - API changes
- `INFRA` - Infrastructure/CI/CD
