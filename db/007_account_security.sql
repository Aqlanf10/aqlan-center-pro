-- Self-service identity security; no branch permission grants global account administration.
-- The trusted server verifies current plaintext password using scrypt before calling
-- change_account_password, passing the exact verified stored hash and version as CAS.
-- Never put plaintext, password hashes, or session token hashes into audit/operation.
-- All identity mutations lock login_account first, then sessions. Login's expensive
-- scrypt check occurs outside the transaction; issue_session rejects its stale version.
-- Server enforces same-origin JSON POST, secure cookies, password bounds and throttling.
-- Function actor/current token arguments come exclusively from the authenticated server.
-- Successful current-session revocation/password change requires clearing the cookie.
ALTER TABLE clinic.login_account ADD COLUMN credential_version integer NOT NULL DEFAULT 1
 CHECK(credential_version BETWEEN 1 AND 2147483646);
ALTER TABLE clinic.session ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE;
ALTER TABLE clinic.session ADD COLUMN credential_version integer NOT NULL DEFAULT 1
 CHECK(credential_version BETWEEN 1 AND 2147483646);
CREATE TABLE clinic.auth_audit (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 actor_id uuid NOT NULL REFERENCES clinic.staff,
 action text NOT NULL CHECK(action IN ('session.revoked','sessions.others_revoked','password.changed')),
 target_session_id uuid,
 affected_sessions integer NOT NULL CHECK(affected_sessions>=0),
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((action='session.revoked')=(target_session_id IS NOT NULL))
);
CREATE TRIGGER immutable_auth_audit BEFORE UPDATE OR DELETE ON clinic.auth_audit
 FOR EACH ROW EXECUTE FUNCTION clinic.reject_mutation();

-- Private helper: returned credential row (including hash) must never be public API data.
CREATE FUNCTION clinic.require_account_session(p_actor uuid,p_current_token_hash text)
RETURNS clinic.login_account LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,clinic AS $$
DECLARE account_row clinic.login_account;
BEGIN
 SELECT * INTO account_row FROM clinic.login_account WHERE staff_id=p_actor FOR UPDATE;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM clinic.staff WHERE id=p_actor AND active)
  OR NOT EXISTS(SELECT 1 FROM clinic.session WHERE staff_id=p_actor AND token_hash=p_current_token_hash
    AND expires_at>now() AND credential_version=account_row.credential_version)
 THEN RAISE EXCEPTION 'AUTH_REQUIRED' USING ERRCODE='42501'; END IF;
 RETURN account_row;
END $$;

CREATE FUNCTION clinic.issue_session(p_actor uuid,p_expected_credential_version integer,p_token_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,clinic AS $$
DECLARE account_row clinic.login_account; session_row clinic.session;
BEGIN
 IF p_token_hash IS NULL OR p_token_hash !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'INVALID_SESSION_HASH'; END IF;
 SELECT * INTO account_row FROM clinic.login_account WHERE staff_id=p_actor FOR UPDATE;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM clinic.staff WHERE id=p_actor AND active)
 THEN RAISE EXCEPTION 'AUTH_REQUIRED' USING ERRCODE='42501'; END IF;
 IF p_expected_credential_version IS DISTINCT FROM account_row.credential_version
 THEN RAISE EXCEPTION 'STALE_CREDENTIAL_VERSION'; END IF;
 INSERT INTO clinic.session(token_hash,staff_id,credential_version,expires_at)
 VALUES(p_token_hash,p_actor,account_row.credential_version,now()+interval '8 hours') RETURNING * INTO session_row;
 RETURN jsonb_build_object('id',session_row.id,'credentialVersion',session_row.credential_version,'expiresAt',session_row.expires_at);
END $$;

CREATE FUNCTION clinic.account_sessions(p_actor uuid,p_current_token_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,clinic AS $$
DECLARE account_row clinic.login_account; sessions jsonb;
BEGIN
 account_row:=clinic.require_account_session(p_actor,p_current_token_hash);
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'createdAt',created_at,'expiresAt',expires_at,
  'current',token_hash=p_current_token_hash) ORDER BY created_at DESC,id),'[]'::jsonb) INTO sessions
 FROM clinic.session WHERE staff_id=p_actor AND expires_at>now() AND credential_version=account_row.credential_version;
 RETURN jsonb_build_object('credentialVersion',account_row.credential_version,'sessions',sessions);
END $$;

CREATE FUNCTION clinic.revoke_account_session(p_actor uuid,p_current_token_hash text,p_target_session_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,clinic AS $$
DECLARE target clinic.session;
BEGIN
 PERFORM clinic.require_account_session(p_actor,p_current_token_hash);
 DELETE FROM clinic.session WHERE staff_id=p_actor AND id=p_target_session_id RETURNING * INTO target;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE='P0002'; END IF;
 INSERT INTO clinic.auth_audit(actor_id,action,target_session_id,affected_sessions)
 VALUES(p_actor,'session.revoked',target.id,1);
 RETURN jsonb_build_object('revoked',true,'signedOut',target.token_hash=p_current_token_hash);
END $$;

CREATE FUNCTION clinic.revoke_other_sessions(p_actor uuid,p_current_token_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,clinic AS $$
DECLARE affected integer;
BEGIN
 PERFORM clinic.require_account_session(p_actor,p_current_token_hash);
 DELETE FROM clinic.session WHERE staff_id=p_actor AND token_hash<>p_current_token_hash;
 GET DIAGNOSTICS affected=ROW_COUNT;
 IF affected>0 THEN
  INSERT INTO clinic.auth_audit(actor_id,action,affected_sessions) VALUES(p_actor,'sessions.others_revoked',affected);
 END IF;
 RETURN jsonb_build_object('revokedCount',affected);
END $$;

CREATE FUNCTION clinic.change_account_password(p_actor uuid,p_current_token_hash text,
 p_expected_credential_version integer,p_verified_old_hash text,p_new_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,clinic AS $$
DECLARE account_row clinic.login_account; affected integer;
BEGIN
 account_row:=clinic.require_account_session(p_actor,p_current_token_hash);
 IF p_expected_credential_version IS DISTINCT FROM account_row.credential_version
  OR p_verified_old_hash IS DISTINCT FROM account_row.password_hash
 THEN RAISE EXCEPTION 'STALE_CREDENTIAL_VERSION'; END IF;
 IF p_new_hash IS NULL OR p_new_hash !~ '^scrypt-v1\$[a-f0-9]{32}\$[a-f0-9]{128}$'
 THEN RAISE EXCEPTION 'INVALID_PASSWORD_HASH'; END IF;
 IF account_row.credential_version>=2147483646 THEN RAISE EXCEPTION 'CREDENTIAL_VERSION_EXHAUSTED'; END IF;
 UPDATE clinic.login_account SET password_hash=p_new_hash,credential_version=credential_version+1 WHERE staff_id=p_actor;
 DELETE FROM clinic.session WHERE staff_id=p_actor;
 GET DIAGNOSTICS affected=ROW_COUNT;
 INSERT INTO clinic.auth_audit(actor_id,action,affected_sessions) VALUES(p_actor,'password.changed',affected);
 RETURN jsonb_build_object('credentialVersion',account_row.credential_version+1,'signedOut',true);
END $$;

REVOKE ALL ON clinic.auth_audit FROM PUBLIC,clinic_runtime;
REVOKE INSERT,DELETE ON clinic.session FROM clinic_runtime;
GRANT SELECT,UPDATE ON clinic.login_account TO clinic_command_owner;
GRANT SELECT,INSERT,DELETE ON clinic.session TO clinic_command_owner;
GRANT INSERT ON clinic.auth_audit TO clinic_command_owner;
REVOKE ALL ON FUNCTION clinic.require_account_session(uuid,text),clinic.issue_session(uuid,integer,text),
 clinic.account_sessions(uuid,text),clinic.revoke_account_session(uuid,text,uuid),clinic.revoke_other_sessions(uuid,text),
 clinic.change_account_password(uuid,text,integer,text,text) FROM PUBLIC;
GRANT CREATE ON SCHEMA clinic TO clinic_command_owner;
ALTER FUNCTION clinic.require_account_session(uuid,text) OWNER TO clinic_command_owner;
ALTER FUNCTION clinic.issue_session(uuid,integer,text) OWNER TO clinic_command_owner;
ALTER FUNCTION clinic.account_sessions(uuid,text) OWNER TO clinic_command_owner;
ALTER FUNCTION clinic.revoke_account_session(uuid,text,uuid) OWNER TO clinic_command_owner;
ALTER FUNCTION clinic.revoke_other_sessions(uuid,text) OWNER TO clinic_command_owner;
ALTER FUNCTION clinic.change_account_password(uuid,text,integer,text,text) OWNER TO clinic_command_owner;
REVOKE CREATE ON SCHEMA clinic FROM clinic_command_owner;
GRANT EXECUTE ON FUNCTION clinic.issue_session(uuid,integer,text),clinic.account_sessions(uuid,text),
 clinic.revoke_account_session(uuid,text,uuid),clinic.revoke_other_sessions(uuid,text),
 clinic.change_account_password(uuid,text,integer,text,text) TO clinic_runtime;
INSERT INTO clinic.schema_version VALUES(7,now());
