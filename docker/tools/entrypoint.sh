#!/bin/sh
# One-shot jobs for the `migrate` compose service (and an Azure Container Apps Job in production).
# Runs as expense_owner: MIGRATE_DATABASE_URL reaches the prisma CLI via prisma.config.ts.
set -eu

log() { echo "[tools] $*"; }

migrate() {
  log 'migrate: prisma migrate deploy'
  prisma migrate deploy
}

# seed.ts rebinds DATABASE_URL to the owner URL. Reference data on every run; the demo cast only
# when SEED_ON_START=true and the users table is empty (that check lives in seed.ts, D-45).
seed() {
  log 'seed: prisma db seed'
  prisma db seed
}

# HeadBucket with retry/backoff up to 60 s, CreateBucket if missing (idempotent). A no-op for the
# fs driver (the storage-gate fallback, 01 §11.3); the script also skips memory.
ensure_bucket() {
  if [ "${RECEIPT_STORAGE_DRIVER:-s3}" = "fs" ]; then
    log 'ensure-bucket: skipped (fs driver)'
    return 0
  fi
  log 'ensure-bucket: tsx scripts/ensure-bucket.ts'
  tsx scripts/ensure-bucket.ts
}

case "${1:-release}" in
  migrate) migrate ;;
  seed) seed ;;
  ensure-bucket) ensure_bucket ;;
  release)
    # migrate → ensure-bucket → seed. The seed is unconditional (its reference part runs on every
    # release), and the bucket must exist first: the demo seed uploads C04's receipt through the
    # real receipts service.
    migrate
    ensure_bucket
    seed
    ;;
  *) exec "$@" ;; # e.g. `docker compose run --rm migrate sh`
esac
