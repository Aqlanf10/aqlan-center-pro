import test from 'node:test';
import assert from 'node:assert/strict';
import {historySummary,historyContent,historyForm,historyPayload} from './patient-history.mjs';

const section=status=>({status,details:status==='reported'?'<script>unsafe()</script>':''});
const current={version:1,medical:section('unknown'),dental:section('none'),allergies:section('reported'),observed_on:'2026-01-02',source:'patient_report',reason:'<reason>',reviewed_by:'actor-id',reviewed_at:'2026-01-02T10:00:00Z'};
test('branch allergy summary distinguishes unreviewed, unknown, none and reported without executable user content',()=>{
 assert.match(historySummary({current:null}),/لم تُسجل مراجعة/);
 assert.match(historySummary({current:{...current,allergies:section('unknown')}}),/غير معروفة/);
 assert.match(historySummary({current:{...current,allergies:section('none')}}),/لا توجد حساسية مُبلّغ/);
 const reported=historySummary({current});
 assert.match(reported,/حساسية مُبلّغ عنها في هذا الفرع/);
 assert.match(reported,/translate="no"/);assert.match(reported,/&lt;script&gt;/);assert.doesNotMatch(reported,/<script>/);
});
test('history payload never sends hidden stale details as unknown or none, and keeps captured version',()=>{
 const values={expectedVersion:'2',source:'guardian_report',reason:'مراجعة جديدة',observedOn:'2026-01-02',medicalStatus:'unknown',medicalDetails:'previous details',dentalStatus:'none',dentalDetails:'previous details',allergiesStatus:'reported',allergiesDetails:'معلومة أصلية'};
 const form={elements:Object.fromEntries(Object.entries(values).map(([key,value])=>[key,{value}]))};
 assert.deepEqual(historyPayload(form),{expectedVersion:2,source:'guardian_report',reason:'مراجعة جديدة',observedOn:'2026-01-02',medical:{status:'unknown',details:''},dental:{status:'none',details:''},allergies:{status:'reported',details:'معلومة أصلية'}});
});
test('history UI preserves immutable attribution and hides review action for read-only clinicians',()=>{
 const history={version:2,current:{...current,version:2},revisions:[{...current,version:2},current]};
 const readOnly=historyContent(history,false,{id:'actor-id',display_name:'<reviewer>'});
 assert.doesNotMatch(readOnly,/data-action="review-history"/);
 assert.match(readOnly,/&lt;reviewer&gt;/);assert.match(readOnly,/&lt;reason&gt;/);assert.match(readOnly,/<details/);
 assert.match(historyContent(history,true),/data-action="review-history"/);
 const form=historyForm({version:0,current:null},'2026-01-02');
 assert.match(form,/name="expectedVersion" type="hidden" value="0"/);
 assert.equal((form.match(/value="unknown" selected/g)||[]).length,3);
 assert.match(form,/<option value="">اختر مصدر المراجعة/);
});

test('saved review timestamp uses the selected locale and branch timezone without raw ISO text',()=>{
 const history={version:1,current,revisions:[current]};
 const aden=historyContent(history,false,null,'en','Asia/Aden');
 const utc=historyContent(history,false,null,'en','UTC');
 assert.match(aden,/1:00 PM/);assert.match(utc,/10:00 AM/);
 assert.doesNotMatch(aden,/2026-01-02T10:00:00Z/);
 assert.equal(current.reviewed_at,'2026-01-02T10:00:00Z');
});
