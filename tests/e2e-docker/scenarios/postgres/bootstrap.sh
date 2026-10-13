#!/usr/bin/env sh
# Scenario: postgres
# Adds a db-password (engine=postgres) account and a postgres target bound to
# it. Inline secret is empty + WRONG username — backend rejects 422 if both
# inline secret and accounts[] are present, but the has_inline_credentials()
# rule checks ONLY secret fields, so a non-matching inline username is fine.
# If gated ever defaulted to inline, the connection would try empty-password
# auth as "WRONG-INLINE-USER" and fail. A successful upstream session
# therefore proves the bound account credentials reached the upstream.
#
# Sourced by tests/e2e-docker/bootstrap.sh (subshell). Inherits ROLE_ID,
# USER_ID, ADMIN, TOKEN, CURL from the parent.
set -eu

echo "[postgres step 1] create db-password account 'postgres-root' (engine=postgres)"
PG_ACCOUNT=$($CURL -X POST "$ADMIN/accounts" -d '{
  "kind":"db-password",
  "name":"postgres-root",
  "description":"root postgres credentials for e2e",
  "credentials":{"kind":"db-password","engine":"postgres","username":"postgres","password":"rootpass"},
  "tags":["e2e"]
}')
PG_ACCOUNT_ID=$(echo "$PG_ACCOUNT" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
echo "  pg_account_id=$PG_ACCOUNT_ID"

echo "[postgres step 2] create postgres target bound to postgres-root (inline secret EMPTY)"
PG_TARGET=$($CURL -X POST "$ADMIN/targets" -d "{
  \"name\":\"postgres-up\",
  \"description\":\"postgres upstream — proof of account binding\",
  \"options\":{
    \"kind\":\"Postgres\",
    \"host\":\"postgres-upstream\",
    \"port\":5432,
    \"username\":\"WRONG-INLINE-USER\",
    \"password\":\"\",
    \"tls\":{\"mode\":\"Preferred\",\"verify\":false},
    \"readonly\":false
  },
  \"accounts\":[{\"account_id\":$PG_ACCOUNT_ID,\"role\":\"primary\"}]
}")
PG_TARGET_ID=$(echo "$PG_TARGET" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
echo "  pg_target_id=$PG_TARGET_ID"

echo "[postgres step 3] grant operators role access to postgres-up"
$CURL -X POST "$ADMIN/targets/$PG_TARGET_ID/roles/$ROLE_ID" > /dev/null

echo ""
echo "[postgres summary] bootstrap OK"
echo "  PG BIND  alice:postgres-up@gated:35432 -> postgres-upstream:5432"
echo "    inline says: username=WRONG-INLINE-USER password=<empty>"
echo "    bound account: engine=postgres username=postgres password=rootpass  <- must win"
