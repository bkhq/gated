#!/usr/bin/env sh
# sidecar-image: alpine:3.19
# Probe: prove the bound http-headers account's headers reach the upstream.
#
# Steps:
#   1. Look up alice's user_id via admin token.
#   2. Mint an api-token for alice (Bearer auth for the HTTP proxy listener).
#   3. GET https://gated:36443/anything with X-Gated-Target: http-up.
#   4. Parse the upstream echo; assert it contains the unique test token
#      'test-token-l3-7' under the Authorization header.
#
# The test discriminates bound-vs-inline because:
#   - the target's inline upstream_auth is {kind:"None"} (no injection)
#   - the client's own Authorization header (the api-token) is stripped by
#     gated's engine before reaching upstream (injected names take precedence)
#   - therefore the only way 'test-token-l3-7' appears in the upstream echo
#     is if gated injected it from the bound http-headers account.
set -u

apk add --no-cache curl jq > /dev/null 2>&1 || true

ADMIN="https://gated:8888/admin/api"
ADMIN_TOKEN="token-value"
H_ADMIN="X-Gated-Token: $ADMIN_TOKEN"
H_JSON="Content-Type: application/json"
EXPECTED_TOKEN="test-token-l3-7"

echo "[probe] lookup alice user_id"
USERS=$(curl -sfk -H "$H_ADMIN" "$ADMIN/users") || {
  echo "[FAIL] could not list users"; exit 1;
}
USER_ID=$(echo "$USERS" | jq -r '.[] | select(.username=="alice") | .id')
if [ -z "$USER_ID" ] || [ "$USER_ID" = "null" ]; then
  echo "[FAIL] alice not found"; echo "$USERS"; exit 1
fi
echo "  user_id=$USER_ID"

echo "[probe] mint api-token for alice"
TOKEN_RESP=$(curl -sfk -H "$H_ADMIN" -H "$H_JSON" \
  -X POST "$ADMIN/users/$USER_ID/api-tokens" \
  -d '{"label":"l3-7-http-headers-probe","expiry":"2099-12-31T23:59:59Z"}') || {
  echo "[FAIL] mint api-token failed"; exit 1;
}
API_TOKEN=$(echo "$TOKEN_RESP" | jq -r '.secret')
if [ -z "$API_TOKEN" ] || [ "$API_TOKEN" = "null" ]; then
  echo "[FAIL] api-token secret missing"; echo "$TOKEN_RESP"; exit 1
fi
echo "  api-token minted (length=${#API_TOKEN})"

echo "[probe] GET https://gated:36443/anything via http-up (account binding must win)"
ECHO_RESP=$(curl -sfk \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "X-Gated-Target: http-up" \
  "https://gated:36443/anything")
status=$?
echo "exit=$status"
echo "--- upstream echo ---"
echo "$ECHO_RESP"
echo "--- /upstream echo ---"

if [ $status -ne 0 ]; then
  echo "[FAIL] http proxy request failed"
  exit 1
fi

UPSTREAM_AUTH=$(echo "$ECHO_RESP" | jq -r '.headers.authorization // .headers.Authorization // empty')
echo "[probe] upstream saw Authorization='$UPSTREAM_AUTH'"

if [ "$UPSTREAM_AUTH" = "Bearer $EXPECTED_TOKEN" ]; then
  echo "[OK] http-headers probe passed — bound account injected '$EXPECTED_TOKEN'"
  exit 0
else
  echo "[FAIL] expected Authorization 'Bearer $EXPECTED_TOKEN', got '$UPSTREAM_AUTH'"
  exit 1
fi
