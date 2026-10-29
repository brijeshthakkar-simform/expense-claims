-- ====================================================================================================
-- verified.sql — Expense Claims POC: the data-integrity SQL, PROVEN against a real PostgreSQL
--
-- Verified 2026-10-13 on PostgreSQL 18.4 (npm embedded-postgres 18.4.0-beta.17; canonical pins the 18.6 image)
-- with Prisma CLI 7.10.0: `prisma migrate deploy` as expense_owner applied every migration below, and
-- `prisma migrate diff` (live DB -> schema.prisma) and (migrations replayed in a shadow DB -> schema.prisma)
-- are both EMPTY. 127/127 tests green, attacks run as the least-privilege role expense_app
-- (multi-connection concurrency included). Test catalogue, bugs fixed and harness: sqlproof-report.md.
--
-- Layout = the planned Prisma migrations (canonical C-23), in apply order. Each migration.sql is EXACTLY
-- the concatenation of its blocks:
--   >>>> PRISMA-GENERATED  -> run `pnpm prisma migrate dev --create-only --name <name>`, do not hand-write
--   >>>> HAND-WRITTEN      -> paste where the label says (prepend / append) BEFORE applying the migration
-- The superuser bootstrap (docker/postgres/initdb/01-roles.sh) is not a migration; it runs first.
--
-- Function versions (CREATE OR REPLACE keeps the triggers bound):
--   #1 assert_claim_editable   v1 in 0002 -> v2 in 0004 (adds the snapshot freeze)
--   #4 claims_guard            v1 in 0002 -> v2 in 0004 (full whitelist + chain / approval / audit preconditions)
--   #6 claim_submissions_verify v1 in 0004 -> v2 in 0005 (adds receipt verification)
-- SQLSTATEs: UC001 CLAIM_LOCKED · UC002 CLAIM_NOT_EDITABLE · UC003 TOTAL_IS_DERIVED · UC004 NO_LINE_ITEMS ·
--   UC005 INVALID_STATUS_TRANSITION · UC006 ALREADY_DECIDED · UC007 APPEND_ONLY · UC008 APPROVER_NOT_ELIGIBLE ·
--   UC009 TOTAL_MISMATCH · UC010 IMMUTABLE_FIELD · UC011 APPROVAL_INCOMPLETE · UC012 CHAIN_INVALID ·
--   UC013 CATEGORY_INACTIVE · UC014 EXPENSE_DATE_IN_FUTURE · UC015 AUDIT_EVENT_MISSING · UC016 SNAPSHOT_MISMATCH ·
--   UC017 CLAIM_HAS_HISTORY  (canonical C-05; the app maps by SQLSTATE only)
-- ====================================================================================================


-- ====================================================================================================
-- not a migration: docker/postgres/initdb/01-roles.sh  (postgres superuser, first boot, empty volume)
-- Wrap in: psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<-SQL ... SQL
-- (psql autocommits each statement, which CREATE DATABASE requires; from a driver send them one by one.)
-- Re-run the database part for every database that needs prod privileges (expense_perf, the Testcontainers DB).
-- ====================================================================================================
-- ---- cluster part (once) ----------------------------------------------------
CREATE ROLE expense_owner LOGIN PASSWORD '${DB_OWNER_PASSWORD}'
  NOSUPERUSER NOCREATEROLE CREATEDB NOBYPASSRLS;          -- CREATEDB only for the local Prisma shadow DB
CREATE ROLE expense_app LOGIN PASSWORD '${DB_APP_PASSWORD}'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;
ALTER ROLE expense_app SET statement_timeout = '15s';
ALTER ROLE expense_app SET lock_timeout = '5s';
ALTER ROLE expense_app SET idle_in_transaction_session_timeout = '30s';

-- ---- database part (per database) -------------------------------------------
CREATE DATABASE expense_claims OWNER expense_owner;
ALTER DATABASE expense_claims SET timezone TO 'UTC';
REVOKE ALL ON DATABASE expense_claims FROM PUBLIC;                -- drops PUBLIC's CONNECT + TEMPORARY (temp-table shadowing)
GRANT CONNECT ON DATABASE expense_claims TO expense_app;
\connect expense_claims
ALTER SCHEMA public OWNER TO expense_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;                  -- no CREATE (and no implicit USAGE) for anyone else
GRANT USAGE ON SCHEMA public TO expense_app;


-- ====================================================================================================
-- migration: 0001_init  ->  prisma/migrations/20261013090000_init/migration.sql   (phase P0)
-- ====================================================================================================
-- >>>> HAND-WRITTEN: PREPEND above the Prisma DDL
-- ---------------------------------------------------------------------------
-- HAND-PREPENDED to the Prisma-generated init migration: claims.claim_number has
-- DEFAULT next_claim_number(), so the sequence and the function must exist first.
-- ---------------------------------------------------------------------------
CREATE SEQUENCE public.claim_number_seq AS bigint START WITH 1 INCREMENT BY 1 NO CYCLE;

-- EXP-<IST year>-<global sequence, zero-padded to at least 6 digits>. Gaps are fine.
-- greatest(6, length(n)) because lpad() alone would TRUNCATE once n reaches 1,000,000.
CREATE FUNCTION public.next_claim_number()
RETURNS text
LANGUAGE sql
VOLATILE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT 'EXP-' || to_char(now() AT TIME ZONE 'Asia/Kolkata', 'YYYY') || '-'
         || lpad(s.n::text, greatest(6, length(s.n::text)), '0')
    FROM (SELECT nextval('public.claim_number_seq') AS n) AS s;
$$;

-- >>>> PRISMA-GENERATED by `pnpm prisma migrate dev --create-only --name init` (do not hand-write; shown so the reader sees what was verified)
-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "user_role" AS ENUM ('EMPLOYEE', 'FINANCE', 'ADMIN');

-- CreateEnum
CREATE TYPE "claim_status" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "departments" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "code" VARCHAR(16) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "employee_code" VARCHAR(20) NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "role" "user_role" NOT NULL DEFAULT 'EMPLOYEE',
    "can_approve" BOOLEAN NOT NULL DEFAULT false,
    "is_fallback_approver" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "department_id" UUID NOT NULL,
    "manager_id" UUID,
    "password_hash" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idle_expires_at" TIMESTAMPTZ(3) NOT NULL,
    "absolute_expires_at" TIMESTAMPTZ(3) NOT NULL,
    "user_agent" VARCHAR(512),

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categories" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "gl_code" VARCHAR(20) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" SMALLINT NOT NULL DEFAULT 0,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "claims" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "claim_number" VARCHAR(24) NOT NULL DEFAULT next_claim_number(),
    "claimant_id" UUID NOT NULL,
    "title" VARCHAR(120) NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "status" "claim_status" NOT NULL DEFAULT 'DRAFT',
    "total_minor" INTEGER NOT NULL DEFAULT 0,
    "current_revision" INTEGER NOT NULL DEFAULT 0,
    "current_submission_id" UUID,
    "submitted_at" TIMESTAMPTZ(3),
    "approved_at" TIMESTAMPTZ(3),
    "rejected_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "line_items" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "claim_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "expense_date" DATE NOT NULL,
    "amount_minor" INTEGER NOT NULL,
    "description" VARCHAR(500) NOT NULL,
    "merchant" VARCHAR(120),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "line_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "departments_code_key" ON "departments"("code");

-- CreateIndex
CREATE UNIQUE INDEX "users_employee_code_key" ON "users"("employee_code");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_manager_id_idx" ON "users"("manager_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_one_fallback_approver" ON "users"("is_fallback_approver") WHERE (is_fallback_approver);

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "categories_code_key" ON "categories"("code");

-- CreateIndex
CREATE UNIQUE INDEX "claims_claim_number_key" ON "claims"("claim_number");

-- CreateIndex
CREATE UNIQUE INDEX "claims_current_submission_id_key" ON "claims"("current_submission_id");

-- CreateIndex
CREATE INDEX "claims_claimant_list_idx" ON "claims"("claimant_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "claims_finance_list_idx" ON "claims"("status", "submitted_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "claims_submitted_idx" ON "claims"("submitted_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "claims_export_idx" ON "claims"("approved_at", "id");

-- CreateIndex
CREATE INDEX "line_items_claim_idx" ON "line_items"("claim_id", "expense_date", "id");

-- CreateIndex
CREATE UNIQUE INDEX "line_items_id_claim_id_key" ON "line_items"("id", "claim_id");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_manager_id_fkey" FOREIGN KEY ("manager_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claims" ADD CONSTRAINT "claims_claimant_id_fkey" FOREIGN KEY ("claimant_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "line_items" ADD CONSTRAINT "line_items_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "claims"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "line_items" ADD CONSTRAINT "line_items_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ====================================================================================================
-- migration: 0002_integrity_core  ->  prisma/migrations/20261013091000_integrity_core/migration.sql   (phase P0)
-- ====================================================================================================
-- >>>> HAND-WRITTEN (the Prisma-generated file is empty)
-- Hand-written; `prisma migrate dev --create-only --name integrity_core` produces an empty file.
-- Every function: schema-qualified names + pinned search_path (D-36). Raise convention (C-05):
--   RAISE EXCEPTION USING ERRCODE = 'UCnnn', MESSAGE = '<API_CODE>: ...'  -- the app maps by SQLSTATE only.

-- ===========================================================================
-- CHECK constraints (DB backstops for the Zod rules)
-- ===========================================================================
ALTER TABLE public.users
  ADD CONSTRAINT users_email_lowercase        CHECK (email = lower(email)),
  ADD CONSTRAINT users_finance_cannot_approve CHECK (NOT (role = 'FINANCE' AND can_approve)),
  ADD CONSTRAINT users_fallback_must_approve  CHECK (NOT is_fallback_approver OR can_approve),
  ADD CONSTRAINT users_not_own_manager        CHECK (manager_id <> id);

ALTER TABLE public.categories
  ADD CONSTRAINT categories_gl_code_format CHECK (gl_code ~ '^[0-9]{4,10}$');

ALTER TABLE public.claims
  ADD CONSTRAINT claims_claim_number_format         CHECK (claim_number ~ '^EXP-[0-9]{4}-[0-9]{6,}$'),
  ADD CONSTRAINT claims_currency_format             CHECK (currency ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT claims_total_range                 CHECK (total_minor BETWEEN 0 AND 1000000000),
  ADD CONSTRAINT claims_revision_nonneg             CHECK (current_revision >= 0),
  ADD CONSTRAINT claims_approved_at_iff_approved    CHECK ((status = 'APPROVED') = (approved_at IS NOT NULL)),
  ADD CONSTRAINT claims_rejected_at_iff_rejected    CHECK ((status = 'REJECTED') = (rejected_at IS NOT NULL)),
  ADD CONSTRAINT claims_revision_matches_submission CHECK ((current_revision = 0) = (current_submission_id IS NULL)),
  ADD CONSTRAINT claims_submitted_has_revision      CHECK (status = 'DRAFT' OR current_revision >= 1),
  ADD CONSTRAINT claims_title_length                CHECK (char_length(btrim(title)) BETWEEN 3 AND 120);

ALTER TABLE public.line_items
  ADD CONSTRAINT line_items_amount_range        CHECK (amount_minor BETWEEN 1 AND 100000000),
  ADD CONSTRAINT line_items_expense_date_min    CHECK (expense_date >= DATE '2000-01-01'),
  ADD CONSTRAINT line_items_description_length  CHECK (char_length(btrim(description)) BETWEEN 3 AND 500);

-- ===========================================================================
-- #1 assert_claim_editable(claim_id) — v1 (replaced in 0004 to add the snapshot freeze)
-- Locks the parent claim FOR NO KEY UPDATE, then checks it. Lock first, check second:
-- the status we read cannot change until we commit.
-- ===========================================================================
CREATE FUNCTION public.assert_claim_editable(p_claim_id uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_status public.claim_status;
  v_number text;
BEGIN
  SELECT c.status, c.claim_number INTO v_status, v_number
    FROM public.claims c WHERE c.id = p_claim_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN;  -- unknown claim: the FK raises 23503; or the parent is being cascade-deleted
  END IF;
  IF v_status = 'APPROVED' THEN
    RAISE EXCEPTION USING ERRCODE = 'UC001',
      MESSAGE = format('CLAIM_LOCKED: claim %s is approved and read-only', v_number);
  ELSIF v_status = 'SUBMITTED' THEN
    RAISE EXCEPTION USING ERRCODE = 'UC002',
      MESSAGE = format('CLAIM_NOT_EDITABLE: claim %s is in approval; recall it to edit', v_number),
      HINT = 'RECALL_TO_EDIT';
  END IF;
END
$$;

-- ===========================================================================
-- #2 line_items_before_write — BEFORE INSERT/UPDATE/DELETE, row
-- ===========================================================================
CREATE FUNCTION public.line_items_before_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.claim_id IS DISTINCT FROM OLD.claim_id THEN
    RAISE EXCEPTION USING ERRCODE = 'UC010',
      MESSAGE = 'IMMUTABLE_FIELD: a line item cannot move to another claim';
  END IF;

  IF TG_OP = 'DELETE' THEN
    PERFORM public.assert_claim_editable(OLD.claim_id);       -- UC001 / UC002
    RETURN OLD;
  END IF;

  PERFORM public.assert_claim_editable(NEW.claim_id);         -- UC001 / UC002

  IF (TG_OP = 'INSERT' OR NEW.expense_date IS DISTINCT FROM OLD.expense_date)
     AND NEW.expense_date > (now() AT TIME ZONE 'Asia/Kolkata')::date THEN
    RAISE EXCEPTION USING ERRCODE = 'UC014',
      MESSAGE = format('EXPENSE_DATE_IN_FUTURE: %s is after today in Asia/Kolkata', NEW.expense_date);
  END IF;

  IF (TG_OP = 'INSERT' OR NEW.category_id IS DISTINCT FROM OLD.category_id)
     AND EXISTS (SELECT 1 FROM public.categories cat WHERE cat.id = NEW.category_id AND NOT cat.is_active) THEN
    RAISE EXCEPTION USING ERRCODE = 'UC013',
      MESSAGE = 'CATEGORY_INACTIVE: choose an active expense category';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER line_items_10_before_write
  BEFORE INSERT OR UPDATE OR DELETE ON public.line_items
  FOR EACH ROW EXECUTE FUNCTION public.line_items_before_write();

-- ===========================================================================
-- #3 line_items_recompute_claim_totals — AFTER STATEMENT with transition tables
-- The ONLY writer of claims.total_minor. Full recompute (never deltas), parents locked
-- in id order, and the SUM is a new statement => a fresh READ COMMITTED snapshot taken
-- after the lock was granted, so it sees every committed line plus our own.
-- ===========================================================================
CREATE FUNCTION public.line_items_recompute_claim_totals()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_claim_ids uuid[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT array_agg(DISTINCT n.claim_id) INTO v_claim_ids FROM new_rows n;
  ELSIF TG_OP = 'DELETE' THEN
    SELECT array_agg(DISTINCT o.claim_id) INTO v_claim_ids FROM old_rows o;
  ELSE  -- UPDATE: rows whose amount or parent changed; recompute BOTH old and new parents
    SELECT array_agg(DISTINCT v.claim_id) INTO v_claim_ids
      FROM new_rows n
      JOIN old_rows o ON o.id = n.id
      CROSS JOIN LATERAL (VALUES (n.claim_id), (o.claim_id)) AS v(claim_id)
     WHERE n.amount_minor IS DISTINCT FROM o.amount_minor
        OR n.claim_id IS DISTINCT FROM o.claim_id;
  END IF;

  IF v_claim_ids IS NULL THEN
    RETURN NULL;  -- e.g. a description-only edit
  END IF;

  PERFORM 1 FROM public.claims c WHERE c.id = ANY (v_claim_ids) ORDER BY c.id FOR NO KEY UPDATE;

  UPDATE public.claims c
     SET total_minor = s.total
    FROM (SELECT ids.id, COALESCE(SUM(li.amount_minor), 0)::integer AS total
            FROM unnest(v_claim_ids) AS ids(id)
            LEFT JOIN public.line_items li ON li.claim_id = ids.id
           GROUP BY ids.id) AS s
   WHERE c.id = s.id
     AND c.total_minor IS DISTINCT FROM s.total;

  RETURN NULL;
END
$$;

CREATE TRIGGER line_items_20_recompute_after_insert
  AFTER INSERT ON public.line_items
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.line_items_recompute_claim_totals();

CREATE TRIGGER line_items_20_recompute_after_update
  AFTER UPDATE ON public.line_items
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.line_items_recompute_claim_totals();

CREATE TRIGGER line_items_20_recompute_after_delete
  AFTER DELETE ON public.line_items
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.line_items_recompute_claim_totals();

-- ===========================================================================
-- #4 claims_guard — v1 (P0). The ONLY BEFORE trigger on claims. Replaced by v2 in 0004,
-- which adds the chain/approval/audit preconditions once those tables exist.
-- v1 allows only DRAFT->SUBMITTED and SUBMITTED->DRAFT: approvals arrive with 0004.
-- ===========================================================================
CREATE FUNCTION public.claims_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_is_app     boolean     := (current_user = 'expense_app');
  v_now        timestamptz := now();          -- transaction start: one instant per transition
  v_transition text;
  v_seq        bigint;
BEGIN
  -- ---------------------------------------------------------------- INSERT
  IF TG_OP = 'INSERT' THEN
    IF NEW.total_minor IS DISTINCT FROM 0 THEN
      RAISE EXCEPTION USING ERRCODE = 'UC003',
        MESSAGE = 'TOTAL_IS_DERIVED: a claim is created with total_minor = 0; the total is derived from its line items';
    END IF;
    IF NEW.status <> 'DRAFT' OR NEW.current_revision <> 0 OR NEW.current_submission_id IS NOT NULL
       OR NEW.submitted_at IS NOT NULL OR NEW.approved_at IS NOT NULL OR NEW.rejected_at IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'UC005',
        MESSAGE = 'INVALID_STATUS_TRANSITION: a claim is created as an empty DRAFT (revision 0, no submission)';
    END IF;
    IF v_is_app THEN
      -- claim_number is DB-owned. Keep it only if it is the number the column DEFAULT just drew in
      -- this session (so the sequence is not consumed twice); anything app-supplied is replaced.
      BEGIN
        v_seq := currval('public.claim_number_seq');
      EXCEPTION WHEN object_not_in_prerequisite_state THEN
        v_seq := NULL;
      END;
      IF v_seq IS NULL OR NEW.claim_number IS DISTINCT FROM
           'EXP-' || to_char(v_now AT TIME ZONE 'Asia/Kolkata', 'YYYY') || '-'
           || lpad(v_seq::text, greatest(6, length(v_seq::text)), '0') THEN
        NEW.claim_number := public.next_claim_number();
      END IF;
      NEW.created_at := v_now;
    END IF;
    RETURN NEW;
  END IF;

  -- ---------------------------------------------------------------- DELETE
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'APPROVED' THEN
      RAISE EXCEPTION USING ERRCODE = 'UC001',
        MESSAGE = format('CLAIM_LOCKED: claim %s is approved and read-only', OLD.claim_number);
    END IF;
    IF OLD.current_revision > 0 THEN
      RAISE EXCEPTION USING ERRCODE = 'UC017',
        MESSAGE = format('CLAIM_HAS_HISTORY: claim %s was submitted and cannot be deleted', OLD.claim_number);
    END IF;
    RETURN OLD;
  END IF;

  -- ---------------------------------------------------------------- UPDATE
  IF OLD.status = 'APPROVED' THEN
    RAISE EXCEPTION USING ERRCODE = 'UC001',
      MESSAGE = format('CLAIM_LOCKED: claim %s is approved and read-only', OLD.claim_number);
  END IF;

  IF (NEW.id, NEW.claimant_id, NEW.claim_number, NEW.currency, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.claimant_id, OLD.claim_number, OLD.currency, OLD.created_at) THEN
    RAISE EXCEPTION USING ERRCODE = 'UC010',
      MESSAGE = 'IMMUTABLE_FIELD: id, claimant, claim number, currency and created_at never change';
  END IF;

  IF NEW.total_minor IS DISTINCT FROM OLD.total_minor THEN
    IF pg_trigger_depth() < 2 THEN   -- not called from the recompute trigger
      RAISE EXCEPTION USING ERRCODE = 'UC003',
        MESSAGE = 'TOTAL_IS_DERIVED: total_minor is computed from line items and cannot be written';
    END IF;
    IF OLD.status NOT IN ('DRAFT', 'REJECTED') THEN
      RAISE EXCEPTION USING ERRCODE = 'UC002',
        MESSAGE = format('CLAIM_NOT_EDITABLE: claim %s is %s', OLD.claim_number, OLD.status);
    END IF;
  END IF;

  IF NEW.title IS DISTINCT FROM OLD.title AND OLD.status = 'SUBMITTED' THEN
    RAISE EXCEPTION USING ERRCODE = 'UC002',
      MESSAGE = format('CLAIM_NOT_EDITABLE: claim %s is in approval; recall it to edit', OLD.claim_number),
      HINT = 'RECALL_TO_EDIT';
  END IF;

  v_transition := OLD.status::text || '>' || NEW.status::text;

  IF NEW.status <> OLD.status AND v_transition NOT IN ('DRAFT>SUBMITTED', 'SUBMITTED>DRAFT') THEN   -- v1 whitelist
    RAISE EXCEPTION USING ERRCODE = 'UC005',
      MESSAGE = format('INVALID_STATUS_TRANSITION: %s -> %s is not allowed', OLD.status, NEW.status);
  END IF;

  -- DB-owned transition timestamps change only inside their own transition (all roles)
  IF (NEW.submitted_at IS DISTINCT FROM OLD.submitted_at AND v_transition NOT IN ('DRAFT>SUBMITTED', 'REJECTED>SUBMITTED'))
     OR (NEW.approved_at IS DISTINCT FROM OLD.approved_at AND v_transition <> 'SUBMITTED>APPROVED')
     OR (NEW.rejected_at IS DISTINCT FROM OLD.rejected_at AND v_transition NOT IN ('SUBMITTED>REJECTED', 'REJECTED>SUBMITTED')) THEN
    RAISE EXCEPTION USING ERRCODE = 'UC010',
      MESSAGE = 'IMMUTABLE_FIELD: submitted_at / approved_at / rejected_at are set by the database at their transition';
  END IF;

  IF NEW.status = OLD.status THEN
    IF (NEW.current_revision, NEW.current_submission_id) IS DISTINCT FROM (OLD.current_revision, OLD.current_submission_id) THEN
      RAISE EXCEPTION USING ERRCODE = 'UC010',
        MESSAGE = 'IMMUTABLE_FIELD: the submission pointer moves only on submit';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status = 'SUBMITTED' THEN
    IF NOT EXISTS (SELECT 1 FROM public.line_items li WHERE li.claim_id = NEW.id) THEN
      RAISE EXCEPTION USING ERRCODE = 'UC004',
        MESSAGE = format('NO_LINE_ITEMS: claim %s has no line items', NEW.claim_number);
    END IF;
    IF NEW.current_revision <> OLD.current_revision + 1 OR NEW.current_submission_id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'UC012',
        MESSAGE = 'CHAIN_INVALID: a submit bumps current_revision by one and points at the new submission';
    END IF;
    NEW.submitted_at := CASE WHEN v_is_app OR NEW.submitted_at IS NOT DISTINCT FROM OLD.submitted_at
                             THEN v_now ELSE NEW.submitted_at END;
  ELSIF (NEW.current_revision, NEW.current_submission_id) IS DISTINCT FROM (OLD.current_revision, OLD.current_submission_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'UC010',
      MESSAGE = 'IMMUTABLE_FIELD: the submission pointer moves only on submit';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER claims_10_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.claims
  FOR EACH ROW EXECUTE FUNCTION public.claims_guard();

-- ===========================================================================
-- #5 assert_claim_total_consistent — commit-time backstop (UC009)
-- DEFERRABLE INITIALLY DEFERRED: the invariant must hold at COMMIT; it is briefly false
-- between a row write and the end-of-statement recompute.
-- ===========================================================================
CREATE FUNCTION public.assert_claim_total_consistent()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_ids uuid[];
  v_bad record;
BEGIN
  IF TG_TABLE_NAME = 'claims' THEN
    v_ids := ARRAY[NEW.id];
  ELSIF TG_OP = 'INSERT' THEN
    v_ids := ARRAY[NEW.claim_id];
  ELSIF TG_OP = 'DELETE' THEN
    v_ids := ARRAY[OLD.claim_id];
  ELSE
    v_ids := ARRAY[OLD.claim_id, NEW.claim_id];
  END IF;

  SELECT c.claim_number, c.total_minor AS stored, COALESCE(s.sum_minor, 0) AS actual
    INTO v_bad
    FROM public.claims c
    LEFT JOIN LATERAL (SELECT SUM(li.amount_minor) AS sum_minor
                         FROM public.line_items li WHERE li.claim_id = c.id) AS s ON true
   WHERE c.id = ANY (v_ids)
     AND c.total_minor <> COALESCE(s.sum_minor, 0)
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'UC009',
      MESSAGE = format('TOTAL_MISMATCH: claim %s stores %s but its line items sum to %s',
                       v_bad.claim_number, v_bad.stored, v_bad.actual);
  END IF;
  RETURN NULL;   -- a claim deleted in this transaction is simply not found
END
$$;

CREATE CONSTRAINT TRIGGER line_items_90_total_consistent
  AFTER INSERT OR UPDATE OF amount_minor, claim_id OR DELETE ON public.line_items
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.assert_claim_total_consistent();

CREATE CONSTRAINT TRIGGER claims_90_total_consistent
  AFTER UPDATE ON public.claims
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (OLD.total_minor IS DISTINCT FROM NEW.total_minor)
  EXECUTE FUNCTION public.assert_claim_total_consistent();

-- ===========================================================================
-- Auditor: compute-on-read survives as a view that must always be empty (pnpm verify:integrity)
-- ===========================================================================
CREATE VIEW public.v_claim_total_drift WITH (security_invoker = true) AS
SELECT c.id AS claim_id, c.total_minor, COALESCE(s.line_sum, 0)::bigint AS line_sum
  FROM public.claims c
  LEFT JOIN (SELECT li.claim_id, SUM(li.amount_minor) AS line_sum
               FROM public.line_items li GROUP BY li.claim_id) AS s ON s.claim_id = c.id
 WHERE c.total_minor <> COALESCE(s.line_sum, 0);


-- ====================================================================================================
-- migration: 0003_privileges  ->  prisma/migrations/20261013092000_privileges/migration.sql   (phase P0)
-- ====================================================================================================
-- >>>> HAND-WRITTEN (the Prisma-generated file is empty)
-- Hand-written. Explicit grants per table, in the migration that creates the table's
-- privileges (C-16). NO `ALTER DEFAULT PRIVILEGES` for DML: a new table is never
-- accidentally writable by the app. Database-level REVOKEs live in 01-roles.sh.
-- expense_app gets no TRUNCATE, TRIGGER or REFERENCES anywhere, and nothing on _prisma_migrations.

GRANT SELECT                         ON public.departments, public.users, public.categories TO expense_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sessions, public.claims, public.line_items  TO expense_app;
GRANT SELECT                         ON public.v_claim_total_drift                         TO expense_app;
GRANT USAGE, SELECT                  ON SEQUENCE public.claim_number_seq                    TO expense_app;


-- ====================================================================================================
-- migration: 0004_workflow  ->  prisma/migrations/20261016090000_workflow/migration.sql   (phase P3)
-- ====================================================================================================
-- >>>> PRISMA-GENERATED by `pnpm prisma migrate dev --create-only --name workflow` (do not hand-write; shown so the reader sees what was verified)
-- CreateEnum
CREATE TYPE "approval_step_status" AS ENUM ('WAITING', 'PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "approver_resolver" AS ENUM ('REPORTING_LINE', 'DESIGNATED_USER');

-- CreateEnum
CREATE TYPE "claim_event_type" AS ENUM ('CLAIM_SUBMITTED', 'CLAIM_RESUBMITTED', 'STEP_APPROVED', 'CLAIM_APPROVED', 'CLAIM_REJECTED', 'CLAIM_RECALLED');

-- CreateEnum
CREATE TYPE "event_actor_role" AS ENUM ('CLAIMANT', 'APPROVER');

-- CreateTable
CREATE TABLE "approval_policy_tiers" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "level" SMALLINT NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "label" VARCHAR(80) NOT NULL,
    "applies_above_minor" INTEGER NOT NULL,
    "resolver" "approver_resolver" NOT NULL,
    "levels_up" SMALLINT,
    "designated_user_id" UUID,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_policy_tiers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "claim_submissions" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "claim_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "submitted_by_id" UUID NOT NULL,
    "submitted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "total_minor" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "line_item_count" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "claim_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_steps" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "claim_id" UUID NOT NULL,
    "submission_id" UUID NOT NULL,
    "level" SMALLINT NOT NULL,
    "tier_code" VARCHAR(32) NOT NULL,
    "tier_label" VARCHAR(80) NOT NULL,
    "applies_above_minor" INTEGER NOT NULL,
    "approver_id" UUID NOT NULL,
    "resolved_via" VARCHAR(16) NOT NULL,
    "status" "approval_step_status" NOT NULL,
    "activated_at" TIMESTAMPTZ(3),
    "decided_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "comment" VARCHAR(1000),
    "rejection_reason" VARCHAR(1000),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "claim_events" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "claim_id" UUID NOT NULL,
    "submission_id" UUID,
    "step_id" UUID,
    "revision" INTEGER NOT NULL,
    "type" "claim_event_type" NOT NULL,
    "actor_id" UUID NOT NULL,
    "actor_role" "event_actor_role" NOT NULL,
    "from_status" "claim_status" NOT NULL,
    "to_status" "claim_status" NOT NULL,
    "total_minor" INTEGER NOT NULL,
    "reason" VARCHAR(1000),
    "payload" JSONB NOT NULL DEFAULT '{}',
    "request_id" VARCHAR(64) NOT NULL,
    "tx_id" BIGINT NOT NULL DEFAULT ((pg_current_xact_id())::text)::bigint,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "claim_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "approval_policy_tiers_level_key" ON "approval_policy_tiers"("level");

-- CreateIndex
CREATE UNIQUE INDEX "approval_policy_tiers_code_key" ON "approval_policy_tiers"("code");

-- CreateIndex
CREATE UNIQUE INDEX "claim_submissions_claim_id_revision_key" ON "claim_submissions"("claim_id", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "claim_submissions_id_claim_id_key" ON "claim_submissions"("id", "claim_id");

-- CreateIndex
CREATE INDEX "approval_steps_pending_queue_idx" ON "approval_steps"("approver_id", "activated_at", "id") WHERE (status = 'PENDING'::approval_step_status);

-- CreateIndex
CREATE INDEX "approval_steps_approver_history_idx" ON "approval_steps"("approver_id", "decided_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "approval_steps_visibility_idx" ON "approval_steps"("claim_id", "approver_id");

-- CreateIndex
CREATE UNIQUE INDEX "approval_steps_submission_id_level_key" ON "approval_steps"("submission_id", "level");

-- CreateIndex
CREATE UNIQUE INDEX "approval_steps_submission_id_approver_id_key" ON "approval_steps"("submission_id", "approver_id");

-- CreateIndex
CREATE UNIQUE INDEX "approval_steps_one_pending_per_submission" ON "approval_steps"("submission_id") WHERE (status = 'PENDING'::approval_step_status);

-- CreateIndex
CREATE INDEX "claim_events_timeline_idx" ON "claim_events"("claim_id", "occurred_at", "id");

-- AddForeignKey
ALTER TABLE "approval_policy_tiers" ADD CONSTRAINT "approval_policy_tiers_designated_user_id_fkey" FOREIGN KEY ("designated_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claims" ADD CONSTRAINT "claims_current_submission_id_fkey" FOREIGN KEY ("current_submission_id") REFERENCES "claim_submissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_submissions" ADD CONSTRAINT "claim_submissions_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "claims"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_submissions" ADD CONSTRAINT "claim_submissions_submitted_by_id_fkey" FOREIGN KEY ("submitted_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_steps" ADD CONSTRAINT "approval_steps_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "claims"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_steps" ADD CONSTRAINT "approval_steps_submission_id_claim_id_fkey" FOREIGN KEY ("submission_id", "claim_id") REFERENCES "claim_submissions"("id", "claim_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_steps" ADD CONSTRAINT "approval_steps_approver_id_fkey" FOREIGN KEY ("approver_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_events" ADD CONSTRAINT "claim_events_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "claims"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_events" ADD CONSTRAINT "claim_events_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "claim_submissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_events" ADD CONSTRAINT "claim_events_step_id_fkey" FOREIGN KEY ("step_id") REFERENCES "approval_steps"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_events" ADD CONSTRAINT "claim_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- >>>> HAND-WRITTEN: APPEND below the Prisma DDL
-- ---------------------------------------------------------------------------
-- HAND-APPENDED to the Prisma-generated workflow migration.
-- ---------------------------------------------------------------------------

-- ===========================================================================
-- CHECK constraints
-- ===========================================================================
ALTER TABLE public.approval_policy_tiers
  ADD CONSTRAINT tiers_level_min          CHECK (level >= 1),
  ADD CONSTRAINT tiers_threshold_nonneg   CHECK (applies_above_minor >= 0),
  ADD CONSTRAINT tiers_levels_up_range    CHECK (levels_up BETWEEN 1 AND 5),
  ADD CONSTRAINT tiers_resolver_shape     CHECK (
        (resolver = 'REPORTING_LINE'  AND levels_up IS NOT NULL AND designated_user_id IS NULL)
     OR (resolver = 'DESIGNATED_USER' AND designated_user_id IS NOT NULL AND levels_up IS NULL));

ALTER TABLE public.claim_submissions
  ADD CONSTRAINT claim_submissions_revision_min    CHECK (revision >= 1),
  ADD CONSTRAINT claim_submissions_total_positive  CHECK (total_minor > 0),
  ADD CONSTRAINT claim_submissions_line_count_min  CHECK (line_item_count >= 1);

ALTER TABLE public.approval_steps
  ADD CONSTRAINT steps_level_min               CHECK (level >= 1),
  ADD CONSTRAINT steps_resolved_via            CHECK (resolved_via IN ('PRIMARY', 'ESCALATED', 'FALLBACK')),
  ADD CONSTRAINT steps_activated               CHECK (status IN ('WAITING', 'CANCELLED') OR activated_at IS NOT NULL),
  ADD CONSTRAINT steps_decided_iff             CHECK ((status IN ('APPROVED', 'REJECTED')) = (decided_at IS NOT NULL)),
  ADD CONSTRAINT steps_cancelled_iff           CHECK ((status = 'CANCELLED') = (cancelled_at IS NOT NULL)),
  ADD CONSTRAINT steps_reason_iff_rejected     CHECK ((status = 'REJECTED') = (rejection_reason IS NOT NULL)),
  ADD CONSTRAINT steps_reason_length           CHECK (rejection_reason IS NULL OR char_length(btrim(rejection_reason)) BETWEEN 10 AND 1000),
  ADD CONSTRAINT steps_comment_only_on_approve CHECK (comment IS NULL OR status = 'APPROVED');

ALTER TABLE public.claim_events
  ADD CONSTRAINT claim_events_payload_object     CHECK (jsonb_typeof(payload) = 'object'),
  ADD CONSTRAINT claim_events_rejection_reason   CHECK (type <> 'CLAIM_REJECTED' OR reason IS NOT NULL);

-- ===========================================================================
-- #1 assert_claim_editable — v2: adds the SNAPSHOT FREEZE. Once this transaction (or any)
-- has inserted the submission for revision current+1, the claim's content is frozen even
-- though its status is still DRAFT/REJECTED, so the snapshot can't drift from what is submitted.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.assert_claim_editable(p_claim_id uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_status   public.claim_status;
  v_number   text;
  v_revision integer;
BEGIN
  SELECT c.status, c.claim_number, c.current_revision INTO v_status, v_number, v_revision
    FROM public.claims c WHERE c.id = p_claim_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN;  -- unknown claim: the FK raises 23503; or the parent is being cascade-deleted
  END IF;
  IF v_status = 'APPROVED' THEN
    RAISE EXCEPTION USING ERRCODE = 'UC001',
      MESSAGE = format('CLAIM_LOCKED: claim %s is approved and read-only', v_number);
  ELSIF v_status = 'SUBMITTED' THEN
    RAISE EXCEPTION USING ERRCODE = 'UC002',
      MESSAGE = format('CLAIM_NOT_EDITABLE: claim %s is in approval; recall it to edit', v_number),
      HINT = 'RECALL_TO_EDIT';
  ELSIF EXISTS (SELECT 1 FROM public.claim_submissions s
                 WHERE s.claim_id = p_claim_id AND s.revision > v_revision) THEN
    RAISE EXCEPTION USING ERRCODE = 'UC002',
      MESSAGE = format('CLAIM_NOT_EDITABLE: claim %s is being submitted; its snapshot is already taken', v_number);
  END IF;
END
$$;

-- ===========================================================================
-- #6 claim_submissions_verify — BEFORE INSERT. v1 (replaced in 0005 to verify receipts too).
-- Service-built snapshot, DB-verified against the live rows of the locked claim.
-- ===========================================================================
CREATE FUNCTION public.claim_submissions_verify()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_c        record;
  v_lines    integer;
  v_snap_n   integer;
  v_snap_sum bigint;
  v_diff     integer;
BEGIN
  PERFORM public.assert_claim_editable(NEW.claim_id);   -- lock; APPROVED -> UC001; SUBMITTED / already snapshotted -> UC002

  SELECT c.claimant_id, c.title, c.currency, c.total_minor, c.current_revision,
         u.employee_code, u.name, u.email, d.code AS department_code
    INTO v_c
    FROM public.claims c
    JOIN public.users u ON u.id = c.claimant_id
    JOIN public.departments d ON d.id = u.department_id
   WHERE c.id = NEW.claim_id;
  IF NOT FOUND THEN
    RETURN NEW;  -- FK raises 23503
  END IF;

  SELECT count(*) INTO v_lines FROM public.line_items li WHERE li.claim_id = NEW.claim_id;
  IF v_lines = 0
     OR jsonb_typeof(NEW.snapshot -> 'lines') IS DISTINCT FROM 'array'
     OR jsonb_array_length(CASE WHEN jsonb_typeof(NEW.snapshot -> 'lines') = 'array'
                                THEN NEW.snapshot -> 'lines' ELSE '[]'::jsonb END) = 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'UC004',
      MESSAGE = 'NO_LINE_ITEMS: a submission needs at least one line item';
  END IF;

  IF NEW.revision IS DISTINCT FROM v_c.current_revision + 1 THEN
    RAISE EXCEPTION USING ERRCODE = 'UC016',
      MESSAGE = format('SNAPSHOT_MISMATCH: the next revision is %s, not %s', v_c.current_revision + 1, NEW.revision);
  END IF;
  IF NEW.submitted_by_id IS DISTINCT FROM v_c.claimant_id THEN
    RAISE EXCEPTION USING ERRCODE = 'UC016',
      MESSAGE = 'SNAPSHOT_MISMATCH: only the claimant submits a claim';
  END IF;
  IF NEW.currency IS DISTINCT FROM v_c.currency
     OR NEW.total_minor IS DISTINCT FROM v_c.total_minor
     OR NEW.line_item_count IS DISTINCT FROM v_lines
     OR (NEW.snapshot ->> 'v')          IS DISTINCT FROM '1'
     OR (NEW.snapshot ->> 'title')      IS DISTINCT FROM v_c.title
     OR (NEW.snapshot ->> 'currency')   IS DISTINCT FROM v_c.currency::text
     OR (NEW.snapshot ->> 'totalMinor') IS DISTINCT FROM v_c.total_minor::text
     OR (NEW.snapshot -> 'claimant')    IS DISTINCT FROM jsonb_build_object(
            'id', v_c.claimant_id, 'employeeCode', v_c.employee_code, 'name', v_c.name,
            'email', v_c.email, 'departmentCode', v_c.department_code) THEN
    RAISE EXCEPTION USING ERRCODE = 'UC016',
      MESSAGE = 'SNAPSHOT_MISMATCH: header (title, currency, total, line count, claimant) differs from the live claim';
  END IF;

  -- Exact line-set equality (multiset), including the frozen category name and GL code used by the export.
  WITH snap AS (
    SELECT x."lineItemId", x."expenseDate", x."categoryId", x."categoryCode", x."categoryName", x."glCode",
           x."amountMinor", x.description, x.merchant
      FROM jsonb_to_recordset(NEW.snapshot -> 'lines') AS x(
             "lineItemId" uuid, "expenseDate" date, "categoryId" uuid, "categoryCode" text, "categoryName" text,
             "glCode" text, "amountMinor" integer, description text, merchant text)
  ), live AS (
    SELECT li.id, li.expense_date, li.category_id, cat.code::text, cat.name::text, cat.gl_code::text,
           li.amount_minor, li.description::text, li.merchant::text
      FROM public.line_items li
      JOIN public.categories cat ON cat.id = li.category_id
     WHERE li.claim_id = NEW.claim_id
  )
  SELECT (SELECT count(*) FROM (SELECT * FROM snap EXCEPT ALL SELECT * FROM live) AS a)
       + (SELECT count(*) FROM (SELECT * FROM live EXCEPT ALL SELECT * FROM snap) AS b),
         (SELECT count(*) FROM snap),
         (SELECT COALESCE(SUM("amountMinor"), 0) FROM snap)
    INTO v_diff, v_snap_n, v_snap_sum;
  IF v_diff <> 0 OR v_snap_n <> v_lines OR v_snap_sum <> v_c.total_minor THEN
    RAISE EXCEPTION USING ERRCODE = 'UC016',
      MESSAGE = 'SNAPSHOT_MISMATCH: snapshot lines differ from the live line items';
  END IF;

  -- No receipts table yet (0005): a snapshot may not reference any receipt.
  IF jsonb_path_exists(NEW.snapshot, '$.lines[*].receipts[*]') THEN
    RAISE EXCEPTION USING ERRCODE = 'UC016',
      MESSAGE = 'SNAPSHOT_MISMATCH: snapshot lists receipts that do not exist';
  END IF;

  IF current_user = 'expense_app' THEN
    NEW.submitted_at := now();
    NEW.created_at   := now();
  END IF;
  RETURN NEW;
END
$$;

-- ===========================================================================
-- #7 approval_steps_guard — BEFORE INSERT/UPDATE/DELETE, row
-- ===========================================================================
CREATE FUNCTION public.approval_steps_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_is_app     boolean     := (current_user = 'expense_app');
  v_now        timestamptz := now();
  v_claim      record;
  v_ok         boolean;
  v_transition text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = 'UC007',
      MESSAGE = 'APPEND_ONLY: approval steps are never deleted';
  END IF;

  -- Lock order: the claim first (re-locking a lock the service already holds is a no-op).
  SELECT c.status, c.claimant_id, c.current_revision, c.current_submission_id INTO v_claim
    FROM public.claims c
   WHERE c.id = CASE WHEN TG_OP = 'INSERT' THEN NEW.claim_id ELSE OLD.claim_id END
     FOR NO KEY UPDATE;

  -- ---------------------------------------------------------------- INSERT
  IF TG_OP = 'INSERT' THEN
    IF NOT FOUND THEN
      RETURN NEW;  -- FK raises 23503
    END IF;
    IF v_claim.status NOT IN ('DRAFT', 'REJECTED') OR NOT EXISTS (
         SELECT 1 FROM public.claim_submissions s
          WHERE s.id = NEW.submission_id AND s.claim_id = NEW.claim_id
            AND s.revision = v_claim.current_revision + 1) THEN
      RAISE EXCEPTION USING ERRCODE = 'UC012',
        MESSAGE = 'CHAIN_INVALID: approval steps are created only by a submit, for the claim''s newest submission';
    END IF;
    SELECT (u.is_active AND u.can_approve AND u.role <> 'FINANCE' AND u.id <> v_claim.claimant_id) INTO v_ok
      FROM public.users u WHERE u.id = NEW.approver_id;
    IF v_ok IS NOT TRUE THEN
      RAISE EXCEPTION USING ERRCODE = 'UC008',
        MESSAGE = 'APPROVER_NOT_ELIGIBLE: an approver is active, can approve, is not Finance and is not the claimant';
    END IF;
    IF NEW.decided_at IS NOT NULL OR NEW.cancelled_at IS NOT NULL
       OR NEW.comment IS NOT NULL OR NEW.rejection_reason IS NOT NULL
       OR (NEW.level = 1 AND NEW.status <> 'PENDING')
       OR (NEW.level > 1 AND (NEW.status <> 'WAITING' OR NEW.activated_at IS NOT NULL)) THEN
      RAISE EXCEPTION USING ERRCODE = 'UC012',
        MESSAGE = 'CHAIN_INVALID: level 1 starts PENDING, later levels start WAITING, nothing is decided yet';
    END IF;
    IF NEW.status = 'PENDING' AND (v_is_app OR NEW.activated_at IS NULL) THEN
      NEW.activated_at := v_now;
    END IF;
    IF v_is_app THEN
      NEW.created_at := v_now;
    END IF;
    RETURN NEW;
  END IF;

  -- ---------------------------------------------------------------- UPDATE
  IF OLD.status IN ('APPROVED', 'REJECTED', 'CANCELLED') THEN
    RAISE EXCEPTION USING ERRCODE = 'UC006',
      MESSAGE = format('ALREADY_DECIDED: approval step %s is already %s', OLD.id, OLD.status);
  END IF;

  IF (NEW.id, NEW.claim_id, NEW.submission_id, NEW.level, NEW.tier_code, NEW.tier_label,
      NEW.applies_above_minor, NEW.approver_id, NEW.resolved_via, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.claim_id, OLD.submission_id, OLD.level, OLD.tier_code, OLD.tier_label,
      OLD.applies_above_minor, OLD.approver_id, OLD.resolved_via, OLD.created_at) THEN
    RAISE EXCEPTION USING ERRCODE = 'UC010',
      MESSAGE = 'IMMUTABLE_FIELD: an approval step''s approver, level, tier and submission never change';
  END IF;

  IF NEW.status = OLD.status THEN
    IF NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION USING ERRCODE = 'UC010',
        MESSAGE = 'IMMUTABLE_FIELD: an open step changes only through a status transition';
    END IF;
    RETURN NEW;
  END IF;

  IF v_claim.status IS DISTINCT FROM 'SUBMITTED' OR v_claim.current_submission_id IS DISTINCT FROM OLD.submission_id THEN
    RAISE EXCEPTION USING ERRCODE = 'UC005',
      MESSAGE = 'INVALID_STATUS_TRANSITION: steps change only while their submission is the one in approval';
  END IF;

  v_transition := OLD.status::text || '>' || NEW.status::text;

  IF v_transition NOT IN ('WAITING>PENDING', 'PENDING>APPROVED', 'PENDING>REJECTED', 'WAITING>CANCELLED', 'PENDING>CANCELLED') THEN
    RAISE EXCEPTION USING ERRCODE = 'UC005',
      MESSAGE = format('INVALID_STATUS_TRANSITION: step %s -> %s is not allowed', OLD.status, NEW.status);
  END IF;

  IF (NEW.activated_at IS DISTINCT FROM OLD.activated_at AND v_transition <> 'WAITING>PENDING')
     OR (NEW.decided_at IS DISTINCT FROM OLD.decided_at AND v_transition NOT IN ('PENDING>APPROVED', 'PENDING>REJECTED'))
     OR (NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at AND v_transition NOT IN ('WAITING>CANCELLED', 'PENDING>CANCELLED'))
     OR (NEW.comment IS DISTINCT FROM OLD.comment AND v_transition <> 'PENDING>APPROVED')
     OR (NEW.rejection_reason IS DISTINCT FROM OLD.rejection_reason AND v_transition <> 'PENDING>REJECTED') THEN
    RAISE EXCEPTION USING ERRCODE = 'UC010',
      MESSAGE = 'IMMUTABLE_FIELD: a step''s timestamps, comment and reason change only in their own transition';
  END IF;

  CASE v_transition
    WHEN 'WAITING>PENDING' THEN
      IF NOT EXISTS (SELECT 1 FROM public.approval_steps p
                      WHERE p.submission_id = OLD.submission_id AND p.level = OLD.level - 1
                        AND p.status = 'APPROVED') THEN
        RAISE EXCEPTION USING ERRCODE = 'UC012',
          MESSAGE = 'CHAIN_INVALID: a level activates only after the previous level is approved';
      END IF;
      NEW.activated_at := CASE WHEN v_is_app OR NEW.activated_at IS NULL THEN v_now ELSE NEW.activated_at END;
    WHEN 'PENDING>APPROVED', 'PENDING>REJECTED' THEN
      -- eligibility re-checked at decision time (a demotion mid-chain can't produce an approval)
      SELECT (u.is_active AND u.can_approve AND u.role <> 'FINANCE' AND u.id <> v_claim.claimant_id) INTO v_ok
        FROM public.users u WHERE u.id = OLD.approver_id;
      IF v_ok IS NOT TRUE THEN
        RAISE EXCEPTION USING ERRCODE = 'UC008',
          MESSAGE = 'APPROVER_NOT_ELIGIBLE: the approver is no longer eligible to decide this step';
      END IF;
      NEW.decided_at := CASE WHEN v_is_app OR NEW.decided_at IS NULL THEN v_now ELSE NEW.decided_at END;
    ELSE  -- 'WAITING>CANCELLED', 'PENDING>CANCELLED' (rejection at an earlier level, or recall)
      NEW.cancelled_at := CASE WHEN v_is_app OR NEW.cancelled_at IS NULL THEN v_now ELSE NEW.cancelled_at END;
  END CASE;

  RETURN NEW;
END
$$;

-- ===========================================================================
-- #8 forbid_mutation — append-only tables. On claim_events INSERT by expense_app the DB
-- stamps occurred_at and tx_id, so the app can neither backdate an event nor attribute it
-- to another transaction.
-- ===========================================================================
CREATE FUNCTION public.forbid_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    RAISE EXCEPTION USING ERRCODE = 'UC007',
      MESSAGE = format('APPEND_ONLY: %s rows cannot be %s', TG_TABLE_NAME, lower(TG_OP) || 'd');
  END IF;
  IF current_user = 'expense_app' THEN
    NEW.occurred_at := now();
    NEW.tx_id := pg_current_xact_id()::text::bigint;
  END IF;
  RETURN NEW;
END
$$;

-- ===========================================================================
-- #9 assert_transition_audited — deferred: COMMIT fails (UC015) unless THIS transaction
-- wrote the matching event with the right actor.
-- ===========================================================================
CREATE FUNCTION public.assert_transition_audited()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_tx   bigint := pg_current_xact_id()::text::bigint;
  v_type public.claim_event_type;
BEGIN
  IF TG_TABLE_NAME = 'claims' THEN
    v_type := CASE OLD.status::text || '>' || NEW.status::text
                WHEN 'DRAFT>SUBMITTED'    THEN 'CLAIM_SUBMITTED'::public.claim_event_type
                WHEN 'REJECTED>SUBMITTED' THEN 'CLAIM_RESUBMITTED'::public.claim_event_type
                WHEN 'SUBMITTED>APPROVED' THEN 'CLAIM_APPROVED'::public.claim_event_type
                WHEN 'SUBMITTED>REJECTED' THEN 'CLAIM_REJECTED'::public.claim_event_type
                WHEN 'SUBMITTED>DRAFT'    THEN 'CLAIM_RECALLED'::public.claim_event_type
              END;
    IF v_type IS NULL OR NOT EXISTS (
         SELECT 1
           FROM public.claim_events e
          WHERE e.claim_id = NEW.id
            AND e.tx_id = v_tx
            AND e.type = v_type
            AND e.from_status = OLD.status
            AND e.to_status = NEW.status
            AND e.revision = NEW.current_revision
            AND e.submission_id IS NOT DISTINCT FROM NEW.current_submission_id
            AND CASE
                  WHEN v_type IN ('CLAIM_APPROVED', 'CLAIM_REJECTED') THEN
                    e.actor_role = 'APPROVER' AND EXISTS (
                      SELECT 1 FROM public.approval_steps st
                       WHERE st.id = e.step_id
                         AND st.submission_id = NEW.current_submission_id
                         AND st.approver_id = e.actor_id
                         AND st.status = CASE WHEN v_type = 'CLAIM_APPROVED'
                                              THEN 'APPROVED'::public.approval_step_status
                                              ELSE 'REJECTED'::public.approval_step_status END)
                  ELSE e.actor_role = 'CLAIMANT' AND e.actor_id = NEW.claimant_id
                END) THEN
      RAISE EXCEPTION USING ERRCODE = 'UC015',
        MESSAGE = format('AUDIT_EVENT_MISSING: claim %s moved %s -> %s without a matching %s event by the right actor in this transaction',
                         NEW.claim_number, OLD.status, NEW.status, v_type);
    END IF;
  ELSE  -- approval_steps: a decision needs an event naming this step, written by its approver
    IF NOT EXISTS (
         SELECT 1
           FROM public.claim_events e
          WHERE e.claim_id = NEW.claim_id
            AND e.tx_id = v_tx
            AND e.step_id = NEW.id
            AND e.submission_id = NEW.submission_id
            AND e.actor_role = 'APPROVER'
            AND e.actor_id = NEW.approver_id
            AND e.type = ANY (CASE WHEN NEW.status = 'APPROVED'
                                   THEN ARRAY['STEP_APPROVED', 'CLAIM_APPROVED']::public.claim_event_type[]
                                   ELSE ARRAY['CLAIM_REJECTED']::public.claim_event_type[] END)) THEN
      RAISE EXCEPTION USING ERRCODE = 'UC015',
        MESSAGE = format('AUDIT_EVENT_MISSING: step %s became %s without a matching event by its approver in this transaction',
                         NEW.id, NEW.status);
    END IF;
  END IF;
  RETURN NULL;
END
$$;

-- ===========================================================================
-- #4 claims_guard — v2 (CREATE OR REPLACE; the trigger stays bound). Full transition
-- whitelist plus the workflow preconditions.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.claims_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_is_app     boolean     := (current_user = 'expense_app');
  v_now        timestamptz := now();          -- transaction start: one instant per transition
  v_transition text;
  v_seq        bigint;
  v_lines      integer;
  v_tiers      integer;
  v_steps      integer;
  v_bad        integer;
  v_sub        record;
BEGIN
  -- ---------------------------------------------------------------- INSERT
  IF TG_OP = 'INSERT' THEN
    IF NEW.total_minor IS DISTINCT FROM 0 THEN
      RAISE EXCEPTION USING ERRCODE = 'UC003',
        MESSAGE = 'TOTAL_IS_DERIVED: a claim is created with total_minor = 0; the total is derived from its line items';
    END IF;
    IF NEW.status <> 'DRAFT' OR NEW.current_revision <> 0 OR NEW.current_submission_id IS NOT NULL
       OR NEW.submitted_at IS NOT NULL OR NEW.approved_at IS NOT NULL OR NEW.rejected_at IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'UC005',
        MESSAGE = 'INVALID_STATUS_TRANSITION: a claim is created as an empty DRAFT (revision 0, no submission)';
    END IF;
    IF v_is_app THEN
      -- claim_number is DB-owned. Keep it only if it is the number the column DEFAULT just drew in
      -- this session (so the sequence is not consumed twice); anything app-supplied is replaced.
      BEGIN
        v_seq := currval('public.claim_number_seq');
      EXCEPTION WHEN object_not_in_prerequisite_state THEN
        v_seq := NULL;
      END;
      IF v_seq IS NULL OR NEW.claim_number IS DISTINCT FROM
           'EXP-' || to_char(v_now AT TIME ZONE 'Asia/Kolkata', 'YYYY') || '-'
           || lpad(v_seq::text, greatest(6, length(v_seq::text)), '0') THEN
        NEW.claim_number := public.next_claim_number();
      END IF;
      NEW.created_at := v_now;
    END IF;
    RETURN NEW;
  END IF;

  -- ---------------------------------------------------------------- DELETE
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'APPROVED' THEN
      RAISE EXCEPTION USING ERRCODE = 'UC001',
        MESSAGE = format('CLAIM_LOCKED: claim %s is approved and read-only', OLD.claim_number);
    END IF;
    IF OLD.current_revision > 0 THEN
      RAISE EXCEPTION USING ERRCODE = 'UC017',
        MESSAGE = format('CLAIM_HAS_HISTORY: claim %s was submitted and cannot be deleted', OLD.claim_number);
    END IF;
    RETURN OLD;
  END IF;

  -- ---------------------------------------------------------------- UPDATE
  IF OLD.status = 'APPROVED' THEN
    RAISE EXCEPTION USING ERRCODE = 'UC001',
      MESSAGE = format('CLAIM_LOCKED: claim %s is approved and read-only', OLD.claim_number);
  END IF;

  IF (NEW.id, NEW.claimant_id, NEW.claim_number, NEW.currency, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.claimant_id, OLD.claim_number, OLD.currency, OLD.created_at) THEN
    RAISE EXCEPTION USING ERRCODE = 'UC010',
      MESSAGE = 'IMMUTABLE_FIELD: id, claimant, claim number, currency and created_at never change';
  END IF;

  IF NEW.total_minor IS DISTINCT FROM OLD.total_minor THEN
    IF pg_trigger_depth() < 2 THEN   -- not called from the recompute trigger
      RAISE EXCEPTION USING ERRCODE = 'UC003',
        MESSAGE = 'TOTAL_IS_DERIVED: total_minor is computed from line items and cannot be written';
    END IF;
    IF OLD.status NOT IN ('DRAFT', 'REJECTED') THEN
      RAISE EXCEPTION USING ERRCODE = 'UC002',
        MESSAGE = format('CLAIM_NOT_EDITABLE: claim %s is %s', OLD.claim_number, OLD.status);
    END IF;
  END IF;

  IF NEW.title IS DISTINCT FROM OLD.title AND OLD.status = 'SUBMITTED' THEN
    RAISE EXCEPTION USING ERRCODE = 'UC002',
      MESSAGE = format('CLAIM_NOT_EDITABLE: claim %s is in approval; recall it to edit', OLD.claim_number),
      HINT = 'RECALL_TO_EDIT';
  END IF;

  v_transition := OLD.status::text || '>' || NEW.status::text;

  IF NEW.status <> OLD.status AND v_transition NOT IN ('DRAFT>SUBMITTED', 'REJECTED>SUBMITTED', 'SUBMITTED>DRAFT',
                                                       'SUBMITTED>APPROVED', 'SUBMITTED>REJECTED') THEN
    RAISE EXCEPTION USING ERRCODE = 'UC005',
      MESSAGE = format('INVALID_STATUS_TRANSITION: %s -> %s is not allowed', OLD.status, NEW.status);
  END IF;

  -- DB-owned transition timestamps change only inside their own transition (all roles)
  IF (NEW.submitted_at IS DISTINCT FROM OLD.submitted_at AND v_transition NOT IN ('DRAFT>SUBMITTED', 'REJECTED>SUBMITTED'))
     OR (NEW.approved_at IS DISTINCT FROM OLD.approved_at AND v_transition <> 'SUBMITTED>APPROVED')
     OR (NEW.rejected_at IS DISTINCT FROM OLD.rejected_at AND v_transition NOT IN ('SUBMITTED>REJECTED', 'REJECTED>SUBMITTED')) THEN
    RAISE EXCEPTION USING ERRCODE = 'UC010',
      MESSAGE = 'IMMUTABLE_FIELD: submitted_at / approved_at / rejected_at are set by the database at their transition';
  END IF;

  IF NEW.status = OLD.status THEN
    IF (NEW.current_revision, NEW.current_submission_id) IS DISTINCT FROM (OLD.current_revision, OLD.current_submission_id) THEN
      RAISE EXCEPTION USING ERRCODE = 'UC010',
        MESSAGE = 'IMMUTABLE_FIELD: the submission pointer moves only on submit';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status <> 'SUBMITTED'
     AND (NEW.current_revision, NEW.current_submission_id) IS DISTINCT FROM (OLD.current_revision, OLD.current_submission_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'UC010',
      MESSAGE = 'IMMUTABLE_FIELD: the submission pointer moves only on submit';
  END IF;

  IF NEW.status = 'SUBMITTED' THEN
    -- (a) zero line items are never submittable
    SELECT count(*) INTO v_lines FROM public.line_items li WHERE li.claim_id = NEW.id;
    IF v_lines = 0 THEN
      RAISE EXCEPTION USING ERRCODE = 'UC004',
        MESSAGE = format('NO_LINE_ITEMS: claim %s has no line items', NEW.claim_number);
    END IF;
    -- (b) points at this claim's brand-new submission (revision N+1)
    SELECT s.revision, s.total_minor, s.line_item_count, s.snapshot ->> 'title' AS title INTO v_sub
      FROM public.claim_submissions s
     WHERE s.id = NEW.current_submission_id AND s.claim_id = NEW.id;
    IF NOT FOUND OR NEW.current_revision <> OLD.current_revision + 1 OR v_sub.revision <> NEW.current_revision THEN
      RAISE EXCEPTION USING ERRCODE = 'UC012',
        MESSAGE = 'CHAIN_INVALID: a submit points at this claim''s new submission (revision N+1)';
    END IF;
    IF v_sub.total_minor <> NEW.total_minor OR v_sub.line_item_count <> v_lines OR v_sub.title IS DISTINCT FROM NEW.title THEN
      RAISE EXCEPTION USING ERRCODE = 'UC016',
        MESSAGE = 'SNAPSHOT_MISMATCH: the submission no longer matches the claim being submitted';
    END IF;
    -- (c) the chain = every active tier with total > applies_above_minor, in level order:
    --     same count, levels exactly 1..n, tier copies match, level 1 PENDING + activated, rest WAITING
    WITH tiers AS (
      SELECT t.code, t.applies_above_minor, row_number() OVER (ORDER BY t.level) AS rn
        FROM public.approval_policy_tiers t
       WHERE t.is_active AND t.applies_above_minor < NEW.total_minor
    ), steps AS (
      SELECT st.level, st.tier_code, st.applies_above_minor, st.status, st.activated_at
        FROM public.approval_steps st
       WHERE st.submission_id = NEW.current_submission_id
    )
    SELECT (SELECT count(*) FROM tiers),
           (SELECT count(*) FROM steps),
           (SELECT count(*)
              FROM tiers t FULL JOIN steps s ON s.level = t.rn
             WHERE t.rn IS NULL OR s.level IS NULL
                OR s.tier_code <> t.code OR s.applies_above_minor <> t.applies_above_minor
                OR (s.level = 1 AND (s.status <> 'PENDING' OR s.activated_at IS NULL))
                OR (s.level > 1 AND s.status <> 'WAITING'))
      INTO v_tiers, v_steps, v_bad;
    IF v_tiers = 0 OR v_steps <> v_tiers OR v_bad > 0 THEN
      RAISE EXCEPTION USING ERRCODE = 'UC012',
        MESSAGE = format('CHAIN_INVALID: claim %s needs %s approval level(s) for total %s; the chain has %s step(s) (%s bad)',
                         NEW.claim_number, v_tiers, NEW.total_minor, v_steps, v_bad);
    END IF;
    NEW.submitted_at := CASE WHEN v_is_app OR NEW.submitted_at IS NOT DISTINCT FROM OLD.submitted_at
                             THEN v_now ELSE NEW.submitted_at END;
    NEW.rejected_at := NULL;

  ELSIF NEW.status = 'APPROVED' THEN
    IF NOT EXISTS (SELECT 1 FROM public.approval_steps st WHERE st.submission_id = NEW.current_submission_id)
       OR EXISTS (SELECT 1 FROM public.approval_steps st
                   WHERE st.submission_id = NEW.current_submission_id AND st.status <> 'APPROVED') THEN
      RAISE EXCEPTION USING ERRCODE = 'UC011',
        MESSAGE = format('APPROVAL_INCOMPLETE: claim %s still has steps that are not approved', NEW.claim_number);
    END IF;
    NEW.approved_at := CASE WHEN v_is_app OR NEW.approved_at IS NULL THEN v_now ELSE NEW.approved_at END;

  ELSIF NEW.status = 'REJECTED' THEN
    IF NOT EXISTS (SELECT 1 FROM public.approval_steps st
                    WHERE st.submission_id = NEW.current_submission_id AND st.status = 'REJECTED')
       OR EXISTS (SELECT 1 FROM public.approval_steps st
                   WHERE st.submission_id = NEW.current_submission_id AND st.status IN ('WAITING', 'PENDING')) THEN
      RAISE EXCEPTION USING ERRCODE = 'UC011',
        MESSAGE = 'APPROVAL_INCOMPLETE: a rejection needs a rejected step and no open steps';
    END IF;
    NEW.rejected_at := CASE WHEN v_is_app OR NEW.rejected_at IS NULL THEN v_now ELSE NEW.rejected_at END;

  ELSE  -- SUBMITTED -> DRAFT (recall)
    IF EXISTS (SELECT 1 FROM public.approval_steps st
                WHERE st.submission_id = OLD.current_submission_id AND st.status IN ('WAITING', 'PENDING')) THEN
      RAISE EXCEPTION USING ERRCODE = 'UC012',
        MESSAGE = 'CHAIN_INVALID: cancel the open approval steps before recalling';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

-- ===========================================================================
-- Triggers
-- ===========================================================================
CREATE TRIGGER claim_submissions_00_append_only
  BEFORE UPDATE OR DELETE ON public.claim_submissions
  FOR EACH ROW EXECUTE FUNCTION public.forbid_mutation();

CREATE TRIGGER claim_submissions_10_verify
  BEFORE INSERT ON public.claim_submissions
  FOR EACH ROW EXECUTE FUNCTION public.claim_submissions_verify();

CREATE TRIGGER approval_steps_10_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.approval_steps
  FOR EACH ROW EXECUTE FUNCTION public.approval_steps_guard();

CREATE CONSTRAINT TRIGGER approval_steps_95_transition_audited
  AFTER UPDATE OF status ON public.approval_steps
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW.status IN ('APPROVED', 'REJECTED') AND OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.assert_transition_audited();

CREATE TRIGGER claim_events_00_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.claim_events
  FOR EACH ROW EXECUTE FUNCTION public.forbid_mutation();

CREATE CONSTRAINT TRIGGER claims_95_transition_audited
  AFTER UPDATE OF status ON public.claims
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.assert_transition_audited();

-- ===========================================================================
-- Grants (C-16)
-- ===========================================================================
GRANT SELECT                 ON public.approval_policy_tiers                TO expense_app;
GRANT SELECT, INSERT         ON public.claim_submissions, public.claim_events TO expense_app;
GRANT SELECT, INSERT, UPDATE ON public.approval_steps                       TO expense_app;


-- ====================================================================================================
-- migration: 0005_receipts  ->  prisma/migrations/20261021090000_receipts/migration.sql   (phase P6)
-- ====================================================================================================
-- >>>> PRISMA-GENERATED by `pnpm prisma migrate dev --create-only --name receipts` (do not hand-write; shown so the reader sees what was verified)
-- CreateTable
CREATE TABLE "receipts" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "claim_id" UUID NOT NULL,
    "line_item_id" UUID NOT NULL,
    "storage_key" VARCHAR(512) NOT NULL,
    "file_name" VARCHAR(255) NOT NULL,
    "content_type" VARCHAR(100) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "uploaded_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "receipts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "receipts_storage_key_key" ON "receipts"("storage_key");

-- CreateIndex
CREATE INDEX "receipts_line_item_idx" ON "receipts"("line_item_id");

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_line_item_id_claim_id_fkey" FOREIGN KEY ("line_item_id", "claim_id") REFERENCES "line_items"("id", "claim_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- >>>> HAND-WRITTEN: APPEND below the Prisma DDL
-- ---------------------------------------------------------------------------
-- HAND-APPENDED to the Prisma-generated receipts migration.
-- ---------------------------------------------------------------------------
ALTER TABLE public.receipts
  ADD CONSTRAINT receipts_content_type_allowed CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
  ADD CONSTRAINT receipts_size_range           CHECK (size_bytes BETWEEN 1 AND 10485760),
  ADD CONSTRAINT receipts_sha256_format        CHECK (sha256 ~ '^[0-9a-f]{64}$');

-- ===========================================================================
-- #10 receipts_before_write — BEFORE INSERT/UPDATE/DELETE, row: lock the parent claim, then
-- check it (UC001 approved, UC002 submitted / snapshot taken); a receipt never moves (UC010).
-- ===========================================================================
CREATE FUNCTION public.receipts_before_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.claim_id IS DISTINCT FROM OLD.claim_id
                           OR NEW.line_item_id IS DISTINCT FROM OLD.line_item_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'UC010',
      MESSAGE = 'IMMUTABLE_FIELD: a receipt cannot move to another line item or claim';
  END IF;
  IF TG_OP = 'DELETE' THEN
    PERFORM public.assert_claim_editable(OLD.claim_id);
    RETURN OLD;
  END IF;
  PERFORM public.assert_claim_editable(NEW.claim_id);
  RETURN NEW;
END
$$;

CREATE TRIGGER receipts_10_before_write
  BEFORE INSERT OR UPDATE OR DELETE ON public.receipts
  FOR EACH ROW EXECUTE FUNCTION public.receipts_before_write();

-- ===========================================================================
-- #6 claim_submissions_verify — v2 (CREATE OR REPLACE): the snapshot's receipts must equal
-- the live receipts too, so a forged storageKey/sha256 can never become "evidence".
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.claim_submissions_verify()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_c        record;
  v_lines    integer;
  v_snap_n   integer;
  v_snap_sum bigint;
  v_diff     integer;
BEGIN
  PERFORM public.assert_claim_editable(NEW.claim_id);   -- lock; APPROVED -> UC001; SUBMITTED / already snapshotted -> UC002

  SELECT c.claimant_id, c.title, c.currency, c.total_minor, c.current_revision,
         u.employee_code, u.name, u.email, d.code AS department_code
    INTO v_c
    FROM public.claims c
    JOIN public.users u ON u.id = c.claimant_id
    JOIN public.departments d ON d.id = u.department_id
   WHERE c.id = NEW.claim_id;
  IF NOT FOUND THEN
    RETURN NEW;  -- FK raises 23503
  END IF;

  SELECT count(*) INTO v_lines FROM public.line_items li WHERE li.claim_id = NEW.claim_id;
  IF v_lines = 0
     OR jsonb_typeof(NEW.snapshot -> 'lines') IS DISTINCT FROM 'array'
     OR jsonb_array_length(CASE WHEN jsonb_typeof(NEW.snapshot -> 'lines') = 'array'
                                THEN NEW.snapshot -> 'lines' ELSE '[]'::jsonb END) = 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'UC004',
      MESSAGE = 'NO_LINE_ITEMS: a submission needs at least one line item';
  END IF;

  IF NEW.revision IS DISTINCT FROM v_c.current_revision + 1 THEN
    RAISE EXCEPTION USING ERRCODE = 'UC016',
      MESSAGE = format('SNAPSHOT_MISMATCH: the next revision is %s, not %s', v_c.current_revision + 1, NEW.revision);
  END IF;
  IF NEW.submitted_by_id IS DISTINCT FROM v_c.claimant_id THEN
    RAISE EXCEPTION USING ERRCODE = 'UC016',
      MESSAGE = 'SNAPSHOT_MISMATCH: only the claimant submits a claim';
  END IF;
  IF NEW.currency IS DISTINCT FROM v_c.currency
     OR NEW.total_minor IS DISTINCT FROM v_c.total_minor
     OR NEW.line_item_count IS DISTINCT FROM v_lines
     OR (NEW.snapshot ->> 'v')          IS DISTINCT FROM '1'
     OR (NEW.snapshot ->> 'title')      IS DISTINCT FROM v_c.title
     OR (NEW.snapshot ->> 'currency')   IS DISTINCT FROM v_c.currency::text
     OR (NEW.snapshot ->> 'totalMinor') IS DISTINCT FROM v_c.total_minor::text
     OR (NEW.snapshot -> 'claimant')    IS DISTINCT FROM jsonb_build_object(
            'id', v_c.claimant_id, 'employeeCode', v_c.employee_code, 'name', v_c.name,
            'email', v_c.email, 'departmentCode', v_c.department_code) THEN
    RAISE EXCEPTION USING ERRCODE = 'UC016',
      MESSAGE = 'SNAPSHOT_MISMATCH: header (title, currency, total, line count, claimant) differs from the live claim';
  END IF;

  WITH snap AS (
    SELECT x."lineItemId", x."expenseDate", x."categoryId", x."categoryCode", x."categoryName", x."glCode",
           x."amountMinor", x.description, x.merchant
      FROM jsonb_to_recordset(NEW.snapshot -> 'lines') AS x(
             "lineItemId" uuid, "expenseDate" date, "categoryId" uuid, "categoryCode" text, "categoryName" text,
             "glCode" text, "amountMinor" integer, description text, merchant text)
  ), live AS (
    SELECT li.id, li.expense_date, li.category_id, cat.code::text, cat.name::text, cat.gl_code::text,
           li.amount_minor, li.description::text, li.merchant::text
      FROM public.line_items li
      JOIN public.categories cat ON cat.id = li.category_id
     WHERE li.claim_id = NEW.claim_id
  )
  SELECT (SELECT count(*) FROM (SELECT * FROM snap EXCEPT ALL SELECT * FROM live) AS a)
       + (SELECT count(*) FROM (SELECT * FROM live EXCEPT ALL SELECT * FROM snap) AS b),
         (SELECT count(*) FROM snap),
         (SELECT COALESCE(SUM("amountMinor"), 0) FROM snap)
    INTO v_diff, v_snap_n, v_snap_sum;
  IF v_diff <> 0 OR v_snap_n <> v_lines OR v_snap_sum <> v_c.total_minor THEN
    RAISE EXCEPTION USING ERRCODE = 'UC016',
      MESSAGE = 'SNAPSHOT_MISMATCH: snapshot lines differ from the live line items';
  END IF;

  -- Receipts: exact multiset equality per line (what the download route and a dispute rely on).
  WITH snap_r AS (
    SELECT (l ->> 'lineItemId')::uuid AS line_item_id, r."receiptId", r."fileName", r."contentType",
           r."sizeBytes", r.sha256, r."storageKey"
      FROM jsonb_array_elements(NEW.snapshot -> 'lines') AS l
      CROSS JOIN LATERAL jsonb_to_recordset(COALESCE(l -> 'receipts', '[]'::jsonb)) AS r(
             "receiptId" uuid, "fileName" text, "contentType" text, "sizeBytes" integer, sha256 text, "storageKey" text)
  ), live_r AS (
    SELECT rc.line_item_id, rc.id, rc.file_name::text, rc.content_type::text, rc.size_bytes,
           rc.sha256::text, rc.storage_key::text
      FROM public.receipts rc
     WHERE rc.claim_id = NEW.claim_id
  )
  SELECT (SELECT count(*) FROM (SELECT * FROM snap_r EXCEPT ALL SELECT * FROM live_r) AS a)
       + (SELECT count(*) FROM (SELECT * FROM live_r EXCEPT ALL SELECT * FROM snap_r) AS b)
    INTO v_diff;
  IF v_diff <> 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'UC016',
      MESSAGE = 'SNAPSHOT_MISMATCH: snapshot receipts differ from the live receipts';
  END IF;

  IF current_user = 'expense_app' THEN
    NEW.submitted_at := now();
    NEW.created_at   := now();
  END IF;
  RETURN NEW;
END
$$;

GRANT SELECT, INSERT, DELETE ON public.receipts TO expense_app;


-- ====================================================================================================
-- NOT VERIFIED HERE (OPTIONAL in canonical C-23): …_export_runs (BUF), …_receipt_upload_intents (§8 BUF).
-- If built, follow the same pattern: explicit grants in the migration, schema-qualified functions with a pinned
-- search_path, and a guard trigger allowing exactly one RUNNING -> SUCCEEDED/FAILED transition on export_runs.
-- ====================================================================================================
