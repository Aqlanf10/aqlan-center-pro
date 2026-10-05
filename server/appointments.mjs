// Copyright (c) 2026 Dr. Aqlan Alkamel. All rights reserved.
// Appointment/reception reads plus the two public endpoints: the lounge
// display snapshot and the appointment request intake. Public handlers are
// shaped here and in clinic.lounge_snapshot so private fields never leave
// the server, not just the screen.
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PHONE = /^\+?[0-9]{7,39}$/;
const fail = (status, code) => { throw Object.assign(new Error(code), { status }); };

export function appointmentsApi({ db, now = () => Date.now(), limitWindowMs = 60 * 60 * 1000, limitMax = 20 }) {
  const ipHits = new Map();
  function throttle(ip) {
    for (const [key, value] of ipHits) if (value.until <= now()) ipHits.delete(key);
    if (ipHits.size > 10000) fail(429, 'RATE_LIMITED');
    const state = ipHits.get(ip);
    if (state && state.count >= limitMax) fail(429, 'RATE_LIMITED');
    const next = state || { count: 0, until: now() + limitWindowMs };
    next.count++; ipHits.set(ip, next);
  }
  async function publicLounge(branchId, sinceRaw) {
    if (!UUID.test(branchId || '')) fail(404, 'BRANCH_NOT_FOUND');
    const since = /^[0-9]{1,19}$/.test(sinceRaw || '') ? sinceRaw : '0';
    const r = await db.query('SELECT clinic.lounge_snapshot($1,$2::bigint) AS s', [branchId, since]);
    if (!r.rows[0]?.s) fail(404, 'BRANCH_NOT_FOUND');
    return r.rows[0].s;
  }
  async function createRequest(data, ip) {
    throttle(ip || 'unknown');
    if (!data || Array.isArray(data) || typeof data !== 'object') fail(400, 'INVALID_REQUEST');
    const branchId = typeof data.branchId === 'string' ? data.branchId : '';
    const fullName = typeof data.fullName === 'string' ? data.fullName.trim() : '';
    const phone = typeof data.phone === 'string' ? data.phone.replace(/[\s\-().]/g, '') : '';
    const specialty = typeof data.specialty === 'string' ? data.specialty : '';
    const preferredDate = typeof data.preferredDate === 'string' ? data.preferredDate : '';
    const note = typeof data.note === 'string' ? data.note.trim().slice(0, 1000) : '';
    if (!UUID.test(branchId)) fail(404, 'BRANCH_NOT_FOUND');
    if (fullName.length < 2 || fullName.length > 200) fail(400, 'INVALID_REQUEST');
    if (!PHONE.test(phone)) fail(400, 'INVALID_PHONE');
    if (!DATE.test(preferredDate)) fail(400, 'INVALID_REQUEST');
    if (note.length > 1000) fail(400, 'INVALID_REQUEST');
    const branch = await db.query('SELECT 1 FROM clinic.branch WHERE id=$1 AND active', [branchId]);
    if (!branch.rows.length) fail(404, 'BRANCH_NOT_FOUND');
    const specialtyRow = await db.query('SELECT 1 FROM clinic.specialty WHERE code=$1', [specialty]);
    if (!specialtyRow.rows.length) fail(400, 'UNKNOWN_SPECIALTY');
    // The branch timezone, the 60-day horizon and duplicate rejection are
    // evaluated atomically in PostgreSQL through the definer function; a
    // duplicate pending request for the same phone/date hits the
    // one_pending_request index (23505).
    const inserted = await db.query(
      'SELECT clinic.submit_appointment_request($1,$2,$3,$4,$5::date,$6) AS id',
      [branchId, fullName, phone, specialty, preferredDate, note]).catch(e => {
      if (e.code === '23505') fail(409, 'DUPLICATE_REQUEST');
      throw e;
    });
    if (!inserted.rows.length || !inserted.rows[0].id) fail(400, 'INVALID_REQUEST_DATE');
    return { ok: true, id: inserted.rows[0].id };
  }
  async function listAppointments(actor, branch, dateRaw) {
    const date = dateRaw ? dateRaw : null;
    if (date && !DATE.test(date)) fail(400, 'INVALID_REQUEST');
    const r = await db.query(
      `SELECT a.id,a.patient_id,p.full_name,a.doctor_id,d.display_name AS doctor_name,
        a.chair_id,c.name AS chair_name,c.room,a.specialty,a.scheduled_date::text AS scheduled_date,
        a.scheduled_minute,a.duration_minutes,a.kind,a.status,a.version,a.cancel_reason
       FROM clinic.appointment a
       JOIN clinic.patient p ON p.id=a.patient_id
       JOIN clinic.staff d ON d.id=a.doctor_id
       JOIN clinic.chair c ON c.id=a.chair_id
       WHERE a.branch_id=$1 AND ($2::date IS NULL OR a.scheduled_date=$2::date)
       ORDER BY a.scheduled_date,a.scheduled_minute,a.id`, [branch, date]);
    return { appointments: r.rows };
  }
  async function listArrivals(actor, branch, dateRaw) {
    const date = dateRaw ? dateRaw : null;
    if (date && !DATE.test(date)) fail(400, 'INVALID_REQUEST');
    const r = await db.query(
      `SELECT ar.id,ar.patient_id,p.full_name,ar.appointment_id,ar.queue_date::text AS queue_date,
        ar.queue_number,ar.status,ar.chair_id,c.name AS chair_name,ar.note,ar.version,
        ar.arrived_at,ar.called_at,ar.seated_at,ar.finished_at,ar.left_at
       FROM clinic.arrival ar
       JOIN clinic.patient p ON p.id=ar.patient_id
       LEFT JOIN clinic.chair c ON c.id=ar.chair_id
       WHERE ar.branch_id=$1 AND ($2::date IS NULL OR ar.queue_date=$2::date)
       ORDER BY ar.queue_number`, [branch, date]);
    return { arrivals: r.rows };
  }
  async function listRequests(actor, branch, statusRaw) {
    if (statusRaw && !['pending', 'booked', 'rejected'].includes(statusRaw)) fail(400, 'INVALID_REQUEST');
    const r = await db.query(
      `SELECT r.id,r.full_name,r.phone,r.specialty,r.preferred_date::text AS preferred_date,
        r.note,r.status,r.review_reason,r.appointment_id,r.created_at
       FROM clinic.appointment_request r
       WHERE r.branch_id=$1 AND ($2::text IS NULL OR r.status=$2)
       ORDER BY (r.status='pending') DESC,r.created_at DESC LIMIT 200`, [branch, statusRaw || null]);
    return { requests: r.rows };
  }
  async function scheduleConfig(actor, branch) {
    const r = await db.query(
      `SELECT
        (SELECT coalesce(jsonb_agg(jsonb_build_object('id',c.id,'name',c.name,'room',c.room,'active',c.active) ORDER BY c.name),'[]'::jsonb)
          FROM clinic.chair c WHERE c.branch_id=$1) AS chairs,
        (SELECT coalesce(jsonb_agg(jsonb_build_object('dayOfWeek',w.day_of_week,'openMinute',w.open_minute,'closeMinute',w.close_minute) ORDER BY w.day_of_week),'[]'::jsonb)
          FROM clinic.working_hours w WHERE w.branch_id=$1) AS working_hours,
        (SELECT coalesce(jsonb_agg(jsonb_build_object('date',h.holiday_date::text,'reason',h.reason) ORDER BY h.holiday_date),'[]'::jsonb)
          FROM clinic.holiday h WHERE h.branch_id=$1) AS holidays,
        (SELECT coalesce(jsonb_object_agg(s.key,s.value||jsonb_build_object('version',s.version)),'{}'::jsonb)
          FROM clinic.branch_setting s WHERE s.branch_id=$1) AS settings,
        (SELECT coalesce(jsonb_agg(jsonb_build_object('id',m.staff_id,'name',st.display_name) ORDER BY st.display_name),'[]'::jsonb)
          FROM clinic.membership m JOIN clinic.staff st ON st.id=m.staff_id
          WHERE m.branch_id=$1 AND st.active) AS doctors`, [branch]);
    return r.rows[0];
  }
  return { publicLounge, createRequest, listAppointments, listArrivals, listRequests, scheduleConfig };
}
