#!/usr/bin/env sh
# Scenario: prove that an HTTP-flavor=kubernetes target with a bound
# k8s-client-cert account presents the account's client certificate to
# the upstream (and that inline upstream_auth=None is ignored, i.e. the
# binding wins).
#
# Sourced from tests/e2e-docker/bootstrap.sh — inherits ADMIN, TOKEN,
# CURL, ROLE_ID. The fixture PEMs live next to this script and are
# baked into the JSON account credentials at run time.
set -eu

SCEN_DIR="${SCENARIOS_DIR}/k8s-client-cert"

# Convert a PEM file to a JSON-string-safe payload: literal newlines
# become the two-character escape sequence \n. busybox awk in the curl
# sidecar supports this.
pem_to_json() {
  awk 'BEGIN{ORS="\\n"} {print}' "$1"
}

CLIENT_CERT_PEM=$(pem_to_json "$SCEN_DIR/client.crt")
CLIENT_KEY_PEM=$(pem_to_json "$SCEN_DIR/client.key")

echo "[k8s-client-cert] step 1: create k8s-client-cert account 'k8s-client-cert-l3-9'"
K8S_CC_ACCOUNT=$($CURL -X POST "$ADMIN/accounts" -d "{
  \"kind\":\"k8s-client-cert\",
  \"name\":\"k8s-client-cert-l3-9\",
  \"description\":\"k8s client cert for e2e — proves account binding\",
  \"credentials\":{
    \"kind\":\"k8s-client-cert\",
    \"client_certificate_pem\":\"$CLIENT_CERT_PEM\",
    \"client_private_key_pem\":\"$CLIENT_KEY_PEM\"
  },
  \"tags\":[\"e2e\"]
}")
K8S_CC_ACCOUNT_ID=$(echo "$K8S_CC_ACCOUNT" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
echo "  k8s_client_cert_account_id=$K8S_CC_ACCOUNT_ID"

echo "[k8s-client-cert] step 2: create http/kubernetes target 'k8s-cert-up' bound to k8s-client-cert-l3-9"
# Inline upstream_auth is 'None' (no inline cert). The HTTP-proxy
# listener (port 36443) terminates TLS for clients and forwards to
# https://k8s-cert-upstream:8443 which requires mTLS. If the bound
# account wins, gated presents the e2e-client-l3-9 client cert to the
# upstream; nginx then echoes the client subject DN.
# tls.verify=false because the upstream cert is self-signed by the
# test CA — KISS, since this scenario is about *client* cert auth, not
# server cert trust.
K8S_CC_TARGET=$($CURL -X POST "$ADMIN/targets" -d "{
  \"name\":\"k8s-cert-up\",
  \"description\":\"k8s mTLS upstream — proof of k8s-client-cert account binding\",
  \"options\":{
    \"kind\":\"Http\",
    \"url\":\"https://k8s-cert-upstream:8443\",
    \"tls\":{\"mode\":\"Required\",\"verify\":false},
    \"upstream_auth\":{\"kind\":\"None\"},
    \"flavor\":\"kubernetes\"
  },
  \"accounts\":[{\"account_id\":$K8S_CC_ACCOUNT_ID,\"role\":\"primary\"}]
}")
K8S_CC_TARGET_ID=$(echo "$K8S_CC_TARGET" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
echo "  k8s_client_cert_target_id=$K8S_CC_TARGET_ID"

echo "[k8s-client-cert] step 3: grant operators role access to k8s-cert-up"
$CURL -X POST "$ADMIN/targets/$K8S_CC_TARGET_ID/roles/$ROLE_ID" > /dev/null

echo ""
echo "[k8s-client-cert] scenario bootstrap OK"
echo "  K8S CERT BIND  alice -> gated:36443 (X-Gated-Target: k8s-cert-up) -> https://k8s-cert-upstream:8443"
echo "    inline upstream_auth: None (no cert)"
echo "    bound account:        k8s-client-cert CN=e2e-client-l3-9  <- must win"
