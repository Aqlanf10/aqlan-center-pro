-- PAT-03 partial: branch-scoped reviewed history, not diagnosis or consent.
-- No row means unreviewed in this branch, never patient-wide absence of allergy.
-- Do not hide earlier unstructured history behind an empty new timeline.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM clinic.patient WHERE medical_history<>'{}'::jsonb)
 THEN RAISE EXCEPTION 'EXISTING_HISTORY_REQUIRES_REVIEWED_MIGRATION'; END IF;
END $$;

CREATE FUNCTION clinic.valid_history_section(p_section jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,clinic AS $$
 SELECT CASE WHEN jsonb_typeof(p_section)='object' THEN coalesce(p_section ?& ARRAY['status','details']
   AND p_section-ARRAY['status','details']='{}'::jsonb
   AND jsonb_typeof(p_section->'status')='string'
   AND jsonb_typeof(p_section->'details')='string'
   AND length(p_section->>'details')<=6000
   AND ((p_section->>'status' IN ('unknown','none') AND p_section->>'details'='')
     OR (p_section->>'status'='reported' AND length(trim(p_section->>'details'))>=3)),false) ELSE false END
$$;

CREATE TABLE clinic.patient_history_revision (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 patient_id uuid NOT NULL, branch_id uuid NOT NULL,
 version integer NOT NULL CHECK(version>0),
 medical jsonb NOT NULL CHECK(clinic.valid_history_section(medical)),
 dental jsonb NOT NULL CHECK(clinic.valid_history_section(dental)),
 allergies jsonb NOT NULL CHECK(clinic.valid_history_section(allergies)),
 source text NOT NULL CHECK(source IN ('patient_report','guardian_report','record_review','clinician_review')),
 reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 3 AND 2000),
 observed_on date NOT NULL CHECK(isfinite(observed_on)),
 reviewed_by uuid NOT NULL REFERENCES clinic.staff,
 reviewed_by_name text NOT NULL,
 reviewed_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(patient_id,branch_id) REFERENCES clinic.patient_branch,
 UNIQUE(patient_id,branch_id,version)
);
CREATE TRIGGER immutable_patient_history BEFORE UPDATE OR DELETE ON clinic.patient_history_revision
 FOR EACH ROW EXECUTE FUNCTION clinic.reject_mutation();

CREATE FUNCTION clinic.read_patient_history(p_actor uuid,p_branch uuid,p_patient uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,clinic AS $$
DECLARE latest jsonb; history jsonb; current_version integer;
BEGIN
 PERFORM clinic.require_permission(p_actor,p_branch,'patient.read');
 PERFORM clinic.require_permission(p_actor,p_branch,'clinical.read');
 IF NOT EXISTS(SELECT 1 FROM clinic.patient_branch WHERE patient_id=p_patient AND branch_id=p_branch)
 THEN RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE='P0002'; END IF;
 -- A single query supplies a consistent current snapshot and immutable timeline.
 SELECT jsonb_agg(to_jsonb(r) ORDER BY r.version DESC),max(r.version)
 INTO history,current_version FROM clinic.patient_history_revision r
 WHERE r.patient_id=p_patient AND r.branch_id=p_branch;
 latest:=history->0;
 RETURN jsonb_build_object('patientId',p_patient,'branchId',p_branch,
   'scope','branch','version',coalesce(current_version,0),'current',latest,
   'revisions',coalesce(history,'[]'::jsonb));
END $$;

CREATE FUNCTION clinic.review_patient_history(p_actor uuid,p_branch uuid,p_patient uuid,p_key uuid,p_data jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,clinic AS $$
DECLARE operation_row clinic.operation%ROWTYPE; operation_payload jsonb;
 current_version integer; next_version integer; revision_id uuid; command_result jsonb; observed date; branch_today date;
BEGIN
 PERFORM clinic.require_permission(p_actor,p_branch,'patient.read');
 PERFORM clinic.require_permission(p_actor,p_branch,'clinical.read');
 PERFORM clinic.require_permission(p_actor,p_branch,'clinical.write');
 IF NOT EXISTS(SELECT 1 FROM clinic.patient_branch WHERE patient_id=p_patient AND branch_id=p_branch)
 THEN RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE='P0002'; END IF;
 IF p_key IS NULL OR p_data IS NULL OR jsonb_typeof(p_data)<>'object'
 THEN RAISE EXCEPTION 'INVALID_HISTORY_REVIEW'; END IF;
 operation_payload:=jsonb_build_object('patientId',p_patient,'review',p_data);
 INSERT INTO clinic.operation(branch_id,key,actor_id,command,payload)
 VALUES(p_branch,p_key,p_actor,'patient.history.review',operation_payload) ON CONFLICT DO NOTHING;
 SELECT * INTO STRICT operation_row FROM clinic.operation WHERE branch_id=p_branch AND key=p_key FOR UPDATE;
 IF operation_row.actor_id<>p_actor OR operation_row.command<>'patient.history.review' OR operation_row.payload<>operation_payload
 THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE='23505'; END IF;
 IF operation_row.result IS NOT NULL THEN RETURN operation_row.result; END IF;
 IF NOT (p_data ?& ARRAY['expectedVersion','medical','dental','allergies','source','reason','observedOn'])
   OR p_data-ARRAY['expectedVersion','medical','dental','allergies','source','reason','observedOn']<>'{}'::jsonb
   OR NOT clinic.valid_history_section(p_data->'medical')
   OR NOT clinic.valid_history_section(p_data->'dental')
   OR NOT clinic.valid_history_section(p_data->'allergies')
   OR jsonb_typeof(p_data->'source') IS DISTINCT FROM 'string'
   OR p_data->>'source' NOT IN ('patient_report','guardian_report','record_review','clinician_review')
   OR jsonb_typeof(p_data->'reason') IS DISTINCT FROM 'string'
   OR length(trim(p_data->>'reason')) NOT BETWEEN 3 AND 2000
   OR jsonb_typeof(p_data->'observedOn') IS DISTINCT FROM 'string'
   OR p_data->>'observedOn' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
 THEN RAISE EXCEPTION 'INVALID_HISTORY_REVIEW'; END IF;
 IF jsonb_typeof(p_data->'expectedVersion') IS DISTINCT FROM 'number'
   OR p_data->>'expectedVersion' !~ '^(0|[1-9][0-9]{0,9})$'
 THEN RAISE EXCEPTION 'HISTORY_VERSION_REQUIRED'; END IF;
 IF (p_data->>'expectedVersion')::bigint>2147483646 THEN RAISE EXCEPTION 'HISTORY_VERSION_REQUIRED'; END IF;
 BEGIN observed:=(p_data->>'observedOn')::date;
 EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN RAISE EXCEPTION 'INVALID_HISTORY_DATE'; END;
 SELECT (now() AT TIME ZONE timezone)::date INTO branch_today FROM clinic.branch WHERE id=p_branch;
 IF NOT isfinite(observed) OR observed>branch_today THEN RAISE EXCEPTION 'INVALID_HISTORY_DATE'; END IF;
 -- Lock the stable membership row, including the first revision, so concurrent
 -- first reviews cannot both use version zero. No application DML is granted.
 PERFORM 1 FROM clinic.patient_branch WHERE patient_id=p_patient AND branch_id=p_branch FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE='P0002'; END IF;
 SELECT coalesce(max(version),0) INTO current_version FROM clinic.patient_history_revision
 WHERE patient_id=p_patient AND branch_id=p_branch;
 IF current_version<>(p_data->>'expectedVersion')::integer THEN RAISE EXCEPTION 'STALE_HISTORY_VERSION'; END IF;
 next_version:=current_version+1;
 INSERT INTO clinic.patient_history_revision(patient_id,branch_id,version,medical,dental,allergies,source,reason,observed_on,reviewed_by,reviewed_by_name)
 VALUES(p_patient,p_branch,next_version,p_data->'medical',p_data->'dental',p_data->'allergies',
   p_data->>'source',trim(p_data->>'reason'),observed,p_actor,
   (SELECT display_name FROM clinic.staff WHERE id=p_actor)) RETURNING id INTO revision_id;
 command_result:=jsonb_build_object('id',revision_id,'version',next_version,'command','patient.history.review');
 INSERT INTO clinic.audit(actor_id,branch_id,action,entity_id,metadata)
 VALUES(p_actor,p_branch,'patient.history.review',revision_id,
   jsonb_build_object('patientId',p_patient,'version',next_version,'source',p_data->>'source'));
 UPDATE clinic.operation SET result=command_result WHERE branch_id=p_branch AND key=p_key;
 RETURN command_result;
END $$;

REVOKE ALL ON clinic.patient_history_revision FROM PUBLIC,clinic_runtime;
REVOKE ALL ON FUNCTION clinic.valid_history_section(jsonb),clinic.read_patient_history(uuid,uuid,uuid),
 clinic.review_patient_history(uuid,uuid,uuid,uuid,jsonb) FROM PUBLIC;
GRANT SELECT,INSERT ON clinic.patient_history_revision TO clinic_command_owner;
-- SELECT FOR UPDATE requires UPDATE privilege; no function exposes membership edits.
GRANT UPDATE ON clinic.patient_branch TO clinic_command_owner;
GRANT EXECUTE ON FUNCTION clinic.valid_history_section(jsonb) TO clinic_command_owner;
GRANT CREATE ON SCHEMA clinic TO clinic_command_owner;
ALTER FUNCTION clinic.read_patient_history(uuid,uuid,uuid) OWNER TO clinic_command_owner;
ALTER FUNCTION clinic.review_patient_history(uuid,uuid,uuid,uuid,jsonb) OWNER TO clinic_command_owner;
REVOKE CREATE ON SCHEMA clinic FROM clinic_command_owner;
GRANT EXECUTE ON FUNCTION clinic.read_patient_history(uuid,uuid,uuid),
 clinic.review_patient_history(uuid,uuid,uuid,uuid,jsonb) TO clinic_runtime;
INSERT INTO clinic.schema_version VALUES(6,now());
