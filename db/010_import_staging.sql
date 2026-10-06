-- IMP-01..03: Legacy import staging, human approval and resumable commit.
-- Staging persists the reviewed domain preview (packages/domain/import-preview.mjs)
-- verbatim; money never moves until clinic.import_commit_rows runs the guarded
-- clinic.execute command core per approved row. No automatic identity merge:
-- CSV file numbers are legacy references only, because clinic.patient.file_number
-- is a system-generated identity and must never silently adopt them (MIG-04/05).

CREATE TABLE clinic.import_batch (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 branch_id uuid NOT NULL REFERENCES clinic.branch,
 created_by uuid NOT NULL REFERENCES clinic.staff,
 source_system text NOT NULL CHECK(length(trim(source_system)) BETWEEN 1 AND 100),
 file_name text NOT NULL CHECK(length(trim(file_name)) BETWEEN 1 AND 200),
 file_hash text NOT NULL CHECK(file_hash ~ '^[a-f0-9]{64}$'),
 default_specialty text NOT NULL REFERENCES clinic.specialty,
 as_of_date date NOT NULL,
 header_map jsonb NOT NULL,
 currency_map jsonb NOT NULL DEFAULT '{}',
 status text NOT NULL DEFAULT 'staged' CHECK(status IN ('staged','approved','cancelled')),
 row_count integer NOT NULL CHECK(row_count >= 0),
 staged_rows integer NOT NULL CHECK(staged_rows >= 0),
 evidence_rows integer NOT NULL CHECK(evidence_rows >= 0),
 rejected_rows integer NOT NULL CHECK(rejected_rows >= 0),
 per_currency jsonb NOT NULL DEFAULT '{}',
 approved_by uuid REFERENCES clinic.staff,
 approved_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(status<>'approved' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL))
);
-- A cancelled batch releases its file hash so the operator can re-upload it;
-- approved/staged batches keep blocking the same bytes durably (MIG-04).
CREATE UNIQUE INDEX one_import_file ON clinic.import_batch(branch_id,file_hash) WHERE status<>'cancelled';

CREATE TABLE clinic.import_row (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 batch_id uuid NOT NULL REFERENCES clinic.import_batch ON DELETE CASCADE,
 line integer NOT NULL CHECK(line >= 1),
 status text NOT NULL CHECK(status IN ('staged','needs_evidence','rejected','imported','failed')),
 data jsonb NOT NULL,
 source_record_id text NOT NULL CHECK(length(source_record_id) BETWEEN 1 AND 200),
 currency text CHECK(currency IN ('YER','SAR','USD')),
 agreed numeric(18,2) CHECK(agreed IS NULL OR agreed>=0),
 previously_paid numeric(18,2) CHECK(previously_paid IS NULL OR previously_paid>=0),
 supplied_remaining numeric(18,2),
 full_name text NOT NULL CHECK(length(full_name) BETWEEN 2 AND 200),
 phone text,
 legacy_file_number text,
 issues jsonb NOT NULL DEFAULT '[]',
 patient_id uuid REFERENCES clinic.patient,
 plan_id uuid REFERENCES clinic.plan,
 error_code text,
 UNIQUE(batch_id,line)
);
CREATE INDEX import_row_batch_status ON clinic.import_row(batch_id,status);

GRANT SELECT,INSERT,UPDATE ON clinic.import_batch,clinic.import_row TO clinic_runtime;

-- Atomic, per-row commit. Each approved row reuses the same guarded command
-- core as manual intake (patient.create -> plan.create -> legacy.activate) in
-- one statement-level transaction, so approval guards, the legacy source
-- uniqueness and journal line integrity behave exactly like hand-entered
-- legacy openings. Deliberately NO per-row PL/pgSQL exception block here:
-- guard_journal_line requires the journal header and its lines to share one
-- transaction id, and a subtransaction would break that invariant. A failing
-- row therefore stays staged (the statement rolls back) and the caller records
-- the failure; re-approving resumes the remaining staged rows (MIG-03).
CREATE OR REPLACE FUNCTION clinic.import_commit_row(p_actor uuid,p_branch uuid,p_batch uuid,p_row uuid,p_attach uuid)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
 v_batch clinic.import_batch%ROWTYPE;
 v_row clinic.import_row%ROWTYPE;
 v_result jsonb; v_patient uuid; v_plan uuid; v_remaining integer;
BEGIN
 PERFORM clinic.require_permission(p_actor,p_branch,'patient.write');
 PERFORM clinic.require_permission(p_actor,p_branch,'clinical.write');
 PERFORM clinic.require_permission(p_actor,p_branch,'finance.agree');
 PERFORM clinic.require_permission(p_actor,p_branch,'finance.opening');
 SELECT * INTO v_batch FROM clinic.import_batch WHERE id=p_batch AND branch_id=p_branch FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'BATCH_NOT_FOUND'; END IF;
 IF v_batch.status<>'staged' THEN RAISE EXCEPTION 'BATCH_NOT_ACTIVE'; END IF;
 SELECT * INTO v_row FROM clinic.import_row WHERE id=p_row AND batch_id=p_batch FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'ROW_NOT_FOUND'; END IF;
 IF v_row.status<>'staged' THEN
   RAISE EXCEPTION '%',CASE v_row.status
     WHEN 'rejected' THEN 'ROW_REJECTED'
     WHEN 'needs_evidence' THEN 'EVIDENCE_REQUIRED'
     WHEN 'imported' THEN 'ROW_ALREADY_IMPORTED'
     ELSE 'ROW_FAILED' END;
 END IF;
 IF p_attach IS NOT NULL THEN
   v_patient:=p_attach;
   IF NOT EXISTS(SELECT 1 FROM clinic.patient_branch WHERE patient_id=v_patient AND branch_id=p_branch)
   THEN RAISE EXCEPTION 'ATTACH_PATIENT_NOT_FOUND'; END IF;
 ELSE
   v_result:=clinic.execute(p_actor,p_branch,gen_random_uuid(),'patient.create',
     jsonb_build_object('fullName',v_row.data->>'fullName',
       'phone',coalesce(nullif(trim(v_row.data->>'phone'),''),'')));
   v_patient:=v_result->>'id';
 END IF;
 v_result:=clinic.execute(p_actor,p_branch,gen_random_uuid(),'plan.create',
   jsonb_build_object('patientId',v_patient,'specialty',v_batch.default_specialty,
     'title','رصيد افتتاحي مُرحَّل','origin','legacy','currency',v_row.currency,
     'agreed',v_row.agreed::text,'previouslyPaid',v_row.previously_paid::text,
     'sourceSystem',v_batch.source_system,'sourceRecordId',v_row.source_record_id,
     'asOfDate',v_batch.as_of_date::text));
 v_plan:=v_result->>'id';
 PERFORM clinic.execute(p_actor,p_branch,gen_random_uuid(),'legacy.activate',
   jsonb_build_object('planId',v_plan,'expectedVersion',1));
 UPDATE clinic.import_row SET status='imported',patient_id=v_patient,plan_id=v_plan,error_code=NULL
  WHERE id=v_row.id;
 SELECT count(*) INTO v_remaining FROM clinic.import_row
  WHERE batch_id=p_batch AND status IN ('staged','needs_evidence');
 IF v_remaining=0 THEN
   UPDATE clinic.import_batch SET status='approved',approved_by=p_actor,approved_at=now() WHERE id=p_batch;
 END IF;
 RETURN jsonb_build_object('patientId',v_patient,'planId',v_plan,'remaining',v_remaining);
END $$;
ALTER FUNCTION clinic.import_commit_row(uuid,uuid,uuid,uuid,uuid) SECURITY DEFINER;
ALTER FUNCTION clinic.import_commit_row(uuid,uuid,uuid,uuid,uuid) SET search_path=pg_catalog,clinic;
REVOKE ALL ON FUNCTION clinic.import_commit_row(uuid,uuid,uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clinic.import_commit_row(uuid,uuid,uuid,uuid,uuid) TO clinic_runtime;

INSERT INTO clinic.schema_version VALUES(10,now());
