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
