-- Copyright (c) 2026 Dr. Aqlan Alkamel. All rights reserved.
-- OB-01/02/03: correction of an already-activated carried-forward legacy
-- opening balance. The original opening journal is never mutated: the
-- correction posts an explicit reversal with a required reason, then a new
-- legacy_opening_correction journal, and updates the plan's reviewed amounts
-- under optimistic version control. Historical credit balances remain
-- representable; a correction may never drive the balance below zero once
-- in-system payments exist (no phantom cash in either direction). The full
-- command dispatcher from migration 008 is restated verbatim with the new
-- command spliced in, exactly as earlier migrations extended it.
-- Run once in a transaction using the migration owner, never the web role.

ALTER TABLE clinic.journal DROP CONSTRAINT journal_kind_check;
ALTER TABLE clinic.journal ADD CONSTRAINT journal_kind_check
  CHECK(kind IN ('agreement','legacy_opening','legacy_opening_correction','payment','reversal'));

-- Invariant: at most one standing opening journal per plan. "Standing" means
-- an opening-kind journal that no reversal targets. Activation inserts the
-- first one; every correction reverses the standing one inside the same
-- transaction before posting its own, so the count never exceeds one.
CREATE FUNCTION clinic.guard_standing_opening() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.kind IN ('agreement','legacy_opening','legacy_opening_correction') AND NEW.reverses IS NULL THEN
   IF EXISTS(SELECT 1 FROM clinic.journal j WHERE j.plan_id=NEW.plan_id
       AND j.kind IN ('agreement','legacy_opening','legacy_opening_correction')
       AND NOT EXISTS(SELECT 1 FROM clinic.journal r WHERE r.reverses=j.id)) THEN
     RAISE EXCEPTION 'OPENING_ALREADY_STANDING';
   END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER standing_opening_guard BEFORE INSERT ON clinic.journal
  FOR EACH ROW EXECUTE FUNCTION clinic.guard_standing_opening();

-- The posted-agreement guard keeps imported numbers immutable for every
-- direct path. The sanctioned correction command is the single exception:
-- execute() raises a transaction-local GUC before its own UPDATE, and the
-- trigger honours it only inside that transaction. clinic_runtime holds no
-- UPDATE on clinic.plan, so no other path can reach the exception.
CREATE OR REPLACE FUNCTION clinic.guard_plan_finance() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (OLD.status<>'draft' OR EXISTS(SELECT 1 FROM clinic.journal WHERE plan_id=OLD.id)) AND
    coalesce(current_setting('app.opening_correction',true),'')<>'1' AND
    ROW(NEW.patient_id,NEW.branch_id,NEW.currency,NEW.agreed,NEW.previously_paid,NEW.origin,NEW.source_system,NEW.source_record_id,NEW.as_of_date,NEW.disputed)
    IS DISTINCT FROM ROW(OLD.patient_id,OLD.branch_id,OLD.currency,OLD.agreed,OLD.previously_paid,OLD.origin,OLD.source_system,OLD.source_record_id,OLD.as_of_date,OLD.disputed)
 THEN RAISE EXCEPTION 'POSTED_AGREEMENT_IMMUTABLE' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION clinic.execute(p_actor uuid,p_branch uuid,p_key uuid,p_command text,p_data jsonb)
RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,clinic AS $$
DECLARE
 audit_metadata jsonb := '{}'; required_permission text; oldop clinic.operation%ROWTYPE; command_result jsonb; entity uuid; journal_id uuid;
 reversal_journal uuid; correction_journal uuid;
 planrow clinic.plan%ROWTYPE; visitrow clinic.visit%ROWTYPE; original clinic.journal%ROWTYPE;
 amount numeric; debt_amount numeric; exchange_rate numeric; paid_currency text; remaining numeric;
 today date := (now() AT TIME ZONE 'Asia/Aden')::date;
 branchtz text; slot_date date; slot_minute integer; slot_duration integer; next_queue integer;
 settingrow clinic.branch_setting%ROWTYPE; appointmentrow clinic.appointment%ROWTYPE;
 arrivalrow clinic.arrival%ROWTYPE; eventrow clinic.call_event%ROWTYPE; requestrow clinic.appointment_request%ROWTYPE;
 extra_result jsonb := '{}';
BEGIN
 IF p_key IS NULL OR p_data IS NULL OR jsonb_typeof(p_data)<>'object' THEN RAISE EXCEPTION 'INVALID_COMMAND'; END IF;
 required_permission:=CASE p_command
 WHEN 'patient.create' THEN 'patient.write' WHEN 'plan.create' THEN 'clinical.write'
 WHEN 'plan.activate' THEN 'finance.agree' WHEN 'legacy.activate' THEN 'finance.opening'
 WHEN 'legacy.review' THEN 'finance.opening'
 WHEN 'legacy.correct' THEN 'finance.opening'
 WHEN 'step.create' THEN 'clinical.write' WHEN 'visit.create' THEN 'clinical.write'
 WHEN 'visit.sign' THEN 'clinical.write' WHEN 'payment.collect' THEN 'finance.collect'
 WHEN 'payment.reverse' THEN 'finance.reverse'
 WHEN 'chair.create' THEN 'settings.write' WHEN 'working_hours.set' THEN 'settings.write'
 WHEN 'working_hours.remove' THEN 'settings.write'
 WHEN 'holiday.set' THEN 'settings.write' WHEN 'holiday.remove' THEN 'settings.write'
 WHEN 'setting.write' THEN 'settings.write'
 WHEN 'appointment.book' THEN 'appointment.write' WHEN 'appointment.reschedule' THEN 'appointment.write'
 WHEN 'appointment.cancel' THEN 'appointment.write' WHEN 'appointment.no_show' THEN 'appointment.write'
 WHEN 'appointment.complete' THEN 'appointment.write'
 WHEN 'arrival.create' THEN 'appointment.write' WHEN 'arrival.call' THEN 'appointment.write'
 WHEN 'arrival.recall' THEN 'appointment.write' WHEN 'arrival.seat' THEN 'appointment.write'
 WHEN 'arrival.finish' THEN 'appointment.write' WHEN 'arrival.leave' THEN 'appointment.write'
 WHEN 'appointment_request.reject' THEN 'appointment.write' END;
 IF required_permission IS NULL THEN RAISE EXCEPTION 'UNKNOWN_COMMAND'; END IF;
 PERFORM clinic.require_permission(p_actor,p_branch,required_permission);
 IF p_command='legacy.review' THEN PERFORM clinic.require_permission(p_actor,p_branch,'finance.agree'); END IF;
 -- Correcting a carried-forward opening touches three authorities at once:
 -- opening numbers (finance.opening), journal reversal (finance.reverse) and
 -- the agreement total (finance.agree), mirroring the review double gate.
 IF p_command='legacy.correct' THEN
   PERFORM clinic.require_permission(p_actor,p_branch,'finance.reverse');
   PERFORM clinic.require_permission(p_actor,p_branch,'finance.agree');
 END IF;
 IF p_command='plan.create' THEN
   IF p_data->>'agreed' IS NOT NULL THEN PERFORM clinic.require_permission(p_actor,p_branch,'finance.agree'); END IF;
   IF p_data->>'previouslyPaid' IS NOT NULL THEN PERFORM clinic.require_permission(p_actor,p_branch,'finance.opening'); END IF;
 END IF;
 IF p_command IN ('legacy.review','legacy.correct','plan.activate','legacy.activate') THEN
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
   IF p_command IN ('legacy.review','legacy.correct','plan.activate','legacy.activate') AND
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
   IF p_command IN ('legacy.review','legacy.correct','plan.activate','legacy.activate') AND
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
     IF p_data->>'appointmentId' IS NOT NULL THEN
       -- Composite FK proves the appointment matches branch and patient.
       UPDATE clinic.visit SET appointment_id=(p_data->>'appointmentId')::uuid WHERE id=entity;
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
 ELSIF p_command='legacy.correct' THEN
   -- OB-01/02/03: correct an activated carried-forward opening. The standing
   -- opening journal (if any) is reversed with the operator's reason, then
   -- the corrected remaining is posted fresh. Plan amounts move atomically
   -- under optimistic version control and the posted-agreement trigger's
   -- transaction-local exception.
   SELECT * INTO STRICT planrow FROM clinic.plan WHERE id=(p_data->>'planId')::uuid AND branch_id=p_branch FOR UPDATE;
   IF planrow.version<>(p_data->>'expectedVersion')::integer THEN RAISE EXCEPTION 'STALE_PLAN_VERSION'; END IF;
   IF planrow.origin<>'legacy' THEN RAISE EXCEPTION 'ONLY_LEGACY_OPENING_CORRECTABLE'; END IF;
   IF planrow.status<>'active' THEN RAISE EXCEPTION 'ONLY_ACTIVE_OPENING_CORRECTABLE'; END IF;
   IF planrow.disputed THEN RAISE EXCEPTION 'DISPUTED_OPENING_NOT_CORRECTABLE'; END IF;
   IF NOT (p_data ?& ARRAY['agreed','previouslyPaid','asOfDate','reason']) OR
      p_data - ARRAY['planId','expectedVersion','agreed','previouslyPaid','asOfDate','reason'] <> '{}'::jsonb OR
      jsonb_typeof(p_data->'agreed')<>'string' OR jsonb_typeof(p_data->'previouslyPaid')<>'string' OR
      jsonb_typeof(p_data->'asOfDate')<>'string' OR jsonb_typeof(p_data->'reason')<>'string'
   THEN RAISE EXCEPTION 'INVALID_CORRECTION_FIELDS'; END IF;
   IF length(trim(p_data->>'reason')) NOT BETWEEN 3 AND 2000 THEN RAISE EXCEPTION 'CORRECTION_REASON_REQUIRED'; END IF;
   IF p_data->>'agreed' !~ '^\d{1,16}(\.\d{1,2})?$' OR
      p_data->>'previouslyPaid' !~ '^\d{1,16}(\.\d{1,2})?$' OR
      p_data->>'asOfDate' !~ '^\d{4}-\d{2}-\d{2}$' THEN RAISE EXCEPTION 'INVALID_AMOUNT'; END IF;
   IF (p_data->>'asOfDate')::date>today THEN RAISE EXCEPTION 'FUTURE_OPENING_DATE'; END IF;
   -- In-system payments already collected (reversed ones excluded). A
   -- correction may never push the remaining balance below zero once such
   -- payments exist; a historical credit with no in-system payments stays
   -- representable exactly like the original activation path.
   SELECT coalesce(sum(p.debt_amount),0) INTO amount FROM clinic.payment p JOIN clinic.journal j ON j.id=p.journal_id
     WHERE j.plan_id=planrow.id AND j.kind='payment' AND NOT EXISTS
     (SELECT 1 FROM clinic.journal r WHERE r.reverses=j.id);
   remaining:=(p_data->>'agreed')::numeric-(p_data->>'previouslyPaid')::numeric;
   IF amount>0 AND remaining-amount<0 THEN RAISE EXCEPTION 'CORRECTION_EXCEEDS_COLLECTED_PAYMENTS'; END IF;
   SELECT * INTO original FROM clinic.journal WHERE plan_id=planrow.id
     AND kind IN ('legacy_opening','legacy_opening_correction') AND reverses IS NULL
     AND NOT EXISTS(SELECT 1 FROM clinic.journal r WHERE r.reverses=clinic.journal.id);
   IF original.id IS NOT NULL THEN
     INSERT INTO clinic.journal(branch_id,patient_id,plan_id,kind,actor_id,effective_date,reverses,reason)
       VALUES(p_branch,planrow.patient_id,planrow.id,'reversal',p_actor,today,original.id,trim(p_data->>'reason'))
       RETURNING id INTO reversal_journal;
     INSERT INTO clinic.journal_line(journal_id,account,currency,debit,credit)
       SELECT reversal_journal,l.account,l.currency,l.credit,l.debit FROM clinic.journal_line l WHERE l.journal_id=original.id;
   END IF;
   IF remaining<>0 THEN
     INSERT INTO clinic.journal(branch_id,patient_id,plan_id,kind,actor_id,effective_date)
       VALUES(p_branch,planrow.patient_id,planrow.id,'legacy_opening_correction',p_actor,(p_data->>'asOfDate')::date)
       RETURNING id INTO correction_journal;
     INSERT INTO clinic.journal_line(journal_id,account,currency,debit,credit)
     VALUES(correction_journal,CASE WHEN remaining>0 THEN 'RECEIVABLE' ELSE 'PATIENT_CREDIT' END,planrow.currency,
       greatest(remaining,0),greatest(-remaining,0)),
     (correction_journal,'LEGACY_CLEARING',planrow.currency,greatest(-remaining,0),greatest(remaining,0));
   END IF;
   audit_metadata:=jsonb_build_object('reason',trim(p_data->>'reason'),
     'before',jsonb_build_object('agreed',planrow.agreed,'previouslyPaid',planrow.previously_paid,
       'asOfDate',planrow.as_of_date,'standingOpeningJournal',original.id),
     'after',jsonb_build_object('agreed',p_data->'agreed','previouslyPaid',p_data->'previouslyPaid','asOfDate',p_data->'asOfDate'),
     'reversalJournal',reversal_journal,'correctionJournal',correction_journal);
   -- Transaction-local exemption consumed by guard_plan_finance for this
   -- single sanctioned UPDATE; nothing else in this transaction mutates plan
   -- financial columns.
   PERFORM set_config('app.opening_correction','1',true);
   UPDATE clinic.plan SET agreed=(p_data->>'agreed')::numeric, previously_paid=(p_data->>'previouslyPaid')::numeric,
     as_of_date=(p_data->>'asOfDate')::date, version=version+1 WHERE id=planrow.id;
   entity:=planrow.id;
 ELSIF p_command='chair.create' THEN
   INSERT INTO clinic.chair(branch_id,name,room)
   VALUES(p_branch,p_data->>'name',nullif(trim(coalesce(p_data->>'room','')),'')) RETURNING id INTO entity;
 ELSIF p_command='working_hours.set' THEN
   IF p_data->>'dayOfWeek' !~ '^[0-6]$' OR p_data->>'openMinute' !~ '^\d{1,4}$' OR p_data->>'closeMinute' !~ '^\d{1,4}$'
   THEN RAISE EXCEPTION 'INVALID_SCHEDULE_INPUT'; END IF;
   slot_minute:=(p_data->>'openMinute')::integer; slot_duration:=(p_data->>'closeMinute')::integer;
   IF slot_minute>=slot_duration THEN RAISE EXCEPTION 'INVALID_SCHEDULE_INPUT'; END IF;
   INSERT INTO clinic.working_hours(branch_id,day_of_week,open_minute,close_minute)
   VALUES(p_branch,(p_data->>'dayOfWeek')::integer,slot_minute,slot_duration)
   ON CONFLICT(branch_id,day_of_week) DO UPDATE SET open_minute=EXCLUDED.open_minute,close_minute=EXCLUDED.close_minute;
   entity:=p_branch;
 ELSIF p_command='working_hours.remove' THEN
   IF p_data->>'dayOfWeek' !~ '^[0-6]$' THEN RAISE EXCEPTION 'INVALID_SCHEDULE_INPUT'; END IF;
   DELETE FROM clinic.working_hours WHERE branch_id=p_branch AND day_of_week=(p_data->>'dayOfWeek')::integer;
   entity:=p_branch;
 ELSIF p_command='holiday.set' THEN
   IF p_data->>'date' !~ '^\d{4}-\d{2}-\d{2}$' THEN RAISE EXCEPTION 'INVALID_SCHEDULE_INPUT'; END IF;
   INSERT INTO clinic.holiday(branch_id,holiday_date,reason)
   VALUES(p_branch,(p_data->>'date')::date,coalesce(p_data->>'reason',''))
   ON CONFLICT(branch_id,holiday_date) DO UPDATE SET reason=EXCLUDED.reason;
   entity:=p_branch;
 ELSIF p_command='holiday.remove' THEN
   IF p_data->>'date' !~ '^\d{4}-\d{2}-\d{2}$' THEN RAISE EXCEPTION 'INVALID_SCHEDULE_INPUT'; END IF;
   DELETE FROM clinic.holiday WHERE branch_id=p_branch AND holiday_date=(p_data->>'date')::date;
   entity:=p_branch;
 ELSIF p_command='setting.write' THEN
   IF p_data->>'key' NOT IN ('lounge.display_mode','lounge.call_expiry_seconds') THEN RAISE EXCEPTION 'UNKNOWN_SETTING'; END IF;
   IF p_data->>'key'='lounge.display_mode' AND
      (jsonb_typeof(p_data->'value')<>'object' OR (p_data->'value')-ARRAY['mode']<>'{}'::jsonb
       OR jsonb_typeof(p_data->'value'->'mode')<>'string'
       OR p_data->'value'->>'mode' NOT IN ('masked_name','queue_number'))
   THEN RAISE EXCEPTION 'INVALID_SETTING_VALUE'; END IF;
   IF p_data->>'key'='lounge.call_expiry_seconds' AND
      (jsonb_typeof(p_data->'value')<>'object' OR (p_data->'value')-ARRAY['seconds']<>'{}'::jsonb
       OR coalesce(p_data->'value'->>'seconds','') !~ '^\d{2,5}$'
       OR (p_data->'value'->>'seconds')::integer NOT BETWEEN 60 AND 43200)
   THEN RAISE EXCEPTION 'INVALID_SETTING_VALUE'; END IF;
   IF jsonb_typeof(p_data->'expectedVersion') IS DISTINCT FROM 'number' OR
      coalesce(p_data->>'expectedVersion','') !~ '^[1-9][0-9]{0,9}$' THEN RAISE EXCEPTION 'EXPECTED_VERSION_REQUIRED'; END IF;
   SELECT * INTO settingrow FROM clinic.branch_setting WHERE branch_id=p_branch AND key=p_data->>'key' FOR UPDATE;
   IF settingrow.branch_id IS NOT NULL AND settingrow.version<>(p_data->>'expectedVersion')::integer
   THEN RAISE EXCEPTION 'VERSION_CONFLICT'; END IF;
   IF settingrow.branch_id IS NULL AND (p_data->>'expectedVersion')::integer<>1 THEN RAISE EXCEPTION 'VERSION_CONFLICT'; END IF;
   INSERT INTO clinic.branch_setting(branch_id,key,value,version,updated_by)
   VALUES(p_branch,p_data->>'key',p_data->'value',CASE WHEN settingrow.branch_id IS NULL THEN 1 ELSE settingrow.version+1 END,p_actor)
   ON CONFLICT(branch_id,key) DO UPDATE SET value=EXCLUDED.value,version=EXCLUDED.version,
     updated_by=EXCLUDED.updated_by,updated_at=now();
   entity:=p_branch;
 ELSIF p_command IN ('appointment.book','appointment.reschedule','appointment.cancel','appointment.no_show','appointment.complete') THEN
   -- Serializing per branch makes the overlap check race-proof (BOOK-01).
   PERFORM pg_advisory_xact_lock(hashtextextended('clinic:schedule:'||p_branch::text,0));
   SELECT timezone INTO branchtz FROM clinic.branch WHERE id=p_branch AND active;
   IF branchtz IS NULL THEN RAISE EXCEPTION 'BRANCH_NOT_FOUND'; END IF;
   today:=(now() AT TIME ZONE branchtz)::date;
   IF p_command='appointment.book' THEN
     IF NOT (p_data ?& ARRAY['patientId','doctorId','chairId','specialty','date','minute','duration'])
     THEN RAISE EXCEPTION 'INVALID_SCHEDULE_INPUT'; END IF;
     IF NOT EXISTS(SELECT 1 FROM clinic.patient_branch WHERE patient_id=(p_data->>'patientId')::uuid AND branch_id=p_branch)
     THEN RAISE EXCEPTION 'PATIENT_NOT_IN_BRANCH'; END IF;
     IF NOT EXISTS(SELECT 1 FROM clinic.staff WHERE id=(p_data->>'doctorId')::uuid AND active)
     THEN RAISE EXCEPTION 'DOCTOR_NOT_FOUND'; END IF;
     IF NOT EXISTS(SELECT 1 FROM clinic.membership WHERE staff_id=(p_data->>'doctorId')::uuid AND branch_id=p_branch)
     THEN RAISE EXCEPTION 'DOCTOR_NOT_IN_BRANCH'; END IF;
     IF NOT EXISTS(SELECT 1 FROM clinic.chair WHERE id=(p_data->>'chairId')::uuid AND branch_id=p_branch AND active)
     THEN RAISE EXCEPTION 'CHAIR_NOT_FOUND'; END IF;
     IF NOT EXISTS(SELECT 1 FROM clinic.specialty WHERE code=p_data->>'specialty')
     THEN RAISE EXCEPTION 'UNKNOWN_SPECIALTY'; END IF;
     IF coalesce(p_data->>'kind','consultation') NOT IN ('consultation','treatment','follow_up')
     THEN RAISE EXCEPTION 'INVALID_SCHEDULE_INPUT'; END IF;
     IF p_data->>'requestId' IS NOT NULL THEN
       SELECT * INTO STRICT requestrow FROM clinic.appointment_request
       WHERE id=(p_data->>'requestId')::uuid AND branch_id=p_branch FOR UPDATE;
       IF requestrow.status<>'pending' THEN RAISE EXCEPTION 'INVALID_REQUEST_STATE'; END IF;
     END IF;
     entity:=NULL;
   ELSE
     SELECT * INTO STRICT appointmentrow FROM clinic.appointment WHERE id=(p_data->>'appointmentId')::uuid AND branch_id=p_branch FOR UPDATE;
     IF appointmentrow.status<>'booked' THEN RAISE EXCEPTION 'APPOINTMENT_NOT_BOOKED'; END IF;
     IF jsonb_typeof(p_data->'expectedVersion') IS DISTINCT FROM 'number' OR
        appointmentrow.version<>(p_data->>'expectedVersion')::integer
     THEN RAISE EXCEPTION 'VERSION_CONFLICT'; END IF;
     entity:=appointmentrow.id;
   END IF;
   IF p_command IN ('appointment.book','appointment.reschedule') THEN
     IF p_data->>'date' !~ '^\d{4}-\d{2}-\d{2}$' OR p_data->>'minute' !~ '^\d{1,4}$' OR p_data->>'duration' !~ '^\d{1,3}$'
     THEN RAISE EXCEPTION 'INVALID_SCHEDULE_INPUT'; END IF;
     slot_date:=(p_data->>'date')::date;
     slot_minute:=(p_data->>'minute')::integer;
     slot_duration:=(p_data->>'duration')::integer;
     IF slot_date<today THEN RAISE EXCEPTION 'PAST_APPOINTMENT'; END IF;
     IF slot_date>today+365 THEN RAISE EXCEPTION 'APPOINTMENT_TOO_FAR'; END IF;
     IF slot_minute>1439 OR slot_duration NOT BETWEEN 5 AND 480 THEN RAISE EXCEPTION 'INVALID_SCHEDULE_INPUT'; END IF;
     PERFORM clinic.assert_slot_free(p_branch,
       coalesce((p_data->>'chairId')::uuid,appointmentrow.chair_id),
       coalesce((p_data->>'doctorId')::uuid,appointmentrow.doctor_id),
       slot_date,slot_minute,slot_duration,
       CASE WHEN p_command='appointment.reschedule' THEN entity END);
   END IF;
   IF p_command='appointment.book' THEN
     INSERT INTO clinic.appointment(branch_id,patient_id,doctor_id,chair_id,specialty,scheduled_date,scheduled_minute,
       duration_minutes,kind,source,request_id,created_by)
     VALUES(p_branch,(p_data->>'patientId')::uuid,(p_data->>'doctorId')::uuid,(p_data->>'chairId')::uuid,
       p_data->>'specialty',slot_date,slot_minute,slot_duration,coalesce(p_data->>'kind','consultation'),
       CASE WHEN p_data->>'requestId' IS NOT NULL THEN 'request' ELSE 'staff' END,
       (p_data->>'requestId')::uuid,p_actor) RETURNING * INTO appointmentrow;
     entity:=appointmentrow.id;
     IF p_data->>'requestId' IS NOT NULL THEN
       UPDATE clinic.appointment_request SET status='booked',appointment_id=appointmentrow.id,
         reviewed_by=p_actor,reviewed_at=now() WHERE id=requestrow.id;
     END IF;
   ELSIF p_command='appointment.reschedule' THEN
     UPDATE clinic.appointment SET scheduled_date=slot_date,scheduled_minute=slot_minute,
       duration_minutes=slot_duration,
       chair_id=coalesce((p_data->>'chairId')::uuid,appointmentrow.chair_id),
       doctor_id=coalesce((p_data->>'doctorId')::uuid,appointmentrow.doctor_id),
       kind=coalesce(p_data->>'kind',appointmentrow.kind),
       version=version+1 WHERE id=appointmentrow.id;
   ELSIF p_command='appointment.cancel' THEN
     IF length(trim(coalesce(p_data->>'reason','')))<3 THEN RAISE EXCEPTION 'CANCEL_REASON_REQUIRED'; END IF;
     UPDATE clinic.appointment SET status='cancelled',cancel_reason=trim(p_data->>'reason'),version=version+1 WHERE id=appointmentrow.id;
   ELSIF p_command='appointment.no_show' THEN
     UPDATE clinic.appointment SET status='no_show',version=version+1 WHERE id=appointmentrow.id;
   ELSE
     UPDATE clinic.appointment SET status='completed',version=version+1 WHERE id=appointmentrow.id;
   END IF;
 ELSIF p_command IN ('arrival.create','arrival.call','arrival.recall','arrival.seat','arrival.finish','arrival.leave') THEN
   SELECT timezone INTO branchtz FROM clinic.branch WHERE id=p_branch AND active;
   IF branchtz IS NULL THEN RAISE EXCEPTION 'BRANCH_NOT_FOUND'; END IF;
   today:=(now() AT TIME ZONE branchtz)::date;
   IF p_command='arrival.create' THEN
     -- Serializing per branch and day makes queue numbers race-proof.
     PERFORM pg_advisory_xact_lock(hashtextextended('clinic:queue:'||p_branch::text||':'||today::text,0));
     IF NOT EXISTS(SELECT 1 FROM clinic.patient_branch WHERE patient_id=(p_data->>'patientId')::uuid AND branch_id=p_branch)
     THEN RAISE EXCEPTION 'PATIENT_NOT_IN_BRANCH'; END IF;
     IF p_data->>'appointmentId' IS NOT NULL THEN
       SELECT * INTO STRICT appointmentrow FROM clinic.appointment
       WHERE id=(p_data->>'appointmentId')::uuid AND branch_id=p_branch;
       IF appointmentrow.status<>'booked' THEN RAISE EXCEPTION 'APPOINTMENT_NOT_BOOKED'; END IF;
       IF appointmentrow.patient_id<>(p_data->>'patientId')::uuid THEN RAISE EXCEPTION 'APPOINTMENT_PATIENT_MISMATCH'; END IF;
     END IF;
     next_queue:=coalesce((SELECT max(clinic.arrival.queue_number) FROM clinic.arrival WHERE clinic.arrival.branch_id=p_branch AND clinic.arrival.queue_date=today),0)+1;
     INSERT INTO clinic.arrival(branch_id,patient_id,appointment_id,queue_date,queue_number,note)
     VALUES(p_branch,(p_data->>'patientId')::uuid,(p_data->>'appointmentId')::uuid,today,next_queue,
       coalesce(p_data->>'note','')) RETURNING * INTO arrivalrow;
     entity:=arrivalrow.id;
     extra_result:=jsonb_build_object('queueNumber',next_queue);
   ELSE
     SELECT * INTO STRICT arrivalrow FROM clinic.arrival WHERE id=(p_data->>'arrivalId')::uuid AND branch_id=p_branch FOR UPDATE;
     entity:=arrivalrow.id;
     IF p_command='arrival.call' THEN
       IF arrivalrow.status<>'waiting' THEN RAISE EXCEPTION 'INVALID_TRANSITION'; END IF;
       UPDATE clinic.arrival SET status='called',called_at=now(),version=version+1 WHERE id=arrivalrow.id;
       INSERT INTO clinic.call_event(branch_id,arrival_id,chair_id,called_by)
       VALUES(p_branch,arrivalrow.id,arrivalrow.chair_id,p_actor) RETURNING * INTO eventrow;
       extra_result:=jsonb_build_object('eventId',eventrow.id,'sequence',eventrow.sequence,
         'queueNumber',arrivalrow.queue_number);
     ELSIF p_command='arrival.recall' THEN
       IF arrivalrow.status<>'called' THEN RAISE EXCEPTION 'INVALID_TRANSITION'; END IF;
       SELECT * INTO STRICT eventrow FROM clinic.call_event
       WHERE arrival_id=arrivalrow.id AND branch_id=p_branch ORDER BY sequence DESC LIMIT 1 FOR UPDATE;
       UPDATE clinic.call_event SET repeats=repeats+1,last_called_at=now() WHERE id=eventrow.id;
       UPDATE clinic.arrival SET called_at=now(),version=version+1 WHERE id=arrivalrow.id;
       extra_result:=jsonb_build_object('eventId',eventrow.id,'repeats',eventrow.repeats+1);
     ELSIF p_command='arrival.seat' THEN
       IF arrivalrow.status<>'called' THEN RAISE EXCEPTION 'INVALID_TRANSITION'; END IF;
       IF NOT EXISTS(SELECT 1 FROM clinic.chair WHERE id=(p_data->>'chairId')::uuid AND branch_id=p_branch AND active)
       THEN RAISE EXCEPTION 'CHAIR_NOT_FOUND'; END IF;
       UPDATE clinic.arrival SET status='in_chair',chair_id=(p_data->>'chairId')::uuid,seated_at=now(),version=version+1 WHERE id=arrivalrow.id;
     ELSIF p_command='arrival.finish' THEN
       IF arrivalrow.status<>'in_chair' THEN RAISE EXCEPTION 'INVALID_TRANSITION'; END IF;
       UPDATE clinic.arrival SET status='done',finished_at=now(),version=version+1 WHERE id=arrivalrow.id;
     ELSE
       IF arrivalrow.status NOT IN ('waiting','called') THEN RAISE EXCEPTION 'INVALID_TRANSITION'; END IF;
       UPDATE clinic.arrival SET status='left',left_at=now(),version=version+1 WHERE id=arrivalrow.id;
     END IF;
   END IF;
 ELSIF p_command='appointment_request.reject' THEN
   SELECT * INTO STRICT requestrow FROM clinic.appointment_request WHERE id=(p_data->>'requestId')::uuid AND branch_id=p_branch FOR UPDATE;
   IF requestrow.status<>'pending' THEN RAISE EXCEPTION 'INVALID_REQUEST_STATE'; END IF;
   IF length(trim(coalesce(p_data->>'reason',''))) NOT BETWEEN 3 AND 1000 THEN RAISE EXCEPTION 'REJECT_REASON_REQUIRED'; END IF;
   UPDATE clinic.appointment_request SET status='rejected',review_reason=trim(p_data->>'reason'),
     reviewed_by=p_actor,reviewed_at=now() WHERE id=requestrow.id;
   entity:=requestrow.id;
 END IF;
 command_result:=jsonb_build_object('id',entity,'command',p_command)||extra_result;
 INSERT INTO clinic.audit(actor_id,branch_id,action,entity_id,metadata) VALUES(p_actor,p_branch,p_command,entity,audit_metadata);
 UPDATE clinic.operation SET result=command_result WHERE branch_id=p_branch AND key=p_key;
 RETURN command_result;
END $$;

ALTER FUNCTION clinic.execute(uuid,uuid,uuid,text,jsonb) SECURITY DEFINER;
ALTER FUNCTION clinic.execute(uuid,uuid,uuid,text,jsonb) SET search_path=pg_catalog,clinic;
REVOKE ALL ON FUNCTION clinic.execute(uuid,uuid,uuid,text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION clinic.guard_standing_opening() FROM PUBLIC;
INSERT INTO clinic.schema_version VALUES(9,now());
