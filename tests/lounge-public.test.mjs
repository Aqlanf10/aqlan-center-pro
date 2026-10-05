import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from '../server/app.mjs';
import { hashPassword } from '../server/password.mjs';

test('public lounge and appointment-request HTTP: minimal payload, isolation, duplicates and throttling (LOUNGE-02/03, BOOK-02)', async () => {
  const db = new PGlite();
  for (const file of (await readdir(new URL('../db/', import.meta.url))).filter(f => /^\d+.*\.sql$/.test(f)).sort()) await db.exec(await readFile(new URL(`../db/${file}`, import.meta.url), 'utf8'));
  const branch = randomUUID(), actor = randomUUID(), role = randomUUID();
  await db.query('INSERT INTO clinic.branch(id,name) VALUES($1,$2)', [branch, 'فرع الصالة']);
  await db.query('INSERT INTO clinic.staff(id,display_name) VALUES($1,$2)', [actor, 'موظف الاستقبال']);
  await db.query('INSERT INTO clinic.role(id,name) VALUES($1,$2)', [role, role]);
  await db.query('INSERT INTO clinic.role_permission SELECT $1,code FROM clinic.permission', [role]);
  await db.query('INSERT INTO clinic.membership VALUES($1,$2,$3)', [actor, branch, role]);
  await db.query('INSERT INTO clinic.login_account(staff_id,username,password_hash) VALUES($1,$2,$3)', [actor, 'reception.owner', await hashPassword('reception-password-1')]);
  const runtime = { query: async (sql, params) => { await db.exec('SET ROLE clinic_runtime'); try { return await db.query(sql, params); } finally { await db.exec('RESET ROLE'); } } };
  const origin = 'http://localhost:3000';
  const server = createApp({ db: runtime, origin });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (path, cookie) => fetch(base + path, { headers: cookie ? { Cookie: cookie } : {} });
  const post = (path, data, cookie) => fetch(base + path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(data) });
  const command = (name, payload, cookie) => post(`/api/branches/${branch}/commands`, { key: randomUUID(), command: name, payload }, cookie);
  try {
    // Public lounge requires no session and never exposes sensitive fields.
    const emptyLounge = await get(`/api/public/lounge/${branch}`);
    assert.equal(emptyLounge.status, 200);
    assert.deepEqual(Object.keys(await emptyLounge.json()).sort(), ['activeCall', 'branch', 'displayMode', 'events', 'generatedAt', 'waitingCount']);
    assert.equal((await get(`/api/public/lounge/${randomUUID()}`)).status, 404);
    assert.equal((await get('/api/public/lounge/not-a-uuid')).status, 404);

    // Scheduled routes are session-guarded and permission-guarded.
    assert.equal((await get(`/api/branches/${branch}/appointments`)).status, 401);
    const login = await post('/api/login', { username: 'reception.owner', password: 'reception-password-1' });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    assert.equal((await get(`/api/branches/${branch}/schedule-config`, cookie)).status, 200);
    const cfg = (await (await get(`/api/branches/${branch}/schedule-config`, cookie)).json());
    assert.equal(cfg.doctors.length, 1);
    await db.query("DELETE FROM clinic.role_permission WHERE role_id=$1 AND permission='appointment.write'", [role]);
    assert.equal((await get(`/api/branches/${branch}/appointments`, cookie)).status, 403);
    await db.query("INSERT INTO clinic.role_permission VALUES($1,'appointment.write')", [role]);

    // Booking through the public HTTP command path, then arrival + call.
    const patient = (await command('patient.create', { fullName: 'زائر الصالة', phone: '777000111' }, cookie));
    assert.equal(patient.status, 200);
    const patientId = (await patient.json()).id;
    const chair = (await command('chair.create', { name: 'كرسي الصالة', room: 'غرفة 1' }, cookie));
    const chairId = (await chair.json()).id;
    const date = (await db.query("SELECT ((now() AT TIME ZONE 'Asia/Aden')::date + 7)::text AS d")).rows[0].d;
    const booked = await command('appointment.book', { patientId, doctorId: actor, chairId, specialty: 'general', date, minute: '600', duration: '30' }, cookie);
    assert.equal(booked.status, 200);
    const appointmentId = (await booked.json()).id;
    const arrival = await command('arrival.create', { patientId, appointmentId }, cookie);
    const arrivalId = (await arrival.json()).id;
    const call = await command('arrival.call', { arrivalId }, cookie);
    const callData = await call.json();

    const lounge = await (await get(`/api/public/lounge/${branch}`)).json();
    assert.equal(lounge.branch, 'فرع الصالة');
    assert.equal(lounge.activeCall.displayName, 'زائر ا.');
    assert.equal(lounge.activeCall.queueNumber, 1);
    assert.equal(lounge.activeCall.eventId, callData.eventId);
    const serialized = JSON.stringify(lounge);
    for (const secret of ['زائر الصالة', '777000111', 'patient_id', 'file_number', 'phone']) assert.equal(serialized.includes(secret), false);

    // Public request intake: validation, duplicate rejection, range checks.
    const tomorrow = (await db.query("SELECT ((now() AT TIME ZONE 'Asia/Aden')::date + 1)::text AS d")).rows[0].d;
    const ok = await post('/api/public/appointment-request', { branchId: branch, fullName: 'طالب موعد', phone: '+967 777 123 456', specialty: 'orthodontics', preferredDate: tomorrow, note: 'أفضل العصر' });
    assert.equal(ok.status, 200);
    const okData = await ok.json();
    assert.ok(okData.id);
    const duplicate = await post('/api/public/appointment-request', { branchId: branch, fullName: 'طالب موعد', phone: '+967777123456', specialty: 'orthodontics', preferredDate: tomorrow });
    assert.equal(duplicate.status, 409);
    assert.equal((await duplicate.json()).error, 'DUPLICATE_REQUEST');
    assert.equal((await post('/api/public/appointment-request', { branchId: branch, fullName: 'طالب موعد', phone: 'abc', specialty: 'orthodontics', preferredDate: tomorrow })).status, 400);
    assert.equal((await post('/api/public/appointment-request', { branchId: branch, fullName: 'طالب موعد', phone: '777999888', specialty: 'orthodontics', preferredDate: '2020-01-01' })).status, 400);
    assert.equal((await post('/api/public/appointment-request', { branchId: randomUUID(), fullName: 'طالب موعد', phone: '777999888', specialty: 'general', preferredDate: tomorrow })).status, 404);
    const requests = await (await get(`/api/branches/${branch}/appointment-requests?status=pending`, cookie)).json();
    assert.equal(requests.requests.length, 1);
    assert.equal(requests.requests[0].phone, '+967777123456');

    // Per-IP throttling bounds anonymous abuse (single-instance budget).
    let throttled = 0;
    for (let i = 0; i < 25; i++) {
      const r = await post('/api/public/appointment-request', { branchId: branch, fullName: `طالب ${i}`, phone: `777456${String(i).padStart(3, '0')}`, specialty: 'general', preferredDate: tomorrow });
      if (r.status === 429) throttled++;
    }
    assert.ok(throttled > 0, 'expected at least one 429 after the IP budget');
  } finally {
    await new Promise(resolve => server.close(resolve));
    await db.close();
  }
});
