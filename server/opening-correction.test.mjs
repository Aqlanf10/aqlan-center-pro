import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from './app.mjs';
import { hashPassword } from './password.mjs';

test('legacy opening correction: reversal chain, balances, idempotency, guards', async t => {
 const db = new PGlite(); let server;
 try {
  const directory = new URL('../db/', import.meta.url);
  for (const file of (await readdir(directory)).filter(f => /^\d+.*\.sql$/.test(f)).sort())
   await db.exec(await readFile(new URL(file, directory), 'utf8'));
  const owner = randomUUID(), doctor = randomUUID(), opener = randomUUID(), branch = randomUUID();
  const ownerRole = randomUUID(), doctorRole = randomUUID(), openerRole = randomUUID();
  await db.query('INSERT INTO clinic.staff(id,display_name) VALUES($1,$2),($3,$4),($5,$6)',
    [owner, 'المدير', doctor, 'الطبيب', opener, 'مفتتح الحسابات']);
  await db.query('INSERT INTO clinic.branch(id,name) VALUES($1,$2)', [branch, 'الفرع الرئيسي']);
  await db.query('INSERT INTO clinic.role(id,name) VALUES($1,$2),($3,$4),($5,$6)',
    [ownerRole, 'Owner', doctorRole, 'Doctor', openerRole, 'Opener']);
  await db.query('INSERT INTO clinic.role_permission SELECT $1,code FROM clinic.permission', [ownerRole]);
  await db.query("INSERT INTO clinic.role_permission SELECT $1,code FROM clinic.permission WHERE code IN ('patient.read','clinical.read','clinical.write')", [doctorRole]);
  await db.query("INSERT INTO clinic.role_permission SELECT $1,code FROM clinic.permission WHERE code IN ('patient.read','finance.read','finance.opening','finance.agree')", [openerRole]);
  await db.query('INSERT INTO clinic.membership VALUES($1,$2,$3),($4,$2,$5),($6,$2,$7)',
    [owner, branch, ownerRole, doctor, doctorRole, opener, openerRole]);
  const password = 'fixture-' + randomUUID(), passwordHash = await hashPassword(password);
  await db.query('INSERT INTO clinic.login_account(staff_id,username,password_hash) VALUES($1,$2,$3),($4,$5,$3),($6,$7,$3)',
    [owner, 'ob-owner', passwordHash, doctor, 'ob-doctor', opener, 'ob-opener']);
  await db.exec('CREATE ROLE ob_runtime LOGIN INHERIT; GRANT clinic_runtime TO ob_runtime');
  // Every app query runs inside a per-query transaction authorized as the
  // runtime role, so the connection itself stays superuser for the few
  // direct checks (audit, guard-trigger inserts) the HTTP surface never
  // performs. This mirrors production exactly: runtime role for app paths.
  const runAsRuntime = async (sql, params) => {
   await db.exec('BEGIN');
   try {
    // SET LOCAL ROLE (not SESSION AUTHORIZATION): it reliably reverts at
    // COMMIT, and the superuser connection may assume any role.
    await db.exec('SET LOCAL ROLE ob_runtime');
    const result = await db.query(sql, params);
    await db.exec('COMMIT');
    return result;
   } catch (e) { await db.exec('ROLLBACK'); throw e; }
  };
  server = createApp({ db: { query: runAsRuntime }, origin: 'http://localhost:3000' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, { cookie, body, method = body ? 'POST' : 'GET' } = {}) => {
   const response = await fetch(base + path, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { Origin: 'http://localhost:3000', 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
   return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const login = async u => {
   const r = await request('/api/login', { body: { username: u, password } });
   if (r.status !== 200) throw new Error(`login ${u} -> ${r.status} ${JSON.stringify(r.data)}`);
   return r.cookie;
 };
  const ownerCookie = await login('ob-owner');
  const doctorCookie = await login('ob-doctor');
  const openerCookie = await login('ob-opener');
  const command = async (cookie, commandName, payload, key = randomUUID()) =>
    request(`/api/branches/${branch}/commands`, { cookie, body: { key, command: commandName, payload } });
  // Setup steps must succeed; a non-2xx here is a harness bug, not an assertion.
  const must = async (cookie, commandName, payload) => {
    const r = await command(cookie, commandName, payload);
    if (r.status !== 200) throw new Error(`setup ${commandName} -> ${r.status} ${JSON.stringify(r.data)}`);
    return r.data;
  };
  const balances = async (patientId, currency = 'YER') => {
   const r = await request(`/api/branches/${branch}/patients/${patientId}/statement`, { cookie: ownerCookie });
   return r.data.balances.find(b => b.currency === currency)?.balance || '0.00';
  };
  const standingCount = async patientId => (await db.query(
    `SELECT count(*)::int AS n FROM clinic.journal j WHERE j.patient_id=$1 AND j.branch_id=$2
     AND j.kind IN ('agreement','legacy_opening','legacy_opening_correction')
     AND NOT EXISTS(SELECT 1 FROM clinic.journal r WHERE r.reverses=j.id)`, [patientId, branch])).rows[0].n;
  // audit rows and direct journal inserts are checked above the runtime
  // boundary (connection superuser); the HTTP surface itself never needs them.
  const elevated = async (sql, params) => db.query(sql, params);

  // --- setup: activated legacy opening with a standing 6000.00 receivable ---
  const patient = (await must(ownerCookie, 'patient.create', { fullName: 'مريض الافتتاحي', phone: '+967700000001' })).id;
  const plan = (await must(ownerCookie, 'plan.create', { patientId: patient, specialty: 'general', title: 'حالة سابقة للتصحيح', origin: 'legacy', currency: 'YER', agreed: '10000.00', previouslyPaid: '4000.00', sourceSystem: 'paper', sourceRecordId: 'P-0001', asOfDate: '2026-09-01', disputed: false, clinicalSummary: { progress: 'استكمال مرحلة' } })).id;
  const v1 = await must(ownerCookie, 'legacy.review', { planId: plan, agreed: '10000.00', previouslyPaid: '4000.00', disputed: false, reason: 'تثبيت أرقام الأرشيف الورقي', expectedVersion: 1 });
  assert.equal(v1.command, 'legacy.review');
  const activated = await must(ownerCookie, 'legacy.activate', { planId: plan, expectedVersion: 2 });
  assert.equal(activated.command, 'legacy.activate');
  assert.equal(await balances(patient), '6000.00');
  assert.equal(await standingCount(patient), 1);
  const planRow1 = (await db.query('SELECT version,as_of_date::text AS d FROM clinic.plan WHERE id=$1', [plan])).rows[0];
  assert.equal(planRow1.version, 3);

  // --- OB-01: correction reduces the carried remainder (6000 -> 4000) ---
  const correction = await command(ownerCookie, 'legacy.correct', { planId: plan, expectedVersion: 3, agreed: '10000.00', previouslyPaid: '6000.00', asOfDate: '2026-09-01', reason: 'رقم القيد الورقي كان 6000 وليس 4000 — إثبات من دفتر الأرشيف' });
  assert.equal(correction.status, 200);
  assert.equal(await balances(patient), '4000.00');
  assert.equal(await standingCount(patient), 1);
  const kinds = (await db.query('SELECT j.kind FROM clinic.journal j WHERE j.patient_id=$1 AND j.branch_id=$2 ORDER BY j.recorded_at,j.id', [patient, branch])).rows.map(r => r.kind).sort();
  // reversal + correction share one transaction timestamp, so compare as a set
  assert.deepEqual(kinds, ['legacy_opening', 'legacy_opening_correction', 'reversal']);
  const meta = (await elevated("SELECT metadata FROM clinic.audit WHERE action='legacy.correct' ORDER BY id DESC LIMIT 1")).rows[0].metadata;
  assert.ok(meta.reversalJournal && meta.correctionJournal);
  const reversedTarget = (await elevated('SELECT reverses FROM clinic.journal WHERE id=$1', [meta.reversalJournal])).rows[0].reverses;
  assert.equal(reversedTarget, meta.before.standingOpeningJournal);
  const planRow2 = (await db.query('SELECT version,previously_paid,agreed FROM clinic.plan WHERE id=$1', [plan])).rows[0];
  assert.equal(planRow2.version, 4);
  assert.equal(planRow2.previously_paid, '6000.00');

  // --- idempotency: same key replays the stored result, no new journals ---
  const journalsBefore = (await db.query('SELECT count(*)::int AS n FROM clinic.journal WHERE patient_id=$1', [patient])).rows[0].n;
  const replayKey = randomUUID();
  const first = await command(ownerCookie, 'legacy.correct', { planId: plan, expectedVersion: 4, agreed: '10000.00', previouslyPaid: '7000.00', asOfDate: '2026-09-01', reason: 'تصحيح ثانٍ موثق من نفس المصدر' }, replayKey);
  assert.equal(first.status, 200);
  const replay = await command(ownerCookie, 'legacy.correct', { planId: plan, expectedVersion: 4, agreed: '10000.00', previouslyPaid: '7000.00', asOfDate: '2026-09-01', reason: 'تصحيح ثانٍ موثق من نفس المصدر' }, replayKey);
  assert.equal(replay.status, 200);
  assert.equal(replay.data.id, first.data.id);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM clinic.journal WHERE patient_id=$1', [patient])).rows[0].n, journalsBefore + 2);
  assert.equal(await standingCount(patient), 1);
  assert.equal(await balances(patient), '3000.00');
  // conflicting payload on the same key is rejected
  const conflict = await command(ownerCookie, 'legacy.correct', { planId: plan, expectedVersion: 4, agreed: '10000.00', previouslyPaid: '8000.00', asOfDate: '2026-09-01', reason: 'تصحيح ثانٍ موثق من نفس المصدر' }, replayKey);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.data.error, 'CONFLICT');

  // --- OB-02: in-system payments cap the correction (no phantom cash) ---
  const paid = (await command(ownerCookie, 'payment.collect', { planId: plan, amount: '1000.00', currency: 'YER', rate: '1' })).data.id;
  assert.ok(paid);
  assert.equal(await balances(patient), '2000.00');
  const tooFar = await command(ownerCookie, 'legacy.correct', { planId: plan, expectedVersion: 5, agreed: '10000.00', previouslyPaid: '9500.00', asOfDate: '2026-09-01', reason: 'محاولة تتجاوز المحصل فعلياً وتصنع دائنًا وهميًا' });
  assert.equal(tooFar.status, 400);
  assert.equal(tooFar.data.error, 'CORRECTION_EXCEEDS_COLLECTED_PAYMENTS');
  assert.equal(await balances(patient), '2000.00');

  // --- guard: a second standing opening can never be inserted directly ---
  const planId = plan;
  await assert.rejects(
    () => elevated(`INSERT INTO clinic.journal(branch_id,patient_id,plan_id,kind,actor_id,effective_date)
      VALUES($1,$2,$3,'legacy_opening',$4,current_date)`, [branch, patient, planId, owner]),
    /OPENING_ALREADY_STANDING/);

  // --- historical credit balance correction (no in-system payments yet) ---
  const p2 = (await must(ownerCookie, 'patient.create', { fullName: 'مريض دائن تاريخي', phone: '+967700000002' })).id;
  const plan2 = (await must(ownerCookie, 'plan.create', { patientId: p2, specialty: 'general', title: 'حالة دائنة تاريخية', origin: 'legacy', currency: 'YER', agreed: '3000.00', previouslyPaid: '5000.00', sourceSystem: 'mini', sourceRecordId: 'M-77', asOfDate: '2026-08-15', disputed: false, clinicalSummary: {} })).id;
  await must(ownerCookie, 'legacy.activate', { planId: plan2, expectedVersion: 1 });
  assert.equal(await balances(p2), '-2000.00');
  const creditFix = await command(ownerCookie, 'legacy.correct', { planId: plan2, expectedVersion: 2, agreed: '3000.00', previouslyPaid: '4500.00', asOfDate: '2026-08-15', reason: 'تخفيف الدائن التاريخي بعد مراجعة الإيصالات' });
  assert.equal(creditFix.status, 200);
  assert.equal(await balances(p2), '-1500.00');
  assert.equal(await standingCount(p2), 1);

  // --- correction to zero: reversal only, no replacement journal ---
  const zeroFix = await command(ownerCookie, 'legacy.correct', { planId: plan2, expectedVersion: 3, agreed: '4500.00', previouslyPaid: '4500.00', asOfDate: '2026-08-15', reason: 'الرصيد الصحيح صفر بعد سداد كامل قبل النظام' });
  assert.equal(zeroFix.status, 200);
  assert.equal(await balances(p2), '0.00');
  const kinds2 = (await db.query('SELECT j.kind FROM clinic.journal j WHERE j.patient_id=$1 ORDER BY j.recorded_at,j.id', [p2])).rows.map(r => r.kind).sort();
  // zeroFix reverses the standing CORRECTION journal from creditFix, so two
  // reversals exist in total; the chain never leaves two openings standing.
  assert.deepEqual(kinds2, ['legacy_opening', 'legacy_opening_correction', 'reversal', 'reversal']);

  // --- zero-remainder activation: correction posts the first journal only ---
  const p3 = (await must(ownerCookie, 'patient.create', { fullName: 'مريض بلا رصيد', phone: '+967700000003' })).id;
  const plan3 = (await must(ownerCookie, 'plan.create', { patientId: p3, specialty: 'general', title: 'سابق مسدد كاملاً', origin: 'legacy', currency: 'SAR', agreed: '500.00', previouslyPaid: '500.00', sourceSystem: 'desktop', sourceRecordId: 'D-9', asOfDate: '2026-07-01', disputed: false, clinicalSummary: {} })).id;
  await must(ownerCookie, 'legacy.activate', { planId: plan3, expectedVersion: 1 });
  assert.equal(await balances(p3, 'SAR'), '0.00');
  const firstJournal = await command(ownerCookie, 'legacy.correct', { planId: plan3, expectedVersion: 2, agreed: '500.00', previouslyPaid: '400.00', asOfDate: '2026-07-01', reason: 'ظهر ذمم 100 بعد جرد الأرشيف' });
  assert.equal(firstJournal.status, 200);
  assert.equal(await balances(p3, 'SAR'), '100.00');
  const kinds3 = (await db.query('SELECT j.kind FROM clinic.journal j WHERE j.patient_id=$1 ORDER BY j.recorded_at,j.id', [p3])).rows.map(r => r.kind).sort();
  assert.deepEqual(kinds3, ['legacy_opening_correction']);

  // --- payment collection respects the corrected balance ---
  await command(ownerCookie, 'payment.collect', { planId: plan3, amount: '80.00', currency: 'SAR', rate: '1' });
  assert.equal(await balances(p3, 'SAR'), '20.00');
  const over = await command(ownerCookie, 'payment.collect', { planId: plan3, amount: '50.00', currency: 'SAR', rate: '1' });
  assert.equal(over.status, 400);
  assert.equal(over.data.error, 'PAYMENT_EXCEEDS_BALANCE_OR_ROUNDS_TO_ZERO');

  // --- validation and authorization rejections ---
  const stale = await command(ownerCookie, 'legacy.correct', { planId: plan3, expectedVersion: 2, agreed: '500.00', previouslyPaid: '400.00', asOfDate: '2026-07-01', reason: 'إصدار قديم بعد تغير الخطة' });
  assert.equal(stale.data.error, 'STALE_PLAN_VERSION');
  const future = await command(ownerCookie, 'legacy.correct', { planId: plan3, expectedVersion: 3, agreed: '500.00', previouslyPaid: '400.00', asOfDate: '2027-01-01', reason: 'تاريخ افتتاحي مستقبلي غير مقبول' });
  assert.equal(future.data.error, 'FUTURE_OPENING_DATE');
  const badFields = await command(ownerCookie, 'legacy.correct', { planId: plan3, expectedVersion: 3, agreed: '500.00', previouslyPaid: '400.00', asOfDate: '2026-07-01', reason: 'سبب صحيح ومكتمل', disputed: false });
  assert.equal(badFields.data.error, 'INVALID_CORRECTION_FIELDS');
  const shortReason = await command(ownerCookie, 'legacy.correct', { planId: plan3, expectedVersion: 3, agreed: '500.00', previouslyPaid: '400.00', asOfDate: '2026-07-01', reason: 'س' });
  assert.equal(shortReason.data.error, 'CORRECTION_REASON_REQUIRED');
  // doctor has no opening authority at all
  const noOpening = await command(doctorCookie, 'legacy.correct', { planId: plan3, expectedVersion: 3, agreed: '500.00', previouslyPaid: '400.00', asOfDate: '2026-07-01', reason: 'الطبيب لا يملك صلاحية الافتتاحي' });
  assert.equal(noOpening.status, 403);
  assert.equal(noOpening.data.error, 'FORBIDDEN');
  // opener can review and agree but cannot reverse journals
  const noReverse = await command(openerCookie, 'legacy.correct', { planId: plan3, expectedVersion: 3, agreed: '500.00', previouslyPaid: '400.00', asOfDate: '2026-07-01', reason: 'الافتتاحي بلا صلاحية عكس القيود' });
  assert.equal(noReverse.status, 403);
  assert.equal(noReverse.data.error, 'FORBIDDEN');
  // draft legacy plan is not correctable
  const draftPlan = (await must(ownerCookie, 'plan.create', { patientId: p3, specialty: 'general', title: 'مسودة لم تُعتمد بعد', origin: 'legacy', currency: 'SAR', agreed: '100.00', previouslyPaid: '0.00', sourceSystem: 'paper', sourceRecordId: 'P-9', asOfDate: '2026-07-01', disputed: false, clinicalSummary: {} })).id;
  const draftTry = await command(ownerCookie, 'legacy.correct', { planId: draftPlan, expectedVersion: 1, agreed: '100.00', previouslyPaid: '0.00', asOfDate: '2026-07-01', reason: 'التصحيح يشمل المعتمد فقط' });
  assert.equal(draftTry.data.error, 'ONLY_ACTIVE_OPENING_CORRECTABLE');
  // new-origin plan is not correctable through the opening path
  const newPlan = (await must(ownerCookie, 'plan.create', { patientId: p3, specialty: 'general', title: 'خطة جديدة عادية', origin: 'new', currency: 'SAR', agreed: '900.00', clinicalSummary: {} })).id;
  const newTry = await command(ownerCookie, 'legacy.correct', { planId: newPlan, expectedVersion: 1, agreed: '900.00', previouslyPaid: '0.00', asOfDate: '2026-07-01', reason: 'مخطط جديد لا يُصحح كافتتاحي' });
  assert.equal(newTry.data.error, 'ONLY_LEGACY_OPENING_CORRECTABLE');
 } finally {
  await server?.close();
  await db.close();
 }
});
