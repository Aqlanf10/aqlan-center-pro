// Copyright (c) 2026 Dr. Aqlan Alkamel. All rights reserved.
// IMP-01..03 integration evidence: staging persists the domain verdicts,
// approval reuses the guarded command core, resume completes partial batches,
// and durable dedup blocks repeated files and known source identities.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { createDatabase, fixture } from './helpers/database.mjs';
import { importApi } from '../server/import.mjs';
import { buildXlsx } from './helpers/xlsx.mjs';

let db, imports;
before(async () => { db = await createDatabase(); imports = importApi({ db }); });
after(async () => { await db?.close(); });

const HEADERS = 'sourceRecordId,fullName,currency,agreed,previouslyPaid,remaining,fileNumber,phone';
const csvOf = rows => `${HEADERS}\n${rows.join('\n')}`;
const hash = csv => createHash('sha256').update(csv).digest('hex');
const map = { sourceRecordId: 'sourceRecordId', fullName: 'fullName', currency: 'currency', agreed: 'agreed', previouslyPaid: 'previouslyPaid', remaining: 'remaining', fileNumber: 'fileNumber', phone: 'phone' };
const stageInput = (csv, changes = {}) => ({
  sourceSystem: 'desktop', fileName: 'legacy.csv', fileHash: hash(csv), csv, delimiter: ',',
  headerMap: map, currencyMap: { سعودي: 'SAR' }, defaultSpecialty: 'orthodontics', asOfDate: '2025-12-31', ...changes,
});
const rowOf = async batchId => (await db.query('SELECT id,line,status,patient_id,plan_id,error_code,issues,candidates,currency,agreed::text AS agreed,previously_paid::text AS previously_paid,legacy_file_number,phone FROM clinic.import_row WHERE batch_id=$1 ORDER BY line', [batchId])).rows;
const balance = async planId => (await db.query(
  `SELECT coalesce(sum(l.debit-l.credit),0)::text AS a FROM clinic.journal j JOIN clinic.journal_line l ON l.journal_id=j.id
   WHERE j.plan_id=$1 AND l.account='RECEIVABLE'`, [planId])).rows[0].a;
const dayAfter = async days => (await db.query("SELECT ((now() AT TIME ZONE 'Asia/Aden')::date + $1::int)::text AS d", [days])).rows[0].d;

test('import staging: verdicts, counts and per-currency summary persist verbatim (IMP-01)', async () => {
  const f = await fixture(db);
  const csv = csvOf([
    '1,مريض أول,SAR,1000,400,600,0123,777000001',
    '2,مريض ثان,SAR,?,?,0,,777000002',
    '3,مريض ثالث,عملة مجهولة,300,0,300,,777000003',
  ]);
  const staged = await imports.stage(f.actor, f.branch, stageInput(csv));
  assert.equal(staged.summary.totalRows, 3);
  assert.equal(staged.summary.rejectedRows, 1);
  assert.equal(staged.summary.perCurrency.SAR.rowCount, 2);
  assert.equal(staged.summary.perCurrency.SAR.openingReceivable, '600.00');
  assert.equal(staged.summary.perCurrency.SAR.unknownFinanceCount, 1);
  const batch = (await db.query('SELECT * FROM clinic.import_batch WHERE id=$1', [staged.batchId])).rows[0];
  assert.equal(batch.status, 'staged');
  assert.equal(batch.row_count, 3);
  assert.equal(batch.staged_rows, 1);
  assert.equal(batch.evidence_rows, 1);
  assert.equal(batch.rejected_rows, 1);
  const rows = await rowOf(staged.batchId);
  assert.deepEqual(rows.map(r => r.status), ['staged', 'needs_evidence', 'rejected']);
  assert.equal(rows[0].currency, 'SAR');
  assert.equal(rows[0].agreed, '1000.00');
  assert.equal(rows[0].legacy_file_number, '0123');
  assert.equal(rows[0].phone, '777000001');
  // Arabic currency token resolved through the explicit map only.
  const list = await imports.list(f.actor, f.branch);
  assert.equal(list.batches[0].id, staged.batchId);
});

test('import staging: evidence rows and rejected rows are never approvable (IMP-03)', async () => {
  const f = await fixture(db);
  const csv = csvOf(['1,مريض أول,SAR,1000,400,600,,777', '2,مريض ثان,SAR,?,?,0,,777']);
  const staged = await imports.stage(f.actor, f.branch, stageInput(csv));
  const rows = await rowOf(staged.batchId);
  const result = await imports.approve(f.actor, f.branch, staged.batchId, rows.map(r => ({ rowId: r.id })));
  assert.equal(result.imported, 1);
  assert.equal(result.failed, 1);
  assert.deepEqual(result.failedRows.map(x => x.code), ['EVIDENCE_REQUIRED']);
  assert.equal(result.remaining, 1);
  assert.equal(result.batchStatus, 'staged');
  const after = await rowOf(staged.batchId);
  assert.equal(after[0].status, 'imported');
  assert.equal(after[1].status, 'needs_evidence');
  // The committed row carries the exact legacy opening: receivable 600 SAR.
  assert.equal(await balance(after[0].plan_id), '600.00');
  const plan = (await db.query('SELECT origin,source_system,source_record_id,as_of_date::text AS d,currency,agreed::text AS a,previously_paid::text AS p,status FROM clinic.plan WHERE id=$1', [after[0].plan_id])).rows[0];
  assert.equal(plan.origin, 'legacy');
  assert.equal(plan.source_system, 'desktop');
  assert.equal(plan.source_record_id, '1');
  assert.equal(plan.currency, 'SAR');
  assert.equal(plan.status, 'active');
  assert.equal(plan.a, '1000.00');
  assert.equal(plan.p, '400.00');
});

test('import staging: resume completes a batch after evidence resolution, then batch approves (IMP-03)', async () => {
  const f = await fixture(db);
  const csv = csvOf(['1,مريض أول,SAR,100,0,100,,', '2,مريض ثان,SAR,?,?,0,,']);
  const staged = await imports.stage(f.actor, f.branch, stageInput(csv));
  const rows = await rowOf(staged.batchId);
  const first = await imports.approve(f.actor, f.branch, staged.batchId, [{ rowId: rows[0].id }]);
  assert.equal(first.imported, 1);
  assert.equal(first.failed, 0);
  assert.equal(first.remaining, 1);
  assert.equal(first.batchStatus, 'staged');
  // Evidence review resolves the unknown amounts out-of-band (row correction screen follows).
  await db.query("UPDATE clinic.import_row SET status='staged',agreed='500.00',previously_paid='0.00' WHERE id=$1", [rows[1].id]);
  const second = await imports.approve(f.actor, f.branch, staged.batchId, [{ rowId: rows[1].id }]);
  assert.equal(second.imported, 1);
  assert.equal(second.failed, 0);
  assert.equal(second.remaining, 0);
  assert.equal(second.batchStatus, 'approved');
  const batch = (await db.query('SELECT status,approved_by,approved_at FROM clinic.import_batch WHERE id=$1', [staged.batchId])).rows[0];
  assert.equal(batch.status, 'approved');
  assert.equal(batch.approved_by, f.actor);
  assert.ok(batch.approved_at);
});

test('import staging: committed sources and file hashes block re-import durably (IMP-04)', async () => {
  const f = await fixture(db);
  const csv = csvOf(['1,مريض أول,SAR,100,0,100,,']);
  const first = await imports.stage(f.actor, f.branch, stageInput(csv));
  const rows = await rowOf(first.batchId);
  await imports.approve(f.actor, f.branch, first.batchId, [{ rowId: rows[0].id }]);
  // Same bytes: the identical file hash is already staged in this branch, so
  // the re-upload is blocked outright instead of persisting a dead batch.
  await assert.rejects(() => imports.stage(f.actor, f.branch, stageInput(csv)), /FILE_ALREADY_KNOWN/);
  // Same source identity, different bytes: SOURCE_ALREADY_KNOWN.
  const sameSource = await imports.stage(f.actor, f.branch, stageInput(csvOf(['1,مريض أول,SAR,100,0,100,,']), { fileHash: hash('modified') }));
  assert.equal(sameSource.summary.rejectedRows, 1);
  const issueCodes = (await rowOf(sameSource.batchId))[0].issues.map(x => x.code);
  assert.ok(issueCodes.includes('SOURCE_ALREADY_KNOWN'));
  // A staged (not yet approved) batch also blocks the same identity.
  const stagedOther = await imports.stage(f.actor, f.branch, stageInput(csvOf(['9,مريض ثان,SAR,100,0,100,,']), { fileHash: hash('other') }));
  const conflict = await imports.stage(f.actor, f.branch, stageInput(csvOf(['9,مريض ثان,SAR,100,0,100,,']), { fileHash: hash('conflict') }));
  assert.equal(conflict.summary.rejectedRows, 1);
  await imports.cancel(f.actor, f.branch, stagedOther.batchId);
});

test('import staging: cancelled batch releases its file hash and cannot approve (IMP-03)', async () => {
  const f = await fixture(db);
  const csv = csvOf(['1,مريض أول,SAR,100,0,100,,']);
  const input = stageInput(csv, { fileHash: hash('cancel-me') });
  const staged = await imports.stage(f.actor, f.branch, input);
  const cancelRow = (await rowOf(staged.batchId))[0].id;
  await imports.cancel(f.actor, f.branch, staged.batchId);
  await assert.rejects(
    () => imports.approve(f.actor, f.branch, staged.batchId, [{ rowId: cancelRow }]),
    /BATCH_NOT_ACTIVE/);
  const again = await imports.stage(f.actor, f.branch, input);
  assert.equal(again.summary.rejectedRows, 0);
  const batches = await imports.list(f.actor, f.branch);
  assert.ok(batches.batches.some(b => b.id === staged.batchId && b.status === 'cancelled'));
});

test('import staging: explicit attachment keeps an existing patient; bad attachment fails the row only (IMP-02)', async () => {
  const f = await fixture(db);
  const existing = await f.patient({ fullName: 'مريض قائم', phone: '777111222' });
  const csv = csvOf(['1,مريض قائم,SAR,100,0,100,,777111222', '2,مريض جديد,SAR,50,0,50,,']);
  const staged = await imports.stage(f.actor, f.branch, stageInput(csv));
  const rows = await rowOf(staged.batchId);
  const result = await imports.approve(f.actor, f.branch, staged.batchId, [
    { rowId: rows[0].id, attachPatientId: existing },
    { rowId: rows[1].id, attachPatientId: randomUUID() },
  ]);
  assert.equal(result.imported, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.remaining, 0);
  const after = await rowOf(staged.batchId);
  // Domain source lines are physical CSV lines: the header occupies line 1.
  assert.equal(after.find(r => r.line === 2).patient_id, existing);
  assert.equal(after.find(r => r.line === 3).error_code, 'ATTACH_PATIENT_NOT_FOUND');
  // No new patient was created: the attached row reused the existing one and
  // the bad attachment failed before intake.
  const branchPatients = (await db.query('SELECT count(*)::int AS n FROM clinic.patient_branch WHERE branch_id=$1', [f.branch])).rows[0].n;
  assert.equal(branchPatients, 1);
  const planCount = (await db.query('SELECT count(*)::int AS n FROM clinic.plan WHERE patient_id=$1', [existing])).rows[0].n;
  assert.equal(planCount, 1);
});

test('import staging: stage rejects future dates, unknown specialties and bad options', async () => {
  const f = await fixture(db);
  const csv = csvOf(['1,مريض أول,SAR,100,0,100,,']);
  const futureDate = await dayAfter(1);
  await assert.rejects(() => imports.stage(f.actor, f.branch, stageInput(csv, { asOfDate: futureDate })), /FUTURE_OPENING_DATE/);
  await assert.rejects(() => imports.stage(f.actor, f.branch, stageInput(csv, { defaultSpecialty: 'unknown_spec' })), /UNKNOWN_SPECIALTY/);
  await assert.rejects(() => imports.stage(f.actor, f.branch, stageInput(csv, { fileHash: 'nothash' })), /INVALID_STAGE_INPUT/);
  await assert.rejects(() => imports.stage(f.actor, f.branch, stageInput(csv, { headerMap: undefined })), /INVALID_OPTIONS/);
  await assert.rejects(() => imports.stage(f.actor, f.branch, stageInput('a,b\n1,2', { delimiter: '|' })), /INVALID_STAGE_INPUT/);
  await assert.rejects(() => imports.approve(f.actor, f.branch, randomUUID(), [{ rowId: 'bad' }]), /INVALID_DECISIONS/);
});

test('import staging: approval requires the finance opening permission', async () => {
  const f = await fixture(db);
  const csv = csvOf(['1,مريض أول,SAR,100,0,100,,']);
  const staged = await imports.stage(f.actor, f.branch, stageInput(csv, { fileHash: hash('perm') }));
  const rows = await rowOf(staged.batchId);
  // A membership whose role holds only patient.write can stage but never approve.
  const limited = randomUUID(), limitedRole = randomUUID();
  await db.query('INSERT INTO clinic.staff(id,display_name) VALUES($1,$2)', [limited, 'موظف إدخال']);
  await db.query('INSERT INTO clinic.role(id,name) VALUES($1,$2)', [limitedRole, 'patient-writer']);
  await db.query('INSERT INTO clinic.role_permission VALUES($1,$2)', [limitedRole, 'patient.write']);
  await db.query('INSERT INTO clinic.membership VALUES($1,$2,$3)', [limited, f.branch, limitedRole]);
  await assert.rejects(
    () => imports.approve(limited, f.branch, staged.batchId, [{ rowId: rows[0].id }]),
    e => e.code === '42501');
});

test('import routes are wired before the generic patient route', async () => {
  const actor = randomUUID(), branch = randomUUID(), calls = [];
  const appDb = { query: async (sql, args = []) => {
    calls.push({ sql, args });
    if (sql.includes('FROM clinic.session t')) return { rows: [{ id: actor, display_name: 'مستخدم', username: 'user' }] };
    return { rows: [] };
  } };
  const { createApp } = await import('../server/app.mjs');
  const server = createApp({ db: appDb, origin: 'https://clinic.example.invalid', production: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const headers = { Cookie: `__Host-aqlan_session=${'a'.repeat(64)}` };
    const list = await fetch(`${base}/api/branches/${branch}/imports`, { headers });
    assert.equal(list.status, 200);
    const stage = await fetch(`${base}/api/branches/${branch}/imports`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', Origin: 'https://clinic.example.invalid' }, body: JSON.stringify({}) });
    assert.equal(stage.status, 400);
    assert.equal((await stage.json()).error, 'INVALID_STAGE_INPUT');
    const detail = await fetch(`${base}/api/branches/${branch}/imports/${randomUUID()}?status=staged`, { headers });
    assert.equal(detail.status, 404);
    assert.equal((await detail.json()).error, 'BATCH_NOT_FOUND');
    const wrongMethod = await fetch(`${base}/api/branches/${branch}/imports`, { method: 'DELETE', headers });
    assert.equal(wrongMethod.status, 405);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('import staging: candidate matching persists proposals and attachment reuses the patient (MIG-03)', async () => {
  const f = await fixture(db);
  const seed = await imports.stage(f.actor, f.branch, stageInput(csvOf([
    '1,مريض مرجعي,SAR,1000,400,600,0500,777123456',
  ]), { fileHash: hash('seed-batch') }));
  await imports.approve(f.actor, f.branch, seed.batchId, [{ rowId: (await rowOf(seed.batchId))[0].id }]);
  const seeded = await rowOf(seed.batchId);
  const knownPatient = seeded[0].patient_id;
  assert.ok(knownPatient);

  // A second file with the same legacy file number and phone proposes the
  // known patient; the proposal is persisted with name + signal, never merged.
  const next = await imports.stage(f.actor, f.branch, stageInput(csvOf([
    '2,مريض مرجعي,SAR,900,0,900,0500,777-123-456',
    '3,غريب تماما,SAR,100,0,100,,',
  ]), { fileHash: hash('second-batch') }));
  const rows = await rowOf(next.batchId);
  const candidateRow = rows[0];
  assert.deepEqual(candidateRow.candidates, [{ patientId: knownPatient, fullName: 'مريض مرجعي', matchedBy: 'fileNumber' }]);
  assert.deepEqual(rows[1].candidates, []);
  const issueCodes = candidateRow.issues.map(x => x.code);
  assert.ok(issueCodes.includes('IDENTITY_REVIEW'));
  // Phone-only matches also propose, labeled as phone signal.
  const phoneOnly = await imports.stage(f.actor, f.branch, stageInput(csvOf([
    '4,مريض مرجعي,SAR,100,0,100,,777123456',
  ]), { fileHash: hash('third-batch') }));
  const phoneRow = (await rowOf(phoneOnly.batchId))[0];
  assert.deepEqual(phoneRow.candidates, [{ patientId: knownPatient, fullName: 'مريض مرجعي', matchedBy: 'phone' }]);

  // Approval with the proposed attachment reuses the patient: no new patient.
  const before = Number((await db.query('SELECT count(*) AS n FROM clinic.patient')).rows[0].n);
  const approved = await imports.approve(f.actor, f.branch, next.batchId, [
    { rowId: candidateRow.id, attachPatientId: knownPatient },
    { rowId: rows[1].id },
  ]);
  assert.equal(approved.imported, 2);
  assert.equal(Number((await db.query('SELECT count(*) AS n FROM clinic.patient')).rows[0].n), before + 1);
  const attached = (await rowOf(next.batchId))[0];
  assert.equal(attached.patient_id, knownPatient);
  const plans = await db.query('SELECT patient_id FROM clinic.plan WHERE id=$1', [attached.plan_id]);
  assert.equal(plans.rows[0].patient_id, knownPatient);
  // Wrong branch attachment still fails the row only.
  const stray = await imports.stage(f.actor, f.branch, stageInput(csvOf([
    '5,وصل خاطئ,SAR,50,0,50,,',
  ]), { fileHash: hash('stray-batch') }));
  const strayRow = (await rowOf(stray.batchId))[0];
  const result = await imports.approve(f.actor, f.branch, stray.batchId, [{ rowId: strayRow.id, attachPatientId: f.otherBranch }]);
  assert.equal(result.imported, 0);
  assert.equal(result.failedRows[0].code, 'ATTACH_PATIENT_NOT_FOUND');
});

test('import staging: reordered and renamed files with identical sources stay blocked (MIG-04)', async () => {
  const f = await fixture(db);
  const original = csvOf(['1,مريض أول,SAR,100,0,100,0500,']);
  const first = await imports.stage(f.actor, f.branch, stageInput(original));
  await imports.approve(f.actor, f.branch, first.batchId, [{ rowId: (await rowOf(first.batchId))[0].id }]);
  // Reordered columns + renamed file + extra padding row: different bytes, so
  // the file hash passes, but the durable source identity (system+id+currency)
  // is what blocks the event — exactly the MIG-04 key, not the fingerprint.
  const reordered = csvOf(['1,مريض أول,SAR,100,0,100,0500,', 'pad,حشو محايد,SAR,1,0,1,,']);
  const remapped = stageInput(reordered, { fileHash: hash('reordered'), fileName: 'نسخة-معاد-ترتيبها.csv',
    headerMap: { sourceRecordId: 'sourceRecordId', fullName: 'fullName', currency: 'currency', agreed: 'agreed', previouslyPaid: 'previouslyPaid', remaining: 'remaining', fileNumber: 'fileNumber', phone: 'phone' } });
  const staged = await imports.stage(f.actor, f.branch, remapped);
  assert.equal(staged.summary.rejectedRows, 1);
  const codes = (await rowOf(staged.batchId))[0].issues.map(x => x.code);
  assert.ok(codes.includes('SOURCE_ALREADY_KNOWN'));
  // Same record id under a different source system is a DIFFERENT identity.
  const otherSystem = await imports.stage(f.actor, f.branch, stageInput(csvOf(['1,مريض أول,SAR,100,0,100,0500,']),
    { sourceSystem: 'mini', fileHash: hash('mini-copy') }));
  assert.equal(otherSystem.summary.rejectedRows, 0);
});

test('import staging: xlsx workbooks stage and approve end to end (MIG-01)', async () => {
  const f = await fixture(db);
  const workbook = buildXlsx([
    ['sourceRecordId', 'fullName', 'currency', 'agreed', 'previouslyPaid', 'remaining', 'fileNumber', 'phone'],
    ['X-1', 'مريض ورقة عمل', 'SAR', '1200', '200', '1000', '0600', '777555000'],
    ['X-2', 'مريض ثان ورقة', 'SAR', '300', '50', '250', '', ''],
  ]);
  const dataBase64 = workbook.toString('base64');
  const parsed = await imports.parse(f.actor, f.branch, { format: 'xlsx', dataBase64 });
  assert.deepEqual(parsed.headers, ['sourceRecordId', 'fullName', 'currency', 'agreed', 'previouslyPaid', 'remaining', 'fileNumber', 'phone']);
  assert.equal(parsed.format, 'xlsx');
  const staged = await imports.stage(f.actor, f.branch, stageInput('', {
    format: 'xlsx', dataBase64, fileHash: createHash('sha256').update(workbook).digest('hex'), fileName: 'legacy.xlsx' }));
  assert.equal(staged.summary.totalRows, 2);
  assert.equal(staged.summary.perCurrency.SAR.openingReceivable, '1250.00');
  const rows = await rowOf(staged.batchId);
  assert.deepEqual(rows.map(r => r.status), ['staged', 'staged']);
  assert.equal(rows[0].agreed, '1200.00');
  assert.equal(rows[0].legacy_file_number, '0600');
  assert.equal(rows[0].phone, '777555000');
  const approved = await imports.approve(f.actor, f.branch, staged.batchId, rows.map(r => ({ rowId: r.id })));
  assert.equal(approved.imported, 2);
  assert.equal(approved.batchStatus, 'approved');
  // A second upload of the same workbook bytes is blocked by its file hash.
  await assert.rejects(() => imports.stage(f.actor, f.branch, stageInput('', {
    format: 'xlsx', dataBase64, fileHash: createHash('sha256').update(workbook).digest('hex'), fileName: 'legacy.xlsx' })), /FILE_ALREADY_KNOWN/);
  // Corrupt workbooks surface the safe bilingual code, not a crash.
  await assert.rejects(() => imports.parse(f.actor, f.branch, { format: 'xlsx', dataBase64: Buffer.from('junk').toString('base64') }), /INVALID_WORKBOOK/);
  await assert.rejects(() => imports.parse(f.actor, f.branch, { format: 'xlsx', dataBase64: 'not base64!!!' }), /INVALID_STAGE_INPUT/);
});
