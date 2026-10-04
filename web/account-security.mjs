// Account-scoped controls. Passwords exist only in form fields and the pending request.
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const accountErrors={
 CURRENT_PASSWORD_INCORRECT:'كلمة المرور الحالية غير صحيحة.',
 INVALID_PASSWORD_CHANGE:'راجع متطلبات كلمة المرور الجديدة.',
 PASSWORD_UNCHANGED:'اختر كلمة مرور جديدة تختلف عن الحالية.',
 PASSWORD_CONFIRM_MISMATCH:'تأكيد كلمة المرور لا يطابق الكلمة الجديدة.',
 STALE_CREDENTIAL_VERSION:'تغيرت بيانات الدخول. أعد قراءة الجلسات قبل تغيير كلمة المرور.',
 ACCOUNT_PASSWORD_UNKNOWN:'تعذر حسم نتيجة تغيير كلمة المرور. سجّل الدخول بالكلمة الجديدة؛ إذا رُفضت، جرّب السابقة. لا تعِد إرسال طلب التغيير دون تسجيل الدخول والتحقق.',
 ACCOUNT_PASSWORD_CHANGED:'تغيرت كلمة المرور وأُنهِيت جميع الجلسات. سجّل الدخول بالكلمة الجديدة.',
 ACCOUNT_SIGNED_OUT:'أُنهِيت هذه الجلسة. سجّل الدخول للمتابعة.',
 ACCOUNT_REVOKE_UNKNOWN:'تعذر حسم نتيجة إنهاء الجلسة. أعد قراءة الجلسات للتحقق قبل المحاولة مجددًا.'
};
export function passwordPayload(form,credentialVersion){
 const value=name=>form.elements[name].value;
 if(value('newPassword')!==value('confirmPassword'))throw Object.assign(new Error('PASSWORD_CONFIRM_MISMATCH'),{code:'PASSWORD_CONFIRM_MISMATCH'});
 return {currentPassword:value('currentPassword'),newPassword:value('newPassword'),expectedCredentialVersion:credentialVersion};
}
export function accountContent(account,locale='ar',timeZone='Asia/Aden'){
 const date=value=>esc(new Intl.DateTimeFormat(locale,{timeZone,dateStyle:'medium',timeStyle:'short'}).format(new Date(value)));
 return `<h1>حسابي وجلساتي</h1><p>إدارة جلسات حسابك وكلمة مرورك في جميع الفروع.</p><div class="account-message error" role="alert"></div><section class="card"><div class="section-head"><h2>الجلسات النشطة</h2><button class="button" type="button" data-account="reload">إعادة قراءة الجلسات</button></div><p class="muted">وقت إنشاء الجلسة وانتهائها يساعدانك على مراجعة الدخول إلى حسابك.</p><div class="account-sessions">${account.sessions.map(session=>`<article class="account-session"><h3>${session.current?'هذه الجلسة':'جلسة أخرى'}</h3><dl class="plan-facts"><div><dt>بدأت في</dt><dd><bdi>${date(session.createdAt)}</bdi></dd></div><div><dt>تنتهي في</dt><dd><bdi>${date(session.expiresAt)}</bdi></dd></div></dl><button class="button" type="button" data-account="revoke" data-session="${esc(session.id)}" data-current="${Boolean(session.current)}">إنهاء الجلسة</button></article>`).join('')}</div><button class="button space-top" type="button" data-account="revoke-others" ${account.sessions.some(s=>!s.current)?'':'disabled'}>إنهاء الجلسات الأخرى</button><div id="account-confirmation"></div></section><section class="card space-top"><h2>تغيير كلمة المرور</h2><p class="banner">سيؤدي تغيير كلمة المرور إلى إنهاء جميع جلسات حسابك، بما فيها هذه الجلسة. ستحتاج إلى تسجيل الدخول بالكلمة الجديدة.</p><p>كلمة المرور الجديدة بين 12 و256 حرفًا وتختلف عن الحالية.</p><form id="account-password"><div class="form-grid">${[['currentPassword','كلمة المرور الحالية','current-password'],['newPassword','كلمة المرور الجديدة','new-password'],['confirmPassword','تأكيد كلمة المرور الجديدة','new-password']].map(([name,label,autocomplete])=>`<label class="field"><span>${label}</span><input name="${name}" type="password" dir="ltr" autocomplete="${autocomplete}" required ${name==='currentPassword'?'':'minlength="12"'} maxlength="256"></label>`).join('')}</div><label class="check"><input type="checkbox" name="acknowledged" required> <span>أفهم أن تغيير كلمة المرور سينهي جميع جلساتي.</span></label><button class="button primary space-top" type="submit">تغيير كلمة المرور وإنهاء الجلسات</button></form></section>`;
}
export function mountAccount(root,{api,locale,timeZone,errorText,signOut,getActorId}){
 const actorId=getActorId(),active=()=>root.isConnected&&getActorId()===actorId;
 let account=null,busy=false,load=0;
 const showError=message=>{if(active()){root.querySelector('.account-message').textContent=message;root.querySelector('.account-message').scrollIntoView({block:'nearest'});}};
 const clearPasswords=()=>root.querySelectorAll('input[type="password"]').forEach(input=>input.value='');
 const lock=()=>{busy=true;const controls=[...document.querySelectorAll('.shell button,.shell select,.shell input')].map(el=>[el,el.disabled]);for(const [el]of controls)el.disabled=true;return ()=>{for(const [el,disabled]of controls)if(el.isConnected)el.disabled=disabled;busy=false;};};
 async function reload(message=''){
  const generation=++load;clearPasswords();account=null;root.innerHTML='<h1>حسابي وجلساتي</h1><div class="account-message error" role="alert"></div><p role="status">جارٍ قراءة الجلسات…</p>';
  try{const data=await api('/api/account/sessions');if(!active()||generation!==load)return;account=data;root.innerHTML=accountContent(account,locale,timeZone);if(message)showError(message);}
  catch(error){if(!active()||generation!==load)return;root.innerHTML='<h1>حسابي وجلساتي</h1><div class="account-message error" role="alert"></div><button class="button" type="button" data-account="reload">إعادة قراءة الجلسات</button>';showError(errorText(error));}
 }
 root.addEventListener('click',event=>{
  const button=event.target.closest('[data-account]');if(!button||busy)return;
  const action=button.dataset.account;
  if(action==='reload'){void reload();return;}
  if(action==='cancel'){root.querySelector('#account-confirmation').innerHTML='';return;}
  if(action==='revoke'||action==='revoke-others'){
   const message=action==='revoke-others'?'ستنتهي جميع جلساتك الأخرى؛ ستبقى هذه الجلسة مفتوحة.':button.dataset.current==='true'?'ستنتهي هذه الجلسة وستعود إلى تسجيل الدخول.':'ستنتهي الجلسة المختارة؛ ستبقى هذه الجلسة مفتوحة.';
   root.querySelector('#account-confirmation').innerHTML=`<form id="account-revoke" class="banner space-top" data-path="${action==='revoke-others'?'/api/account/sessions/revoke-others':`/api/account/sessions/${encodeURIComponent(button.dataset.session)}/revoke`}"><p>${message}</p><label class="check"><input type="checkbox" required> <span>أؤكد إنهاء الجلسات المحددة.</span></label><div class="actions"><button class="button primary" type="submit">تأكيد الإنهاء</button><button class="button" type="button" data-account="cancel">إلغاء</button></div></form>`;
  }
 });
 root.addEventListener('submit',async event=>{
  const form=event.target;if(!['account-password','account-revoke'].includes(form.id))return;event.preventDefault();if(busy||!account)return;
  let payload;try{payload=form.id==='account-password'?passwordPayload(form,account.credentialVersion):{};}catch(error){showError(errorText(error));return;}
  const password=form.id==='account-password',unlock=lock();
  try{const result=await api(password?'/api/account/password':form.dataset.path,payload);if(password?result.signedOut!==true||!Number.isSafeInteger(result.credentialVersion):form.dataset.path.endsWith('/revoke-others')?!Number.isSafeInteger(result.revokedCount):typeof result.revoked!=='boolean'||typeof result.signedOut!=='boolean')throw Object.assign(new Error('INVALID_RESPONSE'),{code:'INVALID_RESPONSE'});clearPasswords();if(result.signedOut){signOut(password?'ACCOUNT_PASSWORD_CHANGED':'ACCOUNT_SIGNED_OUT');return;}await reload('تم إنهاء الجلسات المحددة.');}
  catch(error){clearPasswords();if(!active())return;
   if(password&&!['CURRENT_PASSWORD_INCORRECT','INVALID_PASSWORD_CHANGE','PASSWORD_UNCHANGED','STALE_CREDENTIAL_VERSION','TRY_LATER','AUTH_REQUIRED'].includes(error.code)){signOut('ACCOUNT_PASSWORD_UNKNOWN');return;}
   if(password&&error.code==='STALE_CREDENTIAL_VERSION'){await reload(errorText(error));return;}
   showError(password?errorText(error):accountErrors.ACCOUNT_REVOKE_UNKNOWN);
   if(!password)root.querySelector('#account-confirmation').innerHTML='';
  }finally{payload=null;clearPasswords();unlock();}
 });
 void reload();
}
