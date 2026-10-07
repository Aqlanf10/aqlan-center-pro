import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {createApp} from './app.mjs';
import {hashPassword} from './password.mjs';

test('self account HTTP: session isolation, credential change, revocation and secret-free audit',async()=>{
 const db=new PGlite();
 for(const file of (await readdir(new URL('../db/',import.meta.url))).filter(f=>/^\d+.*\.sql$/.test(f)).sort()) await db.exec(await readFile(new URL(`../db/${file}`,import.meta.url),'utf8'));
 const oldPassword='original-password-123',newPassword='replacement-password-456';
 const actors=[];
 for(const username of ['self.owner','other.owner']) {
  const actor=(await db.query('INSERT INTO clinic.staff(display_name) VALUES($1) RETURNING id',[username])).rows[0].id;
  actors.push(actor);await db.query('INSERT INTO clinic.login_account(staff_id,username,password_hash) VALUES($1,$2,$3)',[actor,username,await hashPassword(oldPassword)]);
 }
 // Use the actual restricted runtime role, while retaining admin access for assertions.
 const runtime={query:async(sql,params)=>{
  await db.exec('SET ROLE clinic_runtime');
  try {return await db.query(sql,params);} finally {await db.exec('RESET ROLE');}
 }};
 const origin='http://localhost:3000';const server=createApp({db:runtime,origin});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
 const get=(path,cookie)=>fetch(base+path,{headers:cookie?{Cookie:cookie}:{}});
 const post=(path,data,cookie,source=origin)=>fetch(base+path,{method:'POST',headers:{Origin:source,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(data)});
 const login=async(username='self.owner',password=oldPassword)=>{
  const response=await post('/api/login',{username,password});assert.equal(response.status,200);
  return response.headers.get('set-cookie').split(';')[0];
 };
 const sessions=async cookie=>{const response=await get('/api/account/sessions',cookie);assert.equal(response.status,200);return response.json();};
 try {
  assert.equal((await get('/api/account/sessions')).status,401);
  const own=await login(), second=await login(),other=await login('other.owner');
  const list=await sessions(own);assert.equal(list.credentialVersion,1);assert.equal(list.sessions.length,2);
  assert.equal(list.sessions.filter(row=>row.current).length,1);
  for(const row of list.sessions) assert.deepEqual(Object.keys(row).sort(),['createdAt','current','expiresAt','id']);
  const foreign=(await sessions(other)).sessions[0].id;
  assert.equal((await post(`/api/account/sessions/${foreign}/revoke`,{},own)).status,404);
  assert.equal((await post('/api/account/sessions/revoke-others',{},own,'https://evil.test')).status,403);
  assert.equal((await get('/api/me',other)).status,200);
  const revoked=await post('/api/account/sessions/revoke-others',{},own);assert.equal(revoked.status,200);
  assert.equal((await revoked.json()).revokedCount,1);assert.equal((await get('/api/me',second)).status,401);
  assert.equal((await get('/api/me',own)).status,200);
  const change={currentPassword:oldPassword,newPassword,expectedCredentialVersion:1};
  const wrong=await post('/api/account/password',{...change,currentPassword:'incorrect'},own);
  assert.equal(wrong.status,400);assert.equal((await wrong.json()).error,'CURRENT_PASSWORD_INCORRECT');
  assert.equal((await sessions(own)).credentialVersion,1);
  const spoofed=await post('/api/account/password',{...change,actorId:actors[1]},own);assert.equal(spoofed.status,400);
  const stale=await post('/api/account/password',{...change,expectedCredentialVersion:2},own);assert.equal(stale.status,409);
  assert.equal((await post('/api/account/password',change,own,'https://evil.test')).status,403);
  const successful=await post('/api/account/password',change,own);assert.equal(successful.status,200);
  assert.deepEqual(await successful.json(),{signedOut:true,credentialVersion:2});assert.match(successful.headers.get('set-cookie'),/Max-Age=0/);
  assert.equal((await get('/api/me',own)).status,401);
  assert.equal((await post('/api/login',{username:'self.owner',password:oldPassword})).status,401);
  const fresh=await login('self.owner',newPassword);assert.equal((await sessions(fresh)).credentialVersion,2);
  assert.equal((await get('/api/me',other)).status,200);
  const current=(await sessions(fresh)).sessions.find(row=>row.current);
  const signout=await post(`/api/account/sessions/${current.id}/revoke`,{},fresh);assert.equal(signout.status,200);
  assert.equal((await signout.json()).signedOut,true);assert.equal((await get('/api/me',fresh)).status,401);
  const audit=(await db.query('SELECT * FROM clinic.auth_audit ORDER BY created_at')).rows;
  assert.equal(audit.filter(row=>row.action==='password.changed').length,1);
  const serialized=JSON.stringify(audit);for(const secret of [oldPassword,newPassword,'scrypt-v1',own,other]) assert.equal(serialized.includes(secret),false);
  // Reauthentication attempts are bounded per actor even with valid sessions.
  for(let i=0;i<5;i++) assert.equal((await post('/api/account/password',{...change,currentPassword:'incorrect'},other)).status,400);
  assert.equal((await post('/api/account/password',change,other)).status,429);
  assert.equal((await get('/api/me',other)).status,200);
 } finally {await new Promise(resolve=>server.close(resolve));await db.close();}
});
