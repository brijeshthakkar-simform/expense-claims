-- >>>> HAND-WRITTEN (the Prisma-generated file is empty)
-- Hand-written. Explicit grants per table, in the migration that creates the table's
-- privileges (C-16). NO `ALTER DEFAULT PRIVILEGES` for DML: a new table is never
-- accidentally writable by the app. Database-level REVOKEs live in 01-roles.sh.
-- expense_app gets no TRUNCATE, TRIGGER or REFERENCES anywhere, and nothing on _prisma_migrations.

GRANT SELECT                         ON public.departments, public.users, public.categories TO expense_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sessions, public.claims, public.line_items  TO expense_app;
GRANT SELECT                         ON public.v_claim_total_drift                         TO expense_app;
GRANT USAGE, SELECT                  ON SEQUENCE public.claim_number_seq                    TO expense_app;

-- Added after the SQL proof (01 §4 trap 17): `prisma migrate reset` recreates schema public,
-- which drops the schema-level grants 01-roles.sh made. Re-assert them here (idempotent). TC-I07 checks.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO expense_app;
