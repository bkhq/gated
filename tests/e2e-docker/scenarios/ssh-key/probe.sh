#!/usr/bin/env sh
# sidecar-image: alpine:3.19
# Probe: alice -> gated:2222 (password) -> ssh-key-upstream (gated uses bound
# ssh-key account's ed25519 PEM). Asserts `whoami` == 'deploy', proving the
# bound ssh-key account's private key drove the upstream login and the empty
# inline credentials were ignored.
set -u
apk add --no-cache sshpass openssh-client > /dev/null 2>&1 || true

echo "[probe] SSH session through gated:2222 with bound ssh-key account (must land as 'deploy')"
output=$(sshpass -p alice123 ssh -p 2222 \
  -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  -o PreferredAuthentications=password -o PubkeyAuthentication=no \
  -o LogLevel=ERROR \
  "alice:ssh-key-up@gated" \
  'whoami; hostname; uname -a' 2>&1)
status=$?
echo "exit=$status"
echo "--- output ---"
echo "$output"
echo "--- /output ---"
if [ $status -eq 0 ] && echo "$output" | grep -q "^deploy$"; then
  echo "[OK] ssh-key probe passed — bound account 'ssh-deploy-key' authenticated upstream as deploy"
  exit 0
else
  echo "[FAIL] ssh-key probe failed — expected whoami=deploy"
  exit 1
fi
