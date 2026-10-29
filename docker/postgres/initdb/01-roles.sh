#!/usr/bin/env bash
# Runs once as the image superuser on an empty volume (initdb). Testcontainers mounts this same file,
# so tests get the same roles and REVOKEs as compose and production. Table grants live in migrations,
# explicitly per table, with no ALTER DEFAULT PRIVILEGES (03 §8.2).
set -euo pipefail
: "${DB_OWNER_PASSWORD:?}" "${DB_APP_PASSWORD:?}"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
     -v owner_pw="$DB_OWNER_PASSWORD" -v app_pw="$DB_APP_PASSWORD" -v db="$POSTGRES_DB" <<'SQL'
-- expense_owner: owns DB, schema and every object; used ONLY by the migrate job and host prisma CLI
CREATE ROLE expense_owner LOGIN PASSWORD :'owner_pw' NOSUPERUSER NOCREATEROLE NOBYPASSRLS CREATEDB; -- CREATEDB: local shadow DB
-- expense_app: runtime; owns nothing; DML grants come from migrations
CREATE ROLE expense_app LOGIN PASSWORD :'app_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;
ALTER ROLE expense_app SET statement_timeout = '15s';
ALTER ROLE expense_app SET lock_timeout = '5s';
ALTER ROLE expense_app SET idle_in_transaction_session_timeout = '30s';

ALTER DATABASE :"db" OWNER TO expense_owner;
ALTER DATABASE :"db" SET timezone TO 'UTC';
REVOKE ALL ON DATABASE :"db" FROM PUBLIC;                -- drops PUBLIC's CONNECT + TEMPORARY: no temp tables shadowing `claims` (RT-M10)
GRANT CONNECT ON DATABASE :"db" TO expense_app;
ALTER SCHEMA public OWNER TO expense_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;                 -- no CREATE (and no implicit USAGE) for anyone else
GRANT USAGE ON SCHEMA public TO expense_app;
-- These are the exact statements verified by the SQL proof (03 §16.1).
SQL
