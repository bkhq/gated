#!/usr/bin/env sh
# sidecar-image: alpine:3.19
# Runs inside an alpine sidecar on the e2e docker network. `gated`
# resolves to the gated container; port 36443 is the HTTP-proxy (k8s)
# listener (HTTPS to clients, accepts Bearer tokens).
#
# Asserts that the bound k8s-client-cert account is what reaches the
# upstream — the nginx upstream at k8s-cert-upstream:8443 requires
# mTLS, verifies the client cert against the baked CA, and echoes the
# client subject DN. The unique sentinel `e2e-client-l3-9` is the CN of
# the cert wired into the bound account; if inline upstream_auth=None
# had been used instead, the nginx mTLS handshake would have failed
# with "SSL alert: bad certificate" and the probe would fail.
set -u
apk add --no-cache curl jq > /dev/null 2>&1 || true

ADMIN="https://gated:8888/admin/api"
ADMIN_TOKEN="token-value"
ADMIN_CURL="curl -sfk -H X-Gated-Token:$ADMIN_TOKEN -H Content-Type:application/json"

echo "[probe-k8s-client-cert] find alice user_id"
USERS=$($ADMIN_CURL "$ADMIN/users") || { echo "[FAIL] list users"; exit 1; }
ALICE_ID=$(echo "$USERS" | jq -r '.[] | select(.username=="alice") | .id')
[ "$ALICE_ID" = "null" ] && ALICE_ID=""
if [ -z "$ALICE_ID" ]; then
  echo "[FAIL] could not locate alice user_id"
  echo "$USERS"
  exit 1
fi
echo "  alice_id=$ALICE_ID"

echo "[probe-k8s-client-cert] mint API token for alice (client -> gated bearer auth)"
TOKEN_RESP=$($ADMIN_CURL -X POST "$ADMIN/users/$ALICE_ID/api-tokens" -d '{
  "label":"k8s-client-cert-l3-9 probe",
  "expiry":"2099-01-01T00:00:00Z"
}') || { echo "[FAIL] mint api-token"; exit 1; }
ALICE_TOKEN=$(echo "$TOKEN_RESP" | sed -n 's/.*"secret":"\([^"]*\)".*/\1/p')
if [ -z "$ALICE_TOKEN" ]; then
  echo "[FAIL] empty alice token; response=$TOKEN_RESP"
  exit 1
fi
echo "  alice_token=<len ${#ALICE_TOKEN}>"

echo "[probe-k8s-client-cert] curl gated:36443 -> k8s-cert-up -> https://k8s-cert-upstream:8443"
RESP=$(curl -sk \
  -H "Authorization: Bearer $ALICE_TOKEN" \
  -H "X-Gated-Target: k8s-cert-up" \
  "https://gated:36443/" 2>&1) || {
  echo "[FAIL] curl failed"
  echo "$RESP"
  exit 1
}
echo "--- upstream response ---"
echo "$RESP"
echo "--- /upstream response ---"

# nginx with ssl_verify_client=on echoes "client_subject=CN=e2e-client-l3-9".
# Assert on the unique CN — not on "client_subject" alone, which would
# match any response containing that string.
if echo "$RESP" | grep -q "e2e-client-l3-9"; then
  echo "[OK] bound k8s-client-cert presented to upstream"
  exit 0
else
  echo "[FAIL] bound client cert CN 'e2e-client-l3-9' not in upstream echo"
  exit 1
fi
