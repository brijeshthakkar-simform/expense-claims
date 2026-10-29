#!/usr/bin/env bash
# §7 Q2, steps 3–4 of 4 (UI → curl → psql → disable trigger): "the database itself refuses".
# Connects with psql AS expense_app (the runtime role the app uses; DML grants only, owns nothing)
# inside the compose postgres container and tries what a compromised app or a raw SQL user would:
#   1. UC001: edit a line of the APPROVED claim C04 (EXP-2026-000004)
#   2. UC001: delete C04's receipt (the seeded conference-pass invoice: evidence, not a draft file)
#   3. UC003: write claims.total_minor directly on the DRAFT C01 (the total is derived, never set)
#   4. 42501: ALTER TABLE claims DISABLE TRIGGER claims_10_guard (not the owner)
#   5. 42501: SET session_replication_role = replica (would silence every trigger)
# Each attempt runs in BEGIN … ROLLBACK, so even an unexpected success would change nothing.
# Then it shows the totals still agree with the lines (v_claim_total_drift is empty) and the
# receipt is still there.
# Exits 0 only when every expected SQLSTATE was seen.
#
#   docker compose up --build --wait     # the seeded local stack
#   scripts/demo/sql-attacks.sh
#
# Reads DB_APP_PASSWORD and POSTGRES_DB from the environment, else from .env (dotenv rules: quotes
# and inline comments are handled). Overrides: DEMO_APPROVED_CLAIM, DEMO_DRAFT_CLAIM. Needs docker.
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

command -v docker >/dev/null 2>&1 || die 'docker is required'

DB=$(env_get POSTGRES_DB expense_claims)
APP_PASSWORD=$(env_get DB_APP_PASSWORD)
[ -n "$APP_PASSWORD" ] || die "DB_APP_PASSWORD is not set (environment or $ENV_FILE)"
APPROVED=${DEMO_APPROVED_CLAIM:-EXP-2026-000004}
DRAFT=${DEMO_DRAFT_CLAIM:-EXP-2026-000001}
for n in "$APPROVED" "$DRAFT"; do
  [[ $n =~ ^EXP-[0-9]{4}-[0-9]{6}$ ]] || die "not a claim number: $n"
done

# psql as expense_app inside the postgres container, over the compose network (host `postgres`,
# the address the app itself uses): pg_hba trusts loopback, but this path is scram-sha-256, so the
# password is really checked. It reaches the container through the environment (-e NAME), never
# through argv.
psql_app() {
  PGPASSWORD=$APP_PASSWORD docker compose -f "$ROOT/compose.yaml" exec -T -e PGPASSWORD postgres \
    psql -X -q -h postgres -U expense_app -d "$DB" "$@"
}

echo "==> Connect as expense_app to $DB"
facts=$(psql_app -At -F '|' -v ON_ERROR_STOP=1 -c "
  SELECT current_user, c.claim_number, c.status, c.total_minor
    FROM public.claims c
   WHERE c.claim_number IN ('$APPROVED', '$DRAFT')
   ORDER BY c.claim_number" 2>&1) ||
  die "psql failed (is the stack up? docker compose up --build --wait): $facts"
printf '%s\n' "$facts" | awk -F'|' '{ printf "    as %s: %s %-9s total=%s paise\n", $1, $2, $3, $4 }'
role=$(printf '%s\n' "$facts" | head -n 1 | cut -d'|' -f1)
[ "$role" = expense_app ] || die "connected as '$role', expected expense_app"
approved_total=$(printf '%s\n' "$facts" | awk -F'|' -v n="$APPROVED" '$2 == n && $3 == "APPROVED" { print $4 }')
[ -n "$approved_total" ] || die "$APPROVED is not APPROVED (fresh seed: docker compose down -v && docker compose up --build --wait)"
draft_status=$(printf '%s\n' "$facts" | awk -F'|' -v n="$DRAFT" '$2 == n { print $3 }')
[ -n "$draft_status" ] && [ "$draft_status" != APPROVED ] ||
  die "$DRAFT must exist and not be APPROVED (got '${draft_status:-missing}')"
receipts_sql="SELECT count(*) FROM public.receipts r JOIN public.claims c ON c.id = r.claim_id
   WHERE c.claim_number = '$APPROVED'"
receipts=$(psql_app -At -v ON_ERROR_STOP=1 -c "$receipts_sql" 2>&1) || die "psql failed: $receipts"
[ "$receipts" -gt 0 ] 2>/dev/null ||
  die "$APPROVED has no receipt to delete (fresh seed: docker compose down -v && docker compose up --build --wait)"
echo "    as expense_app: $APPROVED has $receipts receipt(s)"

failures=0
# attack LABEL SQLSTATE SQL: runs SQL in BEGIN … ROLLBACK and expects `ERROR: <SQLSTATE>`.
attack() {
  local label=$1 expected=$2 sql=$3 out
  printf '\n==> %s (expect %s)\n' "$label" "$expected"
  printf '%s\n' "$sql" | sed 's/^/    sql> /'
  out=$(printf '\\set VERBOSITY verbose\n\\set SHOW_CONTEXT never\nBEGIN;\n%s\nROLLBACK;\n' "$sql" |
    psql_app -v ON_ERROR_STOP=1 2>&1) || true
  printf '%s\n' "$out" | grep -E '^(ERROR|DETAIL|HINT):' | sed 's/^/    /' || true
  if printf '%s\n' "$out" | grep -Eq "^ERROR:[[:space:]]+${expected}:"; then
    echo "    PASS  $expected"
  else
    echo "    FAIL  expected SQLSTATE $expected; psql said:"
    printf '%s\n' "$out" | sed 's/^/      /'
    failures=$((failures + 1))
  fi
}

attack "UC001: edit a line of the APPROVED claim $APPROVED" UC001 \
  "UPDATE public.line_items SET amount_minor = amount_minor + 100000
 WHERE claim_id = (SELECT id FROM public.claims WHERE claim_number = '$APPROVED');"

attack "UC001: delete the receipts of the APPROVED claim $APPROVED" UC001 \
  "DELETE FROM public.receipts
 WHERE claim_id = (SELECT id FROM public.claims WHERE claim_number = '$APPROVED');"

attack "UC003: write the total of the $draft_status claim $DRAFT directly" UC003 \
  "UPDATE public.claims SET total_minor = 100 WHERE claim_number = '$DRAFT';"

attack '42501: switch off the guard trigger' 42501 \
  'ALTER TABLE public.claims DISABLE TRIGGER claims_10_guard;'

attack '42501: silence every trigger for the session' 42501 \
  'SET session_replication_role = replica;'

echo
echo '==> Afterwards: nothing changed and every total still equals the sum of its lines'
after=$(psql_app -At -F '|' -v ON_ERROR_STOP=1 -c "
  SELECT (SELECT total_minor FROM public.claims WHERE claim_number = '$APPROVED'),
         ($receipts_sql),
         (SELECT count(*) FROM public.v_claim_total_drift)" 2>&1) || die "psql failed: $after"
IFS='|' read -r after_total after_receipts drift <<<"$after"
if [ "$after_total" = "$approved_total" ] && [ "$after_receipts" = "$receipts" ] && [ "$drift" = 0 ]; then
  echo "    PASS  $APPROVED total=$after_total paise, $after_receipts receipt(s) (unchanged); v_claim_total_drift rows: $drift"
else
  echo "    FAIL  $APPROVED total=$after_total (was $approved_total), receipts=$after_receipts (was $receipts); v_claim_total_drift rows: $drift"
  failures=$((failures + 1))
fi

if [ "$failures" -gt 0 ]; then
  echo "==> $failures check(s) failed" >&2
  exit 1
fi
echo '==> OK: as expense_app the database refused all five (UC001, UC001, UC003, 42501, 42501)'
