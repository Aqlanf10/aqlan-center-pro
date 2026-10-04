import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

test('runtime role can execute authorized commands but cannot bypass command boundary',async()=>{
 const db=new PGlite();
 try {
  for(const file of (await readdir(new URL('../db/',import.meta.url))).filter(f=>/^\d+.*\.sql$/.test(f)).sort()) await db.exec(await readFile(new URL(`../db/${file}`,import.meta.url),'utf8'));
  const staff=(await db.query("INSERT INTO clinic.staff(display_name) VALUES('Owner') RETURNING id")).rows[0].id;
  const branch=(await db.query("INSERT INTO clinic.branch(name) VALUES('Main') RETURNING id")).rows[0].id;
  const role=(await db.query("INSERT INTO clinic.role(name) VALUES('Test') RETURNING id")).rows[0].id;
  await db.query('INSERT INTO clinic.role_permission SELECT $1,code FROM clinic.permission',[role]);
  await db.query('INSERT INTO clinic.membership VALUES($1,$2,$3)',[staff,branch,role]);
  await db.query("INSERT INTO clinic.login_account VALUES($1,'owner','test-hash',now())",[staff]);
  await db.exec('CREATE ROLE test_app LOGIN INHERIT; GRANT clinic_runtime TO test_app; SET SESSION AUTHORIZATION test_app');
  assert.equal((await db.query('SELECT username FROM clinic.login_account')).rows[0].username,'owner');
  await db.query("INSERT INTO clinic.session(token_hash,staff_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",['a'.repeat(64),staff]);
  await db.query('DELETE FROM clinic.session WHERE staff_id=$1',[staff]);
  const patient=(await db.query("SELECT clinic.execute($1,$2,'11111111-1111-4111-8111-111111111111','patient.create',$3::jsonb) AS result",[staff,branch,JSON.stringify({fullName:'Real patient'})])).rows[0].result;
  assert.ok(patient.id);
  const command=async(name,payload)=>(await db.query('SELECT clinic.execute($1,$2,$3,$4,$5::jsonb) AS result',[staff,branch,randomUUID(),name,JSON.stringify(payload)])).rows[0].result;
  const plan=await command('plan.create',{patientId:patient.id,title:'Orthodontic treatment',specialty:'orthodontics',origin:'new',currency:'SAR',agreed:'1000.00'});
  await command('plan.activate',{planId:plan.id,expectedVersion:1});
  const step=await command('step.create',{planId:plan.id,procedureName:'Adjustment',tooth:'11'});
  const visit=await command('visit.create',{planId:plan.id,stepId:step.id,note:'Adjustment completed'});
  await command('visit.sign',{visitId:visit.id,completeStep:true});
  await command('payment.collect',{planId:plan.id,amount:'140000.00',currency:'YER',rate:'140.00'});
  const payment=(await db.query("SELECT id FROM clinic.journal WHERE kind='payment'")).rows[0].id;
  await command('payment.reverse',{journalId:payment,reason:'Test correction'});
  assert.equal((await db.query('SELECT status FROM clinic.visit WHERE id=$1',[visit.id])).rows[0].status,'signed');
  for(const sql of ["INSERT INTO clinic.patient(primary_branch_id,full_name,created_by) SELECT id,'Forged', '"+staff+"'::uuid FROM clinic.branch",'DELETE FROM clinic.patient','TRUNCATE clinic.patient CASCADE','DROP TABLE clinic.patient','CREATE TABLE clinic.backdoor(x int)','SET ROLE clinic_command_owner','ALTER ROLE test_app SUPERUSER',"UPDATE clinic.login_account SET password_hash='forged'"]){
   await assert.rejects(db.exec(sql),undefined,sql);
  }
  await assert.rejects(db.query("SELECT clinic.execute($1,'22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333','patient.create',$2::jsonb)",[staff,JSON.stringify({fullName:'Wrong branch'})]),/FORBIDDEN/);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM clinic.patient')).rows[0].n,1);
 } finally { await db.close(); }
});
