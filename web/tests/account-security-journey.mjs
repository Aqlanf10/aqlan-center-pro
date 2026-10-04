import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';

export async function accountSecurityJourney({page,browser,password,db,fixture:f,screenshot}){
 const origin=new URL(page.url()).origin,contexts=[];
 const login=async(target,secret)=>{await target.goto(origin);await target.locator('#login-form').waitFor();await target.locator('[name="username"]').fill('browser.fixture');await target.locator('[name="password"]').fill(secret);await target.locator('#login-form [type="submit"]').click();await target.locator('[data-action="account"]').waitFor();};
 const extraSession=async(secret)=>{const context=await browser.newContext();contexts.push(context);const target=await context.newPage();await login(target,secret);return target;};
 const sessions=target=>target.evaluate(async()=>{const r=await fetch('/api/account/sessions');return {status:r.status,data:await r.json()};});
 const account=async()=>{await page.locator('[data-action="account"]').click();await page.locator('#account-password').waitFor();};
 const confirm=async()=>{await page.locator('#account-revoke input[type="checkbox"]').check();await page.locator('#account-revoke [type="submit"]').click();};
 const fillPassword=async(old,next,confirmation=next)=>{await page.locator('[name="currentPassword"]').fill(old);await page.locator('[name="newPassword"]').fill(next);await page.locator('[name="confirmPassword"]').fill(confirmation);await page.locator('[name="acknowledged"]').check();};
 const submitPassword=()=>page.locator('#account-password [type="submit"]').click();
 try{
  const other=await extraSession(password),third=await extraSession(password);
  const otherId=(await sessions(other)).data.sessions.find(s=>s.current).id;
  await account();assert.equal(await page.locator('.account-session').count(),3);
  await page.locator(`[data-session="${otherId}"]`).click();
  assert.match(await page.locator('#account-revoke').innerText(),/selected session/i);
  await page.locator('[data-account="cancel"]').click();assert.equal((await sessions(other)).status,200);
  await page.locator(`[data-session="${otherId}"]`).click();await confirm();await page.waitForFunction(()=>document.querySelectorAll('.account-session').length===2);
  assert.equal((await sessions(other)).status,401);assert.equal((await sessions(third)).status,200);
  await page.locator('[data-account="revoke-others"]').click();await confirm();await page.waitForFunction(()=>document.querySelectorAll('.account-session').length===1);
  assert.equal((await sessions(third)).status,401);assert.equal((await sessions(page)).status,200);
  await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await screenshot('account-mobile-en.png');
  await page.locator('[data-action="locale"]').click();await page.locator('#account-password').waitFor();assert.equal(await page.locator('html').getAttribute('dir'),'rtl');assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await screenshot('account-mobile-ar.png');
  await page.locator('[data-action="locale"]').click();await page.locator('#account-password').waitFor();
  const next=randomBytes(24).toString('hex');
  await fillPassword(password,next,next+'x');await submitPassword();await page.getByText('Password confirmation does not match the new password.',{exact:true}).waitFor();
  await fillPassword('wrong-synthetic-password',next);await submitPassword();await page.getByText('The current password is incorrect.',{exact:true}).waitFor();assert.equal(await page.locator('[name="newPassword"]').inputValue(),'');
  await fillPassword(password,password);await submitPassword();await page.getByText('Choose a new password different from the current one.',{exact:true}).waitFor();
  const additional=await extraSession(password),version=(await sessions(page)).data.credentialVersion;
  await fillPassword(password,next);await submitPassword();await page.locator('#login-form').waitFor();assert.match(await page.locator('#login-form .error').innerText(),/password changed/i);assert.equal(await page.locator('[name="password"]').inputValue(),'');assert.equal((await sessions(additional)).status,401);
  await login(page,next);await account();assert.equal((await sessions(page)).data.credentialVersion,version+1);
  const newer=randomBytes(24).toString('hex');let posts=0;
  await page.route('**/api/account/password',async route=>{posts++;await route.fetch();await route.abort('failed');});
  await fillPassword(next,newer);await submitPassword();await page.locator('#login-form').waitFor();assert.match(await page.locator('#login-form .error').innerText(),/outcome is unknown/i);assert.equal(await page.locator('[name="password"]').inputValue(),'');assert.equal(posts,1);
  await page.unroute('**/api/account/password');await login(page,newer);await account();assert.equal((await sessions(page)).data.credentialVersion,version+2);
  assert.deepEqual(await page.evaluate(()=>Object.keys(localStorage)),['aqlan.locale']);assert.deepEqual(await page.evaluate(()=>Object.keys(sessionStorage)),[]);
  // Account access is independent of branch memberships and permissions.
  await db.query('DELETE FROM clinic.membership WHERE staff_id=$1',[f.actor]);await page.reload();await account();assert.equal(await page.locator('.account-session').count(),1);
  await page.locator('[data-account="revoke"][data-current="true"]').click();await confirm();await page.locator('#login-form').waitFor();assert.equal((await sessions(page)).status,401);
  console.log('PASS: self-account sessions, confirmation/cancel, revoke one/others/current, branchless access, password validation/change/all-session revocation, lost password response without blind retry, no secret persistence, Arabic/English mobile.');
 }finally{for(const context of contexts)await context.close();}
}
