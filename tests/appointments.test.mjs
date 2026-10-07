import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase, fixture } from './helpers/database.mjs';

let db;
before(async () => { db = await createDatabase(); });
after(async () => { await db?.close(); });

const dayAfter = async days => (await db.query("SELECT ((now() AT TIME ZONE 'Asia/Aden')::date + $1::int)::text AS d", [days])).rows[0].d;

async function setupSchedule(f) {
  const chair = await f.command('chair.create', { name: 'الكرسي الأول', room: 'غرفة 2' });
  const chair2 = await f.command('chair.create', { name: 'الكرسي الثاني' });
  const doctor2 = randomUUID();
  await db.query('INSERT INTO clinic.staff(id,display_name) VALUES($1,$2)', [doctor2, 'د. الثاني']);
  await db.query('INSERT INTO clinic.membership VALUES($1,$2,$3)', [doctor2, f.branch, f.role]);
  return { chair: chair.id, chair2: chair2.id, doctor: f.actor, doctor2 };
}
function book(f, s, o) {
  return f.command('appointment.book', {
    patientId: o.patientId, doctorId: o.doctorId ?? s.doctor, chairId: o.chairId ?? s.chair,
    specialty: o.specialty ?? 'general', date: o.date, minute: String(o.minute), duration: String(o.duration ?? 30),
    ...o.kind ? { kind: o.kind } : {}, ...o.requestId ? { requestId: o.requestId } : {}
  });
}

test('appointments: slot booking rejects chair and doctor overlaps while touching slots pass (BOOK-01)', async () => {
  const f = await fixture(db), s = await setupSchedule(f), p1 = await f.patient(), p2 = await f.patient(), p3 = await f.patient();
  const date = await dayAfter(7);
  await book(f, s, { patientId: p1, date, minute: 600 });
  await book(f, s, { patientId: p2, date, minute: 630 }); // touching edge is free
  await assert.rejects(book(f, s, { patientId: p3, date, minute: 615, chairId: s.chair2 }), /TIME_CONFLICT/); // doctor busy
  await assert.rejects(book(f, s, { patientId: p3, date, minute: 600, doctorId: s.doctor2 }), /TIME_CONFLICT/); // chair busy
  await book(f, s, { patientId: p3, date, minute: 615, chairId: s.chair2, doctorId: s.doctor2 }); // parallel resources pass
  const rows = (await db.query("SELECT count(*)::int AS n FROM clinic.appointment WHERE branch_id=$1 AND status='booked'", [f.branch])).rows;
  assert.equal(rows[0].n, 3);
});

test('appointments: holidays, configured hours and partially configured days gate booking', async () => {
  const f = await fixture(db), s = await setupSchedule(f), p = await f.patient();
  const date = await dayAfter(7), otherDate = await dayAfter(8);
  await f.command('holiday.set', { date, reason: 'عطلة وطنية' });
  await assert.rejects(book(f, s, { patientId: p, date, minute: 600 }), /BRANCH_HOLIDAY/);
  await f.command('holiday.remove', { date });
  await book(f, s, { patientId: p, date, minute: 600 });
  const dow = Number((await db.query('SELECT EXTRACT(DOW FROM $1::date)::int AS d', [date])).rows[0].d);
  await f.command('working_hours.set', { dayOfWeek: String(dow), openMinute: '480', closeMinute: '1320' });
  const p2 = await f.patient();
  await assert.rejects(book(f, s, { patientId: p2, date, minute: 400 }), /OUTSIDE_WORKING_HOURS/);
  await assert.rejects(book(f, s, { patientId: p2, date, minute: 1310, duration: 30 }), /OUTSIDE_WORKING_HOURS/); // end 1340 > 1320
  await assert.rejects(book(f, s, { patientId: p2, date: otherDate, minute: 600 }), /OUTSIDE_WORKING_HOURS/); // day without a row is closed
  await f.command('working_hours.remove', { dayOfWeek: String(dow) });
  await book(f, s, { patientId: p2, date: otherDate, minute: 600 }); // no hours at all -> open
});

test('appointments: past and far dates, version conflicts, and a midnight-crossing slot (AC-10)', async () => {
  const f = await fixture(db), s = await setupSchedule(f), p = await f.patient(), p2 = await f.patient();
  await assert.rejects(book(f, s, { patientId: p, date: await dayAfter(-1), minute: 600 }), /PAST_APPOINTMENT/);
  await assert.rejects(book(f, s, { patientId: p, date: await dayAfter(400), minute: 600 }), /APPOINTMENT_TOO_FAR/);
  const date = await dayAfter(9);
  const appt = await book(f, s, { patientId: p, date, minute: 600 });
  await assert.rejects(f.command('appointment.reschedule', { appointmentId: appt.id, expectedVersion: 2, date, minute: '900', duration: '30' }), /VERSION_CONFLICT/);
  await f.command('appointment.reschedule', { appointmentId: appt.id, expectedVersion: 1, date, minute: '900', duration: '30' });
  await book(f, s, { patientId: p2, date, minute: 600 }); // old slot freed by reschedule
  // Start-of-day inside configured hours (0..1440 covers the whole day).
  const midnightDate = await dayAfter(11);
  const mdDow = Number((await db.query('SELECT EXTRACT(DOW FROM $1::date)::int AS d', [midnightDate])).rows[0].d);
  await f.command('working_hours.set', { dayOfWeek: String(mdDow), openMinute: '0', closeMinute: '1440' });
  const p3 = await f.patient();
  await book(f, s, { patientId: p3, date: midnightDate, minute: 0, duration: 30 });
  // With the branch's only hours row removed, a crossing-midnight slot books on its own clinic day.
  await f.command('working_hours.remove', { dayOfWeek: String(mdDow) });
  const crossDate = await dayAfter(13);
  const p4 = await f.patient();
  await book(f, s, { patientId: p4, date: crossDate, minute: 1425, duration: 30 });
  const row = (await db.query('SELECT scheduled_minute,duration_minutes FROM clinic.appointment WHERE id=$1', [appt.id])).rows[0];
  assert.deepEqual(row, { scheduled_minute: 900, duration_minutes: 30 });
});

test('appointments: cancel with reason frees the slot; no_show and complete close the state machine', async () => {
  const f = await fixture(db), s = await setupSchedule(f), p = await f.patient(), p2 = await f.patient(), p3 = await f.patient();
  const date = await dayAfter(7);
  const appt = await book(f, s, { patientId: p, date, minute: 600 });
  await assert.rejects(f.command('appointment.cancel', { appointmentId: appt.id, expectedVersion: 1, reason: 'x' }), /CANCEL_REASON_REQUIRED/);
  await f.command('appointment.cancel', { appointmentId: appt.id, expectedVersion: 1, reason: 'سافر المريض' });
  await book(f, s, { patientId: p2, date, minute: 600 }); // slot freed
  await assert.rejects(f.command('appointment.cancel', { appointmentId: appt.id, expectedVersion: 2, reason: 'محاولة ثانية' }), /APPOINTMENT_NOT_BOOKED/);
  const b2 = await book(f, s, { patientId: p2, date, minute: 700 });
  await f.command('appointment.no_show', { appointmentId: b2.id, expectedVersion: 1 });
  const b3 = await book(f, s, { patientId: p3, date, minute: 800 });
  await f.command('appointment.complete', { appointmentId: b3.id, expectedVersion: 1 });
  const rows = Object.fromEntries((await db.query('SELECT id,status FROM clinic.appointment WHERE branch_id=$1', [f.branch])).rows.map(r => [r.id, r.status]));
  assert.equal(rows[appt.id], 'cancelled');
  assert.equal(rows[b2.id], 'no_show');
  assert.equal(rows[b3.id], 'completed');
});

test('arrivals: queue numbers, call identity and transitions never depend on names (FLOW-02, LOUNGE-01)', async () => {
  const f = await fixture(db), s = await setupSchedule(f);
  const p1 = await f.patient({ fullName: 'أحمد محمد' }), p2 = await f.patient({ fullName: 'أحمد محمد' }), p3 = await f.patient();
  const date = await dayAfter(7);
  const appt1 = await book(f, s, { patientId: p1, date, minute: 600 });
  const a1 = await f.command('arrival.create', { patientId: p1, appointmentId: appt1.id });
  assert.equal(a1.queueNumber, 1);
  await assert.rejects(f.command('arrival.create', { patientId: p1, appointmentId: appt1.id }), /ARRIVAL_ALREADY_EXISTS|one_arrival_per_appointment/);
  const a2 = await f.command('arrival.create', { patientId: p2 });
  assert.equal(a2.queueNumber, 2);
  const appt3 = await book(f, s, { patientId: p3, date, minute: 700 });
  await assert.rejects(f.command('arrival.create', { patientId: p1, appointmentId: appt3.id }), /APPOINTMENT_PATIENT_MISMATCH/);
  const c1 = await f.command('arrival.call', { arrivalId: a1.id });
  assert.equal(c1.queueNumber, 1);
  await assert.rejects(f.command('arrival.call', { arrivalId: a1.id }), /INVALID_TRANSITION/);
  const recall = await f.command('arrival.recall', { arrivalId: a1.id });
  assert.equal(recall.eventId, c1.eventId); assert.equal(recall.repeats, 2);
  const c2 = await f.command('arrival.call', { arrivalId: a2.id });
  assert.notEqual(c2.eventId, c1.eventId);
  await f.command('arrival.recall', { arrivalId: a1.id });
  const repeat2 = (await db.query('SELECT repeats FROM clinic.call_event WHERE id=$1', [c2.eventId])).rows[0].repeats;
  assert.equal(repeat2, 1); // recall of one arrival never mutates the other's event
  assert.equal((await db.query('SELECT count(*)::int AS n FROM clinic.call_event WHERE branch_id=$1', [f.branch])).rows[0].n, 2);
  const chairId = s.chair;
  await f.command('arrival.seat', { arrivalId: a1.id, chairId });
  await f.command('arrival.finish', { arrivalId: a1.id });
  await assert.rejects(f.command('arrival.call', { arrivalId: a1.id }), /INVALID_TRANSITION/);
  await assert.rejects(f.command('arrival.finish', { arrivalId: a2.id }), /INVALID_TRANSITION/); // called, not seated
  await f.command('arrival.leave', { arrivalId: a2.id });
  const statuses = Object.fromEntries((await db.query('SELECT id,status FROM clinic.arrival WHERE branch_id=$1', [f.branch])).rows.map(r => [r.id, r.status]));
  assert.deepEqual(statuses, { [a1.id]: 'done', [a2.id]: 'left' });
});

test('lounge snapshot: minimal payload only, expiry, cursor and branch isolation (LOUNGE-02/03)', async () => {
  const f = await fixture(db), s = await setupSchedule(f);
  const p1 = await f.patient({ fullName: 'أحمد محمد صالح', phone: '777111222' }), p2 = await f.patient({ fullName: 'عبدالله' });
  const a1 = await f.command('arrival.create', { patientId: p1 });
  await f.command('arrival.call', { arrivalId: a1.id });
  const a2 = await f.command('arrival.create', { patientId: p2 });
  const c2 = await f.command('arrival.call', { arrivalId: a2.id });
  const other = await fixture(db); // second branch
  const oa = await other.command('arrival.create', { patientId: await other.patient() });
  await other.command('arrival.call', { arrivalId: oa.id });

  const snap = (branch, since = '0') => db.query('SELECT clinic.lounge_snapshot($1,$2::bigint) AS s', [branch, since]);
  const data = (await snap(f.branch)).rows[0].s;
  assert.deepEqual(Object.keys(data).sort(), ['activeCall', 'branch', 'displayMode', 'events', 'generatedAt', 'waitingCount']);
  assert.equal(data.displayMode, 'masked_name');
  assert.equal(data.activeCall.displayName, 'ع•••'); // latest call, masked in SQL not in the browser
  assert.ok(data.events.some(e => e.displayName === 'أحمد م.')); // three-word name keeps first word + initial
  const serialized = JSON.stringify(data);
  assert.equal(serialized.includes('أحمد محمد صالح'), false);
  assert.equal(serialized.includes('777111222'), false);
  assert.equal(serialized.includes('patient_id'), false);
  assert.equal(serialized.includes(other.branch), false);
  assert.equal(data.events.length, 2);
  assert.equal(data.waitingCount, 2);

  const masked = (await db.query("SELECT clinic.mask_name('عبدالله') AS m")).rows[0].m;
  assert.equal(masked, 'ع•••');
  const otherData = (await snap(other.branch)).rows[0].s;
  assert.equal(otherData.events.length, 1);
  assert.equal(otherData.events[0].eventId !== data.events[0].eventId, true);

  const cursor = (await snap(f.branch, String(c2.sequence - 1))).rows[0].s;
  assert.equal(cursor.events.length, 1); // events after the cursor only
  // Expired call is never presented as current.
  await db.query("UPDATE clinic.call_event SET last_called_at=now()-interval '20 minutes' WHERE branch_id=$1", [f.branch]);
  const expired = (await snap(f.branch)).rows[0].s;
  assert.equal(expired.activeCall, null);
  // Seated arrival leaves the active call; the other arrival stays called.
  await db.query("UPDATE clinic.call_event SET last_called_at=now() WHERE branch_id=$1", [f.branch]);
  const beforeSeat = (await snap(f.branch)).rows[0].s;
  assert.equal(beforeSeat.activeCall.queueNumber, 2);
  await f.command('arrival.seat', { arrivalId: a1.id, chairId: s.chair });
  await f.command('arrival.seat', { arrivalId: a2.id, chairId: s.chair });
  const seated = (await snap(f.branch)).rows[0].s;
  assert.equal(seated.activeCall, null);
  // Queue-number display mode sends no display name at all.
  await f.command('setting.write', { key: 'lounge.display_mode', value: { mode: 'queue_number' }, expectedVersion: 1 });
  const queueMode = (await snap(f.branch)).rows[0].s;
  assert.equal(queueMode.displayMode, 'queue_number');
  assert.equal(queueMode.events.every(e => e.displayName === null), true);
  assert.equal((await snap(randomUUID())).rows[0].s, null);
});

test('appointment requests: one pending per phone/date, request booking shares the slot lock (BOOK-02)', async () => {
  const f = await fixture(db), s = await setupSchedule(f);
  const date = await dayAfter(3), otherDay = await dayAfter(4);
  const first = await db.query("SELECT clinic.submit_appointment_request($1,'سعيد العمري','777123456','general',$2::date,'أفضل الصباح') AS id", [f.branch, date]);
  assert.ok(first.rows[0].id);
  await assert.rejects(db.query("SELECT clinic.submit_appointment_request($1,'سعيد العمري','777123456','general',$2::date,'') AS id", [f.branch, date]), /one_pending_request/);
  const second = await db.query("SELECT clinic.submit_appointment_request($1,'سعيد العمري','777123456','general',$2::date,'') AS id", [f.branch, otherDay]);
  assert.ok(second.rows[0].id);
  const patient = await f.patient({ fullName: 'سعيد العمري', phone: '777123456' });
  const booked = await book(f, s, { patientId: patient, date, minute: 600, requestId: first.rows[0].id });
  const row = (await db.query('SELECT status,appointment_id FROM clinic.appointment_request WHERE id=$1', [first.rows[0].id])).rows[0];
  assert.equal(row.status, 'booked'); assert.equal(row.appointment_id, booked.id);
  const src = (await db.query('SELECT source FROM clinic.appointment WHERE id=$1', [booked.id])).rows[0].source;
  assert.equal(src, 'request');
  await assert.rejects(book(f, s, { patientId: patient, date: otherDay, minute: 600, requestId: first.rows[0].id }), /INVALID_REQUEST_STATE/);
  await assert.rejects(book(f, s, { patientId: patient, date, minute: 600, requestId: second.rows[0].id }), /TIME_CONFLICT/); // same slot as first booking
  const stillPending = (await db.query('SELECT status FROM clinic.appointment_request WHERE id=$1', [second.rows[0].id])).rows[0].status;
  assert.equal(stillPending, 'pending'); // failed booking rolls back, request stays reviewable
  await f.command('appointment_request.reject', { requestId: second.rows[0].id, reason: 'التاريخ غير متاح هذا الأسبوع' });
  await assert.rejects(book(f, s, { patientId: patient, date: otherDay, minute: 600, requestId: second.rows[0].id }), /INVALID_REQUEST_STATE/);
  const p = (await db.query('SELECT status,review_reason FROM clinic.appointment_request WHERE id=$1', [second.rows[0].id])).rows[0];
  assert.equal(p.status, 'rejected'); assert.match(p.review_reason, /غير متاح/);
});

test('settings: typed keys with optimistic versions, audit row per write (CFG-01 partial)', async () => {
  const f = await fixture(db);
  await assert.rejects(f.command('setting.write', { key: 'other.key', value: { x: 1 }, expectedVersion: 1 }), /UNKNOWN_SETTING/);
  await assert.rejects(f.command('setting.write', { key: 'lounge.display_mode', value: { mode: 'everything' }, expectedVersion: 1 }), /INVALID_SETTING_VALUE/);
  await assert.rejects(f.command('setting.write', { key: 'lounge.call_expiry_seconds', value: { seconds: 10 }, expectedVersion: 1 }), /INVALID_SETTING_VALUE/);
  await assert.rejects(f.command('setting.write', { key: 'lounge.display_mode', value: { mode: 'masked_name' }, expectedVersion: 2 }), /VERSION_CONFLICT/);
  await f.command('setting.write', { key: 'lounge.display_mode', value: { mode: 'masked_name' }, expectedVersion: 1 });
  await f.command('setting.write', { key: 'lounge.display_mode', value: { mode: 'queue_number' }, expectedVersion: 1 });
  await assert.rejects(f.command('setting.write', { key: 'lounge.display_mode', value: { mode: 'masked_name' }, expectedVersion: 1 }), /VERSION_CONFLICT/);
  const row = (await db.query("SELECT version,value FROM clinic.branch_setting WHERE branch_id=$1 AND key='lounge.display_mode'", [f.branch])).rows[0];
  assert.equal(row.version, 2); assert.equal(row.value.mode, 'queue_number');
  const audits = (await db.query("SELECT count(*)::int AS n FROM clinic.audit WHERE branch_id=$1 AND action='setting.write'", [f.branch])).rows[0].n;
  assert.equal(audits, 2);
});

test('visits: appointment linkage stays inside the same patient and branch', async () => {
  const f = await fixture(db), s = await setupSchedule(f);
  const p1 = await f.patient(), p2 = await f.patient();
  const date = await dayAfter(7);
  const appt = await book(f, s, { patientId: p1, date, minute: 600 });
  const plan1 = await f.activePlan({ patientId: p1 }), plan2 = await f.activePlan({ patientId: p2 });
  const visit = await f.command('visit.create', { planId: plan1, appointmentId: appt.id, note: 'جلسة ضمن الموعد' });
  const link = (await db.query('SELECT appointment_id FROM clinic.visit WHERE id=$1', [visit.id])).rows[0].appointment_id;
  assert.equal(link, appt.id);
  await assert.rejects(f.command('visit.create', { planId: plan2, appointmentId: appt.id, note: 'محاولة ربط خاطئة' }), /visit_appointment_scope|23503|CONFLICT/);
});
