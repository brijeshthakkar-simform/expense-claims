-- ============================================================================
-- docker/postgres/initdb/01-roles.sh  (runs ONCE, as the postgres superuser, on an empty volume)
-- In the real script the passwords come from ${DB_OWNER_PASSWORD} / ${DB_APP_PASSWORD}.
-- Roles are cluster-wide; the DATABASE part is repeated for every database that needs it
-- (expense_claims, expense_perf, and the single Testcontainers DB) so tests run with prod privileges.
-- ============================================================================

-- ---- cluster part (once) ----------------------------------------------------
CREATE ROLE expense_owner LOGIN PASSWORD '{{OWNER_PW}}'
  NOSUPERUSER NOCREATEROLE CREATEDB NOBYPASSRLS;          -- CREATEDB only for the local Prisma shadow DB
CREATE ROLE expense_app LOGIN PASSWORD '{{APP_PW}}'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;
ALTER ROLE expense_app SET statement_timeout = '15s';
ALTER ROLE expense_app SET lock_timeout = '5s';
ALTER ROLE expense_app SET idle_in_transaction_session_timeout = '30s';

-- ---- database part (per database) -------------------------------------------
-- @@DB
CREATE DATABASE {{DB}} OWNER expense_owner;
ALTER DATABASE {{DB}} SET timezone TO 'UTC';
REVOKE ALL ON DATABASE {{DB}} FROM PUBLIC;                -- drops PUBLIC's CONNECT + TEMPORARY (temp-table shadowing)
GRANT CONNECT ON DATABASE {{DB}} TO expense_app;
-- @@IN_DB  (the rest runs connected to {{DB}})
ALTER SCHEMA public OWNER TO expense_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;                  -- no CREATE (and no implicit USAGE) for anyone else
GRANT USAGE ON SCHEMA public TO expense_app;
