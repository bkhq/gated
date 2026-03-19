#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

# Build gated if not specified
if [ -z "${GATED_BINARY:-}" ]; then
    GATED_BINARY="target/debug/gated"
    echo "Building gated..."
    (cd .. && cargo build)
fi

export GATED_BINARY
export RUST_BACKTRACE=1
export NODE_TLS_REJECT_UNAUTHORIZED=0

# Ensure SSH key permissions
chmod 600 ssh-keys/id* 2>/dev/null || true

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
    bun install
fi

# Run tests
exec bun test "$@"
