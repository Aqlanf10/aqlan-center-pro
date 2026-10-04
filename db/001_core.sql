-- Copyright (c) 2026 Dr. Aqlan Alkamel. All rights reserved.
-- Run once in a transaction using the migration owner, never the web role.
CREATE SCHEMA clinic;
CREATE TABLE clinic.schema_version(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE clinic.branch (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 160),
  timezone text NOT NULL DEFAULT 'Asia/Aden', active boolean NOT NULL DEFAULT true
);
CREATE TABLE clinic.staff (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), display_name text NOT NULL,
  active boolean NOT NULL DEFAULT true
);
CREATE TABLE clinic.permission(code text PRIMARY KEY);
INSERT INTO clinic.permission VALUES
 ('patient.read'),('patient.write'),('clinical.read'),('clinical.write'),
 ('finance.read'),('finance.agree'),('finance.collect'),('finance.opening'),('finance.reverse'),
 ('appointment.write'),('settings.write');
CREATE TABLE clinic.role(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL UNIQUE);
CREATE TABLE clinic.role_permission(role_id uuid REFERENCES clinic.role, permission text REFERENCES clinic.permission,
  PRIMARY KEY(role_id,permission));
CREATE TABLE clinic.membership(staff_id uuid REFERENCES clinic.staff, branch_id uuid REFERENCES clinic.branch,
  role_id uuid REFERENCES clinic.role, PRIMARY KEY(staff_id,branch_id,role_id));
CREATE TABLE clinic.specialty(code text PRIMARY KEY, name_ar text NOT NULL);
INSERT INTO clinic.specialty VALUES ('general','طب الأسنان العام'),('orthodontics','تقويم الأسنان'),
 ('endodontics','علاج الجذور'),('periodontics','علاج اللثة'),('prosthodontics','التركيبات'),
 ('implantology','زراعة الأسنان'),('surgery','جراحة الفم'),('pediatric','أسنان الأطفال'),
 ('oral_medicine','طب الفم والمفصل'),('imaging','الأشعة والتصوير');
CREATE TABLE clinic.patient (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), file_number bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 primary_branch_id uuid NOT NULL REFERENCES clinic.branch,
 full_name text NOT NULL CHECK(length(trim(full_name)) BETWEEN 2 AND 200),
 phone text NOT NULL DEFAULT '' CHECK(length(phone)<=40),
 birth_date date, medical_history jsonb NOT NULL DEFAULT '{}',
 created_by uuid NOT NULL REFERENCES clinic.staff, created_at timestamptz NOT NULL DEFAULT now()
);
-- Phone is intentionally NOT unique: families may share a number.
CREATE INDEX patient_search_name ON clinic.patient(full_name);
CREATE INDEX patient_search_phone ON clinic.patient(phone);
CREATE TABLE clinic.patient_branch (
 patient_id uuid REFERENCES clinic.patient, branch_id uuid REFERENCES clinic.branch,
 PRIMARY KEY(patient_id,branch_id)
);
CREATE TABLE clinic.plan (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), patient_id uuid NOT NULL REFERENCES clinic.patient,
 branch_id uuid NOT NULL REFERENCES clinic.branch, specialty text NOT NULL REFERENCES clinic.specialty,
 title text NOT NULL CHECK(length(trim(title)) BETWEEN 2 AND 200),
 origin text NOT NULL CHECK(origin IN ('new','legacy')),
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','completed','cancelled')),
 currency text NOT NULL CHECK(currency IN ('YER','SAR','USD')),
 agreed numeric(18,2) CHECK(agreed>=0), previously_paid numeric(18,2) CHECK(previously_paid>=0),
 disputed boolean NOT NULL DEFAULT false,
 source_system text, source_record_id text, as_of_date date,
 clinical_summary jsonb NOT NULL DEFAULT '{}', clinical_schema_version integer NOT NULL DEFAULT 1,
 created_by uuid NOT NULL REFERENCES clinic.staff, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,patient_id,branch_id),
 FOREIGN KEY(patient_id,branch_id) REFERENCES clinic.patient_branch,
 CHECK(origin='legacy' OR (previously_paid IS NULL AND source_system IS NULL AND source_record_id IS NULL AND as_of_date IS NULL)),
 CHECK(origin='new' OR (source_system IS NOT NULL AND source_record_id IS NOT NULL AND length(trim(source_system))>0 AND length(trim(source_record_id))>0 AND as_of_date IS NOT NULL))
);
CREATE UNIQUE INDEX one_legacy_source ON clinic.plan(branch_id,source_system,source_record_id,currency) WHERE origin='legacy';
CREATE TABLE clinic.plan_step (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), plan_id uuid NOT NULL,
 patient_id uuid NOT NULL, branch_id uuid NOT NULL,
 procedure_name text NOT NULL CHECK(length(trim(procedure_name)) BETWEEN 2 AND 200),
 tooth text CHECK(tooth ~ '^([1-4][1-8]|[5-8][1-5])$'),
 status text NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','in_progress','done','cancelled')),
 FOREIGN KEY(plan_id,patient_id,branch_id) REFERENCES clinic.plan(id,patient_id,branch_id),
 UNIQUE(id,plan_id,patient_id,branch_id)
);
CREATE TABLE clinic.visit (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), plan_id uuid NOT NULL,
 patient_id uuid NOT NULL, branch_id uuid NOT NULL,
 occurred_on date NOT NULL, note text NOT NULL DEFAULT '' CHECK(length(note)<=10000),
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','signed')),
 signed_by uuid REFERENCES clinic.staff, signed_at timestamptz,
 FOREIGN KEY(plan_id,patient_id,branch_id) REFERENCES clinic.plan(id,patient_id,branch_id),
 CHECK((status='draft' AND signed_by IS NULL AND signed_at IS NULL) OR
       (status='signed' AND signed_by IS NOT NULL AND signed_at IS NOT NULL)),
 UNIQUE(id,plan_id,patient_id,branch_id)
);
CREATE TABLE clinic.visit_work (
 visit_id uuid NOT NULL, step_id uuid NOT NULL, plan_id uuid NOT NULL,
 patient_id uuid NOT NULL, branch_id uuid NOT NULL, performed_by uuid NOT NULL REFERENCES clinic.staff,
 PRIMARY KEY(visit_id,step_id),
 FOREIGN KEY(visit_id,plan_id,patient_id,branch_id) REFERENCES clinic.visit(id,plan_id,patient_id,branch_id),
 FOREIGN KEY(step_id,plan_id,patient_id,branch_id) REFERENCES clinic.plan_step(id,plan_id,patient_id,branch_id)
);
CREATE TABLE clinic.journal (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), branch_id uuid NOT NULL, patient_id uuid NOT NULL, plan_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('agreement','legacy_opening','payment','reversal')),
 actor_id uuid NOT NULL REFERENCES clinic.staff, recorded_at timestamptz NOT NULL DEFAULT now(), effective_date date NOT NULL,
 reverses uuid UNIQUE REFERENCES clinic.journal, reason text,
 FOREIGN KEY(plan_id,patient_id,branch_id) REFERENCES clinic.plan(id,patient_id,branch_id),
 CHECK((kind='reversal' AND reverses IS NOT NULL AND length(trim(reason))>=3) OR (kind<>'reversal' AND reverses IS NULL))
);
CREATE UNIQUE INDEX one_agreement_per_plan ON clinic.journal(plan_id) WHERE kind IN ('agreement','legacy_opening');
CREATE TABLE clinic.journal_line (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, journal_id uuid NOT NULL REFERENCES clinic.journal,
 account text NOT NULL CHECK(account IN ('RECEIVABLE','PATIENT_CREDIT','LEGACY_CLEARING','CONTRACT_CLEARING','CASH','FX_BRIDGE')),
 currency text NOT NULL CHECK(currency IN ('YER','SAR','USD')),
 debit numeric(18,2) NOT NULL DEFAULT 0 CHECK(debit>=0), credit numeric(18,2) NOT NULL DEFAULT 0 CHECK(credit>=0),
 CHECK((debit>0 AND credit=0) OR (credit>0 AND debit=0))
);
CREATE INDEX journal_plan ON clinic.journal(plan_id);
CREATE INDEX journal_line_parent ON clinic.journal_line(journal_id);
CREATE TABLE clinic.payment (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), journal_id uuid NOT NULL UNIQUE REFERENCES clinic.journal,
 amount numeric(18,2) NOT NULL CHECK(amount>0), currency text NOT NULL CHECK(currency IN ('YER','SAR','USD')),
 debt_amount numeric(18,2) NOT NULL CHECK(debt_amount>0), debt_currency text NOT NULL CHECK(debt_currency IN ('YER','SAR','USD')),
 rate numeric(24,12) NOT NULL CHECK(rate>0),
 rate_convention text NOT NULL DEFAULT 'payment_currency_per_debt_currency' CHECK(rate_convention='payment_currency_per_debt_currency'),
 CHECK(currency<>debt_currency OR rate=1)
);
CREATE TABLE clinic.operation (
 branch_id uuid NOT NULL REFERENCES clinic.branch, key uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES clinic.staff, command text NOT NULL, payload jsonb NOT NULL, result jsonb,
 PRIMARY KEY(branch_id,key)
);
CREATE TABLE clinic.audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, actor_id uuid NOT NULL REFERENCES clinic.staff,
 branch_id uuid NOT NULL REFERENCES clinic.branch, action text NOT NULL, entity_id uuid NOT NULL,
 occurred_at timestamptz NOT NULL DEFAULT now(), metadata jsonb NOT NULL DEFAULT '{}'
);

CREATE FUNCTION clinic.require_permission(p_actor uuid,p_branch uuid,p_permission text) RETURNS void
LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM clinic.membership m JOIN clinic.staff s ON s.id=m.staff_id
 JOIN clinic.branch b ON b.id=m.branch_id JOIN clinic.role_permission rp ON rp.role_id=m.role_id
 WHERE m.staff_id=p_actor AND m.branch_id=p_branch AND s.active AND b.active AND rp.permission=p_permission)
 THEN RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501'; END IF;
END $$;

CREATE FUNCTION clinic.reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 RAISE EXCEPTION 'APPEND_ONLY' USING ERRCODE='23514';
END $$;
CREATE TRIGGER immutable_journal BEFORE UPDATE OR DELETE ON clinic.journal FOR EACH ROW EXECUTE FUNCTION clinic.reject_mutation();
CREATE TRIGGER immutable_lines BEFORE UPDATE OR DELETE ON clinic.journal_line FOR EACH ROW EXECUTE FUNCTION clinic.reject_mutation();
CREATE TRIGGER immutable_payment BEFORE UPDATE OR DELETE ON clinic.payment FOR EACH ROW EXECUTE FUNCTION clinic.reject_mutation();
CREATE TRIGGER immutable_audit BEFORE UPDATE OR DELETE ON clinic.audit FOR EACH ROW EXECUTE FUNCTION clinic.reject_mutation();

-- Lines may be inserted only in the transaction that creates the journal header.
CREATE FUNCTION clinic.guard_journal_line() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM clinic.journal WHERE id=NEW.journal_id AND xmin::text=pg_current_xact_id()::text)
 THEN RAISE EXCEPTION 'JOURNAL_ALREADY_POSTED' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER prevent_late_lines BEFORE INSERT ON clinic.journal_line FOR EACH ROW EXECUTE FUNCTION clinic.guard_journal_line();

CREATE FUNCTION clinic.assert_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid;
BEGIN
 IF TG_TABLE_NAME='journal' THEN target:=NEW.id; ELSE target:=NEW.journal_id; END IF;
 IF NOT EXISTS(SELECT 1 FROM clinic.journal_line WHERE journal_id=target)
 OR EXISTS(SELECT 1 FROM clinic.journal_line WHERE journal_id=target GROUP BY currency HAVING sum(debit)<>sum(credit))
 THEN RAISE EXCEPTION 'UNBALANCED_JOURNAL' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER balance_header AFTER INSERT ON clinic.journal DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION clinic.assert_balanced();
CREATE CONSTRAINT TRIGGER balance_lines AFTER INSERT ON clinic.journal_line DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION clinic.assert_balanced();

CREATE FUNCTION clinic.guard_plan_finance() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (OLD.status<>'draft' OR EXISTS(SELECT 1 FROM clinic.journal WHERE plan_id=OLD.id)) AND
 ROW(NEW.patient_id,NEW.branch_id,NEW.currency,NEW.agreed,NEW.previously_paid,NEW.origin,NEW.source_system,NEW.source_record_id,NEW.as_of_date,NEW.disputed)
 IS DISTINCT FROM ROW(OLD.patient_id,OLD.branch_id,OLD.currency,OLD.agreed,OLD.previously_paid,OLD.origin,OLD.source_system,OLD.source_record_id,OLD.as_of_date,OLD.disputed)
 THEN RAISE EXCEPTION 'POSTED_AGREEMENT_IMMUTABLE' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protect_posted_plan BEFORE UPDATE ON clinic.plan FOR EACH ROW EXECUTE FUNCTION clinic.guard_plan_finance();
CREATE FUNCTION clinic.guard_signed_visit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.status='signed' THEN RAISE EXCEPTION 'SIGNED_VISIT_IMMUTABLE' USING ERRCODE='23514'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE TRIGGER protect_signed_visit BEFORE UPDATE OR DELETE ON clinic.visit FOR EACH ROW EXECUTE FUNCTION clinic.guard_signed_visit();
CREATE FUNCTION clinic.guard_visit_work() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid; BEGIN
 target:=CASE WHEN TG_OP='DELETE' THEN OLD.visit_id ELSE NEW.visit_id END;
 IF EXISTS(SELECT 1 FROM clinic.visit WHERE id=target AND status='signed') OR
 (TG_OP='UPDATE' AND EXISTS(SELECT 1 FROM clinic.visit WHERE id=OLD.visit_id AND status='signed'))
 THEN RAISE EXCEPTION 'SIGNED_VISIT_IMMUTABLE' USING ERRCODE='23514'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE TRIGGER protect_signed_work BEFORE INSERT OR UPDATE OR DELETE ON clinic.visit_work FOR EACH ROW EXECUTE FUNCTION clinic.guard_visit_work();

-- This is an internal schema. No public table/function access is granted.
REVOKE ALL ON SCHEMA clinic FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA clinic FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA clinic FROM PUBLIC;
INSERT INTO clinic.schema_version VALUES(1,now());
