-- Application authentication; credentials are never exposed through read APIs.
CREATE TABLE clinic.login_account (
 staff_id uuid PRIMARY KEY REFERENCES clinic.staff,
 username text NOT NULL UNIQUE CHECK(username=lower(username) AND length(username) BETWEEN 3 AND 100),
 password_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE clinic.session (
 token_hash text PRIMARY KEY CHECK(length(token_hash)=64),
 staff_id uuid NOT NULL REFERENCES clinic.login_account(staff_id),
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX session_expiry ON clinic.session(expires_at);
REVOKE ALL ON clinic.login_account,clinic.session FROM PUBLIC;
INSERT INTO clinic.schema_version VALUES(3,now());
