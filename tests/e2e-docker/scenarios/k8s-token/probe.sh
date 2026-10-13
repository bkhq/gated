#!/usr/bin/env sh
# sidecar-image: alpine:3.19
# Runs inside an alpine sidecar on the e2e docker network. `gated`
# resolves to the gated container; port 36443 is the HTTP-proxy (k8s)
# listener (HTTPS to clients, mTLS-capable, accepts Bearer tokens).
#
# Asserts the bound k8s-token account credential is what reaches the
# upstream — the Bun echo at k8s-upstream:8080 returns the received
# Authorization header in its JSON body. The unique sentinel
# `test-k8s-token-l3-8` is what was bound on the account; if the inline
# upstream_auth (None) had been used instead, no Authorization header
# would arrive at the upstream and the probe would fail.
set -u
apk add --no-cache curl jq > /dev/null 2>&1 || true

ADMIN="https://gated:8888/admin/api"
ADMIN_TOKEN="token-value"
ADMIN_CURL="curl -sfk -H X-Gated-Token:$ADMIN_TOKEN -H Content-Type:application/json"

echo "[probe-k8s-token] find alice user_id"
USERS=$($ADMIN_CURL "$ADMIN/users") || { echo "[FAIL] list users"; exit 1; }
ALICE_ID=$(echo "$USERS" | jq -r '.[] | select(.username=="alice") | .id')
[ "$ALICE_ID" = "null" ] && ALICE_ID=""
if [ -z "$ALICE_ID" ]; then
  echo "[FAIL] could not locate alice user_id"
  echo "$USERS"
  exit 1
fi
echo "  alice_id=$ALICE_ID"

echo "[probe-k8s-token] mint API token for alice (client -> gated bearer auth)"
TOKEN_RESP=$($ADMIN_CURL -X POST "$ADMIN/users/$ALICE_ID/api-tokens" -d '{
  "label":"k8s-token-l3-8 probe",
  "expiry":"2099-01-01T00:00:00Z"
}') || { echo "[FAIL] mint api-token"; exit 1; }
ALICE_TOKEN=$(echo "$TOKEN_RESP" | sed -n 's/.*"secret":"\([^"]*\)".*/\1/p')
if [ -z "$ALICE_TOKEN" ]; then
  echo "[FAIL] empty alice token; response=$TOKEN_RESP"
  exit 1
fi
echo "  alice_token=<len ${#ALICE_TOKEN}>"

echo "[probe-k8s-token] curl gated:36443 -> k8s-up -> k8s-upstream"
RESP=$(curl -sk \
  -H "Authorization: Bearer $ALICE_TOKEN" \
  -H "X-Gated-Target: k8s-up" \
  "https://gated:36443/api/v1/namespaces" 2>&1) || {
  echo "[FAIL] curl failed"
  echo "$RESP"
  exit 1
}
echo "--- upstream response ---"
echo "$RESP"
echo "--- /upstream response ---"

# The Bun echo returns {"authorization":"Bearer test-k8s-token-l3-8",...}.
# Grep for the unique sentinel — substring match (not just "Bearer") so a
# leaked alice token or stripped-but-not-injected case would fail.
if echo "$RESP" | grep -q "test-k8s-token-l3-8"; then
  echo "[OK] bound k8s-token reached upstream"
  exit 0
else
  echo "[FAIL] bound token sentinel 'test-k8s-token-l3-8' not in upstream echo"
  exit 1
fi
