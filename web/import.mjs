// Copyright (c) 2026 Dr. Aqlan Alkamel. All rights reserved.
// Legacy archive import screen (IMP-01..04). The server is the only parser:
// this page sends raw bytes and shows the verdicts. No automatic identity
// merge, no invented amounts, per-currency totals only, and money moves only
// after an explicit human approval per batch.
const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const state = { user: null, branches: [], branch: null, specialties: [], batches: [], batch: null, rows: [], rowStatus: '', offset: 0, limit: 200, parsed: null, file: null, currencyMap: [], attach: new Map() };

const FIELD_LABELS = {
  sourceRecordId: 'معرف المصدر *', fullName: 'اسم المريض *', currency: 'العملة *', agreed: 'المتفق عليه',
  previouslyPaid: 'المدفوع سابقا', remaining: 'المتبقي', fileNumber: 'رقم الملف (مرجع)', phone: 'الهاتف',
};
const REQUIRED_FIELDS = ['sourceRecordId', 'fullName', 'currency'];
const STATUS_NAMES = { staged: 'جاهز للاعتماد', needs_evidence: 'يحتاج إثباتا', rejected: 'مرفوض', imported: 'مستورد', failed: 'فاشل' };
const STATUS_CLASS = { staged: 'ok', needs_evidence: 'warn', rejected: 'bad', imported: 'done', failed: 'bad' };
const ERROR_NAMES = {
  INVALID_STAGE_INPUT: 'إعدادات الاستيراد غير صحيحة.', UNKNOWN_SPECIALTY: 'التخصص المختار غير معرّف.',
  FUTURE_OPENING_DATE: 'تاريخ الكشف لا يمكن أن يكون مستقبليا.', BATCH_NOT_FOUND: 'الدفعة غير موجودة.',
  BATCH_NOT_ACTIVE: 'الدفعة لم تعد نشطة.', FILE_ALREADY_KNOWN: 'بصمة الملف مسجلة سابقا في هذا الفرع.',
  INVALID_DECISIONS: 'قرارات الاعتماد غير صحيحة.', ROW_NOT_FOUND: 'صف الاستيراد غير موجود.',
  ROW_REJECTED: 'الصفوف المرفوضة لا يمكن اعتمادها أبدا.', EVIDENCE_REQUIRED: 'المبالغ غير المعروفة تحتاج مراجعة إثبات أولا.',
  ROW_ALREADY_IMPORTED: 'هذا الصف مستورد سابقا.', ROW_FAILED: 'فشل هذا الصف؛ راجع تقرير الاستثناء.',
  ATTACH_PATIENT_NOT_FOUND: 'المريض المرفق غير موجود في هذا الفرع.', SOURCE_ALREADY_KNOWN: 'هوية المصدر والعملة معروفتان سابقا.',
  IMPORT_FAILED: 'فشل غير متوقع؛ راجع السجل.', INVALID_CSV: 'صياغة اقتباس CSV غير صحيحة.',
  FILE_LIMIT: 'الملف يتجاوز حد الحجم (5MB).', ROW_LIMIT: 'الملف يتجاوز حد الصفوف (10000).',
  COLUMN_LIMIT: 'الصف يتجاوز حد الأعمدة (64).', CELL_LIMIT: 'خلية تتجاوز طول النص المسموح.',
  INVALID_OPTIONS: 'إعدادات صريحة غير صحيحة.', EMPTY_FILE: 'الملف لا يحتوي صفوف بيانات.',
  INVALID_HEADERS: 'الأعمدة المحددة مفقودة أو مكررة أو ملتبسة.', NETWORK_ERROR: 'تعذر الاتصال بالخادم.',
  BODY_TOO_LARGE: 'حجم الطلب يتجاوز الحد المسموح.', INVALID_WORKBOOK: 'الملف ليس مصنفا XLSX قابلا للقراءة.',
  FILE_READ_FAILED: 'تعذرت قراءة الملف من الجهاز.',
};
const errorText = e => ERROR_NAMES[e?.code || e?.message] || 'حدث خطأ غير متوقع. حاول مرة أخرى.';

function notify(message, bad = false) {
  const el = document.createElement('div');
  el.className = `note ${bad ? 'bad' : 'ok'}`;
  el.textContent = message;
  $('#notifications').append(el);
  setTimeout(() => el.remove(), bad ? 8000 : 4000);
}
async function api(path, body, rawBody) {
  let r;
  try {
    r = await fetch(path, {
      method: body === undefined && !rawBody ? 'GET' : 'POST', credentials: 'same-origin',
      headers: body === undefined && !rawBody ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined && !rawBody ? undefined : JSON.stringify(rawBody ?? body),
    });
  } catch { throw Object.assign(new Error('NETWORK_ERROR'), { code: 'NETWORK_ERROR' }); }
  const data = await r.json().catch(() => { throw Object.assign(new Error('INVALID_RESPONSE'), { code: 'INVALID_RESPONSE' }); });
  if (!r.ok) throw Object.assign(new Error(data.error || 'REQUEST_FAILED'), { code: data.error || 'REQUEST_FAILED' });
  return data;
}
const base = () => `/api/branches/${state.branch.id}/imports`;

const todayAden = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Aden' }).format(new Date());
async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function sha256Bytes(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function base64Of(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}
function readCSV(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(Object.assign(new Error('FILE_READ_FAILED'), { code: 'FILE_READ_FAILED' }));
    reader.readAsText(file, 'utf-8');
  });
}

function renderShell(content) {
  $('#app').innerHTML = `<div class="shell"><aside class="sidebar"><div class="brand"><strong>عقلان سنتر برو</strong><small>استيراد الأرشيف من الأنظمة السابقة</small></div><p class="nav-label">الفرع</p><label><span class="sr-only">الفرع الحالي</span><select id="branch-select" aria-label="الفرع الحالي">${state.branches.map(b => `<option value="${esc(b.id)}" ${b.id === state.branch?.id ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select></label><nav class="nav" aria-label="روابط"><a href="/">→ العودة إلى مساحة العمل</a></nav><div class="side-foot">لا دمج تلقائي للهويات<br>لا اعتماد دون مراجعة بشرية</div></aside><div class="main-wrap"><header class="topbar"><div class="identity"><span class="avatar" aria-hidden="true">${esc(state.user.display_name?.slice(0, 1) || 'ع')}</span><div>${esc(state.user.display_name)}<small>مشغل استيراد</small></div></div></header><main id="main" class="content" tabindex="-1">${content}</main></div></div>`;
  $('#branch-select').addEventListener('change', async e => {
    state.branch = state.branches.find(b => b.id === e.target.value);
    state.batch = null; state.offset = 0; state.rowStatus = '';
    await Promise.all([renderBatches(), renderIntro()]);
  });
}

function wizardHidden() {
  return `<section class="card" id="wizard" hidden>
    <div class="section-head"><h2>استيراد دفعة جديدة</h2><button type="button" class="quiet" data-action="close-wizard">إلغاء</button></div>
    <form id="upload-form">
      <div class="grid cols">
        <label>النظام المصدر<select name="sourceSystem"><option value="desktop">برنامج المكتبي</option><option value="mini">Mini</option><option value="paper">أرشيف ورقي مُرقمن</option></select></label>
        <label>التخصص الافتراضي للخطط<select name="defaultSpecialty">${state.specialties.map(s => `<option value="${esc(s.code)}">${esc(s.name_ar)}</option>`).join('')}</select></label>
        <label>تاريخ كشف الافتتاحي<input type="date" name="asOfDate" required></label>
        <label>الفاصل<select name="delimiter"><option value=",">فاصلة ,</option><option value=";">فاصلة منقوطة ;</option><option value="\t">Tab</option></select></label>
      </div>
      <label class="file-label">ملف CSV أو XLSX (بحد 5MB و10000 صف)<input type="file" name="file" accept=".csv,.txt,.xlsx,text/csv,text/plain,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required></label>
      <button class="button primary" type="submit">قراءة العناوين والعينات ←</button>
    </form>
    <form id="map-form" hidden>
      <p class="muted">اربط كل حقل بعمود من الملف. العمود مأخوذ من قراءة الخادم للعناوين الفعلية، والعينة من أول صف بيانات.</p>
      <div id="map-fields" class="map-fields"></div>
      <h3 class="space-top">خريطة العملات</h3>
      <p class="muted">لكل قيمة عملة في ملفك مصدرها، اختر العملة المعتمدة. القيم بدون ربط تُرفض.</p>
      <div id="currency-map" class="currency-map"></div>
      <div class="actions"><button class="button" type="button" data-action="add-currency">+ إضافة قيمة عملة</button><button class="button primary" type="submit">تجهيز الدفعة للمعاينة ←</button></div>
    </form>
  </section>`;
}

function renderIntro() {
  const canWrite = state.branches.length > 0;
  $('#intro').innerHTML = `<div class="page-head"><div><p class="eyebrow">التهيئة المُرحَّلة</p><h1>استيراد الأرشيف</h1><p class="muted">${esc(state.branch?.name || '')} · معاينة واعتماد واستئناف وتقرير استثناء — دون تحريك أي مبلغ قبل الاعتماد.</p></div>${canWrite ? '<button class="button primary" data-action="open-wizard">+ استيراد دفعة جديدة</button>' : ''}</div>
  <div class="banner">التسلسل: ارفع ملف CSV أو XLSX → اربط الأعمدة بالعينات الفعلية → راجع الحكم لكل صف (جاهز/يحتاج إثباتا/مرفوض) → اعتمد. الملفات المرفوعة تُحجب ببصمتها، وهويات المصدر المعروفة تُرفض تلقائيا لمنع التكرار (MIG-04)، ومرشحو الهوية (رقم الملف/الهاتف) يُعرضون للتأكيد دون دمج تلقائي (MIG-03).</div>`;
}

async function renderBatches() {
  const data = await api(base());
  state.batches = data.batches;
  $('#batches').innerHTML = `<section class="card"><div class="section-head"><h2>الدفعات المُرحَّلة</h2><small>${state.batches.length} دفعة كحد أقصى 50</small></div>${state.batches.length ? `<div class="table-wrap"><table><thead><tr><th>الملف</th><th>المصدر</th><th>الحالة</th><th>الصفوف</th><th>جاهز/إثبات/مرفوض</th><th>مستورد</th><th>تاريخ الكشف</th><th></th></tr></thead><tbody>${state.batches.map(b => `<tr class="${state.batch?.id === b.id ? 'current' : ''}"><td>${esc(b.file_name)}</td><td>${esc({ desktop: 'المكتبي', mini: 'Mini', paper: 'ورقي' }[b.source_system] || b.source_system)}</td><td><span class="chip ${b.status === 'approved' ? 'done' : b.status === 'cancelled' ? 'bad' : 'ok'}">${b.status === 'approved' ? 'معتمدة' : b.status === 'cancelled' ? 'ملغاة' : 'قيد المعالجة'}</span></td><td>${b.row_count}</td><td>${b.staged_rows} / ${b.evidence_rows} / ${b.rejected_rows}</td><td>${b.imported_rows}</td><td>${esc(b.as_of_date)}</td><td><button class="button small" data-action="open-batch" data-id="${esc(b.id)}">فتح</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">لا توجد دفعات بعد. ابدأ باستيراد دفعة جديدة.</p>'}</section>`;
}

function currencyRow([token, code] = ['', 'SAR']) {
  return `<div class="currency-row"><input placeholder="قيمة العملة في الملف (مثال: سعودي)" maxlength="100" data-token value="${esc(token)}"><select data-code>${['YER', 'SAR', 'USD'].map(c => `<option value="${c}" ${c === code ? 'selected' : ''}>${c}</option>`).join('')}</select><button type="button" class="quiet" data-action="remove-currency">حذف</button></div>`;
}

async function handleUpload(e) {
  e.preventDefault();
  const form = e.target;
  const file = form.elements.file.files[0];
  if (!file) return;
  const isXlsx = /\.xlsx$/i.test(file.name) || file.type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  let parsed, fileState;
  if (isXlsx) {
    const buffer = await file.arrayBuffer();
    if (buffer.byteLength > 5 * 1024 * 1024) return notify(ERROR_NAMES.FILE_LIMIT, true);
    const dataBase64 = base64Of(buffer);
    parsed = await api(`${base()}/parse`, { format: 'xlsx', dataBase64 });
    fileState = { name: file.name.slice(0, 200), hash: await sha256Bytes(buffer), format: 'xlsx', dataBase64 };
  } else {
    const csv = await readCSV(file);
    if (csv.length > 5 * 1024 * 1024) return notify(ERROR_NAMES.FILE_LIMIT, true);
    parsed = await api(`${base()}/parse`, { csv, delimiter: form.elements.delimiter.value });
    fileState = { name: file.name.slice(0, 200), hash: await sha256(csv), format: 'csv', csv, delimiter: form.elements.delimiter.value };
  }
  state.file = fileState;
  state.parsed = parsed;
  $('#map-fields').innerHTML = Object.entries(FIELD_LABELS).map(([field, label]) => `
    <div class="map-row"><label><strong>${esc(label)}</strong><select data-field="${field}"><option value="">— لا ربط —</option>${parsed.headers.map((h, i) => `<option value="${i}">${esc(h)} — عينة: ${esc(parsed.samples[0]?.[i] ?? '')}</option>`).join('')}</select></label></div>`).join('');
  // Best-effort preselect: match canonical header names and their Arabic equivalents.
  const presets = { sourceRecordId: ['sourceRecordId', 'معرف المصدر', 'id'], fullName: ['fullName', 'اسم المريض', 'name'], currency: ['currency', 'العملة'], agreed: ['agreed', 'المتفق عليه'], previouslyPaid: ['previouslyPaid', 'المدفوع سابقا'], remaining: ['remaining', 'المتبقي'], fileNumber: ['fileNumber', 'رقم الملف'], phone: ['phone', 'الهاتف'] };
  for (const [field, names] of Object.entries(presets)) {
    const index = parsed.headers.findIndex(h => names.includes(h));
    if (index >= 0) $(`#map-fields select[data-field="${field}"]`).value = String(index);
  }
  const sampleTokens = [...new Set(parsed.samples.map(row => row[parsed.headers.findIndex(h => ['currency', 'العملة'].includes(h))]).filter(v => v && !['YER', 'SAR', 'USD'].includes(v)))].slice(0, 3);
  state.currencyMap = sampleTokens.map(token => [token, 'SAR']);
  $('#currency-map').innerHTML = state.currencyMap.map(currencyRow).join('') || currencyRow();
  $('#map-form').hidden = false;
  $('#map-form').scrollIntoView({ behavior: 'smooth' });
}

function renderPreview() {
  // The stored per-currency summary persists the domain preview verbatim.
  const perCurrency = Object.entries(state.batch.per_currency || {}).filter(([, b]) => b.rowCount);
  $('#detail-head').innerHTML = `<div class="page-head"><div><p class="eyebrow">معاينة الدفعة</p><h1>${esc(state.batch.file_name)}</h1><p class="muted">${esc({ desktop: 'المكتبي', mini: 'Mini', paper: 'ورقي' }[state.batch.source_system] || state.batch.source_system)} · كشف ${esc(state.batch.as_of_date)} · ${state.batch.row_count} صف</p></div><div class="actions">${state.batch.status === 'staged' ? `<button class="button primary" data-action="approve">اعتماد الصفوف الجاهزة (${state.batch.staged_rows})</button><button class="button" data-action="cancel-batch">إلغاء الدفعة</button>` : `<span class="chip ${state.batch.status === 'approved' ? 'done' : 'bad'}">${state.batch.status === 'approved' ? 'معتمدة بالكامل' : 'ملغاة'}</span>`}</div></div>
  <div class="grid stats">${perCurrency.map(([code, b]) => `<article class="card stat"><span class="stat-label">${code}</span><strong class="stat-value">${b.openingReceivable}</strong><small>ذمم افتتاحية · ${b.rowCount} صف${b.unknownFinanceCount ? ` · ${b.unknownFinanceCount} بمبالغ غير معروفة` : ''}${b.historicalCredit !== '0.00' ? ` · رصيد دائن ${b.historicalCredit}` : ''}</small></article>`).join('')}</div>`;
  const filters = ['', 'staged', 'needs_evidence', 'rejected', 'imported', 'failed'];
  $('#row-filters').innerHTML = filters.map(f => `<button class="tab ${state.rowStatus === f ? 'active' : ''}" data-action="filter" data-id="${f}">${f === '' ? 'الكل' : STATUS_NAMES[f]}</button>`).join('');
}

function rowsTable() {
  return `<div class="table-wrap"><table><thead><tr><th>#</th><th>الاسم</th><th>معرف المصدر</th><th>العملة</th><th>المتفق</th><th>المدفوع</th><th>الحالة</th><th>الملاحظات</th></tr></thead><tbody>
  ${state.rows.map(r => {
    const issues = [...(r.issues || [])].map(i => `<div class="issue ${i.severity === 'error' ? 'bad' : 'warn'}">${esc(i.messageAr)}</div>`);
    if (r.error_code) issues.push(`<div class="issue bad">${esc(ERROR_NAMES[r.error_code] || r.error_code)}</div>`);
    const attach = state.attach.get(r.id);
    const candidates = (r.candidates || []).filter(c => c && c.patientId);
    if (candidates.length && r.status === 'staged') issues.push(`<div class="attach-candidates">${candidates.map(c => `<button class="button small" data-action="choose-attach" data-id="${esc(r.id)}" data-pid="${esc(c.patientId)}" data-name="${esc(c.fullName || c.patientId)}">مرشح: ${esc(c.fullName || c.patientId)} (${c.matchedBy === 'phone' ? 'هاتف' : 'ملف'})</button>`).join('')}</div>`);
    return `<tr><td>${r.line}</td><td>${esc(r.full_name)}</td><td>${esc(r.data?.sourceRecordId || '')}</td><td>${esc(r.currency || '—')}</td><td>${esc(r.agreed ?? '؟')}</td><td>${esc(r.previously_paid ?? '؟')}</td><td><span class="chip ${STATUS_CLASS[r.status]}">${STATUS_NAMES[r.status]}</span></td><td class="issues">${issues.join('') || '—'}${r.status === 'staged' ? `<details class="attach"><summary>ربط بمريض قائم</summary><div class="attach-body" data-row="${esc(r.id)}">${attach ? `<p>سيُربط بـ: <b>${esc(attach.full_name)}</b> <button class="quiet" data-action="clear-attach" data-id="${esc(r.id)}">إلغاء الربط</button></p>` : `<div class="searchbar"><input maxlength="100" placeholder="ابحث بالاسم أو الهاتف…" data-search="${esc(r.id)}"><button class="button small" data-action="search-patient" data-id="${esc(r.id)}">بحث</button></div><div class="attach-results" data-results="${esc(r.id)}"></div>`}</div></details>` : ''}</td></tr>`;
  }).join('')}</tbody></table></div>
  ${state.rows.length === state.limit ? `<button class="button" data-action="more">عرض المزيد</button>` : ''}`;
}

async function openBatch(id) {
  state.batch = state.batches.find(b => b.id === id) || null;
  state.offset = 0; state.rowStatus = ''; state.attach = new Map();
  const data = await api(`${base()}/${id}?limit=${state.limit}&offset=0`);
  state.batch = data.batch; state.rows = data.rows;
  $('#batch-detail').hidden = false;
  renderPreview();
  $('#rows').innerHTML = rowsTable();
  $('#batch-detail').scrollIntoView({ behavior: 'smooth' });
}
async function reloadRows() {
  const statusParam = state.rowStatus ? `&status=${state.rowStatus}` : '';
  const data = await api(`${base()}/${state.batch.id}?limit=${state.limit}&offset=${state.offset}${statusParam}`);
  state.batch = data.batch; state.rows = data.rows;
  renderPreview(); $('#rows').innerHTML = rowsTable();
}
async function searchPatient(rowId, query) {
  const data = await api(`/api/branches/${state.branch.id}/patients?q=${encodeURIComponent(query)}`);
  $(`[data-results="${rowId}"]`).innerHTML = data.patients.slice(0, 5).map(p => `<button class="button small" data-action="choose-attach" data-id="${esc(rowId)}" data-pid="${esc(p.id)}" data-name="${esc(p.full_name)}">${esc(p.full_name)} — ${esc(String(p.file_number ?? ''))}</button>`).join('') || '<p class="muted">لا نتائج.</p>';
}

document.addEventListener('click', async e => {
  const button = e.target.closest('[data-action]');
  if (!button) return;
  const action = button.dataset.action, id = button.dataset.id;
  try {
    if (action === 'open-wizard') { $('#wizard').hidden = false; $('#wizard').scrollIntoView({ behavior: 'smooth' }); }
    else if (action === 'close-wizard') { $('#wizard').hidden = true; $('#map-form').hidden = true; }
    else if (action === 'add-currency') { $('#currency-map').insertAdjacentHTML('beforeend', currencyRow()); }
    else if (action === 'remove-currency') { button.closest('.currency-row').remove(); }
    else if (action === 'open-batch') await openBatch(id);
    else if (action === 'filter') { state.rowStatus = id; state.offset = 0; await reloadRows(); }
    else if (action === 'more') { state.offset += state.limit; await reloadRows(); }
    else if (action === 'search-patient') { const query = $(`[data-search="${id}"]`).value.trim(); if (query) await searchPatient(id, query); }
    else if (action === 'choose-attach') { state.attach.set(id, { id: button.dataset.pid, full_name: button.dataset.name }); await reloadRows(); }
    else if (action === 'clear-attach') { state.attach.delete(id); await reloadRows(); }
    else if (action === 'cancel-batch') {
      if (!confirm('إلغاء الدفعة يفك حجز بصمة الملف ويسمح بإعادة رفعها. متابعة؟')) return;
      await api(`${base()}/${state.batch.id}/cancel`, {});
      notify('أُلغيت الدفعة.');
      await renderBatches(); await openBatch(state.batch.id);
    } else if (action === 'approve') {
      const stagedRows = state.rows.filter(r => r.status === 'staged');
      if (!stagedRows.length) return notify('لا صفوف جاهزة للاعتماد في العرض الحالي.', true);
      if (!confirm(`اعتماد ${stagedRows.length} صفًا سيُنشئ مرضى وخطط افتتاحية وقيود يومية. متابعة؟`)) return;
      const decisions = stagedRows.map(r => ({ rowId: r.id, ...(state.attach.get(r.id) ? { attachPatientId: state.attach.get(r.id).id } : {}) }));
      const result = await api(`${base()}/${state.batch.id}/approve`, { decisions });
      notify(`استُورد ${result.imported} صفًا${result.failed ? `، وفشل ${result.failed}` : ''}.`);
      if (result.failedRows?.length) console.warn('failed rows', result.failedRows);
      await renderBatches(); state.offset = 0; await reloadRows();
    }
  } catch (err) { notify(errorText(err), true); }
});

document.addEventListener('submit', async e => {
  try {
    if (e.target.id === 'upload-form') return await handleUpload(e);
    if (e.target.id === 'map-form') {
      e.preventDefault();
      const headerMap = {};
      for (const select of $('#map-fields').querySelectorAll('select')) {
        if (select.value !== '') headerMap[select.dataset.field] = state.parsed.headers[Number(select.value)];
      }
      for (const field of REQUIRED_FIELDS) if (!headerMap[field]) return notify(`حقل إجباري غير مربوط: ${FIELD_LABELS[field]}`, true);
      const currencyMap = {};
      for (const row of $('#currency-map').querySelectorAll('.currency-row')) {
        const token = row.querySelector('[data-token]').value.trim(), code = row.querySelector('[data-code]').value;
        if (token) {
          if (currencyMap[token]) return notify(`قيمة عملة مكررة: ${token}`, true);
          currencyMap[token] = code;
        }
      }
      const fd = $('#upload-form').elements;
      const filePayload = state.file.format === 'xlsx'
        ? { format: 'xlsx', dataBase64: state.file.dataBase64 }
        : { format: 'csv', csv: state.file.csv, delimiter: state.file.delimiter };
      const staged = await api(base(), {
        sourceSystem: fd.sourceSystem.value, fileName: state.file.name, fileHash: state.file.hash,
        headerMap, currencyMap, defaultSpecialty: fd.defaultSpecialty.value, asOfDate: fd.asOfDate.value,
        ...filePayload,
      });
      notify(`جهزت الدفعة: ${staged.summary.totalRows} صف (${staged.summary.rejectedRows} مرفوض).`);
      $('#wizard').hidden = true; $('#map-form').hidden = true; $('#upload-form').reset(); $('#map-form').reset();
      // form.reset() clears the boot-filled statement date, which would silently
      // block the next submission on HTML5 validation — restore it.
      const dateInput = $('#upload-form').elements.asOfDate;
      dateInput.max = todayAden(); dateInput.value = todayAden();
      state.offset = 0; state.rowStatus = '';
      await renderBatches();
      await openBatch(staged.batchId);
    }
  } catch (err) { notify(errorText(err), true); }
});

(async function boot() {
  try {
    const me = await api('/api/me');
    state.user = me.user;
  } catch {
    $('#main').className = 'import-page';
    $('#main').innerHTML = '<section class="card"><h1>جلسة مطلوبة</h1><p class="muted">هذه الشاشة للمشغلين المصرح لهم. سجّل الدخول من مساحة العمل أولا.</p><a class="button primary" href="/">الذهاب لتسجيل الدخول</a></section>';
    return;
  }
  const [branches, specialties] = await Promise.all([api('/api/branches'), api('/api/specialties')]);
  state.branches = branches.branches; state.specialties = specialties.specialties;
  if (!state.branches.length) { renderShell('<section class="card"><h1>لا يوجد فرع متاح</h1><p class="muted">اطلب من مسؤول النظام تعيين عضويتك في أحد الفروع.</p></section>'); return; }
  state.branch = state.branches[0];
  renderShell(`<div id="intro"></div>${wizardHidden()}<div id="batches"></div><section class="card" id="batch-detail" hidden><div id="detail-head"></div><nav class="tabs" id="row-filters" aria-label="تصفية الحالة"></nav><div id="rows"></div></section>`);
  await Promise.all([renderBatches(), renderIntro()]);
  const dateInput = $('#upload-form').elements.asOfDate;
  dateInput.max = todayAden(); dateInput.value = todayAden();
})().catch(err => { $('#main').className = 'import-page'; $('#main').innerHTML = `<section class="card"><h1>تعذر تحميل الشاشة</h1><p class="muted">${esc(errorText(err))}</p></section>`; });
