#!/usr/bin/env bash
# §7 Q2, step 2 of 4 (UI → curl → psql → disable trigger): "an approved claim is read-only".
# Logs in as Asha with curl and tries to change C04 (EXP-2026-000004, APPROVED on 2026-09-15)
# through the public API: the PUT, and every other owner mutation, must come back 409 CLAIM_LOCKED
# and change nothing. Exits 0 only when every expected code was seen.
#
#   docker compose up --build --wait     # the seeded local stack
#   scripts/demo/edit-approved.sh
#
# Reads SEED_DEMO_PASSWORD and APP_BASE_URL from the environment, else from .env (dotenv rules:
# quotes and inline comments are handled). Overrides: DEMO_BASE_URL, DEMO_EMAIL, DEMO_CLAIM_NUMBER.
# Needs curl and jq.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
ENV_FILE=${ENV_FILE:-$ROOT/.env}

# env_get KEY [default]: the process environment wins, else the last `KEY=` line of .env.
env_get() {
  local key=$1 def=${2-} line val
  if [ -n "${!key+x}" ]; then
    printf '%s' "${!key}"
    return
  fi
  line=$(grep -E "^[[:space:]]*(export[[:space:]]+)?${key}[[:space:]]*=" "$ENV_FILE" 2>/dev/null |
    tail -n 1 | tr -d '\r') || true
  if [ -z "$line" ]; then
    printf '%s' "$def"
    return
  fi
  val=${line#*=}
  val=${val#"${val%%[![:space:]]*}"} # leading blanks
  case $val in
    \"*) val=${val#\"} && val=${val%%\"*} ;;
    \'*) val=${val#\'} && val=${val%%\'*} ;;
    *) val=$(printf '%s' "$val" | sed -E 's/[[:space:]]+#.*$//; s/[[:space:]]+$//') ;;
  esac
  printf '%s' "$val"
}

die() {
  echo "error: $*" >&2
  exit 2
}

for tool in curl jq; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is required"
done

BASE_URL=${DEMO_BASE_URL:-$(env_get APP_BASE_URL http://localhost:3000)}
BASE_URL=${BASE_URL%/}
EMAIL=${DEMO_EMAIL:-asha.rao@acme.test}
CLAIM_NUMBER=${DEMO_CLAIM_NUMBER:-EXP-2026-000004}
PASSWORD=$(env_get SEED_DEMO_PASSWORD)
[ -n "$PASSWORD" ] || die "SEED_DEMO_PASSWORD is not set (environment or $ENV_FILE)"

WORK=$(mktemp -d)
JAR=$WORK/cookies
trap 'rm -rf "$WORK"' EXIT

# call METHOD PATH [JSON-BODY]: prints the HTTP status; the body lands in $WORK/body and the
# response headers in $WORK/headers. A body travels on stdin, never in argv.
call() {
  local method=$1 path=$2 body=${3-}
  local args=(-sS -o "$WORK/body" -D "$WORK/headers" -w '%{http_code}' -b "$JAR" -c "$JAR"
    -X "$method" -H 'Accept: application/json')
  if [ -n "$body" ]; then
    printf '%s' "$body" |
      curl "${args[@]}" -H 'Content-Type: application/json' --data-binary @- "$BASE_URL$path"
  else
    curl "${args[@]}" "$BASE_URL$path"
  fi
}
request_id() { grep -i '^x-request-id:' "$WORK/headers" | head -n 1 | cut -d' ' -f2 | tr -d '\r'; }
error_code() { jq -r '.error.code // empty' "$WORK/body" 2>/dev/null || true; }

echo "==> Stack: $BASE_URL"
status=$(call GET /api/health/ready) || die "cannot reach $BASE_URL (run: docker compose up --build --wait)"
[ "$status" = 200 ] || die "GET /api/health/ready returned $status"

echo "==> Log in as $EMAIL"
login=$(jq -nc --arg e "$EMAIL" --arg p "$PASSWORD" '{email: $e, password: $p}')
status=$(call POST /api/v1/auth/login "$login")
[ "$status" = 200 ] || die "login returned $status $(error_code)"

echo "==> Find $CLAIM_NUMBER among my APPROVED claims"
status=$(call GET '/api/v1/claims?status=APPROVED&limit=100')
[ "$status" = 200 ] || die "GET /api/v1/claims returned $status $(error_code)"
CLAIM_ID=$(jq -r --arg n "$CLAIM_NUMBER" '.data[] | select(.claimNumber == $n) | .id' \
  "$WORK/body") || CLAIM_ID=
[ -n "$CLAIM_ID" ] || die "$CLAIM_NUMBER is not an APPROVED claim of $EMAIL (fresh seed: docker compose down -v && docker compose up --build --wait)"

status=$(call GET "/api/v1/claims/$CLAIM_ID")
[ "$status" = 200 ] || die "GET claim returned $status"
cp "$WORK/body" "$WORK/before"
jq -r '.data | "    \(.claimNumber)  \(.title)  status=\(.status)  total=\(.totalMinor) paise  approvedAt=\(.approvedAt)\n    allowedActions=\(.allowedActions | tostring)  (no EDIT: the UI shows no edit buttons)"' \
  "$WORK/before"

# The edit a claimant might try after approval: the first line goes up by ₹1,000.
edit=$(jq -c '.data | {
  title,
  lineItems: ([.lineItems[] | {id, expenseDate, categoryId: .category.id, amountMinor, description}
               + (if .merchant then {merchant} else {} end)]
              | .[0].amountMinor += 100000)
}' "$WORK/before")

failures=0
# expect LABEL METHOD PATH [BODY]: the route must answer 409 CLAIM_LOCKED.
expect_locked() {
  local label=$1 method=$2 path=$3 body=${4-} code
  status=$(call "$method" "$path" "$body") || status=000
  code=$(error_code)
  if [ "$status" = 409 ] && [ "$code" = CLAIM_LOCKED ]; then
    printf '    PASS  %-34s → %s %s  (x-request-id %s)\n' "$label" "$status" "$code" "$(request_id)"
  else
    printf '    FAIL  %-34s → %s %s  (expected 409 CLAIM_LOCKED)\n' "$label" "$status" "${code:-}"
    failures=$((failures + 1))
  fi
}

echo "==> PUT /api/v1/claims/$CLAIM_ID  (first line +₹1,000)"
expect_locked 'PUT  (edit lines)' PUT "/api/v1/claims/$CLAIM_ID" "$edit"
jq '.' "$WORK/body" | sed 's/^/    /'

echo "==> The other owner mutations on the same claim"
expect_locked 'POST /submit' POST "/api/v1/claims/$CLAIM_ID/submit" '{}'
expect_locked 'POST /recall' POST "/api/v1/claims/$CLAIM_ID/recall" '{}'
expect_locked 'DELETE' DELETE "/api/v1/claims/$CLAIM_ID"

echo "==> Nothing changed"
status=$(call GET "/api/v1/claims/$CLAIM_ID") || status=000
if [ "$status" = 200 ] && [ "$(jq -c '.data' "$WORK/body")" = "$(jq -c '.data' "$WORK/before")" ]; then
  echo "    PASS  the claim reads back identical (status, total, lines, approval)"
else
  echo "    FAIL  the claim changed or could not be read back ($status)"
  failures=$((failures + 1))
fi

call POST /api/v1/auth/logout >/dev/null || true

if [ "$failures" -gt 0 ]; then
  echo "==> $failures check(s) failed" >&2
  exit 1
fi
echo "==> OK: the API refuses every edit of an APPROVED claim with 409 CLAIM_LOCKED"
