-- Copyright (c) 2026 Dr. Aqlan Alkamel. All rights reserved.
-- BOOK-01/BOOK-02/FLOW-02/LOUNGE-01..03 partial: appointments, arrivals,
-- call events, lounge snapshot and branch settings. Public lounge output is
-- shaped exclusively by clinic.lounge_snapshot; tables remain internal.
-- Run once in a transaction using the migration owner, never the web role.

CREATE TABLE clinic.chair (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES clinic.branch,
  name text NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 120),
  room text CHECK(room IS NULL OR length(trim(room)) BETWEEN 1 AND 120),
  active boolean NOT NULL DEFAULT true,
  UNIQUE(branch_id,name)
);

-- Yemen week starts Sunday. day_of_week follows PostgreSQL DOW (0=Sunday).
-- Partial configuration is intentional: days without a row are closed.
CREATE TABLE clinic.working_hours (
  branch_id uuid NOT NULL REFERENCES clinic.branch,
  day_of_week integer NOT NULL CHECK(day_of_week BETWEEN 0 AND 6),
  open_minute integer NOT NULL CHECK(open_minute BETWEEN 0 AND 1439),
  close_minute integer NOT NULL CHECK(close_minute BETWEEN 1 AND 1440),
  PRIMARY KEY(branch_id,day_of_week),
  CHECK(close_minute>open_minute)
);

CREATE TABLE clinic.holiday (
  branch_id uuid NOT NULL REFERENCES clinic.branch,
  holiday_date date NOT NULL,
  reason text NOT NULL DEFAULT '' CHECK(length(reason)<=300),
  PRIMARY KEY(branch_id,holiday_date)
);

CREATE TABLE clinic.appointment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES clinic.branch,
  patient_id uuid NOT NULL REFERENCES clinic.patient,
  doctor_id uuid NOT NULL REFERENCES clinic.staff,
  chair_id uuid NOT NULL REFERENCES clinic.chair,
  specialty text NOT NULL REFERENCES clinic.specialty,
  scheduled_date date NOT NULL,
  scheduled_minute integer NOT NULL CHECK(scheduled_minute BETWEEN 0 AND 1439),
  duration_minutes integer NOT NULL CHECK(duration_minutes BETWEEN 5 AND 480),
  kind text NOT NULL DEFAULT 'consultation' CHECK(kind IN ('consultation','treatment','follow_up')),
  status text NOT NULL DEFAULT 'booked' CHECK(status IN ('booked','cancelled','no_show','completed')),
  cancel_reason text CHECK(cancel_reason IS NULL OR length(trim(cancel_reason)) BETWEEN 3 AND 1000),
  source text NOT NULL DEFAULT 'staff' CHECK(source IN ('staff','request')),
  request_id uuid,
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  created_by uuid NOT NULL REFERENCES clinic.staff,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,branch_id,patient_id),
  FOREIGN KEY(patient_id,branch_id) REFERENCES clinic.patient_branch(patient_id,branch_id),
  CHECK((status='cancelled')=(cancel_reason IS NOT NULL)),
  CHECK((source='request')=(request_id IS NOT NULL))
);
CREATE INDEX appointment_schedule ON clinic.appointment(branch_id,scheduled_date,scheduled_minute);

-- Public website/portal intake. Booking from a request goes through the same
-- advisory-locked path as staff booking, so a request and a direct booking
-- cannot double-book the same resource concurrently (BOOK-01/PORTAL-04).
CREATE TABLE clinic.appointment_request (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES clinic.branch,
  full_name text NOT NULL CHECK(length(trim(full_name)) BETWEEN 2 AND 200),
  phone text NOT NULL CHECK(length(trim(phone)) BETWEEN 7 AND 40),
  specialty text NOT NULL REFERENCES clinic.specialty,
  preferred_date date NOT NULL,
  note text NOT NULL DEFAULT '' CHECK(length(note)<=1000),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','booked','rejected')),
  review_reason text CHECK(review_reason IS NULL OR length(trim(review_reason)) BETWEEN 3 AND 1000),
  appointment_id uuid,
  reviewed_by uuid REFERENCES clinic.staff,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK((status='pending') OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)),
  CHECK((status='booked')=(appointment_id IS NOT NULL)),
  CHECK((status='rejected')=(review_reason IS NOT NULL))
);
-- One pending request per phone per branch per date, enforced under concurrency.
CREATE UNIQUE INDEX one_pending_request ON clinic.appointment_request(branch_id,trim(phone),preferred_date) WHERE status='pending';
CREATE INDEX appointment_request_queue ON clinic.appointment_request(branch_id,status,created_at);

-- Reception queue: arrival, call, chair and finish keep separate timestamps
-- and never auto-record clinical work (FLOW-02: suggested is not performed).
CREATE TABLE clinic.arrival (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES clinic.branch,
  patient_id uuid NOT NULL REFERENCES clinic.patient,
  appointment_id uuid,
  queue_date date NOT NULL,
  queue_number integer NOT NULL CHECK(queue_number>0),
  status text NOT NULL DEFAULT 'waiting' CHECK(status IN ('waiting','called','in_chair','done','left')),
  chair_id uuid REFERENCES clinic.chair,
  note text NOT NULL DEFAULT '' CHECK(length(note)<=1000),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  arrived_at timestamptz NOT NULL DEFAULT now(),
  called_at timestamptz,
  seated_at timestamptz,
  finished_at timestamptz,
  left_at timestamptz,
  UNIQUE(id,branch_id),
  UNIQUE(branch_id,queue_date,queue_number),
  FOREIGN KEY(patient_id,branch_id) REFERENCES clinic.patient_branch(patient_id,branch_id),
  FOREIGN KEY(appointment_id,branch_id,patient_id) REFERENCES clinic.appointment(id,branch_id,patient_id)
);
CREATE UNIQUE INDEX one_arrival_per_appointment ON clinic.arrival(appointment_id) WHERE appointment_id IS NOT NULL;
CREATE INDEX arrival_day ON clinic.arrival(branch_id,queue_date,status);

-- Lounge calls carry a stable event id and monotonic sequence. A recall
-- repeats the SAME event (repeats counter), never a duplicate event row.
CREATE TABLE clinic.call_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES clinic.branch,
  arrival_id uuid NOT NULL,
  chair_id uuid REFERENCES clinic.chair,
  sequence bigint GENERATED ALWAYS AS IDENTITY,
  repeats integer NOT NULL DEFAULT 1 CHECK(repeats BETWEEN 1 AND 100),
  called_by uuid NOT NULL REFERENCES clinic.staff,
  called_at timestamptz NOT NULL DEFAULT now(),
  last_called_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,branch_id),
  FOREIGN KEY(arrival_id,branch_id) REFERENCES clinic.arrival(id,branch_id)
);
CREATE INDEX call_event_branch ON clinic.call_event(branch_id,sequence);
CREATE INDEX call_event_arrival ON clinic.call_event(arrival_id);

-- CFG-01/CFG-03 partial: typed, versioned, audited settings. Data-safety
-- rules cannot be disabled through this table.
CREATE TABLE clinic.branch_setting (
  branch_id uuid NOT NULL REFERENCES clinic.branch,
  key text NOT NULL CHECK(key ~ '^[a-z_.]{3,60}$'),
  value jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  updated_by uuid NOT NULL REFERENCES clinic.staff,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(branch_id,key)
);

-- A visit may reference the appointment that brought the patient in; the
-- composite FK proves scope (same branch and same patient).
ALTER TABLE clinic.visit ADD COLUMN appointment_id uuid;
ALTER TABLE clinic.visit ADD CONSTRAINT visit_appointment_scope
  FOREIGN KEY(appointment_id,branch_id,patient_id) REFERENCES clinic.appointment(id,branch_id,patient_id);

-- Presentable masked name for the public lounge: first word + initial.
-- Masking happens in SQL before any response, never in the browser only.
CREATE FUNCTION clinic.mask_name(p_name text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN w[2] IS NULL THEN left(w[1],1)||'•••'
    ELSE w[1]||' '||left(w[2],1)||'.' END
  FROM (SELECT regexp_split_to_array(trim(coalesce(p_name,'')),'\s+') AS w) s
  WHERE coalesce(array_length(w,1),0)>=1 AND w[1]<>''
$$;

-- Slot validity + overlap guard. Callers must already hold the branch
-- advisory schedule lock so concurrent bookings serialize here.
CREATE FUNCTION clinic.assert_slot_free(p_branch uuid,p_chair uuid,p_doctor uuid,p_date date,p_minute integer,p_duration integer,p_exclude uuid)
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,clinic AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM clinic.holiday WHERE branch_id=p_branch AND holiday_date=p_date)
  THEN RAISE EXCEPTION 'BRANCH_HOLIDAY'; END IF;
  IF EXISTS(SELECT 1 FROM clinic.working_hours WHERE branch_id=p_branch) THEN
    IF NOT EXISTS(SELECT 1 FROM clinic.working_hours WHERE branch_id=p_branch
      AND day_of_week=EXTRACT(DOW FROM p_date)::integer
      AND open_minute<=p_minute AND p_minute+p_duration<=close_minute)
    THEN RAISE EXCEPTION 'OUTSIDE_WORKING_HOURS'; END IF;
  END IF;
  IF EXISTS(SELECT 1 FROM clinic.appointment a WHERE a.branch_id=p_branch AND a.status='booked'
    AND a.id IS DISTINCT FROM p_exclude
    AND (a.chair_id=p_chair OR a.doctor_id=p_doctor)
    AND (a.scheduled_date+a.scheduled_minute*interval '1 minute') < (p_date+(p_minute+p_duration)*interval '1 minute')
    AND (p_date+p_minute*interval '1 minute') < (a.scheduled_date+(a.scheduled_minute+a.duration_minutes)*interval '1 minute'))
  THEN RAISE EXCEPTION 'TIME_CONFLICT'; END IF;
END $$;

-- The only public lounge source. Returns NULL for an unknown/inactive branch,
-- and otherwise never includes phones, file numbers, patient ids, diagnoses,
-- money or raw full names (LOUNGE-02/03).
CREATE FUNCTION clinic.lounge_snapshot(p_branch uuid,p_since bigint DEFAULT 0)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,clinic AS $$
WITH cfg AS (
  SELECT
    coalesce((SELECT value->>'mode' FROM clinic.branch_setting WHERE branch_id=p_branch AND key='lounge.display_mode'),'masked_name') AS mode,
    coalesce((SELECT (value->>'seconds')::integer FROM clinic.branch_setting WHERE branch_id=p_branch AND key='lounge.call_expiry_seconds'),300) AS expiry
), b AS (SELECT name FROM clinic.branch WHERE id=p_branch AND active),
recent AS (
  SELECT e.id AS event_id,e.sequence,e.repeats,e.last_called_at,e.chair_id,
         a.queue_number,a.patient_id,a.status
  FROM clinic.call_event e
  JOIN clinic.arrival a ON a.id=e.arrival_id AND a.branch_id=e.branch_id
  WHERE e.branch_id=p_branch AND e.last_called_at>(now()-interval '2 hours')
    AND e.sequence>coalesce(p_since,0)
  ORDER BY e.sequence LIMIT 30
)
SELECT jsonb_build_object(
  'branch',b.name,
  'displayMode',cfg.mode,
  'generatedAt',to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'waitingCount',(SELECT count(*) FROM clinic.arrival WHERE branch_id=p_branch
    AND queue_date=(now() AT TIME ZONE 'Asia/Aden')::date AND status IN ('waiting','called')),
  'activeCall',(SELECT jsonb_build_object(
      'eventId',r.event_id,'sequence',r.sequence,'repeats',r.repeats,
      'queueNumber',r.queue_number,
      'displayName',CASE WHEN cfg.mode='masked_name' THEN coalesce(clinic.mask_name(p.full_name),'') END,
      'chairName',c.name,'room',c.room,
      'calledAt',to_char(r.last_called_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'expiresAt',to_char((r.last_called_at AT TIME ZONE 'UTC')+make_interval(secs=>cfg.expiry),'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    FROM recent r JOIN clinic.patient p ON p.id=r.patient_id LEFT JOIN clinic.chair c ON c.id=r.chair_id
    WHERE r.status='called' AND r.last_called_at>now()-make_interval(secs=>cfg.expiry)
    ORDER BY r.sequence DESC LIMIT 1),
  'events',(SELECT coalesce(jsonb_agg(jsonb_build_object(
      'eventId',r.event_id,'sequence',r.sequence,'repeats',r.repeats,
      'queueNumber',r.queue_number,
      'displayName',CASE WHEN cfg.mode='masked_name' THEN coalesce(clinic.mask_name(p.full_name),'') END,
      'chairName',c.name,'room',c.room,
      'calledAt',to_char(r.last_called_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'expiresAt',to_char((r.last_called_at AT TIME ZONE 'UTC')+make_interval(secs=>cfg.expiry),'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ) ORDER BY r.sequence),'[]'::jsonb)
    FROM recent r JOIN clinic.patient p ON p.id=r.patient_id LEFT JOIN clinic.chair c ON c.id=r.chair_id)
) FROM cfg,b
$$;

-- Rebuilt command boundary: adds appointment, arrival, lounge-settings and
-- public-request commands. Existing command semantics are unchanged.
CREATE OR REPLACE FUNCTION clinic.execute(p_actor uuid,p_branch uuid,p_key uuid,p_command text,p_data jsonb)
RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,clinic AS $$
DECLARE
 audit_metadata jsonb := '{}'; required_permission text; oldop clinic.operation%ROWTYPE; command_result jsonb; entity uuid; journal_id uuid;
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

-- Role grants mirror the existing boundary: commands run as the restricted
-- command owner; the runtime role reads schedules and executes the snapshot.
GRANT SELECT,INSERT ON clinic.chair,clinic.working_hours,clinic.holiday,clinic.appointment,
 clinic.appointment_request,clinic.arrival,clinic.call_event,clinic.branch_setting TO clinic_command_owner;
GRANT UPDATE ON clinic.appointment,clinic.appointment_request,clinic.arrival,clinic.call_event,
 clinic.branch_setting,clinic.holiday,clinic.working_hours TO clinic_command_owner;
GRANT DELETE ON clinic.holiday,clinic.working_hours TO clinic_command_owner;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA clinic TO clinic_command_owner;
ALTER FUNCTION clinic.execute(uuid,uuid,uuid,text,jsonb) SECURITY DEFINER;
ALTER FUNCTION clinic.execute(uuid,uuid,uuid,text,jsonb) SET search_path=pg_catalog,clinic;
REVOKE ALL ON FUNCTION clinic.execute(uuid,uuid,uuid,text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION clinic.assert_slot_free(uuid,uuid,uuid,date,integer,integer,uuid) FROM PUBLIC;
ALTER FUNCTION clinic.assert_slot_free(uuid,uuid,uuid,date,integer,integer,uuid) OWNER TO clinic_command_owner;
REVOKE ALL ON FUNCTION clinic.lounge_snapshot(uuid,bigint) FROM PUBLIC;
ALTER FUNCTION clinic.lounge_snapshot(uuid,bigint) OWNER TO clinic_command_owner;
GRANT EXECUTE ON FUNCTION clinic.lounge_snapshot(uuid,bigint) TO clinic_runtime;
GRANT EXECUTE ON FUNCTION clinic.mask_name(text) TO clinic_runtime;
GRANT SELECT ON clinic.specialty TO clinic_command_owner;
GRANT SELECT ON clinic.chair,clinic.working_hours,clinic.holiday,clinic.appointment,
 clinic.appointment_request,clinic.arrival,clinic.call_event,clinic.branch_setting TO clinic_runtime;
INSERT INTO clinic.schema_version VALUES(8,now());

-- Public request intake: the runtime role submits through this definer
-- function and never gains INSERT on the table directly.
CREATE FUNCTION clinic.submit_appointment_request(p_branch uuid,p_full_name text,p_phone text,p_specialty text,p_preferred_date date,p_note text)
RETURNS uuid LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,clinic AS $$
  INSERT INTO clinic.appointment_request(branch_id,full_name,phone,specialty,preferred_date,note)
  SELECT b.id,p_full_name,p_phone,p_specialty,p_preferred_date,p_note FROM clinic.branch b
  WHERE b.id=p_branch AND b.active AND p_preferred_date
    BETWEEN (now() AT TIME ZONE b.timezone)::date AND (now() AT TIME ZONE b.timezone)::date+60
  RETURNING id
$$;
REVOKE ALL ON FUNCTION clinic.submit_appointment_request(uuid,text,text,text,date,text) FROM PUBLIC;
ALTER FUNCTION clinic.submit_appointment_request(uuid,text,text,text,date,text) OWNER TO clinic_command_owner;
GRANT EXECUTE ON FUNCTION clinic.submit_appointment_request(uuid,text,text,text,date,text) TO clinic_runtime;
