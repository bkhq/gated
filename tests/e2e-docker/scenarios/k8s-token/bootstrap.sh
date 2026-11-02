#!/usr/bin/env sh
# Scenario: prove that an HTTP-flavor=kubernetes target with a bound
# k8s-token account injects the bound bearer token upstream (and that
# inline upstream_auth is ignored).
#
# Sourced from tests/e2e-docker/bootstrap.sh — inherits ADMIN, TOKEN,
# CURL, ROLE_ID, USER_ID (alice's id).
#
# The HTTP-proxy listener authenticates clients with Bearer token or
# mTLS; probe.sh mints its own API token for alice at run time (it can
# reach the admin API with X-Gated-Token: $GATED_ADMIN_TOKEN), so this
# bootstrap creates only the account, target, and role grant.
set -eu

echo "[k8s-token] step 1: create k8s-token account 'k8s-token-l3-8' (CORRECT bound creds)"
K8S_ACCOUNT=$($CURL -X POST "$ADMIN/accounts" -d '{
  "kind":"k8s-token",
  "name":"k8s-token-l3-8",
  "description":"k8s bearer token for e2e — proves account binding",
  "credentials":{"kind":"k8s-token","token":"test-k8s-token-l3-8"},
  "tags":["e2e"]
}')
K8S_ACCOUNT_ID=$(echo "$K8S_ACCOUNT" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
echo "  k8s_account_id=$K8S_ACCOUNT_ID"

echo "[k8s-token] step 2: create http/kubernetes target 'k8s-up' bound to k8s-token-l3-8"
# Inline upstream_auth is 'None' (no inline secret). The HTTP-proxy
# listener (port 36443) terminates TLS for clients and forwards plain
# HTTP to http://k8s-upstream:8080 (the Bun echo). If the bound account
# wins, the upstream sees Authorization: Bearer test-k8s-token-l3-8.
K8S_TARGET=$($CURL -X POST "$ADMIN/targets" -d "{
  \"name\":\"k8s-up\",
  \"description\":\"k8s upstream — proof of k8s-token account binding\",
  \"options\":{
    \"kind\":\"Http\",
    \"url\":\"http://k8s-upstream:8080\",
    \"tls\":{\"mode\":\"Preferred\",\"verify\":false},
    \"upstream_auth\":{\"kind\":\"None\"},
    \"flavor\":\"kubernetes\"
  },
  \"accounts\":[{\"account_id\":$K8S_ACCOUNT_ID,\"role\":\"primary\"}]
}")
K8S_TARGET_ID=$(echo "$K8S_TARGET" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
echo "  k8s_target_id=$K8S_TARGET_ID"

echo "[k8s-token] step 3: grant operators role access to k8s-up"
$CURL -X POST "$ADMIN/targets/$K8S_TARGET_ID/roles/$ROLE_ID" > /dev/null

echo ""
echo "[k8s-token] scenario bootstrap OK"
echo "  K8S BIND  alice -> gated:36443 (X-Gated-Target: k8s-up) -> k8s-upstream:8080"
echo "    inline upstream_auth: None (no token)"
echo "    bound account:        k8s-token test-k8s-token-l3-8  <- must win"
