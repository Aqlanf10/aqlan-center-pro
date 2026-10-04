// Branch-scoped, immutable review UI. User-entered clinical text is never translated.
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const sections={medical:'التاريخ الطبي',dental:'التاريخ السني',allergies:'الحساسية'};
const statuses={unknown:'غير معروف / لم يُراجع',none:'لا شيء مُبلّغ عنه',reported:'معلومات مُبلّغ عنها'};
const sources={patient_report:'إفادة المريض',guardian_report:'إفادة ولي الأمر',record_review:'مراجعة سجل سابق',clinician_review:'مراجعة الطبيب'};
const safeText=value=>`<span translate="no" class="text-block">${esc(value)}</span>`;
export const historyErrors={
 STALE_HISTORY_VERSION:'حُفظت مراجعة أحدث لهذا الفرع. أغلق النافذة وأعد فتح ملف المريض لمراجعة التغيير قبل الحفظ.',
 HISTORY_VERSION_REQUIRED:'تعذر التحقق من إصدار التاريخ الطبي. أعد فتح ملف المريض قبل المراجعة.',
 INVALID_HISTORY_REVIEW:'راجع حالات التاريخ الطبي والتفاصيل ومصدر المراجعة وسببها.',
 INVALID_HISTORY_DATE:'أدخل تاريخ مراجعة صالحًا لا يتجاوز اليوم في هذا الفرع.'
};
export function historySummary(history){
 if(!history)return '';
 const current=history.current, allergy=current?.allergies;
 const label=!current?'لم تُسجل مراجعة للحساسية في هذا الفرع':allergy.status==='unknown'?'الحساسية غير معروفة في آخر مراجعة لهذا الفرع':allergy.status==='none'?'لا توجد حساسية مُبلّغ عنها في آخر مراجعة لهذا الفرع':'حساسية مُبلّغ عنها في هذا الفرع';
 return `<aside class="banner history-alert ${allergy?.status==='reported'?'history-alert-reported':''}" aria-label="ملخص الحساسية في الفرع"><strong>${label}</strong>${allergy?.status==='reported'?`<p class="text-block" translate="no">${esc(allergy.details)}</p>`:''}${current?`<div><span>تاريخ المراجعة:</span> <bdi>${esc(current.observed_on)}</bdi></div>`:''}<small>هذا ملخص مراجعة الفرع الحالي؛ لا يثبت حالة المريض في جميع الفروع.</small></aside>`;
}
function sectionSummary(review){return `<div class="history-sections">${Object.entries(sections).map(([key,label])=>`<section><h3>${label}</h3><p class="pill ${review[key].status==='unknown'?'orange':review[key].status==='none'?'green':''}">${statuses[review[key].status]}</p>${review[key].status==='reported'?`<p class="text-block" translate="no">${esc(review[key].details)}</p>`:''}</section>`).join('')}</div>`;}
function metadata(review,user,locale,timeZone){const savedAt=new Intl.DateTimeFormat(locale,{timeZone,dateStyle:'medium',timeStyle:'short'}).format(new Date(review.reviewed_at));return `<dl class="plan-facts history-metadata"><div><dt>تاريخ المراجعة</dt><dd><bdi dir="ltr">${esc(review.observed_on)}</bdi></dd></div><div><dt>مصدر المعلومات</dt><dd>${sources[review.source]}</dd></div><div><dt>سجّل المراجعة</dt><dd>${safeText(review.reviewed_by_name||(review.reviewed_by===user?.id?user.display_name:''))}</dd></div><div><dt>وقت الحفظ</dt><dd><bdi>${esc(savedAt)}</bdi></dd></div></dl><p><strong>سبب المراجعة:</strong> ${safeText(review.reason)}</p>`;}
export function historyContent(history,editable,user,locale='ar',timeZone='Asia/Aden'){
 const current=history?.current;
 return `<div class="section-head"><h2>التاريخ الطبي والسني والحساسية</h2>${editable?'<button class="button primary" type="button" data-action="review-history">تسجيل مراجعة جديدة</button>':''}</div><p class="banner">كل مراجعة محفوظة بتاريخها ومصدرها ومن سجّلها في هذا الفرع. غياب المعلومة ليس نفيًا للحساسية أو المرض. تُحفظ المراجعات السابقة ولا تُستبدل بصمت.</p>${current?`<article class="card history-current"><div class="section-head"><h3>آخر مراجعة في هذا الفرع</h3><span><span>الإصدار</span> ${esc(history.version)}</span></div>${sectionSummary(current)}${metadata(current,user,locale,timeZone)}</article>`:'<section class="card empty"><h3>لم يُراجع التاريخ الطبي في هذا الفرع بعد</h3><p>ابدأ بمراجعة مع المريض أو ولي الأمر أو مصدر موثّق. لا تفترض أن غياب السجل يعني عدم وجود أمراض أو حساسية.</p></section>'}<section class="history-revisions"><h3>المراجعات السابقة في هذا الفرع</h3>${(history?.revisions||[]).slice(1).map(review=>`<details class="card"><summary><span>الإصدار</span> ${esc(review.version)} · <bdi dir="ltr">${esc(review.observed_on)}</bdi></summary>${sectionSummary(review)}${metadata(review,user,locale,timeZone)}</details>`).join('')||'<p class="muted">لا توجد مراجعات سابقة.</p>'}</section><p class="inline-note">تسجيل هذه المراجعة لا يُعد موافقة طبية أو توقيعًا عليها.</p>`;
}
export function historyForm(history,today){
 const current=history?.current;
 return `<input name="expectedVersion" type="hidden" value="${esc(history?.version??0)}"><p class="banner">هذه مراجعة جديدة للفرع الحالي. اختر «غير معروف» عند عدم التحقق، و«لا شيء مُبلّغ عنه» فقط بعد المراجعة. لن تمحو هذه المراجعة السجل السابق.</p>${Object.entries(sections).map(([key,label])=>{const section=current?.[key]||{status:'unknown',details:''};return `<fieldset class="history-fieldset"><legend>${label}</legend><label class="field"><span>حالة المعلومات</span><select name="${key}Status" data-history-section="${key}" required>${Object.entries(statuses).map(([status,text])=>`<option value="${status}" ${section.status===status?'selected':''}>${text}</option>`).join('')}</select></label><label class="field" data-history-details="${key}" ${section.status==='reported'?'':'hidden'}><span>التفاصيل المُبلّغ عنها</span><textarea name="${key}Details" maxlength="6000" minlength="3" ${section.status==='reported'?'required':'disabled'} translate="no">${esc(section.details)}</textarea></label></fieldset>`;}).join('')}<div class="form-grid"><label class="field"><span>مصدر المعلومات</span><select name="source" required><option value="">اختر مصدر المراجعة</option>${Object.entries(sources).map(([value,label])=>`<option value="${value}">${label}</option>`).join('')}</select></label><label class="field"><span>تاريخ المراجعة</span><input name="observedOn" type="date" value="${esc(today)}" max="${esc(today)}" required></label></div><label class="field"><span>سبب المراجعة</span><textarea name="reason" minlength="3" maxlength="2000" required></textarea></label>`;
}
export function updateHistoryFields(form){for(const key of Object.keys(sections)){const reported=form.elements[`${key}Status`].value==='reported';form.querySelector(`[data-history-details="${key}"]`).hidden=!reported;form.elements[`${key}Details`].disabled=!reported;form.elements[`${key}Details`].required=reported;}}
export function historyPayload(form){
 const payload={expectedVersion:Number(form.elements.expectedVersion.value),source:form.elements.source.value,reason:form.elements.reason.value,observedOn:form.elements.observedOn.value};
 for(const key of Object.keys(sections)){const status=form.elements[`${key}Status`].value;payload[key]={status,details:status==='reported'?form.elements[`${key}Details`].value:''};}
 return payload;
}
