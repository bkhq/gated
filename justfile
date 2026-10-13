set shell := ["bash", "-eu", "-o", "pipefail", "-c"]

workspace_packages := "gated gated-admin gated-ca gated-common gated-core gated-database-protocols gated-db-entities gated-db-migrations gated-protocol-http gated-protocol-mysql gated-protocol-postgres gated-protocol-ssh gated-sso gated-tls gated-web"
web_dir := "web"
config_path := "config.yaml"
cargo_target := env_var_or_default("CARGO_BUILD_TARGET", "x86_64-unknown-linux-gnu")

run $RUST_BACKTRACE='1' *ARGS:
    CARGO_BUILD_TARGET={{cargo_target}} cargo run --target {{cargo_target}} --all-features -- --config {{config_path}} run {{ARGS}}

fmt:
    cargo fmt --all --verbose

fix *ARGS:
    for p in {{workspace_packages}}; do CARGO_BUILD_TARGET={{cargo_target}} cargo fix --target {{cargo_target}} --all-features -p "$p" {{ARGS}}; done

clippy *ARGS:
    CARGO_BUILD_TARGET={{cargo_target}} cargo cranky --target {{cargo_target}} --workspace --all-features {{ARGS}}

test *ARGS:
    CARGO_BUILD_TARGET={{cargo_target}} cargo test --target {{cargo_target}} --workspace --all-features {{ARGS}}

bun *ARGS:
    cd {{web_dir}} && CARGO_BUILD_TARGET={{cargo_target}} bun {{ARGS}}

bunx *ARGS:
    cd {{web_dir}} && CARGO_BUILD_TARGET={{cargo_target}} bunx {{ARGS}}

migrate *ARGS:
    CARGO_BUILD_TARGET={{cargo_target}} cargo run --target {{cargo_target}} --all-features -p gated-db-migrations -- {{ARGS}}

lint *ARGS:
    cd {{web_dir}} && CARGO_BUILD_TARGET={{cargo_target}} bun run lint {{ARGS}}

typecheck:
    cd {{web_dir}} && CARGO_BUILD_TARGET={{cargo_target}} bun run typecheck

test-web *ARGS:
    cd {{web_dir}} && CARGO_BUILD_TARGET={{cargo_target}} bun run test {{ARGS}}

# Run backend + Vite together; nsl banners the actual gated.localhost URL.
# Both processes are nsl-managed: nsl allocates a port and substitutes it into
# the gated CLI via the literal NSL_PORT placeholder, exactly like the Vite
# side picks up PORT. -f lets nsl reclaim a stale route from a prior session.
dev:
    bash scripts/dev.sh

# Manually register an already-running backend with nsl as `gated`.
nsl-route-backend port="8890":
    cd {{web_dir}} && bunx nsl route gated {{port}}

# List nsl's active route table.
nsl-status:
    cd {{web_dir}} && bunx nsl list

i18n-check:
    cd {{web_dir}} && CARGO_BUILD_TARGET={{cargo_target}} bun run i18n-check

openapi-all:
    cd {{web_dir}} && CARGO_BUILD_TARGET={{cargo_target}} bun run openapi

openapi:
    cd {{web_dir}} && CARGO_BUILD_TARGET={{cargo_target}} bun run openapi

config-schema:
    CARGO_BUILD_TARGET={{cargo_target}} cargo run --target {{cargo_target}} -p gated-common --bin config-schema > config-schema.json

cleanup: (fix "--allow-dirty") (clippy "--fix" "--allow-dirty") fmt typecheck lint i18n-check test-web

udeps:
    CARGO_BUILD_TARGET={{cargo_target}} cargo udeps --target {{cargo_target}} --all-features --all-targets
