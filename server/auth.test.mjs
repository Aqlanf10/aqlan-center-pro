import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from './app.mjs';
import { hashPassword,verifyPassword } from './password.mjs';

test('password verifier uses salted scrypt and rejects bad passwords',async()=>{
 const a=await hashPassword('correct-test-password'), b=await hashPassword('correct-test-password');
 assert.notEqual(a,b); assert.equal(await verifyPassword('correct-test-password',a),true);
 assert.equal(await verifyPassword('wrong-password',a),false); assert.equal(await verifyPassword('x','invalid'),false);
 await assert.rejects(hashPassword('short'));
});
test('HTTP authorization, CSRF, inactive account and expiring sessions',async()=>{
 const db=new PGlite();
 for(const file of ['001_core.sql','002_commands.sql','003_auth.sql']) await db.exec(await readFile(new URL(`../db/${file}`,import.meta.url),'utf8'));
 const staff=(await db.query("INSERT INTO clinic.staff(display_name) VALUES('Test owner') RETURNING id")).rows[0].id;
 await db.query('INSERT INTO clinic.login_account(staff_id,username,password_hash) VALUES($1,$2,$3)',[staff,'test-admin',await hashPassword('test-password-123')]);
 const server=createApp({db,origin:'http://localhost:3000'});
 await new Promise(r=>server.listen(0,'127.0.0.1',r)); const url=`http://127.0.0.1:${server.address().port}`;
 const post=(path,data,cookie,origin='http://localhost:3000')=>fetch(url+path,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin,...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(data)});
 try {
  assert.equal((await fetch(url+'/api/branches')).status,401);
  assert.equal((await post('/api/login',{username:'test-admin',password:'test-password-123'},null,'https://attacker.test')).status,403);
  const login=await post('/api/login',{username:'test-admin',password:'test-password-123'}); assert.equal(login.status,200);
  const cookie=login.headers.get('set-cookie'); assert.match(cookie,/HttpOnly/); assert.match(cookie,/SameSite=Strict/);
  const headers={Cookie:cookie.split(';')[0]};
  assert.equal((await fetch(url+'/api/me',{headers})).status,200);
  assert.equal((await fetch(url+'/api/branches/11111111-1111-4111-8111-111111111111/patients',{headers})).status,403);
  assert.equal((await post('/api/branches/11111111-1111-4111-8111-111111111111/commands',{key:'22222222-2222-4222-8222-222222222222',command:'patient.create',payload:{fullName:'Test patient'},actor:staff},headers.Cookie)).status,403);
  await db.query('UPDATE clinic.staff SET active=false WHERE id=$1',[staff]); assert.equal((await fetch(url+'/api/me',{headers})).status,401);
  await db.query('UPDATE clinic.staff SET active=true WHERE id=$1',[staff]);
  await db.exec("UPDATE clinic.session SET expires_at=now()-interval '1 second'"); assert.equal((await fetch(url+'/api/me',{headers})).status,401);
  const second=await post('/api/login',{username:'test-admin',password:'test-password-123'}); const cookie2=second.headers.get('set-cookie').split(';')[0];
  assert.equal((await post('/api/logout',{},cookie2)).status,200); assert.equal((await fetch(url+'/api/me',{headers:{Cookie:cookie2}})).status,401);
  for(let i=0;i<5;i++) assert.equal((await post('/api/login',{username:'test-admin',password:'wrong'})).status,401);
  assert.equal((await post('/api/login',{username:'test-admin',password:'wrong'})).status,429);
 } finally { await new Promise(r=>server.close(r)); await db.close(); }
});
