#!/usr/bin/env sh
# Scenario bootstrap: http-headers account binding.
#
# Sourced by tests/e2e-docker/bootstrap.sh — inherits ADMIN, TOKEN, CURL,
# ROLE_ID, USER_ID. Creates:
#   - http-headers account with a unique Bearer token in its headers
#   - HTTP target "http-up" bound to that account (inline upstream_auth=None)
#   - operators role grant on the target
#
# Inline upstream_auth is the empty `None` variant — `has_inline_credentials`
# treats it as no inline secret, so the bound account is what reaches the
# upstream. If account binding silently failed, the upstream would see no
# Authorization header at all (and the probe would not find the unique token).
set -eu

echo "[http-headers] create http-headers account 'http-up-headers'"
HTTP_ACCOUNT=$($CURL -X POST "$ADMIN/accounts" -d '{
  "kind":"http-headers",
  "name":"http-up-headers",
  "description":"injected headers for e2e http target",
  "credentials":{
    "kind":"http-headers",
    "headers":[
      {"name":"Authorization","value":"Bearer test-token-l3-7","sensitive":true},
      {"name":"X-Gated-E2E","value":"l3-7","sensitive":false}
    ]
  },
  "tags":["e2e"]
}')
HTTP_ACCOUNT_ID=$(echo "$HTTP_ACCOUNT" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
echo "  http_account_id=$HTTP_ACCOUNT_ID"

echo "[http-headers] create http target 'http-up' bound to http-up-headers (inline None)"
HTTP_TARGET=$($CURL -X POST "$ADMIN/targets" -d "{
  \"name\":\"http-up\",
  \"description\":\"http upstream — proof of http-headers account binding\",
  \"options\":{
    \"kind\":\"Http\",
    \"url\":\"http://http-upstream:8080\",
    \"tls\":{\"mode\":\"Disabled\",\"verify\":false},
    \"upstream_auth\":{\"kind\":\"None\"},
    \"flavor\":\"generic\"
  },
  \"accounts\":[{\"account_id\":$HTTP_ACCOUNT_ID,\"role\":\"primary\"}]
}")
HTTP_TARGET_ID=$(echo "$HTTP_TARGET" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
echo "  http_target_id=$HTTP_TARGET_ID"

echo "[http-headers] grant operators role access to http-up"
$CURL -X POST "$ADMIN/targets/$HTTP_TARGET_ID/roles/$ROLE_ID" > /dev/null

echo "[http-headers] bootstrap OK"
echo "  HTTP BINDING alice -> https://gated:36443/anything (X-Gated-Target: http-up)"
echo "    inline says: upstream_auth={kind:None}"
echo "    bound account: headers include Authorization=Bearer test-token-l3-7  <- must win"
