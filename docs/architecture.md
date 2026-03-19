# Gated Architecture

> Version: 0.21.1 | License: Apache-2.0

## Overview

Gated is a smart, fully transparent bastion host / access gateway written in 100% safe Rust. It proxies SSH, HTTPS, MySQL, PostgreSQL, and Kubernetes connections with centralized authentication, RBAC authorization, full session recording, and a web admin UI. It ships as a single binary with no external dependencies.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Language | Rust (Edition 2021) |
| Async Runtime | Tokio 1.20+ (multi-threaded) |
| Web Framework | Poem 3.1 + poem-openapi 5.1 |
| Database ORM | Sea-ORM 1.0 + sqlx 0.8 |
| SSH | russh 0.57 |
| TLS | rustls 0.23 (aws-lc-rs provider) |
| Auth | openidconnect 4.0, ldap3 0.12, totp-rs 5.0 |
| Frontend | TypeScript, React 19, Tailwind CSS 4, shadcn/ui, Vite 8 |
| Build Tool | just (task runner) |

## Workspace Structure

17 crates organized in a Cargo workspace:

```
gated/                          # Main binary & CLI entry point
gated-common/                   # Shared types, auth, config, helpers
gated-core/                     # Core runtime: state, services, recordings, rate limiting
gated-admin/                    # REST API (23 endpoint modules, OpenAPI)
gated-web/                      # Frontend assets (React SPA, embedded via rust-embed)
gated-db-entities/              # SeaORM database models (22 entities)
gated-db-migrations/            # Database migrations (31 migrations)
gated-database-protocols/       # Shared MySQL/Postgres protocol utilities
gated-protocol-ssh/             # SSH bastion (server + client proxy)
gated-protocol-http/            # HTTPS proxy + web UI gateway
gated-protocol-mysql/           # MySQL wire protocol proxy
gated-protocol-postgres/        # PostgreSQL wire protocol proxy
gated-protocol-kubernetes/      # Kubernetes API proxy
gated-ldap/                     # LDAP/Active Directory integration
gated-sso/                      # OpenID Connect SSO
gated-tls/                      # TLS certificate management
gated-ca/                       # Certificate Authority (client cert issuance)
```

## Crate Dependency Graph

```
gated (binary)
├── gated-core
│   ├── gated-common
│   ├── gated-db-entities
│   ├── gated-db-migrations
│   ├── gated-ldap
│   ├── gated-sso
│   └── gated-tls
├── gated-admin
│   ├── gated-core
│   ├── gated-common
│   ├── gated-db-entities
│   ├── gated-ca
│   ├── gated-ldap
│   ├── gated-tls
│   ├── gated-protocol-ssh
│   └── gated-protocol-kubernetes
├── gated-protocol-ssh
│   ├── gated-core
│   ├── gated-common
│   └── gated-tls
├── gated-protocol-http
│   ├── gated-core
│   ├── gated-common
│   ├── gated-admin
│   ├── gated-web
│   └── gated-tls
├── gated-protocol-mysql
│   ├── gated-core
│   ├── gated-common
│   └── gated-database-protocols
├── gated-protocol-postgres
│   ├── gated-core
│   ├── gated-common
│   └── gated-database-protocols
└── gated-protocol-kubernetes
    ├── gated-core
    ├── gated-common
    └── gated-tls
```

## Protocol Support

| Protocol | Crate | TLS | Recording | Auth Methods |
|----------|-------|-----|-----------|-------------|
| SSH | gated-protocol-ssh | Via russh | Terminal + Traffic | Password, PubKey, TOTP |
| HTTPS | gated-protocol-http | TLS termination | Traffic | LDAP, SSO, Password, TOTP |
| MySQL | gated-protocol-mysql | TLS wrapper | TCP traffic | Target credentials |
| PostgreSQL | gated-protocol-postgres | TLS wrapper | TCP traffic | Target credentials |
| Kubernetes | gated-protocol-kubernetes | HTTPS client | Request logs | Client certificates |

All protocols implement the `ProtocolServer` trait:
```rust
#[async_trait]
pub trait ProtocolServer {
    async fn run(self, listen: ListenEndpoint) -> Result<()>;
}
```

## Core Services Architecture

Central dependency injection via `Services` struct (`gated-core/src/services.rs`):

```rust
pub struct Services {
    pub db: Arc<Mutex<DatabaseConnection>>,
    pub recordings: Arc<Mutex<SessionRecordings>>,
    pub config: Arc<Mutex<GatedConfig>>,
    pub state: Arc<Mutex<State>>,
    pub config_provider: Arc<Mutex<ConfigProviderEnum>>,
    pub auth_state_store: Arc<Mutex<AuthStateStore>>,
    pub rate_limiter_registry: Arc<Mutex<RateLimiterRegistry>>,
    pub global_params: Arc<GlobalParams>,
    // ...
}
```

## Authentication System

### Multi-Layered Auth Pipeline

1. **Credential Types** (`gated-common/src/auth/cred.rs`):
   - Password (Argon2 hashed)
   - PublicKey (OpenSSH format)
   - Certificate (PEM X.509)
   - TOTP (RFC 6238)
   - SSO (OAuth2/OIDC)
   - WebUserApproval (manual)

2. **Credential Policies** (`gated-common/src/auth/policy.rs`):
   - `AnySingleCredentialPolicy` - any one credential sufficient
   - `AllCredentialsPolicy` - multiple credentials required (AND)
   - `PerProtocolCredentialPolicy` - protocol-specific requirements

3. **Auth Backends**:
   - `DatabaseConfigProvider` - local database (enum_dispatch)
   - LDAP integration (`gated-ldap`) - directory auth + SSH key sync
   - SSO integration (`gated-sso`) - OpenID Connect providers

4. **AuthState** (`gated-common/src/auth/state.rs`):
   - Per-session auth progress tracking
   - Broadcast channel for state changes
   - 10-minute TTL in `AuthStateStore`

### Auth Flow

```
Client Connect -> AuthState created -> Credential validation
    -> CredentialPolicy check -> Target authorization (RBAC)
    -> Session ticket -> Protocol-specific session
```

## Database Layer

- **ORM**: Sea-ORM 1.0 with sqlx
- **Supported backends**: SQLite (default), PostgreSQL, MySQL (via feature flags)
- **Migrations**: 31 sequential migrations (`gated-db-migrations`)
- **Connection pool**: min 5, max 100, 8s timeouts

### Key Entities (22 models)

```
User, Role, Target, TargetGroup
UserRoleAssignment, TargetRoleAssignment    (RBAC junction tables)
PasswordCredential, PublicKeyCredential,
CertificateCredential, OtpCredential,
SsoCredential                               (credential storage)
Session, Recording, LogEntry                 (audit)
Ticket, ApiToken                             (access tokens)
KnownHost, LdapServer, Parameters           (config)
CertificateRevocation                        (PKI)
```

### RBAC Model

```
User --N:M--> Role --N:M--> Target
                    |
                    +--> TargetGroup --1:N--> Target
```

## Session & Recording System

### Session Lifecycle

1. `State::register_session()` - creates in DB + in-memory HashMap
2. Protocol handler manages connection proxy
3. `SessionRecordings` captures terminal (asciinema) or traffic (raw TCP)
4. Live streaming via broadcast channels (WebSocket to admin UI)
5. Auto-cleanup on session drop

### Recording Types

- **Terminal**: asciinema cast v2 format (SSH sessions)
- **Traffic**: raw TCP packet capture (MySQL/Postgres/HTTP)

## Rate Limiting

Multi-level rate limiting via `governor` library:

```
Global limits -> Per-user limits -> Per-target limits
                                        |
                                   Read/Write split
```

Supports hot-swap via `SwappableLimiterCell` when config changes.

## Web Admin Panel

- **Backend**: Poem REST API with OpenAPI 3.0 auto-generation
- **Frontend**: React 19 SPA embedded via `rust-embed`
- **API Endpoints**: 23 modules covering users, targets, roles, credentials, sessions, recordings, logs, tickets, LDAP, SSH keys
- **Real-time**: WebSocket for session monitoring + live recording playback
- **Terminal Replay**: xterm.js integration for SSH session playback

## Startup Sequence

1. Parse CLI args, load YAML config
2. Initialize rustls provider (AWS-LC)
3. Build `Services` container (DB connect, migrations, init builtins)
4. Install database logger layer
5. Spawn protocol servers concurrently (`FuturesUnordered`)
6. Start cleanup task (expired sessions/recordings)
7. Watch config file for live reload
8. Handle SIGINT/SIGTERM for graceful shutdown

## Configuration

- **Format**: YAML (`/etc/gated.yaml` default)
- **Sections**: HTTP, SSH, MySQL, PostgreSQL, Kubernetes, database, recordings, logging
- **Runtime config**: stored in database, managed via admin API
- **Live reload**: file watcher triggers config refresh

## Testing

- **Integration tests**: Bun/TypeScript in `tests/` directory
- **Coverage**: all protocols, auth methods, session recording, API endpoints
- **Infrastructure**: OIDC mock server, certificate fixtures

## CI/CD

8 GitHub Actions workflows:
- `build.yml` - Multi-platform builds (Linux x86_64/ARM64, macOS)
- `test.yml` - Integration tests
- `docker.yml` - Docker image builds
- `codeql.yml` - Code quality scanning
- `check-schema-compatibility.yml` - Config schema validation
- `dependency-review.yml` - Dependency security
- `reprotest.yml` - Reproducible build verification
- `scorecard.yml` - OpenSSF scorecard

## Deployment

- **Docker**: Multi-stage build (Rust 1.93.1 + Debian), runs as non-root `gated` user
- **Binary**: Single static binary, no external dependencies
- **Health check**: built-in `gated healthcheck` command
