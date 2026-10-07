// Copyright (c) 2026 Dr. Aqlan Alkamel. All rights reserved.
// Versioned, manually entered clinical data. No diagnosis or treatment inference.
// Persistence must enforce one baseline per plan and signed-visit immutability.
export const CLINICAL_SCHEMA_VERSION = 1;
export const SPECIALTIES = Object.freeze(['general','orthodontics','endodontics','periodontics','prosthodontics','implantology','surgery','pediatric','oral_medicine','imaging']);
export const PERIODONTAL_SITES = Object.freeze(['mesiobuccal','buccal','distobuccal','mesiolingual','lingual','distolingual']);
function fail(path) { throw new Error(`INVALID_CLINICAL_FIELD:${path}`); }
function object(value, keys, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k=>!keys.includes(k))) fail(path);
  return value;
}
function text(value,path,max=10000) {
  if(typeof value!=='string' || value.length>max) fail(path);
  return value.trim();
}
function required(value,path,max=200) { const v=text(value,path,max); if(!v) fail(path); return v; }
function optionalText(value,path,max=10000) { return value==null ? null : text(value,path,max); }
function array(value,path,limit=200) { if(!Array.isArray(value) || value.length>limit) fail(path); return value; }
function texts(value,path) { return array(value,path).map((v,i)=>required(v,`${path}[${i}]`,2000)); }
function version(value) { if(value!==1) fail('schemaVersion'); return 1; }
function date(value,path) {
  if(value==null) return null;
  if(typeof value!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0,10)!==value) fail(path);
  return value;
}
// Decimal strings preserve exact provider input. NULL is unknown, never zero.
function millimetres(value,path,{signed=false}={}) {
  if(value==null) return null;
  if(typeof value!=='string' || !(signed ? /^-?\d{1,3}(\.\d{1,2})?$/ : /^\d{1,3}(\.\d{1,2})?$/).test(value)) fail(path);
  return value;
}
export function validateTooth(value) {
  if(typeof value!=='string' || !/^([1-4][1-8]|[5-8][1-5])$/.test(value)) fail('tooth');
  return value;
}
function teeth(value,path) {
  const result=array(value,path,52).map(validateTooth);
  if(new Set(result).size!==result.length) fail(path);
  return result;
}
function arch(value,path) {
  object(value,['appliance','notes'],path);
  return {appliance:optionalText(value.appliance,`${path}.appliance`,500),notes:optionalText(value.notes,`${path}.notes`)};
}
function baseline(value) {
  object(value,['upperArch','lowerArch','consentReferences','notes'],'orthodontics');
  return {
    upperArch: value.upperArch==null?null:arch(value.upperArch,'orthodontics.upperArch'),
    lowerArch: value.lowerArch==null?null:arch(value.lowerArch,'orthodontics.lowerArch'),
    consentReferences:texts(value.consentReferences,'orthodontics.consentReferences'),
    notes:optionalText(value.notes,'orthodontics.notes'),
  };
}
export function validateClinicalPlan(input) {
  object(input,['schemaVersion','specialty','problems','objectives','procedures','notes','orthodontics'],'plan');
  version(input.schemaVersion);
  if(!SPECIALTIES.includes(input.specialty)) fail('specialty');
  if(input.orthodontics!=null && input.specialty!=='orthodontics') fail('orthodontics');
  return {
    schemaVersion:1,specialty:input.specialty,
    problems:texts(input.problems,'problems'), objectives:texts(input.objectives,'objectives'),
    procedures:array(input.procedures,'procedures').map((p,i)=>{
      object(p,['name','teeth'],`procedures[${i}]`);
      return {name:required(p.name,`procedures[${i}].name`,500),teeth:teeth(p.teeth,`procedures[${i}].teeth`)};
    }),
    notes:optionalText(input.notes,'notes'),
    orthodontics:input.orthodontics==null?null:baseline(input.orthodontics),
  };
}
function wire(value,path) {
  if(value==null) return null;
  object(value,['material','size','notes'],path);
  return {material:optionalText(value.material,`${path}.material`,200),size:optionalText(value.size,`${path}.size`,200),notes:optionalText(value.notes,`${path}.notes`)};
}
export function validateOrthodonticAdjustment(input) {
  // Complaint, diagnosis, consent and objectives belong to the baseline, not each adjustment.
  object(input,['schemaVersion','upperArchwire','lowerArchwire','elasticInstructions','progress','hygiene','notes','nextAppointment','retention'],'adjustment');
  return {schemaVersion:version(input.schemaVersion),upperArchwire:wire(input.upperArchwire,'upperArchwire'),lowerArchwire:wire(input.lowerArchwire,'lowerArchwire'),
    elasticInstructions:optionalText(input.elasticInstructions,'elasticInstructions'),progress:optionalText(input.progress,'progress'),
    hygiene:optionalText(input.hygiene,'hygiene'),notes:optionalText(input.notes,'notes'),
    nextAppointment:date(input.nextAppointment,'nextAppointment'),retention:optionalText(input.retention,'retention')};
}
export function validateEndodonticCanal(input) {
  object(input,['schemaVersion','tooth','canal','unit','workingLength','measuredLength','referencePoint','notes'],'canal');
  if(input.unit!=='mm') fail('unit');
  return {schemaVersion:version(input.schemaVersion),tooth:validateTooth(input.tooth),canal:required(input.canal,'canal',100),unit:'mm',
    workingLength:millimetres(input.workingLength,'workingLength'),measuredLength:millimetres(input.measuredLength,'measuredLength'),
    referencePoint:optionalText(input.referencePoint,'referencePoint',500),notes:optionalText(input.notes,'notes')};
}
export function validatePeriodontalChart(input) {
  object(input,['schemaVersion','unit','teeth','notes'],'periodontalChart');
  if(input.unit!==undefined && input.unit!=='mm') fail('unit');
  const seen=new Set();
  const records=array(input.teeth,'teeth',52).map((record,i)=>{
    object(record,['tooth','sites'],`teeth[${i}]`);
    const tooth=validateTooth(record.tooth); if(seen.has(tooth)) fail('duplicateTooth'); seen.add(tooth);
    object(record.sites,PERIODONTAL_SITES,`teeth[${i}].sites`);
    const sites={};
    for(const site of PERIODONTAL_SITES) {
      const value=record.sites[site];
      if(value==null) { sites[site]={pocketDepth:null,recession:null,bleeding:null}; continue; }
      object(value,['pocketDepth','recession','bleeding'],`sites.${site}`);
      if(value.bleeding!=null && typeof value.bleeding!=='boolean') fail(`sites.${site}.bleeding`);
      sites[site]={pocketDepth:millimetres(value.pocketDepth,`sites.${site}.pocketDepth`),recession:millimetres(value.recession,`sites.${site}.recession`,{signed:true}),bleeding:value.bleeding??null};
    }
    return {tooth,sites};
  });
  return {schemaVersion:version(input.schemaVersion),unit:'mm',teeth:records,notes:optionalText(input.notes,'notes')};
}
