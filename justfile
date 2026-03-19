projects := "gated gated-admin gated-ca gated-common gated-core gated-database-protocols gated-db-entities gated-db-migrations gated-ldap gated-mcp gated-protocol-api gated-protocol-http gated-protocol-kubernetes gated-protocol-mysql gated-protocol-postgres gated-protocol-ssh gated-sso gated-tls gated-web"

run $RUST_BACKTRACE='1' *ARGS='run':
     cargo run --all-features -- --config config.yaml {{ARGS}}

fmt:
    for p in {{projects}}; do cargo fmt -p $p -v; done

fix *ARGS:
    for p in {{projects}}; do cargo fix --all-features -p $p {{ARGS}}; done

clippy *ARGS:
    for p in {{projects}}; do cargo cranky --all-features -p $p {{ARGS}}; done

test:
    for p in {{projects}}; do cargo test --all-features -p $p; done

pnpm *ARGS:
    cd gated-web && pnpm {{ARGS}}

pnpx *ARGS:
    cd gated-web && pnpm dlx {{ARGS}}

migrate *ARGS:
    cargo run --all-features -p gated-db-migrations -- {{ARGS}}

lint *ARGS:
    cd gated-web && pnpm run lint {{ARGS}}

typecheck:
    cd gated-web && pnpm run typecheck

openapi-all:
    cd gated-web && pnpm run openapi:schema:admin && pnpm run openapi:schema:gateway && pnpm run openapi:client:admin && pnpm run openapi:client:gateway

openapi:
    cd gated-web && pnpm run openapi:client:admin && pnpm run openapi:client:gateway

config-schema:
    cargo run -p gated-common --bin config-schema > config-schema.json

cleanup: (fix "--allow-dirty") (clippy "--fix" "--allow-dirty") fmt typecheck lint

udeps:
    cargo udeps --all-features --all-targets
