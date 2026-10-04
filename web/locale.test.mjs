import test from 'node:test';
import assert from 'node:assert/strict';
import {getLocale,setLocale,translate,localize,messages} from './locale.mjs';

test('Arabic is primary; English has explicit LTR layout and locale-only persistence',()=>{
 assert.equal(getLocale(),'ar');
 const writes=[];
 globalThis.localStorage={setItem:(key,value)=>writes.push([key,value])};
 globalThis.document={documentElement:{}};
 setLocale('en');
 assert.equal(document.documentElement.lang,'en');
 assert.equal(document.documentElement.dir,'ltr');
 assert.equal(translate('المبلغ المتفق عليه'),'Agreed amount');
 assert.equal(translate('ريال يمني (YER)'),'Yemeni rial (YER)');
 assert.equal(translate('تقويم الأسنان · حالة جديدة'),'Orthodontics · New case');
 assert.deepEqual(writes,[['aqlan.locale','en']]);
 setLocale('ar');
 assert.equal(document.documentElement.dir,'rtl');
 assert.equal(translate('المبلغ المتفق عليه'),'المبلغ المتفق عليه');
});

test('locale rendering preserves clinical content and reverses UI translation',()=>{
 const ui={textContent:'تقويم الأسنان',parentElement:{closest:()=>null}};
 const clinical={textContent:'تقويم الأسنان',parentElement:{closest:()=>({})}};
 const name={textContent:'عقلان الكامل',parentElement:{closest:()=>null}};
 const nodes=[ui,clinical,name];
 globalThis.NodeFilter={SHOW_TEXT:4};
 document.createTreeWalker=()=>{let i=0;return{nextNode:()=>nodes[i++]||null};};
 const root={querySelectorAll:()=>[]};
 setLocale('en');localize(root,new Set(['عقلان الكامل']));
 assert.equal(ui.textContent,'Orthodontics');
 assert.equal(clinical.textContent,'تقويم الأسنان');
 assert.equal(name.textContent,'عقلان الكامل');
 setLocale('ar');localize(root,new Set(['عقلان الكامل']));
 assert.equal(ui.textContent,'تقويم الأسنان');
});

test('current specialties, financial safety labels and intake review have English translations',()=>{
 for(const key of ['طب الأسنان العام','تقويم الأسنان','علاج الجذور','علاج اللثة','التركيبات','زراعة الأسنان','جراحة الفم','أسنان الأطفال','طب الفم والمفصل','الأشعة والتصوير','مراجعة المبالغ السابقة','حفظ المراجعة','تأكيد التحصيل','تأكيد عكس الدفعة']) {
   assert.ok(messages[key],`Missing English label: ${key}`);
   assert.match(messages[key],/[A-Za-z]/);
 }
});

test('inline tooth metadata translates without altering protected procedure text',()=>{
 const procedure={textContent:'تقويم الأسنان',parentElement:{closest:()=>({})}};
 const tooth={textContent:'· السن 11',parentElement:{closest:()=>null}};
 const nodes=[procedure,tooth];
 document.createTreeWalker=()=>{let i=0;return{nextNode:()=>nodes[i++]||null};};
 setLocale('en');localize({querySelectorAll:()=>[]});
 assert.equal(procedure.textContent,'تقويم الأسنان');
 assert.equal(tooth.textContent,'· Tooth 11');
 setLocale('ar');localize({querySelectorAll:()=>[]});
 assert.equal(tooth.textContent,'· السن 11');
});
