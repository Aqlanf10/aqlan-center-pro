import test from 'node:test';
import assert from 'node:assert/strict';
import {accountContent,passwordPayload,accountErrors} from './account-security.mjs';
import {messages} from './locale.mjs';
test('password submission excludes confirmation, actor and other form values and binds captured version',()=>{
 const form={elements:Object.fromEntries(Object.entries({currentPassword:'old synthetic',newPassword:'new synthetic',confirmPassword:'new synthetic',actorId:'forged',acknowledged:'on'}).map(([name,value])=>[name,{value}]))};
 assert.deepEqual(passwordPayload(form,7),{currentPassword:'old synthetic',newPassword:'new synthetic',expectedCredentialVersion:7});
 form.elements.confirmPassword.value='different';assert.throws(()=>passwordPayload(form,7),{code:'PASSWORD_CONFIRM_MISMATCH'});
});
test('session view labels the current session without exposing credential version or session ids as visible text',()=>{
 const html=accountContent({credentialVersion:42,sessions:[{id:'session-identifier',current:true,createdAt:'2026-01-02T10:00:00Z',expiresAt:'2026-01-02T18:00:00Z'}]},'en','UTC');
 assert.match(html,/هذه الجلسة/);assert.match(html,/data-session="session-identifier"/);assert.doesNotMatch(html,/>session-identifier</);assert.doesNotMatch(html,/42/);
 assert.match(html,/autocomplete="current-password"/);assert.match(html,/minlength="12"/);assert.match(html,/name="acknowledged" required/);
 for(const text of Object.values(accountErrors))assert.ok(messages[text],`Missing English error translation`);
});
