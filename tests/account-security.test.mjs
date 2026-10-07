import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {fixture} from './helpers/database.mjs';

// Format-valid synthetic hashes only: scrypt verification belongs to the HTTP server.
const oldHash=`scrypt-v1$${'a'.repeat(32)}$${'b'.repeat(128)}`;
const newHash=`scrypt-v1$${'c'.repeat(32)}$${'d'.repeat(128)}`;
const token=()=>createHash('sha256').update(randomUUID()).digest('hex');
test('account security: upgrade, restricted self-service and atomic credential invalidation',async t=>{
 const db=new PGlite();
 try{
  for(const file of (await readdir(new URL('../db/',import.meta.url))).filter(n=>/^00[1-6]_.*\.sql$/.test(n)).sort())
   await db.exec(await readFile(new URL(`../db/${file}`,import.meta.url),'utf8'));
  const f=await fixture(db),other=await fixture(db);
  await db.query('INSERT INTO clinic.login_account(staff_id,username,password_hash) VALUES($1,$2,$3),($4,$5,$3)',[f.actor,'test.owner',oldHash,other.actor,'test.other']);
  const current=token(),foreignToken=token();
  await db.query("INSERT INTO clinic.session(token_hash,staff_id,expires_at) VALUES($1,$2,now()+interval '1 hour'),($3,$4,now()+interval '1 hour')",[current,f.actor,foreignToken,other.actor]);
  await db.exec(await readFile(new URL('../db/007_account_security.sql',import.meta.url),'utf8'));
  const original=(await db.query('SELECT current_user AS name')).rows[0].name;
  const admin=()=>db.exec('SET SESSION AUTHORIZATION "'+original.replaceAll('"','""')+'"');
  const runtime=()=>db.exec('SET SESSION AUTHORIZATION account_runtime');
  await db.exec('CREATE ROLE account_runtime LOGIN INHERIT; GRANT clinic_runtime TO account_runtime');
  const call=async(name,args)=>(await db.query(`SELECT clinic.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) AS result`,args)).rows[0].result;
  const list=(actor=f.actor,hash=current)=>call('account_sessions',[actor,hash]);
  const issue=(hash=token(),version=1,actor=f.actor)=>call('issue_session',[actor,version,hash]);
  const change=(version=1,verified=oldHash,next=newHash,hash=current)=>call('change_account_password',[f.actor,hash,version,verified,next]);
  let currentId,foreignId;
  await runtime();
  await t.test('old sessions backfill version one and expose only own public IDs',async()=>{
   const data=await list();assert.equal(data.credentialVersion,1);assert.equal(data.sessions.length,1);
   currentId=data.sessions[0].id;assert.match(currentId,/^[a-f0-9-]{36}$/);assert.equal(data.sessions[0].current,true);
   assert.deepEqual(Object.keys(data.sessions[0]).sort(),['createdAt','current','expiresAt','id']);
   assert.ok(!JSON.stringify(data).includes(current));assert.ok(!JSON.stringify(data).includes(oldHash));
   foreignId=(await list(other.actor,foreignToken)).sessions[0].id;
   await assert.rejects(list(other.actor,current),/AUTH_REQUIRED/);
   await assert.rejects(call('revoke_account_session',[f.actor,current,foreignId]),/NOT_FOUND/);
   assert.equal((await list(other.actor,foreignToken)).sessions.length,1);
  });
  await t.test('new sessions require a current credential version and strict token digest',async()=>{
   for(const hash of [null,'a'.repeat(63),'G'.repeat(64),'a'.repeat(64)+'\n'])await assert.rejects(issue(hash),/INVALID_SESSION_HASH/);
   await assert.rejects(issue(token(),null),/STALE_CREDENTIAL_VERSION/);
   await assert.rejects(issue(token(),2),/STALE_CREDENTIAL_VERSION/);
   const session=await issue();assert.equal(session.credentialVersion,1);
   assert.ok(Math.abs(new Date(session.expiresAt).getTime()-Date.now()-8*3600000)<10000);
   await call('revoke_account_session',[f.actor,current,session.id]);
  });
  await t.test('revoke others preserves current and cannot affect another account; repeat adds no audit',async()=>{
   await issue();await issue();
   assert.deepEqual(await call('revoke_other_sessions',[f.actor,current]),{revokedCount:2});
   assert.equal((await list()).sessions[0].id,currentId);
   assert.equal((await list(other.actor,foreignToken)).sessions.length,1);
   assert.deepEqual(await call('revoke_other_sessions',[f.actor,current]),{revokedCount:0});
   await admin();assert.equal((await db.query("SELECT count(*)::int n FROM clinic.auth_audit WHERE action='sessions.others_revoked'")).rows[0].n,1);await runtime();
  });
  await t.test('revoking current reports signout and immediately blocks that session',async()=>{
   const digest=token(),issued=await issue(digest);
   assert.deepEqual(await call('revoke_account_session',[f.actor,digest,issued.id]),{revoked:true,signedOut:true});
   await assert.rejects(list(f.actor,digest),/AUTH_REQUIRED/);
   assert.equal((await list()).sessions.length,1);
  });
  await t.test('wrong verified hash, stale version and malformed new hash leave credentials and sessions intact',async()=>{
   await assert.rejects(change(1,newHash),/STALE_CREDENTIAL_VERSION/);
   await assert.rejects(change(2),/STALE_CREDENTIAL_VERSION/);
   await assert.rejects(change(null),/STALE_CREDENTIAL_VERSION/);
   for(const next of [null,'plaintext',newHash+'\n',newHash.toUpperCase()])await assert.rejects(change(1,oldHash,next),/INVALID_PASSWORD_HASH/);
   assert.equal((await list()).credentialVersion,1);
   await admin();assert.equal((await db.query('SELECT password_hash FROM clinic.login_account WHERE staff_id=$1',[f.actor])).rows[0].password_hash,oldHash);await runtime();
  });
  await t.test('password CAS raises epoch, signs out every old session and rejects pre-change login verification',async()=>{
   const second=token();await issue(second);
   assert.deepEqual(await change(),{credentialVersion:2,signedOut:true});
   await assert.rejects(list(),/AUTH_REQUIRED/);await assert.rejects(list(f.actor,second),/AUTH_REQUIRED/);
   await assert.rejects(issue(token(),1),/STALE_CREDENTIAL_VERSION/);
   await assert.rejects(change(),/AUTH_REQUIRED/);
   const renewed=token();await issue(renewed,2);
   assert.equal((await list(f.actor,renewed)).credentialVersion,2);
   assert.equal((await list(other.actor,foreignToken)).credentialVersion,1);
   await admin();
   assert.equal((await db.query('SELECT password_hash FROM clinic.login_account WHERE staff_id=$1',[f.actor])).rows[0].password_hash,newHash);
   const audit=(await db.query("SELECT * FROM clinic.auth_audit WHERE action='password.changed'")).rows;
   assert.equal(audit.length,1);assert.equal(audit[0].affected_sessions,2);
   const json=JSON.stringify(audit);for(const secret of [oldHash,newHash,current,second,renewed])assert.ok(!json.includes(secret));
   await db.query('UPDATE clinic.staff SET active=false WHERE id=$1',[f.actor]);await runtime();
   await assert.rejects(list(f.actor,renewed),/AUTH_REQUIRED/);await assert.rejects(issue(token(),2),/AUTH_REQUIRED/);
   await admin();await db.query('UPDATE clinic.staff SET active=true WHERE id=$1',[f.actor]);await runtime();
  });
  await t.test('runtime has no raw credential/session writes or audit access; audit resists owner mutations',async()=>{
   await assert.rejects(db.query('UPDATE clinic.login_account SET password_hash=$1 WHERE staff_id=$2',[oldHash,f.actor]),/permission denied/);
   await assert.rejects(db.query('INSERT INTO clinic.session(token_hash,staff_id,expires_at) VALUES($1,$2,now())',[token(),f.actor]),/permission denied/);
   await assert.rejects(db.query('DELETE FROM clinic.session WHERE staff_id=$1',[f.actor]),/permission denied/);
   await assert.rejects(db.query('SELECT * FROM clinic.auth_audit'),/permission denied/);
   await assert.rejects(db.query('SELECT clinic.require_account_session($1,$2)',[other.actor,foreignToken]),/permission denied/);
   await admin();
   await assert.rejects(db.query('UPDATE clinic.auth_audit SET affected_sessions=0'),/APPEND_ONLY/);
   await assert.rejects(db.query('DELETE FROM clinic.auth_audit'),/APPEND_ONLY/);
  });
 }finally{await db.close();}
});
