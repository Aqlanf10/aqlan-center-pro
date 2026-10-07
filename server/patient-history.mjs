/** PAT-03 partial, branch-scoped reviewed history. A null current snapshot means
 * unreviewed in this branch; it must never display as no patient-wide allergies.
 * Route callers supply actorId exclusively from the authenticated server session,
 * and apply the application's body limit, Origin and JSON checks before writes.
 * SQL rechecks every permission and patient/branch link, including on replay.
 */
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
function identities({db,actorId,branchId,patientId}) {
  if(!db?.query) throw new Error('DB_REQUIRED');
  if(![actorId,branchId,patientId].every(value=>typeof value==='string'&&UUID.test(value)))
    throw Object.assign(new Error('INVALID_HISTORY_ID'),{status:400});
}
export async function readPatientHistory(context) {
  identities(context);
  const {db,actorId,branchId,patientId}=context;
  const result=await db.query('SELECT clinic.read_patient_history($1,$2,$3) AS history',[actorId,branchId,patientId]);
  return result.rows[0].history;
}
export async function reviewPatientHistory(context) {
  identities(context);
  const {db,actorId,branchId,patientId,key,payload}=context;
  if(typeof key!=='string'||!UUID.test(key)||!payload||typeof payload!=='object'||Array.isArray(payload))
    throw Object.assign(new Error('INVALID_HISTORY_REVIEW'),{status:400});
  const result=await db.query('SELECT clinic.review_patient_history($1,$2,$3,$4,$5::jsonb) AS result',
    [actorId,branchId,patientId,key,JSON.stringify(payload)]);
  return result.rows[0].result;
}
