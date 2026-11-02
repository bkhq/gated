#!/usr/bin/env sh
# Scenario: ssh-key
# Sourced (in a subshell) by tests/e2e-docker/bootstrap.sh.
# Inherits ADMIN, TOKEN, CURL, ROLE_ID, USER_ID from the parent.
#
# Creates an ssh-key account holding the baked test ed25519 PEM, then
# creates target ssh-key-up bound to it with EMPTY inline credentials.
# If gated ever defaulted to inline creds, the connection would fail
# (no inline password, wrong inline username) — so a successful upstream
# SSH session proves the bound account's key reached the upstream.
set -eu

PEM_PATH="/tests/scenarios/ssh-key/upstream/id_e2e"
if [ ! -f "$PEM_PATH" ]; then
  echo "[ssh-key bootstrap FAIL] missing private key fixture: $PEM_PATH"
  exit 1
fi

# JSON-escape the PEM: literal newlines become \n, no quotes/backslashes
# expected in an OpenSSH PEM beyond what awk handles here.
PEM_JSON=$(awk 'BEGIN{ORS=""} {gsub(/\\/,"\\\\"); gsub(/"/,"\\\""); print $0 "\\n"}' "$PEM_PATH")

echo "[ssh-key 1] create ssh-key account 'ssh-deploy-key'"
SSH_KEY_ACCOUNT=$($CURL -X POST "$ADMIN/accounts" -d "{
  \"kind\":\"ssh-key\",
  \"name\":\"ssh-deploy-key\",
  \"description\":\"ed25519 private key for deploy user on ssh-key-upstream\",
  \"credentials\":{\"kind\":\"ssh-key\",\"username\":\"deploy\",\"private_key_pem\":\"$PEM_JSON\"},
  \"tags\":[\"e2e\"]
}")
SSH_KEY_ACCOUNT_ID=$(echo "$SSH_KEY_ACCOUNT" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
if [ -z "$SSH_KEY_ACCOUNT_ID" ]; then
  echo "[ssh-key bootstrap FAIL] could not parse account id from: $SSH_KEY_ACCOUNT"
  exit 1
fi
echo "  ssh_key_account_id=$SSH_KEY_ACCOUNT_ID"

echo "[ssh-key 2] create target 'ssh-key-up' bound to ssh-deploy-key (inline secret EMPTY)"
SSH_KEY_TARGET=$($CURL -X POST "$ADMIN/targets" -d "{
  \"name\":\"ssh-key-up\",
  \"description\":\"ssh upstream — proof of ssh-key account binding\",
  \"options\":{
    \"kind\":\"Ssh\",
    \"host\":\"ssh-key-upstream\",
    \"port\":22,
    \"allow_insecure_algos\":false,
    \"username\":\"WRONG-INLINE-USER\",
    \"auth\":{\"kind\":\"Password\",\"password\":\"\"}
  },
  \"accounts\":[{\"account_id\":$SSH_KEY_ACCOUNT_ID,\"role\":\"primary\"}]
}")
SSH_KEY_TARGET_ID=$(echo "$SSH_KEY_TARGET" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
if [ -z "$SSH_KEY_TARGET_ID" ]; then
  echo "[ssh-key bootstrap FAIL] could not parse target id from: $SSH_KEY_TARGET"
  exit 1
fi
echo "  ssh_key_target_id=$SSH_KEY_TARGET_ID"

echo "[ssh-key 3] grant operators role access to ssh-key-up"
$CURL -X POST "$ADMIN/targets/$SSH_KEY_TARGET_ID/roles/$ROLE_ID" > /dev/null

echo "[ssh-key summary]"
echo "  alice:ssh-key-up@gated:2222 -> ssh-key-upstream:22"
echo "    inline says: username=WRONG-INLINE-USER password=<empty>"
echo "    bound account: kind=ssh-key username=deploy private_key=<baked ed25519>  <- must win"
