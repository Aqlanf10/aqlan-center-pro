import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {fixture} from './helpers/database.mjs';
import {readPatientHistory,reviewPatientHistory} from '../server/patient-history.mjs';

const unknown=()=>({status:'unknown',details:''});
const none=()=>({status:'none',details:''});
const payload=overrides=>({expectedVersion:0,medical:unknown(),dental:unknown(),allergies:unknown(),
  source:'patient_report',reason:'Synthetic history review',observedOn:'2024-01-01',...overrides});

test('patient history: restricted, dated immutable revisions retain unknown and optimistic review',async t=>{
 const db=new PGlite();
 try {
  for(const name of (await readdir(new URL('../db/',import.meta.url))).filter(n=>/^\d+.*\.sql$/.test(n)).sort())
   await db.exec(await readFile(new URL(`../db/${name}`,import.meta.url),'utf8'));
  const f=await fixture(db),patientId=await f.patient(),otherPatient=await f.patient();
  const foreign=await fixture(db),foreignPatient=await foreign.patient();
  await db.query('INSERT INTO clinic.patient_branch VALUES($1,$2)',[patientId,f.otherBranch]);
  await db.query('INSERT INTO clinic.membership VALUES($1,$2,$3)',[f.actor,f.otherBranch,f.role]);
  const original=(await db.query('SELECT current_user AS name')).rows[0].name;
  const asAdmin=()=>db.exec('SET SESSION AUTHORIZATION "'+original.replaceAll('"','""')+'"');
  const asRuntime=()=>db.exec('SET SESSION AUTHORIZATION history_runtime');
  await db.exec('CREATE ROLE history_runtime LOGIN INHERIT; GRANT clinic_runtime TO history_runtime');
  await asRuntime();
  const context={db,actorId:f.actor,branchId:f.branch,patientId};
  const read=(extra={})=>readPatientHistory({...context,...extra});
  const review=(data,extra={})=>reviewPatientHistory({...context,key:randomUUID(),payload:data,...extra});
  let firstId;
  await t.test('no history is explicitly unreviewed in this branch, with unknown distinct from none',async()=>{
   assert.deepEqual(await read(),{patientId,branchId:f.branch,scope:'branch',version:0,current:null,revisions:[]});
   const key=randomUUID(),data=payload({allergies:none()});
   const first=await review(data,{key});firstId=first.id;
   assert.deepEqual(await review(data,{key}),first);
   assert.equal(first.version,1);
   const history=await read();
   assert.equal(history.current.medical.status,'unknown');
   assert.equal(history.current.allergies.status,'none');
   assert.equal(history.current.branch_id,f.branch);
   assert.equal(history.current.reviewed_by,f.actor);
   assert.equal(history.current.observed_on,'2024-01-01');
   assert.ok(history.current.reviewed_at);
   assert.equal(history.revisions.length,1);
   const otherBranch=await read({branchId:f.otherBranch});
   assert.equal(otherBranch.version,0);assert.equal(otherBranch.current,null,'No cross-branch allergy inference');
  });
  await t.test('stale review rolls back audit/idempotency, fresh correction appends without rewriting original',async()=>{
   const key=randomUUID();
   await assert.rejects(review(payload({allergies:{status:'reported',details:'Synthetic reported allergy'}}),{key}),/STALE_HISTORY_VERSION/);
   await asAdmin();
   assert.equal((await db.query('SELECT count(*)::text AS n FROM clinic.operation WHERE key=$1',[key])).rows[0].n,'0');
   assert.equal((await db.query("SELECT count(*)::text AS n FROM clinic.audit WHERE action='patient.history.review'")).rows[0].n,'1');
   await asRuntime();
   await review(payload({expectedVersion:1,allergies:{status:'reported',details:'حساسية مبلغ عنها للاختبار فقط'}}),{key});
   const history=await read();
   assert.equal(history.version,2);assert.equal(history.current.allergies.status,'reported');
   assert.equal(history.current.allergies.details,'حساسية مبلغ عنها للاختبار فقط');
   assert.equal(history.revisions[1].id,firstId);assert.equal(history.revisions[1].allergies.status,'none');
   await asAdmin();
   await assert.rejects(db.query('UPDATE clinic.patient_history_revision SET reason=$1 WHERE id=$2',['changed',firstId]),/APPEND_ONLY/);
   await assert.rejects(db.query('DELETE FROM clinic.patient_history_revision WHERE id=$1',[firstId]),/APPEND_ONLY/);
   await asRuntime();
  });
  await t.test('invalid sections, overlong notes, future/invalid dates and forged actor are rejected atomically',async()=>{
   const invalid=[{medical:null},{medical:[]},{medical:'none'},{allergies:{status:'none',details:'contradiction'}},
    {allergies:{status:'reported',details:''}},{medical:{status:'reported',details:'x'.repeat(6001)}},
    {medical:{...unknown(),extra:true}},{reason:'x'},{reason:'x'.repeat(2001)},
    {observedOn:'2999-01-01'},{observedOn:'2024-02-30'},{observedOn:'infinity'},
    {expectedVersion:'2'},{expectedVersion:-1},{expectedVersion:0.5},{expectedVersion:2147483647},
    {source:'unreviewed_portal'},{reviewedBy:foreign.actor}];
   for(const change of invalid) await assert.rejects(review(payload({expectedVersion:2,...change})),/INVALID_HISTORY|HISTORY_VERSION_REQUIRED/);
   assert.equal((await read()).version,2);
  });
  await t.test('patient/branch identities and keys cannot be exchanged',async()=>{
   await assert.rejects(read({patientId:foreignPatient}),/NOT_FOUND/);
   await assert.rejects(review(payload(),{patientId:foreignPatient}),/NOT_FOUND/);
   await assert.rejects(read({branchId:foreign.branch,patientId:foreignPatient}),/FORBIDDEN/);
   await assert.rejects(review(payload(),{branchId:foreign.branch,patientId:foreignPatient}),/FORBIDDEN/);
   const key=randomUUID(),data=payload();
   await review(data,{key,patientId:otherPatient});
   await assert.rejects(review(data,{key}),/IDEMPOTENCY_CONFLICT/);
   await assert.rejects(review({...data,reason:'different payload'},{key,patientId:otherPatient}),/IDEMPOTENCY_CONFLICT/);
   assert.equal((await read()).version,2);
  });
  await t.test('permission revocation, disabled identities and removed patient membership are rechecked on replay',async()=>{
   const key=randomUUID(),data=payload({expectedVersion:2});const saved=await review(data,{key});
   for(const permission of ['patient.read','clinical.read','clinical.write']) {
    await asAdmin();await db.query('DELETE FROM clinic.role_permission WHERE role_id=$1 AND permission=$2',[f.role,permission]);await asRuntime();
    await assert.rejects(review(data,{key}),/FORBIDDEN/);
    if(permission!=='clinical.write')await assert.rejects(read(),/FORBIDDEN/);
    await asAdmin();await db.query('INSERT INTO clinic.role_permission VALUES($1,$2)',[f.role,permission]);await asRuntime();
   }
   await asAdmin();await db.query('UPDATE clinic.staff SET active=false WHERE id=$1',[f.actor]);await asRuntime();
   await assert.rejects(review(data,{key}),/FORBIDDEN/);
   await asAdmin();await db.query('UPDATE clinic.staff SET active=true WHERE id=$1',[f.actor]);
   await db.query('UPDATE clinic.branch SET active=false WHERE id=$1',[f.branch]);await asRuntime();
   await assert.rejects(read(),/FORBIDDEN/);await assert.rejects(review(data,{key}),/FORBIDDEN/);
   await asAdmin();await db.query('UPDATE clinic.branch SET active=true WHERE id=$1',[f.branch]);await asRuntime();
   assert.deepEqual(await review(data,{key}),saved);
   // Remove membership only for a patient with no dependent records.
   const empty=await f.patient();
   await asAdmin();await db.query('DELETE FROM clinic.patient_branch WHERE patient_id=$1 AND branch_id=$2',[empty,f.branch]);await asRuntime();
   await assert.rejects(read({patientId:empty}),/NOT_FOUND/);
   await assert.rejects(review(payload(),{patientId:empty}),/NOT_FOUND/);
  });
  await t.test('runtime has only authenticated history functions, no direct clinical table access or owner role',async()=>{
   await assert.rejects(db.query('SELECT * FROM clinic.patient_history_revision'),{code:'42501'});
   await assert.rejects(db.query('UPDATE clinic.patient_history_revision SET reason=$1',['bypass']),{code:'42501'});
   await assert.rejects(db.query('DELETE FROM clinic.patient_history_revision'),{code:'42501'});
   await assert.rejects(db.exec('SET ROLE clinic_command_owner'),{code:'42501'});
   await asAdmin();
   const functions=(await db.query("SELECT p.prosecdef,p.proconfig,r.rolname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner WHERE n.nspname='clinic' AND p.proname IN ('read_patient_history','review_patient_history')")).rows;
   assert.equal(functions.length,2);
   for(const fn of functions){assert.equal(fn.prosecdef,true);assert.equal(fn.rolname,'clinic_command_owner');assert.ok(fn.proconfig.includes('search_path=pg_catalog, clinic'));}
   assert.equal((await db.query("SELECT has_function_privilege('public','clinic.read_patient_history(uuid,uuid,uuid)','EXECUTE') AS allowed")).rows[0].allowed,false);
  });
 } finally {await db.close();}
});

test('patient history module validates route identifiers before accessing the database',async()=>{
 const context={db:{query:()=>{throw Error('query must not run');}},actorId:randomUUID(),branchId:randomUUID(),patientId:randomUUID()};
 await assert.rejects(readPatientHistory({...context,patientId:'invalid'}),/INVALID_HISTORY_ID/);
 await assert.rejects(reviewPatientHistory({...context,key:'invalid',payload:payload()}),/INVALID_HISTORY_REVIEW/);
 await assert.rejects(reviewPatientHistory({...context,key:randomUUID(),payload:[]}),/INVALID_HISTORY_REVIEW/);
});

test('history upgrade refuses to silently discard earlier unstructured patient history',async()=>{
 const db=new PGlite();
 try {
  for(const name of ['001_core.sql','002_commands.sql','003_auth.sql','004_runtime_boundary.sql','005_approval_guards.sql'])
   await db.exec(await readFile(new URL(`../db/${name}`,import.meta.url),'utf8'));
  const f=await fixture(db),patientId=await f.patient();
  await db.query('UPDATE clinic.patient SET medical_history=$1::jsonb WHERE id=$2',[JSON.stringify({unreviewed:'synthetic earlier history'}),patientId]);
  await assert.rejects(db.exec(await readFile(new URL('../db/006_patient_history.sql',import.meta.url),'utf8')),/EXISTING_HISTORY_REQUIRES_REVIEWED_MIGRATION/);
  assert.deepEqual((await db.query('SELECT medical_history FROM clinic.patient WHERE id=$1',[patientId])).rows[0].medical_history,{unreviewed:'synthetic earlier history'});
 } finally {await db.close();}
});
