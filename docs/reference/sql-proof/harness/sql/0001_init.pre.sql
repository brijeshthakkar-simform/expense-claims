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
