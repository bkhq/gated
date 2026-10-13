#!/usr/bin/env sh
# sidecar-image: alpine:3.19
# Runs inside an alpine sidecar on the e2e docker network.
# `gated` resolves to the gated container; port 2222 is the SSH proxy.
set -u
apk add --no-cache sshpass openssh-client > /dev/null 2>&1 || true

echo "[probe] SSH session through gated:2222 (account binding must win over WRONG inline)"
output=$(sshpass -p alice123 ssh -p 2222 \
  -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  -o PreferredAuthentications=password -o PubkeyAuthentication=no \
  -o LogLevel=ERROR \
  "alice:ssh-up@gated" \
  'whoami; hostname; uname -a' 2>&1)
status=$?
echo "exit=$status"
echo "--- output ---"
echo "$output"
echo "--- /output ---"
if [ $status -eq 0 ] && echo "$output" | grep -q "^root"; then
  echo "[OK] SSH probe passed — bound account 'ssh-root' (root:rootpass) authenticated upstream"
  exit 0
else
  echo "[FAIL] SSH probe failed"
  exit 1
fi
