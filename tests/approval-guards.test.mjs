import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { fixture } from './helpers/database.mjs';

test('approval guard upgrade preserves restricted runtime and binds approval to displayed version', async t => {
  const db = new PGlite();
  try {
    const originalRole = (await db.query('SELECT current_user AS name')).rows[0].name;
    const restorePrincipal = () => db.exec('SET SESSION AUTHORIZATION "'+originalRole.replaceAll('"','""')+'"');
    for (const name of ['001_core.sql','002_commands.sql','003_auth.sql','004_runtime_boundary.sql']) {
      await db.exec(await readFile(new URL(`../db/${name}`,import.meta.url),'utf8'));
    }
    const f = await fixture(db);
    // Existing draft and posted plans survive an upgrade from schema 4.
    const posted = await f.activePlan();
    const planId = await f.plan({origin:'legacy',sourceSystem:'paper',sourceRecordId:'upgrade-review',asOfDate:'2024-01-01',previouslyPaid:'400'});
    await db.exec(await readFile(new URL('../db/005_approval_guards.sql',import.meta.url),'utf8'));
    assert.deepEqual((await db.query('SELECT DISTINCT version FROM clinic.plan')).rows,[{version:1}]);
    assert.equal(await f.balance(posted),'1000.00');
    const fn = (await db.query("SELECT p.prosecdef,r.rolname,p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner WHERE n.nspname='clinic' AND p.proname='execute'")).rows[0];
    assert.equal(fn.prosecdef,true);
    assert.equal(fn.rolname,'clinic_command_owner');
    assert.ok(fn.proconfig.includes('search_path=pg_catalog, clinic'));
    await db.exec('CREATE ROLE approval_runtime LOGIN INHERIT; GRANT clinic_runtime TO approval_runtime; SET SESSION AUTHORIZATION approval_runtime');
    const review = {planId,agreed:'10000',previouslyPaid:'0',disputed:false,reason:'review source documents',expectedVersion:1};
    const counts = async () => (await db.query('SELECT (SELECT count(*) FROM clinic.journal)::text AS journals,(SELECT count(*) FROM clinic.plan)::text AS plans')).rows[0];
    await t.test('restricted runtime requires a positive numeric version and cannot bypass commands',async()=>{
      for (const expectedVersion of [undefined,null,'1',0,-1,1.5,2147483648]) {
        await assert.rejects(f.command('legacy.review',{...review,expectedVersion}),/EXPECTED_VERSION_REQUIRED/);
        await assert.rejects(f.command('legacy.activate',{planId,expectedVersion}),/EXPECTED_VERSION_REQUIRED/);
      }
      await assert.rejects(db.query('UPDATE clinic.plan SET version=99 WHERE id=$1',[planId]),{code:'42501'});
      assert.equal((await db.query('SELECT version FROM clinic.plan WHERE id=$1',[planId])).rows[0].version,1);
    });
    await t.test('stale review and activation fail without posting, while fresh approval and exact retry succeed',async()=>{
      const reviewKey = randomUUID();
      const result = await f.command('legacy.review',review,{key:reviewKey});
      assert.deepEqual(await f.command('legacy.review',review,{key:reviewKey}),result);
      assert.equal((await db.query('SELECT version FROM clinic.plan WHERE id=$1',[planId])).rows[0].version,2);
      const before = await counts();
      await assert.rejects(f.command('legacy.review',{...review,agreed:'1000',previouslyPaid:'400'}),/STALE_PLAN_VERSION/);
      await assert.rejects(f.command('legacy.activate',{planId,expectedVersion:1}),/STALE_PLAN_VERSION/);
      assert.deepEqual(await counts(),before);
      const key = randomUUID(), approval = {planId,expectedVersion:2};
      const approved = await f.command('legacy.activate',approval,{key});
      assert.deepEqual(await f.command('legacy.activate',approval,{key}),approved);
      assert.equal(await f.balance(planId),'10000.00');
      assert.equal((await db.query('SELECT version FROM clinic.plan WHERE id=$1',[planId])).rows[0].version,3);
    });
    await t.test('new plans also require the displayed version before posting',async()=>{
      const newPlan = await f.plan();
      await assert.rejects(f.command('plan.activate',{planId:newPlan}),/EXPECTED_VERSION_REQUIRED/);
      await assert.rejects(f.command('plan.activate',{planId:newPlan,expectedVersion:2}),/STALE_PLAN_VERSION/);
      await f.command('plan.activate',{planId:newPlan,expectedVersion:1});
      assert.equal(await f.balance(newPlan),'1000.00');
    });
    await t.test('secondary plan-create permissions are checked before cached replay',async()=>{
      const patientId = await f.patient();
      for (const permission of ['finance.agree','finance.opening']) {
        const key = randomUUID();
        const payload = {patientId,specialty:'general',title:'permission replay',origin:'legacy',currency:'SAR',agreed:'100',previouslyPaid:'25',sourceSystem:'paper',sourceRecordId:randomUUID(),asOfDate:'2024-01-01'};
        const created = await f.command('plan.create',payload,{key});
        await restorePrincipal();
        const auditBefore = await f.count('audit'), operationsBefore = await f.count('operation');
        await db.query('DELETE FROM clinic.role_permission WHERE role_id=$1 AND permission=$2',[f.role,permission]);
        await db.exec('SET SESSION AUTHORIZATION approval_runtime');
        await assert.rejects(f.command('plan.create',payload,{key}),/FORBIDDEN/);
        await restorePrincipal();
        assert.equal(await f.count('audit'),auditBefore);
        assert.equal(await f.count('operation'),operationsBefore);
        await db.query('INSERT INTO clinic.role_permission VALUES($1,$2)',[f.role,permission]);
        await db.exec('SET SESSION AUTHORIZATION approval_runtime');
        assert.deepEqual(await f.command('plan.create',payload,{key}),created);
      }
    });
    await restorePrincipal();
    assert.equal((await db.query("SELECT count(*)::text AS count FROM clinic.audit WHERE action='legacy.review' AND entity_id=$1",[planId])).rows[0].count,'1');
    assert.equal((await db.query("SELECT count(*)::text AS count FROM clinic.operation WHERE command='legacy.review' AND payload->>'planId'=$1",[planId])).rows[0].count,'1');
  } finally { await db.close(); }
});
