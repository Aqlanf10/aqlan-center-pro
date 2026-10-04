-- Run using psql as the role administrator after all schema migrations.
-- Set psql variables runtime_user and runtime_password through the operator's
-- secure provisioning process. Never commit or print their values.
-- Creates a NEW role only; deliberately does not alter an existing identity.
\set ON_ERROR_STOP on
\set ECHO none
\set QUIET 1
\if :{?runtime_user}
\else
  \echo 'runtime_user variable is required'
  \quit 3
\endif
\if :{?runtime_password}
\else
  \echo 'runtime_password variable is required'
  \quit 3
\endif
SELECT length(:'runtime_password') >= 24 AS password_valid,
       :'runtime_user' ~ '^[a-z][a-z0-9_]{2,62}$' AS username_valid \gset
\if :password_valid
\else
  \echo 'Runtime password must contain at least 24 characters'
  \quit 3
\endif
\if :username_valid
\else
  \echo 'Runtime role name must be 3-63 lowercase letters/digits/underscores'
  \quit 3
\endif
BEGIN;
SET LOCAL password_encryption='scram-sha-256';
SELECT format('CREATE ROLE %I LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', :'runtime_user', :'runtime_password') \gexec
SELECT format('GRANT clinic_runtime TO %I', :'runtime_user') \gexec
SELECT format('ALTER ROLE %I SET search_path=pg_catalog,clinic', :'runtime_user') \gexec
COMMIT;
\unset runtime_password
\echo 'Runtime role provisioned. Store its database URL in the server secret configuration.'
