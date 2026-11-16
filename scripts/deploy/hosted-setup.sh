#!/usr/bin/env bash
# One-command hosted setup (docs/deploy-vercel-free.md): database roles, migrations, demo seed, a
# check as the runtime role, and a ready-to-paste Vercel environment file. Run from the repo root:
#   bash scripts/deploy/hosted-setup.sh
# It asks for what it needs; every answer can be given as an environment variable instead:
#   ADMIN_DATABASE_URL (secret), S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID,
#   S3_SECRET_ACCESS_KEY (secret). Switches: ASSUME_YES=1 (no questions), SSLMODE (default
#   verify-full), ALLOW_LOCAL_REHEARSAL=1 (allow a localhost database, for rehearsals only).
# Secrets live in two files created with mode 600: ~/.expense-claims-hosting.env (generated
# passwords, reused on a rerun) and ~/expense-claims-vercel-env.txt. Nothing secret is printed, and
# each secret reaches a command only through that one command's environment, never its arguments.
# The repo .env holds LOCAL values: every command below sets all it needs, and a real environment
# variable always beats .env, so the hosted database can never be mixed up with the local one.
set -euo pipefail

SECRETS_FILE="$HOME/.expense-claims-hosting.env"
VERCEL_ENV_FILE="$HOME/expense-claims-vercel-env.txt"
SSLMODE="${SSLMODE:-verify-full}"
ASSUME_YES="${ASSUME_YES:-0}"
ALLOW_LOCAL_REHEARSAL="${ALLOW_LOCAL_REHEARSAL:-0}"

say() { printf '\n==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

# ask VAR "label" [secret] [default]: use $VAR if set, else prompt (silent for secrets).
ask() {
  local var="$1" label="$2" secret="${3:-}" default="${4:-}" value
  value="${!var:-}"
  if [ -z "$value" ]; then
    if [ -t 0 ]; then
      if [ -n "$secret" ]; then
        read -rs -p "$label: " value
        printf '\n'
      else
        read -r -p "$label${default:+ [$default]}: " value
      fi
    fi
    value="${value:-$default}"
  fi
  [ -n "$value" ] || die "$var is empty. Set it in the environment, or run this in a terminal to be asked."
  printf -v "$var" '%s' "$value"
}

# confirm "question": yes only for y/Y (default no); ASSUME_YES=1 answers yes.
confirm() {
  [ "$ASSUME_YES" = 1 ] && return 0
  [ -t 0 ] || die "No terminal to ask: \"$1\" Run in a terminal, or set ASSUME_YES=1."
  local answer
  read -r -p "$1 [y/N] " answer
  case "$answer" in y | Y | yes | YES) return 0 ;; *) return 1 ;; esac
}

# URL toolbox. The URL travels in $U (an environment variable), never in an argument.
url_part() { # url_part scheme|host|db|user
  node -e '
    const u = new URL(process.env.U);
    const parts = { scheme: u.protocol, host: u.hostname, user: decodeURIComponent(u.username),
      db: decodeURIComponent(u.pathname.slice(1)) };
    process.stdout.write(parts[process.argv[1]] ?? "");
  ' "$1"
}

# build_url ROLE PASSWORD pooled(0|1): $ADMIN_URL as another role, with $SSLMODE and without
# channel_binding. Pooled inserts "-pooler" after the Neon endpoint label (ep-xxx -> ep-xxx-pooler).
build_url() {
  U="$ADMIN_URL" ROLE="$1" PW="$2" POOLED="$3" SSL="$SSLMODE" node -e '
    const u = new URL(process.env.U);
    u.username = process.env.ROLE;
    u.password = process.env.PW;
    u.searchParams.delete("channel_binding");
    u.searchParams.set("sslmode", process.env.SSL);
    if (process.env.POOLED === "1") {
      const m = /^(ep-[^.]+)(\..+)$/.exec(u.hostname);
      if (m) u.hostname = m[1] + "-pooler" + m[2];
      else console.error("    note: " + u.hostname + " does not look like a Neon endpoint, so the pooled URL keeps the direct host");
    }
    process.stdout.write(u.toString());
  '
}

# ---------------------------------------------------------------------------------------------
say "1/8 Preflight"
[ -f package.json ] && [ -f prisma/schema.prisma ] && [ -d scripts/deploy ] ||
  die "Run this from the repository root: bash scripts/deploy/hosted-setup.sh"
command -v node >/dev/null || die "node not found. Install Node 24 (nvm install && nvm use)."
[ "$(node -p 'process.versions.node.split(".")[0]')" = 24 ] ||
  note "WARNING: Node $(node -v) found, this project targets Node 24 (run: nvm use)."
command -v pnpm >/dev/null || die "pnpm not found. Run: corepack enable"
command -v openssl >/dev/null || die "openssl not found (it generates the passwords)."
[ -x node_modules/.bin/prisma ] || die "Dependencies are not installed. Run: pnpm install --frozen-lockfile"
pnpm db:generate >/dev/null 2>&1 || die "pnpm db:generate failed. Run it by hand to see why."
note "Node $(node -v), pnpm $(pnpm -v), Prisma client generated"

# Secrets file: created once, reused on every rerun so the roles and the demo users stay in step.
if [ -f "$SECRETS_FILE" ]; then
  note "Found $SECRETS_FILE from an earlier run."
  confirm "Reuse its passwords? (no = stop; delete the file only together with a fresh database)" ||
    die "Stopped. New passwords need a fresh database, because the demo users already hold the old demo password."
  field() { sed -n "s/^$1=//p" "$SECRETS_FILE" | head -n 1; }
  OWNER_PW="$(field OWNER_PW)"
  APP_PW="$(field APP_PW)"
  DEMO_PW="$(field DEMO_PW)"
  for v in "$OWNER_PW" "$APP_PW" "$DEMO_PW"; do
    [[ "$v" =~ ^[0-9a-f]{48}$ ]] ||
      die "$SECRETS_FILE is damaged (it needs OWNER_PW, APP_PW and DEMO_PW, 48 hex characters each)."
  done
else
  OWNER_PW="$(openssl rand -hex 24)"
  APP_PW="$(openssl rand -hex 24)"
  DEMO_PW="$(openssl rand -hex 24)"
  (umask 077 && printf 'OWNER_PW=%s\nAPP_PW=%s\nDEMO_PW=%s\n' "$OWNER_PW" "$APP_PW" "$DEMO_PW" >"$SECRETS_FILE")
  chmod 600 "$SECRETS_FILE"
  note "Generated three passwords into $SECRETS_FILE (mode 600)."
fi

# Answers. Nothing below falls back to the repo .env: a missing value stops the script here.
echo
note "Paste the DIRECT admin connection string from Neon (the host has no -pooler)."
ask ADMIN_DATABASE_URL "Admin connection string (hidden)" secret
ask S3_ENDPOINT "S3 endpoint (Tigris: https://t3.storage.dev)"
ask S3_REGION "S3 region (Tigris: auto)" "" "auto"
ask S3_BUCKET "Bucket name"
ask S3_ACCESS_KEY_ID "S3 access key id"
ask S3_SECRET_ACCESS_KEY "S3 secret access key (hidden)" secret

ADMIN_URL="$ADMIN_DATABASE_URL"
unset ADMIN_DATABASE_URL
[ "$(U="$ADMIN_URL" url_part scheme 2>/dev/null || true)" != "" ] ||
  die "The admin connection string is not a valid URL."
case "$(U="$ADMIN_URL" url_part scheme)" in
  postgresql: | postgres:) ;;
  *) die "The admin connection string must start with postgresql://" ;;
esac
DB_HOST="$(U="$ADMIN_URL" url_part host)"
DB_NAME="$(U="$ADMIN_URL" url_part db)"
ADMIN_USER="$(U="$ADMIN_URL" url_part user)"
[ -n "$DB_HOST" ] && [ -n "$DB_NAME" ] && [ -n "$ADMIN_USER" ] ||
  die "The admin connection string needs a user, a host and a database name."
case "$DB_HOST" in
  localhost | 127.* | ::1 | \[::1\] | 0.0.0.0 | host.docker.internal | *.localhost)
    [ "$ALLOW_LOCAL_REHEARSAL" = 1 ] ||
      die "$DB_HOST is a local database, and this script is for the hosted one. (Rehearsals only: ALLOW_LOCAL_REHEARSAL=1)" ;;
esac
case "$ADMIN_USER" in
  expense_owner | expense_app)
    die "Use the provider's admin role in the admin string (for Neon: neondb_owner), not $ADMIN_USER." ;;
esac
case "$DB_HOST" in
  *-pooler.*)
    note "The host has -pooler (the pooled string). Using the direct host instead."
    ADMIN_URL="$(U="$ADMIN_URL" node -e 'const u = new URL(process.env.U); u.hostname = u.hostname.replace(/-pooler(?=\.)/, ""); process.stdout.write(u.toString())')"
    DB_HOST="$(U="$ADMIN_URL" url_part host)" ;;
esac
case "$SSLMODE" in
  disable | require | verify-ca | verify-full) ;;
  *) die "SSLMODE must be disable, require, verify-ca or verify-full." ;;
esac
[[ "$S3_ENDPOINT" =~ ^https?://[^/]+ ]] || die "S3_ENDPOINT must be a URL starting with https://"
[ "${#S3_SECRET_ACCESS_KEY}" -ge 8 ] || die "The S3 secret key is shorter than 8 characters (the app refuses that)."
{ [ "${#S3_BUCKET}" -ge 3 ] && [ "${#S3_BUCKET}" -le 63 ]; } || die "S3_BUCKET must be 3 to 63 characters."

# The admin URL (sslmode applied, no channel_binding) and the three URLs derived from it.
ADMIN_PW="$(U="$ADMIN_URL" node -e 'process.stdout.write(decodeURIComponent(new URL(process.env.U).password))')"
[ -n "$ADMIN_PW" ] || die "The admin connection string has no password."
ADMIN_URL="$(build_url "$ADMIN_USER" "$ADMIN_PW" 0)"
unset ADMIN_PW
OWNER_URL="$(build_url expense_owner "$OWNER_PW" 0)"
APP_URL_DIRECT="$(build_url expense_app "$APP_PW" 0)"
APP_URL_POOLED="$(build_url expense_app "$APP_PW" 1)"
for v in "$ADMIN_URL" "$OWNER_URL" "$APP_URL_DIRECT" "$APP_URL_POOLED"; do
  [ -n "$v" ] || die "Could not build a connection string."
done
APP_POOLED_HOST="$(U="$APP_URL_POOLED" url_part host)"
# Prisma's engine ignores sslmode verify-ca and verify-full (it falls back to prefer), so it gets
# require, which makes TLS mandatory.
PRISMA_SSL="$SSLMODE"
case "$SSLMODE" in verify-ca | verify-full) PRISMA_SSL=require ;; esac
OWNER_URL_PRISMA="$(U="$OWNER_URL" SSL="$PRISMA_SSL" node -e 'const u = new URL(process.env.U); u.searchParams.set("sslmode", process.env.SSL); process.stdout.write(u.toString())')"

# Commands that need a secret get it through their own environment only, one function each.
s3_check() {
  RECEIPT_STORAGE_DRIVER=s3 S3_ENDPOINT="$S3_ENDPOINT" S3_REGION="$S3_REGION" S3_BUCKET="$S3_BUCKET" \
    S3_ACCESS_KEY_ID="$S3_ACCESS_KEY_ID" S3_SECRET_ACCESS_KEY="$S3_SECRET_ACCESS_KEY" "$@"
}
as_owner() {
  MIGRATE_DATABASE_URL="$OWNER_URL_PRISMA" DATABASE_URL="$OWNER_URL_PRISMA" CHECKPOINT_DISABLE=1 "$@"
}
seed() { # APP_ENV=local on purpose: see step 6
  APP_ENV=local LOG_LEVEL=warn SEED_ON_START=true SEED_DEMO_PASSWORD="$DEMO_PW" s3_check as_owner "$@"
}
as_app() { # MIGRATE_DATABASE_URL is blanked: this must run as the runtime role only
  APP_ENV=local DATABASE_URL="$APP_URL_DIRECT" MIGRATE_DATABASE_URL="" s3_check "$@"
}

# ---------------------------------------------------------------------------------------------
say "2/8 Database roles and ownership"
note "Target: host $DB_HOST, database $DB_NAME (admin role $ADMIN_USER)"
note "This creates the roles expense_owner and expense_app and makes expense_owner own the database."
confirm "Set up THIS database?" || die "Stopped. Nothing was changed."
ADMIN_DATABASE_URL="$ADMIN_URL" OWNER_PASSWORD="$OWNER_PW" APP_PASSWORD="$APP_PW" \
  pnpm exec tsx scripts/deploy/bootstrap-db.ts ||
  die "The database bootstrap failed (see above). Nothing after it was run."

say "3/8 Migration target"
note "Target: host $DB_HOST, database $DB_NAME (role expense_owner, direct connection)"
confirm "Apply migrations to THIS database?" || die "Stopped before the migrations."

say "4/8 Receipt bucket"
note "Checking (and if needed creating) bucket $S3_BUCKET at $S3_ENDPOINT"
s3_check pnpm exec tsx scripts/ensure-bucket.ts ||
  die "The bucket check failed. Typical causes: a wrong endpoint, key or secret; a key that may not create
buckets (create the bucket in the provider's dashboard, then run this script again); or a bucket name that someone
else already owns (bucket names are global on most providers). The database is already set up, so a rerun is safe."

say "5/8 Apply migrations"
note "Migration status before (it must name the hosted host, not localhost):"
as_owner pnpm exec prisma migrate status || note "(a non-zero status only means migrations are still pending)"
as_owner pnpm db:deploy || die "pnpm db:deploy failed (see above)."

say "6/8 Seed (reference data and the demo accounts)"
# The seed refuses APP_ENV=staging/production on purpose. This shell is on your laptop, and the Vercel
# app is labelled staging. The seed uploads one demo receipt, which is why the bucket had to exist.
seed pnpm db:seed ||
  die "pnpm db:seed failed (see above). If it failed after 'demo cast seeded', recreate the Neon database and run again."

say "7/8 Check as the runtime role (expense_app)"
as_app pnpm verify:integrity || die "The integrity check failed (see above)."

say "8/8 Vercel environment file"
(
  umask 077
  cat >"$VERCEL_ENV_FILE" <<EOF
APP_ENV=staging
APP_BASE_URL=https://REPLACE-WITH-YOUR-VERCEL-URL
DATABASE_URL=$APP_URL_POOLED
DB_POOL_MAX=5
RECEIPT_STORAGE_DRIVER=s3
S3_ENDPOINT=$S3_ENDPOINT
S3_REGION=$S3_REGION
S3_BUCKET=$S3_BUCKET
S3_ACCESS_KEY_ID=$S3_ACCESS_KEY_ID
S3_SECRET_ACCESS_KEY=$S3_SECRET_ACCESS_KEY
ENABLE_EXPERIMENTAL_COREPACK=1
EOF
)
chmod 600 "$VERCEL_ENV_FILE"

cat <<EOF

Done. The database ($DB_HOST, $DB_NAME) and the bucket ($S3_BUCKET) are ready.

Next: paste this file into Vercel's Environment Variables box.
  File:  $VERCEL_ENV_FILE
  Names: APP_ENV, APP_BASE_URL, DATABASE_URL, DB_POOL_MAX, RECEIPT_STORAGE_DRIVER, S3_ENDPOINT,
         S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, ENABLE_EXPERIMENTAL_COREPACK
  DATABASE_URL points at host $APP_POOLED_HOST.
  APP_BASE_URL is a placeholder: set it to your real https address (the guide says when).

Demo logins (one shared password: DEMO_PW in $SECRETS_FILE):
  asha.rao@acme.test (employee)    ravi.menon@acme.test, meera.iyer@acme.test (approvers)
  farah.khan@acme.test (finance)   admin@acme.test

Guide: docs/deploy-vercel-free.md
EOF
