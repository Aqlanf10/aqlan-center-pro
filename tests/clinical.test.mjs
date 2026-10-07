import test from 'node:test';
import assert from 'node:assert/strict';
import {SPECIALTIES,PERIODONTAL_SITES,validateTooth,validateClinicalPlan,validateOrthodonticAdjustment,validateEndodonticCanal,validatePeriodontalChart} from '../packages/domain/clinical.mjs';

test('all specialties share an explicit clinical plan without inferred diagnoses',()=>{
  for(const specialty of SPECIALTIES) {
    const result=validateClinicalPlan({schemaVersion:1,specialty,problems:[],objectives:[],procedures:[],notes:null});
    assert.deepEqual(result.problems,[]); assert.equal(result.notes,null);
  }
  assert.throws(()=>validateClinicalPlan({schemaVersion:2,specialty:'general',problems:[],objectives:[],procedures:[]}),/schemaVersion/);
});
test('FDI accepts complete permanent and deciduous dentitions and rejects invalid identities',()=>{
  for(let quadrant=1;quadrant<=8;quadrant++) for(let n=1;n<=(quadrant<=4?8:5);n++) assert.equal(validateTooth(`${quadrant}${n}`),`${quadrant}${n}`);
  for(const bad of ['19','56','00','91','1','111',11,null]) assert.throws(()=>validateTooth(bad),/tooth/);
  assert.throws(()=>validateClinicalPlan({schemaVersion:1,specialty:'general',problems:[],objectives:[],procedures:[{name:'Manual provider entry',teeth:['11','11']}]}),/teeth/);
});
test('orthodontic baseline and adjustment data remain separate and do not repeat diagnosis',()=>{
  const baseline=validateClinicalPlan({schemaVersion:1,specialty:'orthodontics',problems:['Provider problem'],objectives:['Provider objective'],procedures:[],orthodontics:{upperArch:{appliance:'Provider appliance'},lowerArch:null,consentReferences:['document-42']}});
  assert.equal(baseline.orthodontics.lowerArch,null);
  assert.deepEqual(baseline.orthodontics.consentReferences,['document-42']);
  const adjustment=validateOrthodonticAdjustment({schemaVersion:1,upperArchwire:{material:'Provider material',size:'Provider size'},progress:'Provider observation',nextAppointment:'2026-10-20'});
  assert.equal(adjustment.lowerArchwire,null); assert.equal(adjustment.hygiene,null);
  assert.throws(()=>validateOrthodonticAdjustment({...adjustment,diagnosis:'Repeated baseline'}),/adjustment/);
  assert.throws(()=>validateOrthodonticAdjustment({schemaVersion:1,nextAppointment:'2026-02-30'}),/nextAppointment/);
  assert.throws(()=>validateClinicalPlan({...baseline,specialty:'endodontics'}),/orthodontics/);
});
test('endodontic measurements require exact decimal strings and mm with unknown retained',()=>{
  const input={schemaVersion:1,tooth:'16',canal:'MB',unit:'mm',workingLength:'20.50',measuredLength:null};
  const output=validateEndodonticCanal(input);
  assert.equal(output.workingLength,'20.50'); assert.equal(output.measuredLength,null);
  for(const workingLength of [20.5,'-1','NaN','Infinity','20.555']) assert.throws(()=>validateEndodonticCanal({...input,workingLength}),/workingLength/);
  assert.throws(()=>validateEndodonticCanal({...input,unit:'cm'}),/unit/);
});
test('periodontal six-site chart preserves unknown independently from false and zero',()=>{
  const result=validatePeriodontalChart({schemaVersion:1,teeth:[{tooth:'11',sites:{mesiobuccal:{pocketDepth:'3',recession:'-1.5',bleeding:false},buccal:{pocketDepth:null,recession:'0',bleeding:null}}}]});
  const sites=result.teeth[0].sites;
  assert.deepEqual(Object.keys(sites),PERIODONTAL_SITES);
  assert.deepEqual(sites.mesiobuccal,{pocketDepth:'3',recession:'-1.5',bleeding:false});
  assert.deepEqual(sites.buccal,{pocketDepth:null,recession:'0',bleeding:null});
  assert.deepEqual(sites.distobuccal,{pocketDepth:null,recession:null,bleeding:null});
  assert.equal(Object.hasOwn(result,'healthy'),false);
  assert.deepEqual(validatePeriodontalChart(result),result);
  assert.throws(()=>validatePeriodontalChart({schemaVersion:1,teeth:[{tooth:'11',sites:{buccal:{bleeding:'false'}}}]}),/bleeding/);
  assert.throws(()=>validatePeriodontalChart({schemaVersion:1,teeth:[{tooth:'11',sites:{}},{tooth:'11',sites:{}}]}),/duplicateTooth/);
});
