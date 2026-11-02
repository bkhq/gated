#!/usr/bin/env bash
# sidecar-image: gated-e2e-mysql-upstream
# Runs inside a mariadb-client sidecar on the e2e docker network (mariadb image
# is reused for its `mysql` client binary; entrypoint is overridden).
set -u
echo "[probe] MySQL session through gated:33306 (account binding must win over WRONG inline)"
output=$(mysql -h gated -P 33306 \
  -u 'alice:mysql-up' --password=alice123 \
  --connect-timeout=10 --ssl --ssl-verify-server-cert=FALSE \
  -e 'SELECT @@hostname AS upstream_host, CURRENT_USER() AS upstream_user, VERSION() AS version;' 2>&1)
status=$?
echo "exit=$status"
echo "--- output ---"
echo "$output"
echo "--- /output ---"
if [ $status -eq 0 ] && echo "$output" | grep -q "MariaDB\|MySQL"; then
  echo "[OK] MySQL probe passed — bound account 'mysql-root' (root:rootpass) authenticated upstream"
  exit 0
else
  echo "[FAIL] MySQL probe failed"
  exit 1
fi
