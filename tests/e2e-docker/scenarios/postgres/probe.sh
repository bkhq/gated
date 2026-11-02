#!/usr/bin/env sh
# sidecar-image: postgres:16-alpine
# Runs inside a postgres-alpine sidecar (provides `psql`) on the e2e docker network.
# Connects to the gated postgres listener (gated:35432) as alice:postgres-up with
# alice's gated password. The bound account credentials (engine=postgres,
# username=postgres, password=rootpass) must reach postgres-upstream; the
# WRONG inline username + empty password would fail upstream auth otherwise.
# sslmode=require: gated negotiates TLS; cert is self-signed so we do NOT verify.
set -u
echo "[probe] Postgres session through gated:35432 (account binding must win over WRONG inline)"
output=$(PGPASSWORD=alice123 PGSSLMODE=require \
  psql -h gated -p 35432 -U 'alice:postgres-up' -d postgres \
    --no-psqlrc -t -A \
    -c "SELECT version();" \
    -c "SELECT current_user;" 2>&1)
status=$?
echo "exit=$status"
echo "--- output ---"
echo "$output"
echo "--- /output ---"

if [ $status -ne 0 ]; then
  echo "[FAIL] psql connection or query returned non-zero"
  exit 1
fi

if ! echo "$output" | grep -qi "PostgreSQL"; then
  echo "[FAIL] expected 'PostgreSQL' in version() output — did the session actually reach postgres-upstream?"
  exit 1
fi

# current_user is the second SELECT's result. The bound account user is "postgres".
# If gated had fallen back to inline, the upstream auth handshake would have
# failed with the empty inline password — but defend against an
# empty/whitespace value anyway, since an empty current_user would mean the
# inline path silently substituted.
if ! echo "$output" | grep -qx "postgres"; then
  echo "[FAIL] expected current_user='postgres' (bound account); not found in output"
  exit 1
fi

echo "[OK] Postgres probe passed — bound account 'postgres-root' (postgres:rootpass) authenticated upstream"
exit 0
