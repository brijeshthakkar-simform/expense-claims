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
