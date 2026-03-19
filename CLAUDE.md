# Gated Development Guide

## Project Overview

Gated is a smart bastion host / access gateway written in Rust. It proxies SSH, HTTPS, MySQL, PostgreSQL, and Kubernetes connections with centralized auth, RBAC, session recording, and a web admin UI.

## Build & Run

```bash
# Prerequisites: Rust, Bun, just
just bun install --frozen-lockfile  # Install frontend deps
just bun run build                  # Build frontend
cargo build --release               # Build backend
# Binary: target/release/gated

# Feature flags for database backends
cargo build --features mysql,postgres
```

## Project Structure

- 17 Cargo workspace crates (see `docs/architecture.md` for full map)
- Frontend: `gated-web/` (React 19 + TypeScript + Vite 8 + shadcn/ui + Tailwind CSS 4)
- Tests: `tests/` (Bun + TypeScript integration tests)

## Key Conventions

- All code is 100% safe Rust (no `unsafe`)
- Async-first with Tokio runtime
- `Arc<Mutex<T>>` for shared state
- `anyhow::Result<T>` for error propagation
- `enum_dispatch` for trait-based polymorphism
- Poem framework for HTTP/API endpoints
- Sea-ORM for database operations

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
