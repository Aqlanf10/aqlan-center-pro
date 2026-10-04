import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from './app.mjs';
import { hashPassword } from './password.mjs';

test('authenticated runtime HTTP: integrated new and legacy patient journeys with permission isolation', async t => {
 const db=new PGlite(); let server;
 try {
  const directory=new URL('../db/',import.meta.url);
  for(const file of (await readdir(directory)).filter(f=>/^\d+.*\.sql$/.test(f)).sort()) await db.exec(await readFile(new URL(file,directory),'utf8'));
  const owner=randomUUID(),doctor=randomUUID(),branch=randomUUID(),otherBranch=randomUUID(),ownerRole=randomUUID(),doctorRole=randomUUID();
  await db.query('INSERT INTO clinic.staff(id,display_name) VALUES($1,$2),($3,$4)',[owner,'المدير',doctor,'الطبيب']);
  await db.query('INSERT INTO clinic.branch(id,name) VALUES($1,$2),($3,$4)',[branch,'الفرع الأول',otherBranch,'الفرع الثاني']);
  await db.query('INSERT INTO clinic.role(id,name) VALUES($1,$2),($3,$4)',[ownerRole,'Owner journey',doctorRole,'Doctor journey']);
  await db.query('INSERT INTO clinic.role_permission SELECT $1,code FROM clinic.permission',[ownerRole]);
  await db.query("INSERT INTO clinic.role_permission SELECT $1,code FROM clinic.permission WHERE code IN ('patient.read','clinical.read','clinical.write')",[doctorRole]);
  await db.query('INSERT INTO clinic.membership VALUES($1,$2,$3),($1,$4,$3),($5,$2,$6)',[owner,branch,ownerRole,otherBranch,doctor,doctorRole]);
  const password='generated-fixture-'+randomUUID(),passwordHash=await hashPassword(password);
  await db.query('INSERT INTO clinic.login_account(staff_id,username,password_hash) VALUES($1,$2,$3),($4,$5,$3)',[owner,'journey-owner',passwordHash,doctor,'journey-doctor']);
  await db.exec('CREATE ROLE journey_runtime LOGIN INHERIT; GRANT clinic_runtime TO journey_runtime; SET SESSION AUTHORIZATION journey_runtime');
  const origin='http://localhost:3000'; server=createApp({db,origin});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  const request=async(path,{cookie,body,method=body?'POST':'GET'}={})=>{
   const response=await fetch(base+path,{method,headers:{...(cookie?{Cookie:cookie}:{}),...(body?{Origin:origin,'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
   return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
  };
  const login=await request('/api/login',{body:{username:'journey-owner',password}}); assert.equal(login.status,200); const cookie=login.cookie;
  const docLogin=await request('/api/login',{body:{username:'journey-doctor',password}}); assert.equal(docLogin.status,200); const doctorCookie=docLogin.cookie;
  const path=`/api/branches/${branch}`;
  const command=async(name,payload,{key=randomUUID(),expected=200,session=cookie}={})=>{
   const result=await request(`${path}/commands`,{cookie:session,body:{key,command:name,payload}});
   assert.equal(result.status,expected,`${name}: ${JSON.stringify(result.data)}`); return result.data;
  };
  const get=async(url,session=cookie,expected=200)=>{ const result=await request(url,{cookie:session}); assert.equal(result.status,expected,JSON.stringify(result.data)); return result.data; };
  let patient,plan,step,paymentKey,paymentPayload;
  await t.test('new patient reaches signed clinical visit and exact cross-currency statement',async()=>{
   assert.equal((await get('/api/me')).user.id,owner);
   assert.equal((await get('/api/branches')).branches.length,2);
   assert.ok((await get('/api/specialties')).specialties.some(s=>s.code==='orthodontics'));
   patient=(await command('patient.create',{fullName:'مريض جديد للاختبار',phone:'777000111',birthDate:'1990-01-02'})).id;
   const search=await get(`${path}/patients?q=${encodeURIComponent('مريض جديد')}`); assert.equal(search.patients[0].id,patient);
   const detail=(await get(`${path}/patients/${patient}`)).patient; assert.equal(detail.full_name,'مريض جديد للاختبار'); assert.match(detail.birth_date,/1990-01-02/);
   plan=(await command('plan.create',{patientId:patient,title:'خطة تقويم جديدة',specialty:'orthodontics',origin:'new',currency:'SAR',agreed:'1000.00'})).id;
   await command('plan.activate',{planId:plan});
   step=(await command('step.create',{planId:plan,procedureName:'شد تقويم',tooth:'11'})).id;
   const visit=(await command('visit.create',{planId:plan,stepId:step,note:'تعديل السلك وتوثيق المتابعة'})).id;
   const signKey=randomUUID(); const signed=await command('visit.sign',{visitId:visit,completeStep:true},{key:signKey});
   assert.deepEqual(await command('visit.sign',{visitId:visit,completeStep:true},{key:signKey}),signed);
   const visits=(await get(`${path}/patients/${patient}/visits`)).visits; assert.equal(visits.length,1); assert.equal(visits[0].status,'signed'); assert.equal(visits[0].signed_by,owner);
   const before=await get(`${path}/patients/${patient}/statement`); assert.deepEqual(before.balances,[{currency:'SAR',balance:'1000.00'}]); assert.equal(before.entries.length,1,'signing must not invoice again');
   paymentKey=randomUUID(); paymentPayload={planId:plan,amount:'40000.00',currency:'YER',rate:'400'};
   const pay=await command('payment.collect',paymentPayload,{key:paymentKey}); assert.deepEqual(await command('payment.collect',paymentPayload,{key:paymentKey}),pay);
   const statement=await get(`${path}/patients/${patient}/statement`); assert.deepEqual(statement.balances,[{currency:'SAR',balance:'900.00'}]); assert.equal(statement.entries.length,2);
   const receipt=statement.entries.find(e=>e.kind==='payment'); assert.equal(receipt.amount,'40000.00'); assert.equal(receipt.payment_currency,'YER'); assert.equal(receipt.debt_amount,'100.00'); assert.equal(receipt.debt_currency,'SAR'); assert.equal(receipt.rate,'400.000000000000');
   const plans=(await get(`${path}/patients/${patient}/plans`)).plans; assert.equal(plans[0].id,plan); assert.equal(plans[0].steps[0].status,'done');
  });
  await t.test('legacy unknown values remain draft; known remaining imports without historical cash',async()=>{
   const legacyPatient=(await command('patient.create',{fullName:'مريض تقويم سابق'})).id;
   const legacy={patientId:legacyPatient,title:'متابعة حالة تقويم قديمة',specialty:'orthodontics',origin:'legacy',currency:'SAR',agreed:'1000.00',sourceSystem:'paper',asOfDate:'2024-01-01'};
   const unknown=(await command('plan.create',{...legacy,previouslyPaid:null,sourceRecordId:'unknown-legacy'})).id;
   const blocked=await command('legacy.activate',{planId:unknown},{expected:400}); assert.equal(blocked.error,'LEGACY_REVIEW_REQUIRED');
   const draft=(await get(`${path}/patients/${legacyPatient}/plans`)).plans.find(p=>p.id===unknown); assert.equal(draft.previously_paid,null); assert.equal(draft.status,'draft');
   assert.deepEqual((await get(`${path}/patients/${legacyPatient}/statement`)).entries,[]);
   const previous=(await command('plan.create',{...legacy,previouslyPaid:'400.00',sourceRecordId:'known-legacy'})).id;
   await command('legacy.activate',{planId:previous});
   const statement=await get(`${path}/patients/${legacyPatient}/statement`); assert.deepEqual(statement.balances,[{currency:'SAR',balance:'600.00'}]); assert.equal(statement.entries.length,1); assert.equal(statement.entries[0].kind,'legacy_opening'); assert.equal(statement.entries[0].lines.some(l=>l.account==='CASH'),false);
   const followup=(await command('visit.create',{planId:previous,note:'متابعة العلاج الذي بدأ قبل النظام'})).id; await command('visit.sign',{visitId:followup});
   assert.deepEqual((await get(`${path}/patients/${legacyPatient}/statement`)).balances,[{currency:'SAR',balance:'600.00'}]);
  });
  await t.test('clinical-only doctor sees no structured finance fields or statement',async()=>{
   const branches=(await get('/api/branches',doctorCookie)).branches; assert.equal(branches.length,1); assert.equal(branches[0].permissions.includes('finance.read'),false);
   const clinical=(await get(`${path}/patients/${patient}/plans`,doctorCookie)).plans[0];
   assert.equal(clinical.id,plan); for(const field of ['agreed','previously_paid','currency','disputed']) assert.equal(Object.hasOwn(clinical,field),false,field);
   await get(`${path}/patients/${patient}/statement`,doctorCookie,403);
   await command('payment.collect',{planId:plan,amount:'1',currency:'SAR',rate:'1'},{session:doctorCookie,expected:403});
  });
  await t.test('cross-branch patient and cross-patient procedure attachment denied without partial visit',async()=>{
   await get(`/api/branches/${otherBranch}/patients/${patient}`,cookie,404);
   await get(`/api/branches/${otherBranch}/patients/${patient}/plans`,cookie,404);
   const otherPatient=(await command('patient.create',{fullName:'مريض آخر'})).id;
   const otherPlan=(await command('plan.create',{patientId:otherPatient,title:'خطة مريض آخر',specialty:'general',origin:'new',currency:'USD',agreed:'50'})).id;
   await command('plan.activate',{planId:otherPlan});
   await command('visit.create',{planId:otherPlan,stepId:step,note:'لا يسمح بربط إجراء مريض آخر'},{expected:409});
   assert.deepEqual((await get(`${path}/patients/${otherPatient}/visits`)).visits,[]);
  });
  await t.test('permission revocation denies idempotent replay even while session remains valid',async()=>{
   // Explicit fixture administrator switch: PGlite RESET retains the altered session user.
   await db.exec('SET SESSION AUTHORIZATION postgres');
   await db.query("DELETE FROM clinic.role_permission WHERE role_id=$1 AND permission='finance.collect'",[ownerRole]);
   await db.exec('SET SESSION AUTHORIZATION journey_runtime');
   await command('payment.collect',paymentPayload,{key:paymentKey,expected:403});
   assert.deepEqual((await get(`${path}/patients/${patient}/statement`)).balances,[{currency:'SAR',balance:'900.00'}]);
  });
 } finally { if(server) await new Promise(resolve=>server.close(resolve)); await db.close(); }
});
