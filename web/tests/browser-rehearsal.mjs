// Synthetic, disposable browser integration rehearsal. Never run against patient data.
// npm run test:browser (install Chromium with npx playwright install chromium first).
// Optional: BROWSER_EXECUTABLE=<Chrome/Edge>, BROWSER_ARTIFACT_DIR=<evidence folder>.
// PostgreSQL: BROWSER_DATABASE_URL must point to a fresh *_browser_test database in
// a disposable cluster with no clinic roles yet (roles are cluster-wide).
import assert from 'node:assert/strict';
import {readFile, mkdir, readdir} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {resolve} from 'node:path';
import {chromium} from 'playwright';
import pg from 'pg';
import {PGlite} from '@electric-sql/pglite';
import {fixture} from '../../tests/helpers/database.mjs';
import {createApp} from '../../server/app.mjs';
import {hashPassword} from '../../server/password.mjs';
import {accountSecurityJourney} from './account-security-journey.mjs';
import {patientHistoryJourney} from './patient-history-journey.mjs';

async function testDatabase(){
 const migrations=(await readdir(new URL('../../db/',import.meta.url))).filter(name=>/^\d+_.*\.sql$/.test(name)).sort();
 if(!process.env.BROWSER_DATABASE_URL){const database=new PGlite();try{for(const file of migrations)await database.exec(await readFile(new URL(`../../db/${file}`,import.meta.url),'utf8'));return database;}catch(error){await database.close();throw error;}}
 const url=new URL(process.env.BROWSER_DATABASE_URL);
 if(!/^\/[a-z0-9_]+_browser_test$/.test(url.pathname))throw new Error('Browser database name must end in _browser_test');
 const client=new pg.Pool({connectionString:url.href,max:4});
 try {
  if((await client.query("SELECT 1 FROM pg_namespace WHERE nspname='clinic'")).rows.length)throw new Error('Browser database must be fresh; refusing to alter an existing clinic schema');
  for(const file of migrations)await client.query(await readFile(new URL(`../../db/${file}`,import.meta.url),'utf8'));
  return {query:(...args)=>client.query(...args),exec:sql=>client.query(sql),close:()=>client.end()};
 }catch(error){await client.end();throw error;}
}
const db=await testDatabase();
let app,browser;
try {
 const f=await fixture(db), password=randomBytes(24).toString('hex');
 await db.query('INSERT INTO clinic.login_account(staff_id,username,password_hash) VALUES($1,$2,$3)',[f.actor,'browser.fixture',await hashPassword(password)]);
 // Reserve a loopback port before selecting the exact CSRF origin.
 app=createApp({db,origin:'http://127.0.0.1:43187'});
 await new Promise((ok,bad)=>app.once('error',bad).listen(43187,'127.0.0.1',ok));
 browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE});
 const page=await browser.newPage({viewport:{width:1366,height:900}}), errors=[];
 const screenshot=async name=>{if(process.env.BROWSER_ARTIFACT_DIR){await mkdir(process.env.BROWSER_ARTIFACT_DIR,{recursive:true});await page.locator('#notifications .toast').waitFor({state:'detached'});await page.evaluate(()=>{document.activeElement?.blur();window.scrollTo(0,0);});await page.screenshot({path:resolve(process.env.BROWSER_ARTIFACT_DIR,name),fullPage:true});}};
 page.on('pageerror',e=>errors.push(e.message));
 const action=a=>page.locator(`[data-action="${a}"]`).first();
 const fill=async(name,value)=>page.locator(`#command-form [name="${name}"]`).fill(value);
 const submit=async()=>{await page.locator('#command-form [type="submit"]').click();await page.waitForFunction(()=>{const modal=document.querySelector('#modal');return !modal.open&&!modal.dataset.busy;});};
 const tab=async(id)=>page.locator(`[data-action="tab"][data-id="${id}"]`).click();
 await page.goto('http://127.0.0.1:43187');
 await page.locator('#login-form').waitFor();
 assert.equal(await page.locator('html').getAttribute('dir'),'rtl');
 await page.locator('[name="username"]').fill('browser.fixture');
 await page.locator('[name="password"]').fill(password);
 await action('locale').click();
 assert.equal(await page.locator('[name="username"]').inputValue(),'browser.fixture','Language switch must retain the login draft');
 assert.equal(await page.locator('[name="password"]').inputValue(),password);
 await action('locale').click();
 await page.locator('#login-form [type="submit"]').click();
 await action('new-patient').waitFor();
 await action('new-patient').click();await fill('fullName','مريض تجربة متصفح');await fill('phone','777000001');await fill('birthDate','1990-01-02');await submit();
 assert.match(await page.locator('.patient-meta').innerText(),/1990-01-02/,'Birth dates must not shift through the PostgreSQL driver');
 const primaryPatient=(await db.query('SELECT patient_id FROM clinic.patient_branch WHERE branch_id=$1',[f.branch])).rows[0].patient_id;
 const openPrimary=()=>page.locator(`[data-action="open-patient"][data-id="${primaryPatient}"]`).click();
 await patientHistoryJourney({page,db,fixture:f,screenshot});
 await tab('plans');await action('new-plan').click();
 await fill('title','تقويم الأسنان');await page.locator('[name="specialty"]').selectOption('orthodontics');
 await page.locator('[name="currency"]').selectOption('SAR');await fill('agreed','1000');await fill('progress','تقويم الأسنان');await submit();
 await action('activate-plan').click();await page.locator('#command-form input[type="checkbox"]').check();await submit();
 await action('new-step').click();await fill('procedureName','تقويم الأسنان');await page.locator('[data-action="tooth"][data-id="11"]').click();await submit();
 await action('new-visit').click();await page.locator('[name="stepId"]').selectOption({index:1});const visitDate=await page.locator('[name="occurredOn"]').inputValue();await fill('note','تقويم الأسنان');await submit();
 await tab('visits');await action('sign-visit').click();await page.locator('#command-form input[type="checkbox"]').last().check();await submit();
 assert.match(await page.locator('.plan-top small').innerText(),new RegExp(visitDate));
 let plan=(await db.query('SELECT id FROM clinic.plan WHERE branch_id=$1',[f.branch])).rows[0].id;
 assert.equal(await f.balance(plan),'1000.00');assert.equal(await f.balance(plan,'CASH'),'0');
 await tab('finance');await action('new-payment').click();await page.locator('[name="currency"]').selectOption('YER');await fill('amount','14000');await fill('rate','140');
 assert.match(await page.locator('#payment-preview').innerText(),/100\.00 SAR/);
 let dropPaymentResponse=true;
 await page.route('**/commands',async route=>{if(dropPaymentResponse&&route.request().postDataJSON()?.command==='payment.collect'){dropPaymentResponse=false;await route.fetch();await route.abort('failed');}else await route.continue();});
 await page.locator('[name="confirmed"]').check();await page.locator('#command-form [type="submit"]').click();
 await page.waitForFunction(()=>document.querySelector('#modal').dataset.uncertain==='true');
 await action('close-modal').click();assert.equal(await page.locator('#modal').evaluate(modal=>modal.open),true);
 await page.keyboard.press('Escape');assert.equal(await page.locator('#modal').evaluate(modal=>modal.open),true);
 assert.equal(await page.locator('[name="amount"]').isDisabled(),true);
 assert.equal(await f.balance(plan),'900.00','Payment committed before its response was lost');
 const retryKey=await page.locator('#command-form').getAttribute('data-key');
 await db.query("UPDATE clinic.session SET expires_at=now()-interval '1 second' WHERE staff_id=$1",[f.actor]);
 await page.locator('#command-form [type="submit"]').click();
 const loginRecovery=page.locator('#form-error a[target="_blank"]');await loginRecovery.waitFor();
 assert.equal(await page.locator('#modal').evaluate(modal=>modal.open),true,'Expired session must not discard the uncertain dialog');
 assert.equal(await page.locator('#command-form').getAttribute('data-key'),retryKey);
 assert.equal(await page.locator('[name="amount"]').isDisabled(),true);
 assert.equal(await loginRecovery.getAttribute('href'),'/');assert.equal(await loginRecovery.getAttribute('rel'),'noopener');
 const reauthReady=page.context().waitForEvent('page');await loginRecovery.click();const reauth=await reauthReady;
 await reauth.locator('#login-form').waitFor();await reauth.locator('[name="username"]').fill('browser.fixture');await reauth.locator('[name="password"]').fill(password);
 await reauth.locator('#login-form [type="submit"]').click();await reauth.locator('[data-action="new-patient"]').first().waitFor();await reauth.close();
 await submit();assert.equal(await f.balance(plan),'900.00','Unchanged retry must return the committed payment, not collect again');
 assert.ok(retryKey);assert.equal((await db.query('SELECT count(*)::int AS count FROM clinic.payment p JOIN clinic.journal j ON j.id=p.journal_id WHERE j.plan_id=$1',[plan])).rows[0].count,1);
 await action('locale').click();assert.equal(await page.locator('html').getAttribute('dir'),'ltr');
 await screenshot('desktop-en-statement.png');
 await tab('plans');assert.equal(await page.locator('.plan-top h3').innerText(),'تقويم الأسنان');assert.equal(await page.locator('.plan-note').innerText(),'تقويم الأسنان');
 await tab('visits');assert.equal(await page.locator('#patient-content .text-block').innerText(),'تقويم الأسنان');
 await action('new-visit').click();
 assert.equal(await page.locator('[name="planId"] option').innerText(),'تقويم الأسنان (SAR)','User-entered plan titles must never be translated inside options');
 assert.equal(await page.locator('[name="stepId"] option').last().innerText(),'تقويم الأسنان — 11');
 await action('close-modal').click();
 await tab('plans');await action('new-plan').click();await page.locator('[name="origin"]').selectOption('legacy');await fill('title','حالة سابقة اختبار');await page.locator('[name="currency"]').selectOption('SAR');await fill('asOfDate','2024-01-01');await fill('sourceRecordId','synthetic-browser-legacy');await submit();
 await action('activate-plan').click();await page.locator('#command-form input[type="checkbox"]').check();await page.locator('#command-form [type="submit"]').click();
 await page.waitForFunction(()=>document.querySelector('#form-error').textContent.length>0);
 assert.match(await page.locator('#form-error').innerText(),/review|unknown|disput|complete|amount/i);
 await action('close-modal').click();await action('review-legacy').click();await fill('agreed','1000');await fill('previouslyPaid','400');await fill('reason','مطابقة مستند اصطناعي');await submit();
 const legacyRow=(await db.query("SELECT id,version FROM clinic.plan WHERE origin='legacy'")).rows[0], legacy=legacyRow.id;
 await action('activate-plan').click();
 await f.command('legacy.review',{planId:legacy,expectedVersion:legacyRow.version,agreed:'1100',previouslyPaid:'500',disputed:false,reason:'Synthetic second reviewer change'});
 await page.locator('#command-form input[type="checkbox"]').check();await page.locator('#command-form [type="submit"]').click();
 await page.waitForFunction(()=>document.querySelector('#form-error').textContent.includes('changed'));
 assert.equal(await page.locator('[name="expectedVersion"]').inputValue(),String(legacyRow.version),'Stale approval must not silently refresh its captured version');
 assert.equal(await f.balance(legacy),'0');
 await action('close-modal').click();
 await page.locator('[data-action="navigate"][data-id="patients"]').first().click();await openPrimary();await tab('plans');
 await action('activate-plan').click();await page.locator('#command-form input[type="checkbox"]').check();await submit();
 assert.equal(await f.balance(legacy),'600.00');assert.equal(await f.balance(legacy,'CASH'),'0');
 assert.match(await page.locator('.plan .inline-note').first().innerText(),/2024-01-01/,'Legacy dates must remain the entered calendar date');
 await page.setViewportSize({width:390,height:844});
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Mobile English viewport must not overflow');
 await screenshot('mobile-en.png');
 await action('locale').click();assert.equal(await page.locator('html').getAttribute('dir'),'rtl');
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Mobile Arabic viewport must not overflow');
 await screenshot('mobile-ar.png');
 await page.locator('[data-action="navigate"][data-id="patients"]').first().click();
 await page.locator('#search-form input').fill('بحث لم يرسل');await action('locale').click();assert.equal(await page.locator('#search-form input').inputValue(),'بحث لم يرسل');
 await db.query("DELETE FROM clinic.role_permission WHERE role_id=$1 AND permission='finance.read'",[f.role]);
 await page.reload();await openPrimary();await tab('plans');
 assert.equal(await page.locator('[data-action="tab"][data-id="finance"]').count(),0);
 assert.equal(await page.locator('.plan-facts').count(),0,'Financial amounts must be hidden without finance.read');
 await action('new-visit').click();
 assert.equal(await page.locator('[name="planId"] option').last().innerText(),'تقويم الأسنان','Clinical users do not receive agreement currency');
 await action('close-modal').click();
 await accountSecurityJourney({page,browser,password,db,fixture:f,screenshot});
 assert.deepEqual(errors,[]);
 console.log(`PASS: real Chromium + HTTP + synthetic ${process.env.BROWSER_DATABASE_URL?'PostgreSQL':'PGlite'}: Arabic/English login, new plan, FDI step, signed visit without added debt, YER/SAR payment, legacy unknown rejection/review/activation, protected clinical text, mobile RTL/LTR. This is not Railway or production approval; restricted deployment credentials and concurrent operations have separate gates.`);
} finally {
 await browser?.close();
 if(app?.listening)await new Promise(ok=>app.close(ok));
 await db.close();
}
