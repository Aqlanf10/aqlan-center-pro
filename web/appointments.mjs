// Copyright (c) 2026 Dr. Aqlan Alkamel. All rights reserved.
// Reception module: appointments schedule, waiting queue, public requests and
// lounge configuration (BOOK-01/02, FLOW-02, LOUNGE-01..03). Mounted by app.mjs
// for users holding appointment.write; actions run through the same command API.
const pad = n => String(n).padStart(2, '0');
const minuteToTime = m => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const timeToMinute = t => { const [h, m] = String(t).split(':').map(Number); return h * 60 + (m || 0); };
const KINDS = { consultation: 'استشارة', treatment: 'علاج', follow_up: 'متابعة' };
const APPT_STATUS = { booked: 'محجوز', cancelled: 'ملغى', no_show: 'لم يحضر', completed: 'مكتمل' };
const ARRIVAL_STATUS = { waiting: 'في الانتظار', called: 'تم النداء', in_chair: 'على الكرسي', done: 'منجز', left: 'انصرف' };
const DAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

export function mountAppointments(root, ctx) {
  const { api, can, notify, errorText, esc, dialog, branch, specialties, today } = ctx;
  const state = { tab: 'schedule', date: today(), loaded: '', appointments: [], arrivals: [], requests: [], config: null };
  const base = () => `/api/branches/${branch().id}`;
  const s = v => esc(v ?? '—');

  function openModal(title, bodyHtml, onSubmit, submitLabel = 'حفظ') {
    dialog.innerHTML = `<div class="modal-head"><h2 id="modal-title">${title}</h2><button class="close" type="button" data-action="close-modal" aria-label="إغلاق">×</button></div>
    <form id="appointment-form" class="modal-body"><div class="error" id="appointment-form-error" role="alert"></div>${bodyHtml}
    <div class="modal-foot"><button class="button" type="button" data-action="close-modal">إلغاء</button><button class="button primary" type="submit">${submitLabel}</button></div></form>`;
    dialog.showModal();
    dialog.querySelector('#appointment-form').addEventListener('submit', async event => {
      event.preventDefault();
      const form = event.currentTarget;
      const fields = Object.fromEntries(new FormData(form));
      const submit = form.querySelector('[type=submit]');
      submit.disabled = true;
      try { await onSubmit(fields); dialog.close(); notify('تم الحفظ بنجاح.'); await refresh(); }
      catch (e) { dialog.querySelector('#appointment-form-error').textContent = errorText(e); submit.disabled = false; }
    });
  }
  async function run(command, payload) {
    return api(`${base()}/commands`, { key: crypto.randomUUID(), command, payload });
  }
  async function refresh() {
    const b = base(), date = state.date, tag = `${branch().id}|${date}|${state.tab}`;
    const loads = {
      schedule: async () => { state.appointments = (await api(`${b}/appointments?date=${date}`)).appointments; },
      queue: async () => { state.arrivals = (await api(`${b}/arrivals?date=${date}`)).arrivals; },
      requests: async () => { state.requests = (await api(`${b}/appointment-requests`)).requests; },
      lounge: async () => { state.config = await api(`${b}/schedule-config`); }
    };
    await loads[state.tab]();
    if (state.loaded !== tag) { state.loaded = tag; }
    render();
  }
  const branchDay = () => new Intl.DateTimeFormat('en-CA', { timeZone: branch().timezone || 'Asia/Aden', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

  function bookForm(request = null) {
    const cfg = state.config || { chairs: [], doctors: [] };
    const patients = (ctx.patients() || []).slice(0, 100);
    openModal(request ? 'حجز من طلب إلكتروني' : 'حجز موعد', `
      ${request ? `<div class="preview">طلب من: <strong>${s(request.full_name)}</strong> · ${s(request.phone)} · التاريخ المفضل ${s(request.preferred_date)}</div>` : ''}
      ${request ? '' : `<label class="field"><span>المريض</span><input name="patientName" list="appointment-patients" required placeholder="ابحث بالاسم أو الهاتف واختر الملف"><datalist id="appointment-patients">${patients.map(p => `<option value="${s(p.id)}">${s(p.full_name)}${p.phone ? ' — ' + s(p.phone) : ''}</option>`).join('')}</datalist><small>إن لم يكن للمريض ملف بعد، سجّله أولًا من صفحة ملفات المرضى.</small></label>`}
      <div class="form-grid">
      <label class="field"><span>الطبيب</span><select name="doctorId" required>${cfg.doctors.map(d => `<option translate="no" value="${s(d.id)}">${s(d.name)}</option>`).join('')}</select></label>
      <label class="field"><span>الكرسي / الغرفة</span><select name="chairId" required>${cfg.chairs.filter(c => c.active).map(c => `<option translate="no" value="${s(c.id)}">${s(c.name)}${c.room ? ' — ' + s(c.room) : ''}</option>`).join('') || '<option value="" disabled>أضف كرسيًا من تبويب إعداد الصالة أولًا</option>'}</select></label>
      ${request ? '<input type="hidden" name="patientId" value="">' : ''}
      <label class="field"><span>التخصص</span><select name="specialty" required>${specialties().map(x => `<option value="${s(x.code)}" ${request && request.specialty === x.code ? 'selected' : ''}>${s(x.name_ar)}</option>`).join('')}</select></label>
      <label class="field"><span>نوع الموعد</span><select name="kind"><option value="consultation">استشارة</option><option value="treatment">علاج</option><option value="follow_up">متابعة</option></select></label>
      <label class="field"><span>التاريخ</span><input type="date" name="date" required min="${today()}" value="${s(request?.preferred_date || state.date)}"></label>
      <label class="field"><span>الوقت</span><input type="time" name="time" required step="300" value="10:00"></label>
      <label class="field"><span>المدة (دقيقة)</span><select name="duration">${[15, 20, 30, 45, 60, 90, 120].map(d => `<option value="${d}" ${d === 30 ? 'selected' : ''}>${d} دقيقة</option>`).join('')}</select></label>
      </div>
      <div class="banner">يُمنع التعارض على الخادم: لا يستقبل الكرسي أو الطبيب موعدين متزامنين. الطلب الإلكتروني لا يُعدّ حجزًا مؤكدًا قبل هذا الحجز.</div>`,
      async fields => {
        let patientId = fields.patientId;
        if (!request) {
          patientId = (fields.patientName || '').trim();
          if (!patients.some(p => p.id === patientId)) throw Object.assign(new Error('INVALID_PATIENT_PICK'), { code: 'INVALID_PATIENT_PICK' });
        } else patientId = await ensureRequestPatient(request);
        await run('appointment.book', {
          patientId, doctorId: fields.doctorId, chairId: fields.chairId, specialty: fields.specialty,
          date: fields.date, minute: String(timeToMinute(fields.time)), duration: fields.duration,
          kind: fields.kind, ...(request ? { requestId: request.id } : {})
        });
      }, 'تأكيد الحجز');
  }
  async function ensureRequestPatient(request) {
    const found = await api(`${base()}/patients?q=${encodeURIComponent(request.phone)}`);
    const match = found.patients.find(p => p.phone && p.phone.replace(/[\s\-]/g, '') === request.phone);
    if (match) return match.id;
    const created = await run('patient.create', { fullName: request.full_name, phone: request.phone });
    return created.id;
  }
  function rescheduleForm(row) {
    openModal('تعديل الموعد', `<input type="hidden" name="expectedVersion" value="${s(row.version)}">
      <div class="form-grid">
      <label class="field"><span>التاريخ</span><input type="date" name="date" required min="${today()}" value="${s(row.scheduled_date)}"></label>
      <label class="field"><span>الوقت</span><input type="time" name="time" required step="300" value="${minuteToTime(row.scheduled_minute)}"></label>
      <label class="field"><span>المدة (دقيقة)</span><select name="duration">${[15, 20, 30, 45, 60, 90, 120].map(d => `<option value="${d}" ${d === row.duration_minutes ? 'selected' : ''}>${d} دقيقة</option>`).join('')}</select></label>
      </div><p class="muted">الكرسي والطبيب كما هما؛ لتغييرهما استخدم إعادة الحجز بعد الإلغاء.</p>`,
      async fields => run('appointment.reschedule', {
        appointmentId: row.id, expectedVersion: Number(fields.expectedVersion), date: fields.date,
        minute: String(timeToMinute(fields.time)), duration: fields.duration
      }), 'حفظ التعديل');
  }
  function cancelForm(row) {
    openModal('إلغاء الموعد', `<input type="hidden" name="appointmentId" value="${s(row.id)}"><input type="hidden" name="expectedVersion" value="${s(row.version)}">
      <p><strong>${s(row.full_name)}</strong> · ${s(row.scheduled_date)} ${s(minuteToTime(row.scheduled_minute))}</p>
      <label class="field"><span>سبب الإلغاء</span><textarea name="reason" required minlength="3" maxlength="1000"></textarea></label>
      <label class="check"><input type="checkbox" required>أفهم أن الإلغاء يحفظ الموعد بسّجل أنظف ولا يُحذف.</label>`,
      fields => run('appointment.cancel', { appointmentId: row.id, expectedVersion: Number(fields.expectedVersion), reason: fields.reason }), 'تأكيد الإلغاء');
  }
  function seatForm(row) {
    const cfg = state.config;
    openModal('إجلاس المريض على الكرسي', `<input type="hidden" name="arrivalId" value="${s(row.id)}">
      <p><strong>رقم ${s(row.queue_number)}</strong> · ${s(row.full_name)}</p>
      <label class="field"><span>الكرسي / الغرفة</span><select name="chairId" required>${(cfg?.chairs || []).filter(c => c.active).map(c => `<option translate="no" value="${s(c.id)}">${s(c.name)}${c.room ? ' — ' + s(c.room) : ''}</option>`).join('')}</select></label>`,
      fields => run('arrival.seat', { arrivalId: row.id, chairId: fields.chairId }), 'إجلاس');
  }

  function scheduleTab() {
    return `<section class="card"><div class="section-head"><h2>جدول مواعيد ${s(state.date)}</h2>
      <div class="actions"><input type="date" id="schedule-date" value="${s(state.date)}" aria-label="تاريخ الجدول">${can('appointment.write') ? `<button class="button primary" data-action="appt-book">+ حجز موعد</button>` : ''}</div></div>
      ${state.appointments.length ? `<div class="table-wrap"><table><thead><tr><th>الوقت</th><th>المريض</th><th>الطبيب</th><th>الكرسي</th><th>النوع</th><th>الحالة</th><th>إجراءات</th></tr></thead><tbody>
      ${state.appointments.map(row => `<tr><td><strong>${s(minuteToTime(row.scheduled_minute))}</strong><small class="muted"> ${row.duration_minutes}د</small></td><td>${s(row.full_name)}</td><td>${s(row.doctor_name)}</td><td>${s(row.chair_name)}${row.room ? ` · ${s(row.room)}` : ''}</td><td>${s(KINDS[row.kind])}</td><td><span class="pill ${row.status === 'booked' ? 'green' : row.status === 'completed' ? '' : 'orange'}">${s(APPT_STATUS[row.status])}</span>${row.status === 'cancelled' && row.cancel_reason ? `<small class="muted"> ${s(row.cancel_reason)}</small>` : ''}</td>
      <td class="actions">${row.status === 'booked' ? `<button class="button small" data-action="appt-move" data-id="${s(row.id)}">تعديل</button><button class="button small" data-action="appt-complete" data-id="${s(row.id)}">إكمال</button><button class="button small" data-action="appt-noshow" data-id="${s(row.id)}">لم يحضر</button><button class="button small danger" data-action="appt-cancel" data-id="${s(row.id)}">إلغاء</button>` : ''}</td></tr>`).join('')}
      </tbody></table></div>` : `<div class="empty"><span class="empty-icon" aria-hidden="true">▦</span><h3>لا مواعيد في هذا اليوم</h3><p>احجز موعدًا جديدًا، أو انتقل إلى تبويب قائمة الانتظار لتسجيل حضور فوري.</p></div>`}</section>`;
  }
  function queueTab() {
    return `<section class="card"><div class="section-head"><h2>قائمة الانتظار — ${s(state.date)}</h2>
      <div class="actions"><input type="date" id="schedule-date" value="${s(state.date)}" aria-label="تاريخ القائمة"><button class="button primary" data-action="appt-refresh">تحديث</button></div></div>
      ${state.arrivals.length ? `<div class="table-wrap"><table><thead><tr><th>الدور</th><th>المريض</th><th>الحالة</th><th>الكرسي</th><th>الوصول</th><th>النداء</th><th>الإجلاس</th><th>إجراءات</th></tr></thead><tbody>
      ${state.arrivals.map(row => `<tr><td><strong>${s(row.queue_number)}</strong></td><td>${s(row.full_name)}${row.appointment_id ? ' <span class="pill">بموعد</span>' : ''}</td><td><span class="pill ${row.status === 'waiting' ? '' : row.status === 'called' ? 'orange' : row.status === 'in_chair' ? 'green' : ''}">${s(ARRIVAL_STATUS[row.status])}</span></td><td>${s(row.chair_name)}</td><td>${s(row.arrived_at ? new Date(row.arrived_at).toLocaleTimeString('ar-YE', { hour: '2-digit', minute: '2-digit' }) : '')}</td><td>${s(row.called_at ? new Date(row.called_at).toLocaleTimeString('ar-YE', { hour: '2-digit', minute: '2-digit' }) : '')}</td><td>${s(row.seated_at ? new Date(row.seated_at).toLocaleTimeString('ar-YE', { hour: '2-digit', minute: '2-digit' }) : '')}</td>
      <td class="actions">${row.status === 'waiting' ? `<button class="button small primary" data-action="ar-call" data-id="${s(row.id)}">نداء</button><button class="button small danger" data-action="ar-leave" data-id="${s(row.id)}">انصرف</button>` : ''}
      ${row.status === 'called' ? `<button class="button small" data-action="ar-recall" data-id="${s(row.id)}">إعادة نداء</button><button class="button small primary" data-action="ar-seat" data-id="${s(row.id)}">إجلاس</button><button class="button small danger" data-action="ar-leave" data-id="${s(row.id)}">انصرف</button>` : ''}
      ${row.status === 'in_chair' ? `<button class="button small" data-action="ar-finish" data-id="${s(row.id)}">إنهاء</button>` : ''}</td></tr>`).join('')}
      </tbody></table></div>` : `<div class="empty"><span class="empty-icon" aria-hidden="true">♧</span><h3>لا أحد في الانتظار</h3><p>سجّل حضور مريض من ملفه، أو من الموعد المحجوز له.</p></div>`}
      <p class="inline-note">النداء يظهر فورًا على شاشة الصالة. تسجيل الحضور لا يوثق عملًا سريريًا؛ الزيارة تفتح من ملف المريض وتُوقّع صراحة.</p></section>`;
  }
  function requestsTab() {
    return `<section class="card"><div class="section-head"><h2>طلبات الحجز الإلكترونية</h2><small>تدخل من الموقع العام وتنتظر مراجعة الاستقبال</small></div>
      ${state.requests.length ? `<div class="table-wrap"><table><thead><tr><th>المقدم</th><th>الهاتف</th><th>التخصص</th><th>التاريخ المفضل</th><th>ملاحظة</th><th>الحالة</th><th>إجراءات</th></tr></thead><tbody>
      ${state.requests.map(row => `<tr><td><strong>${s(row.full_name)}</strong></td><td dir="ltr">${s(row.phone)}</td><td>${s(specialties().find(x => x.code === row.specialty)?.name_ar || row.specialty)}</td><td>${s(row.preferred_date)}</td><td>${s(row.note || '')}</td><td><span class="pill ${row.status === 'pending' ? 'orange' : row.status === 'booked' ? 'green' : ''}">${row.status === 'pending' ? 'بانتظار المراجعة' : row.status === 'booked' ? 'تم الحجز' : 'مرفوض'}</span>${row.review_reason ? `<small class="muted"> ${s(row.review_reason)}</small>` : ''}</td>
      <td class="actions">${row.status === 'pending' ? `<button class="button small primary" data-action="req-book" data-id="${s(row.id)}">حجز</button><button class="button small danger" data-action="req-reject" data-id="${s(row.id)}">رفض</button>` : row.appointment_id ? `<a class="button small" href="#" data-action="appt-none" tabindex="-1" aria-disabled="true">مرتبط بموعد</a>` : ''}</td></tr>`).join('')}
      </tbody></table></div>` : `<div class="empty"><span class="empty-icon" aria-hidden="true">◇</span><h3>لا طلبات جديدة</h3><p>عند إتاحة طلب الموعد العام، تظهر الطلبات هنا لمراجعة الهوية وتأكيد الموعد.</p></div>`}
      <div class="banner">لا يظهر للطالب «تم التأكيد» قبل اعتماد الموعد هنا. الطلب المكرر لنفس الهاتف والتاريخ يُرفض آليًا.</div></section>`;
  }
  function loungeTab() {
    const cfg = state.config || { chairs: [], working_hours: [], holidays: [], settings: {} };
    const mode = cfg.settings?.['lounge.display_mode']?.mode || 'masked_name';
    const modeVersion = cfg.settings?.['lounge.display_mode']?.version || 1;
    const expiry = cfg.settings?.['lounge.call_expiry_seconds']?.seconds || 300;
    const expiryVersion = cfg.settings?.['lounge.call_expiry_seconds']?.version || 1;
    const loungeUrl = `${location.origin}/lounge.html?b=${branch().id}`;
    return `<section class="card"><div class="section-head"><h2>إعداد شاشة الصالة</h2></div>
      <div class="banner">شاشة الصالة تعرض رقم الدور والاسم المقنّع فقط — دون هواتف أو مبالغ أو تشخيصات أو أرقام ملفات، ويقرأها من واجهة عامة مخصصة دون جلسة موظف.</div>
      <div class="form-grid">
      <label class="field"><span>طريقة العرض</span><select id="lounge-mode"><option value="masked_name" ${mode === 'masked_name' ? 'selected' : ''}>اسم مقنّع (مثال: أحمد م.)</option><option value="queue_number" ${mode === 'queue_number' ? 'selected' : ''}>رقم الدور فقط</option></select><input type="hidden" id="lounge-mode-version" value="${s(modeVersion)}"></label>
      <label class="field"><span>صلاحية النداء على الشاشة (ثانية)</span><input id="lounge-expiry" type="number" min="60" max="43200" value="${s(expiry)}"><input type="hidden" id="lounge-expiry-version" value="${s(expiryVersion)}"><small>بعد هذه المدة يظهر للنداء القديم أنه منقضي ولا يُعرض كأنه آني.</small></label>
      </div><div class="actions">${can('settings.write') ? '<button class="button primary" data-action="lounge-save">حفظ إعدادات الصالة</button>' : '<span class="pill">صلاحية الإعدادات مطلوبة</span>'}</div>
      <h2 class="space-top">رابط الشاشة</h2><p class="inline-note">افتح هذا الرابط على جهاز الشاشة في الصالة (وضع ملء الشاشة F11):</p>
      <div class="actions"><code dir="ltr" class="lounge-link">${esc(loungeUrl)}</code><button class="button small" data-action="lounge-copy">نسخ الرابط</button></div>
      <h2 class="space-top">الكراسي والغرف</h2>
      ${cfg.chairs.length ? `<div class="table-wrap"><table><thead><tr><th>الاسم</th><th>الغرفة</th><th>الحالة</th></tr></thead><tbody>${cfg.chairs.map(c => `<tr><td>${s(c.name)}</td><td>${s(c.room)}</td><td>${c.active ? '<span class="pill green">نشط</span>' : '<span class="pill">موقوف</span>'}</td></tr>`).join('')}</tbody></table></div>` : '<p class="inline-note">لا كراسي بعد.</p>'}
      ${can('settings.write') ? `<div class="actions"><input id="chair-name" placeholder="اسم الكرسي" maxlength="120" aria-label="اسم الكرسي"><input id="chair-room" placeholder="الغرفة (اختياري)" maxlength="120" aria-label="الغرفة"><button class="button" data-action="chair-add">+ إضافة كرسي</button></div>` : ''}
      <h2 class="space-top">ساعات العمل الأسبوعية</h2>
      ${cfg.working_hours.length ? `<div class="table-wrap"><table><thead><tr><th>اليوم</th><th>من</th><th>إلى</th></tr></thead><tbody>${cfg.working_hours.map(w => `<tr><td>${s(DAYS[w.dayOfWeek])}</td><td dir="ltr">${s(minuteToTime(w.openMinute))}</td><td dir="ltr">${s(minuteToTime(w.closeMinute))}</td></tr>`).join('')}</tbody></table></div><p class="inline-note">الأيام غير المدرجة تعتبر مغلقة للحجز طالما وُجدت ساعات لأيام أخرى.</p>` : '<p class="inline-note">لا ساعات مُعدّة: الحجز مسموح في أي وقت حتى ضبط الساعات.</p>'}
      ${can('settings.write') ? `<div class="actions">${DAYS.map((d, i) => `<button class="button small" data-action="hours-edit" data-id="${i}">${d}</button>`).join('')}</div>` : ''}
      <h2 class="space-top">العطل</h2>
      ${cfg.holidays.length ? `<div class="table-wrap"><table><thead><tr><th>التاريخ</th><th>السبب</th><th></th></tr></thead><tbody>${cfg.holidays.map(h => `<tr><td dir="ltr">${s(h.date)}</td><td>${s(h.reason)}</td><td>${can('settings.write') ? `<button class="button small danger" data-action="holiday-remove" data-id="${s(h.date)}">إزالة</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<p class="inline-note">لا عطل مسجلة.</p>'}
      ${can('settings.write') ? `<div class="actions"><input type="date" id="holiday-date" aria-label="تاريخ العطلة" min="${today()}"><input id="holiday-reason" placeholder="السبب (اختياري)" maxlength="300" aria-label="سبب العطلة"><button class="button" data-action="holiday-add">+ إضافة عطلة</button></div>` : ''}
      </section>`;
  }

  function render() {
    root.innerHTML = `<div class="page-head"><div><p class="eyebrow">الاستقبال والتشغيل</p><h1>المواعيد والصالة</h1><p class="muted">${s(branch().name)} — الجدول وقائمة الانتظار وطلبات الحجز وشاشة الصالة في مكان واحد.</p></div>
      <button class="button" data-action="open-queue-from-file">تسجيل حضور من ملف مريض</button></div>
      <div class="tabs">${[['schedule', 'جدول المواعيد'], ['queue', 'قائمة الانتظار'], ['requests', 'طلبات الحجز'], ['lounge', 'إعداد الصالة']].map(([id, name]) => `<button class="tab ${state.tab === id ? 'active' : ''}" data-action="appt-tab" data-id="${id}" ${state.tab === id ? 'aria-current="true"' : ''}>${name}</button>`).join('')}</div>
      <div id="appointments-panel">${state.tab === 'schedule' ? scheduleTab() : state.tab === 'queue' ? queueTab() : state.tab === 'requests' ? requestsTab() : loungeTab()}</div>`;
  }

  root.addEventListener('click', async event => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const action = button.dataset.action, id = button.dataset.id;
    const findAppointment = list => state.appointments.find(x => x.id === id);
    const findArrival = () => state.arrivals.find(x => x.id === id);
    const findRequest = () => state.requests.find(x => x.id === id);
    try {
      if (action === 'appt-tab') { state.tab = id; state.loaded = ''; await refresh(); }
      else if (action === 'appt-refresh' || action === 'appt-none') { await refresh(); }
      else if (action === 'appt-book') { if (!state.config) state.config = await api(`${base()}/schedule-config`); bookForm(); }
      else if (action === 'appt-move') rescheduleForm(findAppointment());
      else if (action === 'appt-cancel') cancelForm(findAppointment());
      else if (action === 'appt-noshow') await run('appointment.no_show', { appointmentId: id, expectedVersion: findAppointment().version });
      else if (action === 'appt-complete') await run('appointment.complete', { appointmentId: id, expectedVersion: findAppointment().version });
      else if (action === 'req-book') { if (!state.config) state.config = await api(`${base()}/schedule-config`); bookForm(findRequest()); }
      else if (action === 'req-reject') {
        const row = findRequest();
        openModal('رفض الطلب', `<input type="hidden" name="requestId" value="${s(id)}"><label class="field"><span>سبب الرفض</span><textarea name="reason" required minlength="3" maxlength="1000"></textarea></label>`,
          fields => run('appointment_request.reject', { requestId: id, reason: fields.reason }), 'تأكيد الرفض');
      }
      else if (action === 'ar-call') { const r = await run('arrival.call', { arrivalId: id }); notify(`تم النداء — الدور ${r.queueNumber}`); }
      else if (action === 'ar-recall') await run('arrival.recall', { arrivalId: id });
      else if (action === 'ar-seat') { if (!state.config) state.config = await api(`${base()}/schedule-config`); seatForm(findArrival()); }
      else if (action === 'ar-finish') await run('arrival.finish', { arrivalId: id });
      else if (action === 'ar-leave') await run('arrival.leave', { arrivalId: id });
      else if (action === 'lounge-save') {
        const mode = root.querySelector('#lounge-mode').value, modeVersion = Number(root.querySelector('#lounge-mode-version').value);
        const expiry = root.querySelector('#lounge-expiry').value, expiryVersion = Number(root.querySelector('#lounge-expiry-version').value);
        if (!/^\d{2,5}$/.test(expiry) || Number(expiry) < 60 || Number(expiry) > 43200) throw Object.assign(new Error('INVALID_SETTING_VALUE'), { code: 'INVALID_SETTING_VALUE' });
        await run('setting.write', { key: 'lounge.display_mode', value: { mode }, expectedVersion: modeVersion });
        await run('setting.write', { key: 'lounge.call_expiry_seconds', value: { seconds: Number(expiry) }, expectedVersion: expiryVersion });
      }
      else if (action === 'lounge-copy') { await navigator.clipboard.writeText(`${location.origin}/lounge.html?b=${branch().id}`); notify('نُسخ رابط شاشة الصالة.'); }
      else if (action === 'chair-add') {
        const name = root.querySelector('#chair-name').value.trim(), room = root.querySelector('#chair-room').value.trim();
        if (!name) throw Object.assign(new Error('INVALID_SCHEDULE_INPUT'), { code: 'INVALID_SCHEDULE_INPUT' });
        await run('chair.create', { name, room });
      }
      else if (action === 'hours-edit') {
        const day = Number(id);
        const row = (state.config?.working_hours || []).find(w => w.dayOfWeek === day);
        openModal(`ساعات عمل ${DAYS[day]}`, `<input type="hidden" name="dayOfWeek" value="${day}">
          <div class="form-grid"><label class="field"><span>الفتح (دقيقة من منتصف الليل أو وقت)</span><input type="time" name="open" step="300" value="${row ? minuteToTime(row.openMinute) : '08:00'}"></label>
          <label class="field"><span>الإغلاق</span><input type="time" name="close" step="300" value="${row ? minuteToTime(row.closeMinute) : '17:00'}"></label></div>
          <label class="check"><input type="checkbox" name="closed">مغلق في هذا اليوم${row ? ' (يزيل الإعداد)' : ''}</label>`,
          async fields => {
            if (fields.closed) { await run('working_hours.remove', { dayOfWeek: String(day) }); return; }
            await run('working_hours.set', { dayOfWeek: String(day), openMinute: String(timeToMinute(fields.open)), closeMinute: String(timeToMinute(fields.close)) });
          });
      }
      else if (action === 'holiday-add') {
        const date = root.querySelector('#holiday-date').value, reason = root.querySelector('#holiday-reason').value.trim();
        if (!date) throw Object.assign(new Error('INVALID_SCHEDULE_INPUT'), { code: 'INVALID_SCHEDULE_INPUT' });
        await run('holiday.set', { date, reason });
      }
      else if (action === 'holiday-remove') await run('holiday.remove', { date: id });
      else if (action === 'open-queue-from-file') {
        const q = window.prompt('اكتب اسم المريض أو رقم هاتفه للبحث عن ملفه:');
        if (!q) return;
        const found = await api(`${base()}/patients?q=${encodeURIComponent(q)}`);
        if (!found.patients.length) return notify('لا نتائج مطابقة.', true);
        const pick = found.patients.length === 1 ? found.patients[0] : null;
        if (!pick) {
          const name = window.prompt('عدة نتائج. انسخ معرف المريض المطلوب من القائمة:\n' + found.patients.slice(0, 10).map(p => `${p.full_name} — ${p.id.slice(0, 8)}`).join('\n'));
          if (!name) return;
          const chosen = found.patients.find(p => p.id.startsWith(name.trim()));
          if (!chosen) return notify('لم يتم اختيار ملف صحيح.', true);
          await run('arrival.create', { patientId: chosen.id });
        } else await run('arrival.create', { patientId: pick.id });
        state.tab = 'queue'; await refresh();
      }
      else return;
      await refresh();
    } catch (e) { notify(errorText(e), true); }
  });
  root.addEventListener('change', async event => {
    if (event.target.id === 'schedule-date') { state.date = event.target.value || today(); state.loaded = ''; try { await refresh(); } catch (e) { notify(errorText(e), true); } }
  });
  refresh().catch(e => { root.innerHTML = `<div class="banner">${esc(errorText(e))}</div>`; });
}
