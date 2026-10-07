-- Bind financial review and approval to the version displayed to the operator.
-- Existing numbered migrations remain immutable; replacing a function preserves
-- its owner and ACL. SECURITY DEFINER and fixed search_path are restated below.
ALTER TABLE clinic.plan ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK(version>0);
CREATE OR REPLACE FUNCTION clinic.execute(p_actor uuid,p_branch uuid,p_key uuid,p_command text,p_data jsonb)
RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,clinic AS $$
DECLARE
 audit_metadata jsonb := '{}'; required_permission text; oldop clinic.operation%ROWTYPE; command_result jsonb; entity uuid; journal_id uuid;
 planrow clinic.plan%ROWTYPE; visitrow clinic.visit%ROWTYPE; original clinic.journal%ROWTYPE;
 amount numeric; debt_amount numeric; exchange_rate numeric; paid_currency text; remaining numeric;
 today date := (now() AT TIME ZONE 'Asia/Aden')::date;
BEGIN
 IF p_key IS NULL OR p_data IS NULL OR jsonb_typeof(p_data)<>'object' THEN RAISE EXCEPTION 'INVALID_COMMAND'; END IF;
 required_permission:=CASE p_command
 WHEN 'patient.create' THEN 'patient.write' WHEN 'plan.create' THEN 'clinical.write'
 WHEN 'plan.activate' THEN 'finance.agree' WHEN 'legacy.activate' THEN 'finance.opening'
 WHEN 'legacy.review' THEN 'finance.opening'
 WHEN 'step.create' THEN 'clinical.write' WHEN 'visit.create' THEN 'clinical.write'
 WHEN 'visit.sign' THEN 'clinical.write' WHEN 'payment.collect' THEN 'finance.collect'
 WHEN 'payment.reverse' THEN 'finance.reverse' END;
 IF required_permission IS NULL THEN RAISE EXCEPTION 'UNKNOWN_COMMAND'; END IF;
 PERFORM clinic.require_permission(p_actor,p_branch,required_permission);
 IF p_command='legacy.review' THEN PERFORM clinic.require_permission(p_actor,p_branch,'finance.agree'); END IF;
 IF p_command='plan.create' THEN
   IF p_data->>'agreed' IS NOT NULL THEN PERFORM clinic.require_permission(p_actor,p_branch,'finance.agree'); END IF;
   IF p_data->>'previouslyPaid' IS NOT NULL THEN PERFORM clinic.require_permission(p_actor,p_branch,'finance.opening'); END IF;
 END IF;
 IF p_command IN ('legacy.review','plan.activate','legacy.activate') THEN
   IF jsonb_typeof(p_data->'expectedVersion') IS DISTINCT FROM 'number' OR
      coalesce(p_data->>'expectedVersion','') !~ '^[1-9][0-9]{0,9}$'
   THEN RAISE EXCEPTION 'EXPECTED_VERSION_REQUIRED'; END IF;
   IF (p_data->>'expectedVersion')::bigint>2147483647 THEN RAISE EXCEPTION 'EXPECTED_VERSION_REQUIRED'; END IF;
 END IF;
 INSERT INTO clinic.operation(branch_id,key,actor_id,command,payload)
 VALUES(p_branch,p_key,p_actor,p_command,p_data) ON CONFLICT DO NOTHING;
 SELECT * INTO STRICT oldop FROM clinic.operation WHERE branch_id=p_branch AND key=p_key FOR UPDATE;
 IF oldop.actor_id<>p_actor OR oldop.command<>p_command OR oldop.payload<>p_data
 THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE='23505'; END IF;
 IF oldop.result IS NOT NULL THEN RETURN oldop.result; END IF;

 IF p_command='patient.create' THEN
   INSERT INTO clinic.patient(primary_branch_id,full_name,phone,birth_date,created_by)
   VALUES(p_branch,p_data->>'fullName',coalesce(p_data->>'phone',''),(p_data->>'birthDate')::date,p_actor) RETURNING id INTO entity;
   IF (p_data->>'birthDate')::date>today THEN RAISE EXCEPTION 'FUTURE_BIRTH_DATE'; END IF;
   INSERT INTO clinic.patient_branch VALUES(entity,p_branch);
 ELSIF p_command='plan.create' THEN

   -- Reject fractional cents instead of allowing numeric-column silent rounding.
   IF coalesce(p_data->>'agreed','0') !~ '^\d{1,16}(\.\d{1,2})?$' OR
      coalesce(p_data->>'previouslyPaid','0') !~ '^\d{1,16}(\.\d{1,2})?$' THEN RAISE EXCEPTION 'INVALID_AMOUNT'; END IF;
   INSERT INTO clinic.plan(patient_id,branch_id,specialty,title,origin,currency,agreed,previously_paid,
     source_system,source_record_id,as_of_date,disputed,clinical_summary,created_by)
   VALUES((p_data->>'patientId')::uuid,p_branch,p_data->>'specialty',p_data->>'title',p_data->>'origin',p_data->>'currency',
     (p_data->>'agreed')::numeric,(p_data->>'previouslyPaid')::numeric,p_data->>'sourceSystem',p_data->>'sourceRecordId',
     (p_data->>'asOfDate')::date,coalesce((p_data->>'disputed')::boolean,false),coalesce(p_data->'clinicalSummary','{}'),p_actor)
   RETURNING id INTO entity;
 ELSIF p_command='legacy.review' THEN
   SELECT * INTO STRICT planrow FROM clinic.plan WHERE id=(p_data->>'planId')::uuid AND branch_id=p_branch FOR UPDATE;
   IF p_command IN ('legacy.review','plan.activate','legacy.activate') AND
      planrow.version<>(p_data->>'expectedVersion')::integer
   THEN RAISE EXCEPTION 'STALE_PLAN_VERSION'; END IF;
   IF planrow.origin<>'legacy' OR planrow.status<>'draft' OR EXISTS(SELECT 1 FROM clinic.journal WHERE plan_id=planrow.id)
   THEN RAISE EXCEPTION 'ONLY_DRAFT_LEGACY_REVIEW_SUPPORTED'; END IF;
   IF NOT (p_data ?& ARRAY['agreed','previouslyPaid','disputed','reason']) OR
      p_data - ARRAY['planId','agreed','previouslyPaid','disputed','reason','expectedVersion'] <> '{}'::jsonb OR
      jsonb_typeof(p_data->'agreed') NOT IN ('string','null') OR
      jsonb_typeof(p_data->'previouslyPaid') NOT IN ('string','null') OR
      jsonb_typeof(p_data->'disputed')<>'boolean' OR jsonb_typeof(p_data->'reason')<>'string'
   THEN RAISE EXCEPTION 'INVALID_REVIEW_FIELDS'; END IF;
   IF length(trim(coalesce(p_data->>'reason',''))) NOT BETWEEN 3 AND 2000 THEN RAISE EXCEPTION 'REVIEW_REASON_REQUIRED'; END IF;
   IF coalesce(p_data->>'agreed','0') !~ '^\d{1,16}(\.\d{1,2})?$' OR
      coalesce(p_data->>'previouslyPaid','0') !~ '^\d{1,16}(\.\d{1,2})?$' THEN RAISE EXCEPTION 'INVALID_AMOUNT'; END IF;
   audit_metadata:=jsonb_build_object('reason',trim(p_data->>'reason'),
     'before',jsonb_build_object('agreed',planrow.agreed,'previouslyPaid',planrow.previously_paid,'disputed',planrow.disputed),
     'after',jsonb_build_object('agreed',p_data->'agreed','previouslyPaid',p_data->'previouslyPaid','disputed',p_data->'disputed'));
   UPDATE clinic.plan SET agreed=(p_data->>'agreed')::numeric, previously_paid=(p_data->>'previouslyPaid')::numeric,
     disputed=(p_data->>'disputed')::boolean,version=version+1 WHERE id=planrow.id;
   entity:=planrow.id;
 ELSIF p_command IN ('plan.activate','legacy.activate','step.create','visit.create','payment.collect') THEN
   SELECT * INTO STRICT planrow FROM clinic.plan WHERE id=(p_data->>'planId')::uuid AND branch_id=p_branch FOR UPDATE;
   IF p_command IN ('legacy.review','plan.activate','legacy.activate') AND
      planrow.version<>(p_data->>'expectedVersion')::integer
   THEN RAISE EXCEPTION 'STALE_PLAN_VERSION'; END IF;
   IF p_command IN ('plan.activate','legacy.activate') THEN
     IF planrow.status<>'draft' THEN RAISE EXCEPTION 'PLAN_ALREADY_ACTIVATED'; END IF;
     IF (p_command='plan.activate')<>(planrow.origin='new') THEN RAISE EXCEPTION 'WRONG_INTAKE_PATH'; END IF;
     IF planrow.agreed IS NULL OR planrow.disputed OR (planrow.origin='legacy' AND planrow.previously_paid IS NULL)
     THEN RAISE EXCEPTION 'LEGACY_REVIEW_REQUIRED'; END IF;
     IF planrow.as_of_date>today THEN RAISE EXCEPTION 'FUTURE_OPENING_DATE'; END IF;
     remaining:=planrow.agreed-coalesce(planrow.previously_paid,0);
     IF remaining<>0 THEN
       INSERT INTO clinic.journal(branch_id,patient_id,plan_id,kind,actor_id,effective_date)
       VALUES(p_branch,planrow.patient_id,planrow.id,CASE WHEN planrow.origin='new' THEN 'agreement' ELSE 'legacy_opening' END,
         p_actor,coalesce(planrow.as_of_date,today)) RETURNING id INTO journal_id;
       INSERT INTO clinic.journal_line(journal_id,account,currency,debit,credit)
       VALUES(journal_id,CASE WHEN remaining>0 THEN 'RECEIVABLE' ELSE 'PATIENT_CREDIT' END,planrow.currency,
         greatest(remaining,0),greatest(-remaining,0)),
       (journal_id,CASE WHEN planrow.origin='new' THEN 'CONTRACT_CLEARING' ELSE 'LEGACY_CLEARING' END,planrow.currency,
         greatest(-remaining,0),greatest(remaining,0));
     END IF;
     UPDATE clinic.plan SET status='active',version=version+1 WHERE id=planrow.id;
     entity:=planrow.id;
   ELSIF p_command='step.create' THEN
     IF planrow.status NOT IN ('draft','active') THEN RAISE EXCEPTION 'PLAN_CLOSED'; END IF;
     INSERT INTO clinic.plan_step(plan_id,patient_id,branch_id,procedure_name,tooth)
     VALUES(planrow.id,planrow.patient_id,p_branch,p_data->>'procedureName',nullif(p_data->>'tooth','')) RETURNING id INTO entity;
   ELSIF p_command='visit.create' THEN
     IF planrow.status<>'active' THEN RAISE EXCEPTION 'PLAN_NOT_ACTIVE'; END IF;
     IF coalesce((p_data->>'occurredOn')::date,today)>today THEN RAISE EXCEPTION 'FUTURE_VISIT'; END IF;
     INSERT INTO clinic.visit(plan_id,patient_id,branch_id,occurred_on,note)
     VALUES(planrow.id,planrow.patient_id,p_branch,coalesce((p_data->>'occurredOn')::date,today),coalesce(p_data->>'note','')) RETURNING id INTO entity;
     IF p_data->>'stepId' IS NOT NULL THEN
       -- Composite FK prevents a step from another plan/patient being attached.
       INSERT INTO clinic.visit_work VALUES(entity,(p_data->>'stepId')::uuid,planrow.id,planrow.patient_id,p_branch,p_actor);
     END IF;
   ELSE
     IF planrow.status<>'active' THEN RAISE EXCEPTION 'PLAN_NOT_ACTIVE'; END IF;
     IF coalesce(p_data->>'amount','') !~ '^\d{1,16}(\.\d{1,2})?$' OR
        coalesce(p_data->>'rate','') !~ '^\d{1,12}(\.\d{1,12})?$' THEN RAISE EXCEPTION 'INVALID_AMOUNT_OR_RATE'; END IF;
     amount:=(p_data->>'amount')::numeric; exchange_rate:=(p_data->>'rate')::numeric; paid_currency:=p_data->>'currency';
     IF amount<=0 OR exchange_rate<=0 OR paid_currency IS NULL OR paid_currency NOT IN ('YER','SAR','USD') OR
        (paid_currency=planrow.currency AND exchange_rate<>1) THEN RAISE EXCEPTION 'INVALID_PAYMENT'; END IF;
     debt_amount:=round(amount/exchange_rate,2);
     SELECT coalesce(sum(l.debit-l.credit),0) INTO remaining FROM clinic.journal j JOIN clinic.journal_line l ON l.journal_id=j.id
       WHERE j.plan_id=planrow.id AND l.account='RECEIVABLE' AND l.currency=planrow.currency;
     IF debt_amount<=0 OR debt_amount>remaining THEN RAISE EXCEPTION 'PAYMENT_EXCEEDS_BALANCE_OR_ROUNDS_TO_ZERO'; END IF;
     INSERT INTO clinic.journal(branch_id,patient_id,plan_id,kind,actor_id,effective_date)
       VALUES(p_branch,planrow.patient_id,planrow.id,'payment',p_actor,today) RETURNING id INTO journal_id;
     IF paid_currency=planrow.currency THEN
       INSERT INTO clinic.journal_line(journal_id,account,currency,debit,credit)
       VALUES(journal_id,'CASH',paid_currency,amount,0),(journal_id,'RECEIVABLE',planrow.currency,0,debt_amount);
     ELSE
       INSERT INTO clinic.journal_line(journal_id,account,currency,debit,credit)
       VALUES(journal_id,'CASH',paid_currency,amount,0),(journal_id,'FX_BRIDGE',paid_currency,0,amount),
         (journal_id,'FX_BRIDGE',planrow.currency,debt_amount,0),(journal_id,'RECEIVABLE',planrow.currency,0,debt_amount);
     END IF;
     INSERT INTO clinic.payment(journal_id,amount,currency,debt_amount,debt_currency,rate)
       VALUES(journal_id,amount,paid_currency,debt_amount,planrow.currency,exchange_rate) RETURNING id INTO entity;
   END IF;
 ELSIF p_command='visit.sign' THEN
   SELECT * INTO STRICT visitrow FROM clinic.visit WHERE id=(p_data->>'visitId')::uuid AND branch_id=p_branch FOR UPDATE;
   SELECT * INTO STRICT planrow FROM clinic.plan WHERE id=visitrow.plan_id FOR UPDATE;
   IF planrow.status<>'active' THEN RAISE EXCEPTION 'PLAN_NOT_ACTIVE'; END IF;
   IF visitrow.status='signed' THEN RAISE EXCEPTION 'VISIT_ALREADY_SIGNED'; END IF;
   IF length(trim(visitrow.note))<3 THEN RAISE EXCEPTION 'CLINICAL_NOTE_REQUIRED'; END IF;
   UPDATE clinic.visit SET status='signed',signed_by=p_actor,signed_at=now() WHERE id=visitrow.id;
   -- Signing does not create an invoice or charge. Completed step is explicit.
   IF coalesce((p_data->>'completeStep')::boolean,false) THEN
     UPDATE clinic.plan_step SET status='done' WHERE id IN (SELECT step_id FROM clinic.visit_work WHERE visit_id=visitrow.id);
   END IF;
   entity:=visitrow.id;
 ELSIF p_command='payment.reverse' THEN
   SELECT * INTO STRICT original FROM clinic.journal WHERE id=(p_data->>'journalId')::uuid AND branch_id=p_branch;
   SELECT * INTO STRICT planrow FROM clinic.plan WHERE id=original.plan_id FOR UPDATE;
   IF original.kind<>'payment' THEN RAISE EXCEPTION 'ONLY_PAYMENT_REVERSAL_SUPPORTED'; END IF;
   IF length(trim(coalesce(p_data->>'reason','')))<3 THEN RAISE EXCEPTION 'REVERSAL_REASON_REQUIRED'; END IF;
   IF EXISTS(SELECT 1 FROM clinic.journal WHERE reverses=original.id) THEN RAISE EXCEPTION 'ALREADY_REVERSED'; END IF;
   INSERT INTO clinic.journal(branch_id,patient_id,plan_id,kind,actor_id,effective_date,reverses,reason)
     VALUES(p_branch,original.patient_id,original.plan_id,'reversal',p_actor,today,original.id,p_data->>'reason') RETURNING id INTO entity;
   INSERT INTO clinic.journal_line(journal_id,account,currency,debit,credit)
     SELECT entity,l.account,l.currency,l.credit,l.debit FROM clinic.journal_line l WHERE l.journal_id=original.id;
 END IF;
 command_result:=jsonb_build_object('id',entity,'command',p_command);
 INSERT INTO clinic.audit(actor_id,branch_id,action,entity_id,metadata) VALUES(p_actor,p_branch,p_command,entity,audit_metadata);
 UPDATE clinic.operation SET result=command_result WHERE branch_id=p_branch AND key=p_key;
 RETURN command_result;
END $$;

ALTER FUNCTION clinic.execute(uuid,uuid,uuid,text,jsonb) SECURITY DEFINER;
ALTER FUNCTION clinic.execute(uuid,uuid,uuid,text,jsonb) SET search_path=pg_catalog,clinic;
REVOKE ALL ON FUNCTION clinic.execute(uuid,uuid,uuid,text,jsonb) FROM PUBLIC;
INSERT INTO clinic.schema_version VALUES(5,now());
