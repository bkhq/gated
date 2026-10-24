#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
backend_pid=''
frontend_pid=''
cleanup() {
    for child in "$backend_pid" "$frontend_pid"; do
        if [[ -n "$child" ]]; then kill -TERM "$child" 2>/dev/null || true; fi
    done
    wait || true
}
trap cleanup EXIT
trap 'exit 130' INT TERM
web/node_modules/.bin/nsl run -f -n gated -- env CARGO_BUILD_TARGET="${CARGO_BUILD_TARGET:-x86_64-unknown-linux-gnu}" cargo run --target "${CARGO_BUILD_TARGET:-x86_64-unknown-linux-gnu}" --all-features -- --config config.yaml run --admin-port NSL_PORT &
backend_pid=$!
(cd web && exec ./node_modules/.bin/nsl run -f -n gated:/ui -- ./node_modules/.bin/vite) &
frontend_pid=$!
wait -n "$backend_pid" "$frontend_pid"
