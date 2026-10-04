// Copyright (c) 2026 Dr. Aqlan Alkamel. All rights reserved.
// Attack-path coverage for the command boundary; these are NOT HTTP auth tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from '../server/app.mjs';

test('HTTP boundary rejects unauthenticated, cross-origin and forged actor requests', async () => {
  const actor=randomUUID(), branch=randomUUID(), impostor=randomUUID(), calls=[];
  const db={query: async(sql,args=[])=>{
    calls.push({sql,args});
    if(sql.includes('FROM clinic.session t')) return {rows:[{id:actor,display_name:'Synthetic user',username:'synthetic'}]};
    if(sql.includes('clinic.execute(')) return {rows:[{result:{id:randomUUID()}}]};
    return {rows:[]};
  }};
  const origin='https://clinic.example.invalid';
  const server=createApp({db,origin,production:true});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  const route=`${base}/api/branches/${branch}/commands`;
  const command={key:randomUUID(),command:'patient.create',payload:{fullName:'Synthetic patient'},actorId:impostor};
  const headers={'Content-Type':'application/json',Origin:origin,Cookie:`__Host-aqlan_session=${'a'.repeat(64)}`,'X-Actor-Id':impostor};
  try {
    const unauth=await fetch(route,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin,'X-Actor-Id':impostor},body:JSON.stringify(command)});
    assert.equal(unauth.status,401);
    for(const badHeaders of [{...headers,Origin:'https://attacker.example.invalid'},{...headers,Origin:''},{...headers,'Sec-Fetch-Site':'cross-site'}]) {
      const r=await fetch(route,{method:'POST',headers:badHeaders,body:JSON.stringify(command)});
      assert.equal(r.status,403);
    }
    assert.equal(calls.filter(c=>c.sql.includes('clinic.execute(')).length,0);
    const ok=await fetch(route,{method:'POST',headers,body:JSON.stringify(command)});
    assert.equal(ok.status,200);
    const execution=calls.find(c=>c.sql.includes('clinic.execute('));
    assert.equal(execution.args[0],actor);
    assert.equal(execution.args[1],branch);
    assert.equal(ok.headers.get('cache-control'),'no-store');
    assert.match(ok.headers.get('content-security-policy'),/frame-ancestors 'none'/);
    const numeric=await fetch(route,{method:'POST',headers,body:JSON.stringify({...command,payload:{amount:0.1}})});
    assert.equal(numeric.status,400);
    assert.equal(calls.filter(c=>c.sql.includes('clinic.execute(')).length,1);
    const sensitive=await fetch(`${base}/server/password.mjs`);
    assert.equal(sensitive.status,404);
    const source=await fetch(`${base}/package.json`);
    assert.equal(source.status,404);
  } finally { await new Promise(resolve=>server.close(resolve)); }
});

test('command authorization is branch-scoped and rechecked on idempotent replay', async () => {
  const db = new PGlite();
  try {
    for (const name of ['001_core.sql', '002_commands.sql']) {
      await db.exec(await readFile(new URL(`../db/${name}`, import.meta.url), 'utf8'));
    }
    const actor = randomUUID(), other = randomUUID(), branch = randomUUID(), alienBranch = randomUUID(), role = randomUUID();
    await db.query('INSERT INTO clinic.staff(id,display_name) VALUES ($1, $2), ($3, $4)', [actor, 'Security fixture', other, 'Other actor']);
    await db.query('INSERT INTO clinic.branch(id,name) VALUES ($1, $2), ($3, $4)', [branch, 'Allowed branch', alienBranch, 'Other branch']);
    await db.query('INSERT INTO clinic.role(id,name) VALUES ($1,$2)', [role, 'Security fixture role']);
    await db.query('INSERT INTO clinic.role_permission VALUES ($1,$2)', [role, 'patient.write']);
    await db.query('INSERT INTO clinic.membership VALUES ($1,$2,$3),($4,$2,$3)', [actor, branch, role, other]);
    const command = (staff, location, key, name, data) => db.query('SELECT clinic.execute($1,$2,$3,$4,$5::jsonb) AS result', [staff, location, key, name, JSON.stringify(data)]);
    const key = randomUUID(), payload = { fullName: 'Synthetic patient' };
    await assert.rejects(command(actor, alienBranch, randomUUID(), 'patient.create', payload), /FORBIDDEN/);
    await assert.rejects(command(actor, branch, randomUUID(), 'payment.collect', {}), /FORBIDDEN/);
    const created = await command(actor, branch, key, 'patient.create', payload);
    await assert.rejects(command(other, branch, key, 'patient.create', payload), /IDEMPOTENCY_CONFLICT/);
    await db.query('UPDATE clinic.staff SET active=false WHERE id=$1', [actor]);
    await assert.rejects(command(actor, branch, key, 'patient.create', payload), /FORBIDDEN/);
    await db.query('UPDATE clinic.staff SET active=true WHERE id=$1', [actor]);
    await db.query('UPDATE clinic.branch SET active=false WHERE id=$1', [branch]);
    await assert.rejects(command(actor, branch, randomUUID(), 'patient.create', payload), /FORBIDDEN/);
    await db.query('UPDATE clinic.branch SET active=true WHERE id=$1', [branch]);
    const replay = await command(actor, branch, key, 'patient.create', payload);
    assert.deepEqual(replay.rows, created.rows);
    await db.query('DELETE FROM clinic.role_permission WHERE role_id=$1', [role]);
    await assert.rejects(command(actor, branch, key, 'patient.create', payload), /FORBIDDEN/);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM clinic.patient')).rows[0].n, 1);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM clinic.operation')).rows[0].n, 1);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM clinic.audit')).rows[0].n, 1);
  } finally { await db.close(); }
});

test('PUBLIC has no access to internal schema or command functions', async () => {
  const db = new PGlite();
  try {
    for (const name of ['001_core.sql', '002_commands.sql', '003_auth.sql']) {
      await db.exec(await readFile(new URL(`../db/${name}`, import.meta.url), 'utf8'));
    }
    const schema = await db.query("SELECT a.privilege_type FROM pg_namespace n CROSS JOIN LATERAL aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a WHERE n.nspname='clinic' AND a.grantee=0");
    const functions = await db.query("SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE n.nspname='clinic' AND a.grantee=0");
    const tables = await db.query("SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE n.nspname='clinic' AND c.relkind='r' AND a.grantee=0");
    assert.deepEqual(schema.rows, []);
    assert.deepEqual(functions.rows, []);
    assert.deepEqual(tables.rows, []);
  } finally { await db.close(); }
});
