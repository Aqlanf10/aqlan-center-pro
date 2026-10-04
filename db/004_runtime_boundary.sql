-- Dedicated non-login roles. This migration requires a role administrator.
-- Do not grant clinic_command_owner membership to the HTTP runtime role.
CREATE ROLE clinic_command_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE clinic_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
REVOKE ALL ON SCHEMA clinic FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA clinic FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA clinic FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA clinic FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA clinic REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
GRANT USAGE ON SCHEMA clinic TO clinic_command_owner,clinic_runtime;
-- Command role can only mutate the tables required by execute().
GRANT SELECT ON clinic.staff,clinic.branch,clinic.membership,clinic.role_permission,
 clinic.patient,clinic.patient_branch,clinic.plan,clinic.plan_step,clinic.visit,
 clinic.visit_work,clinic.journal,clinic.journal_line,clinic.payment,clinic.operation TO clinic_command_owner;
GRANT INSERT ON clinic.patient,clinic.patient_branch,clinic.plan,clinic.plan_step,
 clinic.visit,clinic.visit_work,clinic.journal,clinic.journal_line,clinic.payment,
 clinic.operation,clinic.audit TO clinic_command_owner;
GRANT UPDATE ON clinic.plan,clinic.plan_step,clinic.visit,clinic.operation TO clinic_command_owner;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA clinic TO clinic_command_owner;
-- An owner change needs CREATE temporarily; remove it before committing migration.
GRANT CREATE ON SCHEMA clinic TO clinic_command_owner;
ALTER FUNCTION clinic.execute(uuid,uuid,uuid,text,jsonb) OWNER TO clinic_command_owner;
ALTER FUNCTION clinic.execute(uuid,uuid,uuid,text,jsonb) SECURITY DEFINER;
ALTER FUNCTION clinic.execute(uuid,uuid,uuid,text,jsonb) SET search_path=pg_catalog,clinic;
ALTER FUNCTION clinic.require_permission(uuid,uuid,text) OWNER TO clinic_command_owner;
ALTER FUNCTION clinic.require_permission(uuid,uuid,text) SECURITY DEFINER;
ALTER FUNCTION clinic.require_permission(uuid,uuid,text) SET search_path=pg_catalog,clinic;
REVOKE CREATE ON SCHEMA clinic FROM clinic_command_owner;
-- The application verifies sessions before passing an actor to execute().
-- Runtime credentials are a trusted backend boundary, never exposed to clients.
GRANT SELECT ON clinic.schema_version,clinic.branch,clinic.staff,clinic.membership,
 clinic.role_permission,clinic.specialty,clinic.patient,clinic.patient_branch,
 clinic.plan,clinic.plan_step,clinic.visit,clinic.journal,clinic.journal_line,
 clinic.payment,clinic.login_account,clinic.session TO clinic_runtime;
GRANT INSERT,DELETE ON clinic.session TO clinic_runtime;
GRANT EXECUTE ON FUNCTION clinic.execute(uuid,uuid,uuid,text,jsonb),
 clinic.require_permission(uuid,uuid,text) TO clinic_runtime;
INSERT INTO clinic.schema_version VALUES(4,now());
