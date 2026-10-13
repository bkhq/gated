#!/usr/bin/env sh
# Bootstrap a gated e2e scenario from inside a sidecar curl container.
# Inline target credentials are DELIBERATELY WRONG so the test proves the
# bound account credentials are what reaches the upstream.
set -eu

ADMIN="${GATED_ADMIN_URL:-https://gated:8888/admin/api}"
TOKEN="${GATED_ADMIN_TOKEN:-token-value}"
# curl args: -k skip TLS verify (self-signed cert), -s silent, -f fail on http error
CURL="curl -sfk -H X-Gated-Token:$TOKEN -H Content-Type:application/json"

echo "[wait] admin api ready..."
i=0
while [ $i -lt 60 ]; do
  if $CURL -o /dev/null "$ADMIN/users" 2>/dev/null; then
    echo "[wait] ready"
    break
  fi
  i=$((i+1))
  sleep 1
done

echo "[step 1] create role 'operators'"
ROLE=$($CURL -X POST "$ADMIN/roles" -d '{"name":"operators"}')
ROLE_ID=$(echo "$ROLE" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
echo "  role_id=$ROLE_ID"

echo "[step 2] create user 'alice'"
USER_RESP=$($CURL -X POST "$ADMIN/users" -d '{"username":"alice"}')
USER_ID=$(echo "$USER_RESP" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
echo "  user_id=$USER_ID"

echo "[step 3] set alice password 'alice123' (for client -> gated auth)"
$CURL -X POST "$ADMIN/users/$USER_ID/credentials/passwords" -d '{"password":"alice123"}' > /dev/null

echo "[step 4] grant alice the operators role"
$CURL -X POST "$ADMIN/users/$USER_ID/roles/$ROLE_ID" > /dev/null

echo "[step 5] create ssh-password account 'ssh-root' (CORRECT upstream creds)"
SSH_ACCOUNT=$($CURL -X POST "$ADMIN/accounts" -d '{
  "kind":"ssh-password",
  "name":"ssh-root",
  "description":"root password for e2e ssh upstream",
  "credentials":{"kind":"ssh-password","username":"root","password":"rootpass"},
  "tags":["e2e"]
}')
# accounts.id is an integer
SSH_ACCOUNT_ID=$(echo "$SSH_ACCOUNT" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
echo "  ssh_account_id=$SSH_ACCOUNT_ID"

echo "[step 6] create ssh target bound to ssh-root account (inline secret EMPTY per backend rule)"
# Backend rejects 422 if both accounts[] and inline-secret are present; the
# rule is enforced via has_inline_credentials() which checks ONLY secret
# fields. So inline username stays as a non-matching sentinel ('WRONG'),
# while inline auth.password is empty. If gated ever defaults to inline,
# the connection would attempt empty-password auth against 'WRONG' user
# and fail — so a successful upstream connection proves account binding
# is what reached the upstream.
SSH_TARGET=$($CURL -X POST "$ADMIN/targets" -d "{
  \"name\":\"ssh-up\",
  \"description\":\"ssh upstream — proof of account binding\",
  \"options\":{
    \"kind\":\"Ssh\",
    \"host\":\"ssh-upstream\",
    \"port\":22,
    \"allow_insecure_algos\":false,
    \"username\":\"WRONG-INLINE-USER\",
    \"auth\":{\"kind\":\"Password\",\"password\":\"\"}
  },
  \"accounts\":[{\"account_id\":$SSH_ACCOUNT_ID,\"role\":\"primary\"}]
}")
SSH_TARGET_ID=$(echo "$SSH_TARGET" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
echo "  ssh_target_id=$SSH_TARGET_ID"

echo "[step 7] grant operators role access to ssh-up"
$CURL -X POST "$ADMIN/targets/$SSH_TARGET_ID/roles/$ROLE_ID" > /dev/null

echo "[step 8] create db-password account 'mysql-root' (CORRECT upstream creds)"
DB_ACCOUNT=$($CURL -X POST "$ADMIN/accounts" -d '{
  "kind":"db-password",
  "name":"mysql-root",
  "description":"root mysql credentials for e2e",
  "credentials":{"kind":"db-password","engine":"mysql","username":"root","password":"rootpass"},
  "tags":["e2e"]
}')
DB_ACCOUNT_ID=$(echo "$DB_ACCOUNT" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
echo "  db_account_id=$DB_ACCOUNT_ID"

echo "[step 9] create mysql target bound to mysql-root account (inline secret EMPTY per backend rule)"
MYSQL_TARGET=$($CURL -X POST "$ADMIN/targets" -d "{
  \"name\":\"mysql-up\",
  \"description\":\"mysql upstream — proof of account binding\",
  \"options\":{
    \"kind\":\"MySql\",
    \"host\":\"mysql-upstream\",
    \"port\":3306,
    \"username\":\"WRONG-INLINE-USER\",
    \"password\":\"\",
    \"tls\":{\"mode\":\"Preferred\",\"verify\":false},
    \"readonly\":false
  },
  \"accounts\":[{\"account_id\":$DB_ACCOUNT_ID,\"role\":\"primary\"}]
}")
MYSQL_TARGET_ID=$(echo "$MYSQL_TARGET" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
echo "  mysql_target_id=$MYSQL_TARGET_ID"

echo "[step 10] grant operators role access to mysql-up"
$CURL -X POST "$ADMIN/targets/$MYSQL_TARGET_ID/roles/$ROLE_ID" > /dev/null

echo ""
echo "[summary] bootstrap OK (baseline)"
echo "  USER         alice / alice123 (gated client-side login)"
echo "  ROLE         operators"
echo "  SSH BINDING  alice:ssh-up@gated:2222 -> ssh-upstream:22"
echo "    inline says: username=WRONG-INLINE-USER password=WRONG-INLINE-PASSWORD"
echo "    bound account: username=root password=rootpass  <- must win"
echo "  MYSQL BIND   alice:mysql-up@gated:33306 -> mysql-upstream:3306"
echo "    inline says: username=WRONG-INLINE-USER password=WRONG-INLINE-PASSWORD"
echo "    bound account: engine=mysql username=root password=rootpass  <- must win"

# Dispatcher: source any scenarios/<name>/bootstrap.sh.
# Each scenario runs in its own subshell — it inherits ROLE_ID, USER_ID, ADMIN,
# TOKEN, and CURL from the parent but cannot mutate them or interfere with
# sibling scenarios. Scenarios must exit non-zero to signal failure; the
# dispatcher then fails the whole bootstrap.
SCENARIOS_DIR="$(dirname "$0")/scenarios"
if [ -d "$SCENARIOS_DIR" ]; then
  for f in $(ls "$SCENARIOS_DIR"/*/bootstrap.sh 2>/dev/null | sort); do
    echo ""
    echo "[scenario-bootstrap] $f"
    if ! ( . "$f" ); then
      echo "[scenario-bootstrap-FAIL] $f"
      exit 1
    fi
  done
fi
