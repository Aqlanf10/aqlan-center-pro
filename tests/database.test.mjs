import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase, fixture } from './helpers/database.mjs';

let db;
before(async () => { db = await createDatabase(); });
after(async () => { await db?.close(); });
const legacy = { origin: 'legacy', sourceSystem: 'paper', sourceRecordId: 'file-123', asOfDate: '2024-01-01', previouslyPaid: '400.00' };

test('database: new patient → plan → visit → payment has shared identities and no legacy cash', async () => {
  const f = await fixture(db), patientId = await f.patient();
  const planId = await f.activePlan({ patientId });
  const step = await f.command('step.create', { planId, procedureName: 'شد التقويم', tooth: '11' });
  const visit = await f.command('visit.create', { planId, stepId: step.id, note: 'متابعة تقدم العلاج' });
  await f.command('visit.sign', { visitId: visit.id, completeStep: true });
  assert.equal(await f.balance(planId), '1000.00');
  assert.equal(await f.balance(planId, 'CASH'), '0');
  await f.command('payment.collect', { planId, amount: '200', currency: 'SAR', rate: '1' });
  assert.equal(await f.balance(planId), '800.00');
  const row = (await db.query('SELECT v.patient_id,v.status,s.status AS step_status FROM clinic.visit v JOIN clinic.visit_work w ON w.visit_id=v.id JOIN clinic.plan_step s ON s.id=w.step_id WHERE v.id=$1', [visit.id])).rows[0];
  assert.deepEqual(row, { patient_id: patientId, status: 'signed', step_status: 'done' });
});

test('database: legacy opening posts only remaining and never historical CASH', async () => {
  const f = await fixture(db), planId = await f.activePlan(legacy);
  assert.equal(await f.balance(planId), '600.00');
  assert.equal(await f.balance(planId, 'CASH'), '0');
  assert.equal(await f.balance(planId, 'LEGACY_CLEARING'), '-600.00');
  const row = (await db.query('SELECT agreed::text,previously_paid::text FROM clinic.plan WHERE id=$1', [planId])).rows[0];
  assert.deepEqual(row, { agreed: '1000.00', previously_paid: '400.00' });
});

test('database: unknown and disputed legacy values stay unknown and require review', async () => {
  const f = await fixture(db);
  for (const [index, change] of [{ agreed: null }, { previouslyPaid: null }, { disputed: true }].entries()) {
    const planId = await f.plan({ ...legacy, sourceRecordId: `review-${index}`, ...change });
    await assert.rejects(f.command('legacy.activate', { planId }), /LEGACY_REVIEW_REQUIRED/);
    assert.equal(await f.balance(planId), '0');
    const row = (await db.query('SELECT status,agreed,previously_paid FROM clinic.plan WHERE id=$1', [planId])).rows[0];
    assert.equal(row.status, 'draft');
    if ('agreed' in change) assert.equal(row.agreed, null);
    if ('previouslyPaid' in change) assert.equal(row.previously_paid, null);
  }
});

test('database: historical patient credit is retained without invented cash', async () => {
  const f = await fixture(db), planId = await f.activePlan({ ...legacy, previouslyPaid: '1200' });
  assert.equal(await f.balance(planId, 'PATIENT_CREDIT'), '-200.00');
  assert.equal(await f.balance(planId, 'RECEIVABLE'), '0');
  assert.equal(await f.balance(planId, 'CASH'), '0');
  await assert.rejects(f.command('payment.collect', { planId, amount: '1', currency: 'SAR', rate: '1' }), /PAYMENT_EXCEEDS/);
});

test('database: actor permissions are branch-scoped and inactive identities are denied', async () => {
  const f = await fixture(db);
  await assert.rejects(f.command('patient.create', { fullName: 'اسم جديد' }, { atBranch: f.otherBranch }), /FORBIDDEN/);
  await db.query('DELETE FROM clinic.role_permission WHERE role_id=$1 AND permission=$2', [f.role, 'finance.agree']);
  await assert.rejects(f.plan(), /FORBIDDEN/);
  await db.query('UPDATE clinic.staff SET active=false WHERE id=$1', [f.actor]);
  await assert.rejects(f.patient(), /FORBIDDEN/);
  await db.query('UPDATE clinic.staff SET active=true WHERE id=$1', [f.actor]);
  await db.query('UPDATE clinic.branch SET active=false WHERE id=$1', [f.branch]);
  await assert.rejects(f.patient(), /FORBIDDEN/);
});

test('database: idempotency retry returns same entity without duplicate journal or audit', async () => {
  const f = await fixture(db), planId = await f.activePlan(), key = randomUUID();
  const payload = { planId, amount: '125', currency: 'SAR', rate: '1' };
  const first = await f.command('payment.collect', payload, { key });
  const audits = await f.count('audit');
  assert.deepEqual(await f.command('payment.collect', payload, { key }), first);
  assert.equal(await f.count('audit'), audits);
  assert.equal(await f.balance(planId), '875.00');
  await assert.rejects(f.command('payment.collect', { ...payload, amount: '126' }, { key }), /IDEMPOTENCY_CONFLICT/);
  await assert.rejects(f.command('patient.create', { fullName: 'تعارض الأمر' }, { key }), /IDEMPOTENCY_CONFLICT/);
});

test('database: failed commands roll back operations, audit and entities and key can retry', async () => {
  const f = await fixture(db), key = randomUUID(), audits = await f.count('audit');
  await assert.rejects(f.command('patient.create', { fullName: 'تاريخ مستقبلي', birthDate: '2999-01-01' }, { key }), /FUTURE_BIRTH_DATE/);
  assert.equal(await f.count('audit'), audits);
  assert.equal(await f.count('operation'), 0);
  assert.equal(Number((await db.query('SELECT count(*) FROM clinic.patient WHERE primary_branch_id=$1', [f.branch])).rows[0].count), 0);
  await f.command('patient.create', { fullName: 'تاريخ صحيح', birthDate: '1990-01-01' }, { key });
  assert.equal(await f.count('operation'), 1);
});

test('database: foreign patient steps cannot be attached and partial visit rolls back', async () => {
  const f = await fixture(db), p1 = await f.activePlan(), p2 = await f.activePlan();
  const step = await f.command('step.create', { planId: p1, procedureName: 'علاج جذور', tooth: '16' });
  const before = await f.count('visit'), audits = await f.count('audit');
  await assert.rejects(f.command('visit.create', { planId: p2, stepId: step.id, note: 'محاولة ربط خاطئة' }), { code: '23503' });
  assert.equal(await f.count('visit'), before);
  assert.equal(await f.count('audit'), audits);
});

test('database: cross-currency payment preserves exact amounts and rate, overpay rolls back', async () => {
  const f = await fixture(db), planId = await f.activePlan();
  const payment = await f.command('payment.collect', { planId, amount: '40000', currency: 'YER', rate: '400' });
  const row = (await db.query('SELECT amount::text,currency,debt_amount::text,debt_currency,rate::text FROM clinic.payment WHERE id=$1', [payment.id])).rows[0];
  assert.deepEqual(row, { amount: '40000.00', currency: 'YER', debt_amount: '100.00', debt_currency: 'SAR', rate: '400.000000000000' });
  assert.equal(await f.balance(planId), '900.00');
  assert.equal(await f.balance(planId, 'CASH'), '40000.00');
  const n = await f.count('journal'), audit = await f.count('audit');
  await assert.rejects(f.command('payment.collect', { planId, amount: '360004', currency: 'YER', rate: '400' }), /PAYMENT_EXCEEDS/);
  assert.equal(await f.count('journal'), n);
  assert.equal(await f.count('audit'), audit);
  const unbalanced = await db.query('SELECT j.id,l.currency FROM clinic.journal j JOIN clinic.journal_line l ON l.journal_id=j.id WHERE j.plan_id=$1 GROUP BY j.id,l.currency HAVING sum(l.debit)<>sum(l.credit)', [planId]);
  assert.equal(unbalanced.rows.length, 0);
});

test('database: payment reversal restores debt and cash exactly and cannot repeat', async () => {
  const f = await fixture(db), planId = await f.activePlan();
  const pay = await f.command('payment.collect', { planId, amount: '375', currency: 'USD', rate: '0.25' }).catch(error => {
    assert.match(error.message, /PAYMENT_EXCEEDS/); return null;
  });
  assert.equal(pay, null);
  const posted = await f.command('payment.collect', { planId, amount: '100', currency: 'USD', rate: '0.25' });
  const journalId = (await db.query('SELECT journal_id FROM clinic.payment WHERE id=$1', [posted.id])).rows[0].journal_id;
  await f.command('payment.reverse', { journalId, reason: 'تصحيح إيصال خاطئ' });
  assert.equal(await f.balance(planId), '1000.00');
  assert.equal(await f.balance(planId, 'CASH'), '0.00');
  await assert.rejects(f.command('payment.reverse', { journalId, reason: 'تكرار العكس' }), /ALREADY_REVERSED/);
});

test('database: visit is signed once, immutable afterwards, with no automatic extra charge', async () => {
  const f = await fixture(db), planId = await f.activePlan(), before = await f.count('journal');
  const visit = await f.command('visit.create', { planId, note: 'جلسة تقويم دورية' }), key = randomUUID();
  await f.command('visit.sign', { visitId: visit.id }, { key });
  await f.command('visit.sign', { visitId: visit.id }, { key });
  await assert.rejects(f.command('visit.sign', { visitId: visit.id }), /VISIT_ALREADY_SIGNED/);
  await assert.rejects(db.query('UPDATE clinic.visit SET note=$1 WHERE id=$2', ['تغيير لاحق', visit.id]), /SIGNED_VISIT_IMMUTABLE/);
  await assert.rejects(db.query('DELETE FROM clinic.visit WHERE id=$1', [visit.id]), /SIGNED_VISIT_IMMUTABLE/);
  assert.equal(await f.count('journal'), before);
});

test('database: posted journals, lines, payments, audits and agreement values are immutable', async () => {
  const f = await fixture(db), planId = await f.activePlan();
  await f.command('payment.collect', { planId, amount: '1', currency: 'SAR', rate: '1' });
  for (const [table, column] of [['journal', 'reason'], ['journal_line', 'account'], ['payment', 'amount'], ['audit', 'action']]) {
    await assert.rejects(db.query(`UPDATE clinic.${table} SET ${column}=${column} WHERE id=(SELECT id FROM clinic.${table} LIMIT 1)`), /APPEND_ONLY/);
    await assert.rejects(db.query(`DELETE FROM clinic.${table} WHERE id=(SELECT id FROM clinic.${table} LIMIT 1)`), /APPEND_ONLY/);
  }
  await assert.rejects(db.query('UPDATE clinic.plan SET agreed=1 WHERE id=$1', [planId]), /POSTED_AGREEMENT_IMMUTABLE/);
  const journalId = (await db.query('SELECT id FROM clinic.journal WHERE plan_id=$1 LIMIT 1', [planId])).rows[0].id;
  await assert.rejects(db.query("INSERT INTO clinic.journal_line(journal_id,account,currency,debit) VALUES($1,'CASH','SAR',1)", [journalId]), /JOURNAL_ALREADY_POSTED/);
});

test('database: unbalanced or empty journals fail at transaction commit', async () => {
  const f = await fixture(db), planId = await f.activePlan();
  const patientId = (await db.query('SELECT patient_id FROM clinic.plan WHERE id=$1', [planId])).rows[0].patient_id;
  for (const withLine of [false, true]) {
    await assert.rejects(db.transaction(async tx => {
      const id = randomUUID();
      await tx.query("INSERT INTO clinic.journal(id,branch_id,patient_id,plan_id,kind,actor_id,effective_date) VALUES($1,$2,$3,$4,'payment',$5,CURRENT_DATE)", [id, f.branch, patientId, planId, f.actor]);
      if (withLine) await tx.query("INSERT INTO clinic.journal_line(journal_id,account,currency,debit) VALUES($1,'CASH','SAR',1)", [id]);
    }), /UNBALANCED_JOURNAL/);
  }
});

test('database: decimal precision, zero values, same-currency FX and duplicate import are guarded', async () => {
  const f = await fixture(db), planId = await f.activePlan();
  for (const payload of [{ amount: '1.001', rate: '1' }, { amount: '0', rate: '1' }, { amount: '1', rate: '0' }, { amount: '1', rate: '2' }]) {
    await assert.rejects(f.command('payment.collect', { planId, currency: 'SAR', ...payload }), /INVALID_/);
  }
  await assert.rejects(f.plan({ agreed: '1.001' }), /INVALID_AMOUNT/);
  await f.plan(legacy);
  await assert.rejects(f.plan(legacy), { code: '23505' });
});

test('database: all three agreement currencies support payment in each other currency', async () => {
  const f = await fixture(db);
  for (const debtCurrency of ['YER', 'SAR', 'USD']) {
    for (const paidCurrency of ['YER', 'SAR', 'USD']) {
      const planId = await f.activePlan({ currency: debtCurrency, agreed: '100' });
      const rate = debtCurrency === paidCurrency ? '1' : '2.5';
      const amount = debtCurrency === paidCurrency ? '10' : '25';
      const result = await f.command('payment.collect', { planId, amount, currency: paidCurrency, rate });
      assert.equal(await f.balance(planId), '90.00');
      const pay = (await db.query('SELECT currency,debt_currency,debt_amount::text FROM clinic.payment WHERE id=$1', [result.id])).rows[0];
      assert.deepEqual(pay, { currency: paidCurrency, debt_currency: debtCurrency, debt_amount: '10.00' });
    }
  }
});

test('database: fully paid legacy treatment continues with visits and no invented opening', async () => {
  const f = await fixture(db), planId = await f.activePlan({ ...legacy, previouslyPaid: '1000' });
  assert.equal(await f.count('journal'), 0);
  const visit = await f.command('visit.create', { planId, note: 'متابعة بعد تسديد الاتفاق سابقاً' });
  await f.command('visit.sign', { visitId: visit.id });
  assert.equal(await f.count('journal'), 0);
  await assert.rejects(f.command('legacy.activate', { planId }), /PLAN_ALREADY_ACTIVATED/);
});

test('database: closed plans reject new payments and visits', async () => {
  const f = await fixture(db);
  for (const status of ['completed', 'cancelled']) {
    const planId = await f.activePlan();
    await db.query('UPDATE clinic.plan SET status=$1 WHERE id=$2', [status, planId]);
    await assert.rejects(f.command('payment.collect', { planId, amount: '1', currency: 'SAR', rate: '1' }), /PLAN_NOT_ACTIVE/);
    await assert.rejects(f.command('visit.create', { planId, note: 'جلسة على خطة مغلقة' }), /PLAN_NOT_ACTIVE/);
  }
});
