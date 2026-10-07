import { PGlite } from '@electric-sql/pglite';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

export async function createDatabase() {
  const db = new PGlite();
  for (const file of (await readdir(new URL('../../db/',import.meta.url))).filter(f=>/^\d+.*\.sql$/.test(f)).sort()) {
    await db.exec(await readFile(new URL(`../../db/${file}`, import.meta.url), 'utf8'));
  }
  return db;
}
export async function fixture(db) {
  const actor = randomUUID(), branch = randomUUID(), otherBranch = randomUUID(), role = randomUUID();
  await db.query('INSERT INTO clinic.branch(id,name) VALUES($1,$2),($3,$4)', [branch, 'المركز', otherBranch, 'فرع آخر']);
  await db.query('INSERT INTO clinic.staff(id,display_name) VALUES($1,$2)', [actor, 'د. عقلان']);
  await db.query('INSERT INTO clinic.role(id,name) VALUES($1,$2)', [role, role]);
  await db.query('INSERT INTO clinic.role_permission SELECT $1,code FROM clinic.permission', [role]);
  await db.query('INSERT INTO clinic.membership VALUES($1,$2,$3)', [actor, branch, role]);
  const command = async (name, payload, { key = randomUUID(), staff = actor, atBranch = branch } = {}) =>
    (await db.query('SELECT clinic.execute($1,$2,$3,$4,$5::jsonb) AS result', [staff, atBranch, key, name, JSON.stringify(payload)])).rows[0].result;
  const patient = async (overrides = {}) => (await command('patient.create', { fullName: 'مريض اختبار', phone: '777000000', ...overrides })).id;
  const plan = async (overrides = {}) => {
    const patientId = overrides.patientId ?? await patient();
    return (await command('plan.create', { patientId, specialty: 'orthodontics', title: 'خطة تقويم', origin: 'new', currency: 'SAR', agreed: '1000.00', ...overrides })).id;
  };
  const activePlan = async (overrides = {}) => {
    const id = await plan(overrides);
    await command(overrides.origin === 'legacy' ? 'legacy.activate' : 'plan.activate', { planId: id, expectedVersion: 1 });
    return id;
  };
  const balance = async (planId, account = 'RECEIVABLE') => (await db.query(`SELECT coalesce(sum(l.debit-l.credit),0)::text AS amount FROM clinic.journal j JOIN clinic.journal_line l ON l.journal_id=j.id WHERE j.plan_id=$1 AND l.account=$2`, [planId, account])).rows[0].amount;
  const count = async table => Number((await db.query(`SELECT count(*) FROM clinic.${table} WHERE branch_id=$1`, [branch])).rows[0].count);
  return { actor, branch, otherBranch, role, command, patient, plan, activePlan, balance, count };
}
