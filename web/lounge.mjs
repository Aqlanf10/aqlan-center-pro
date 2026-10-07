// Copyright (c) 2026 Dr. Aqlan Alkamel. All rights reserved.
// Public lounge display. Polls the minimal snapshot endpoint, announces new
// call events once per repeat, and degrades honestly when offline or stale
// (LOUNGE-01/02/03). No staff session and no sensitive fields are used.
const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const params = new URLSearchParams(location.search);
const branchId = params.get('b') || '';
let lastSequence = 0;
const announced = new Map();
let lastUpdate = null;
let offline = false;
let audioContext = null;
const weekdayNames = ['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];

function beep() {
  try {
    audioContext = audioContext || new (window.AudioContext || window.webkitAudioContext)();
    if (audioContext.state === 'suspended') audioContext.resume();
    const t = audioContext.currentTime;
    for (const [start, freq] of [[0, 880], [0.18, 1180]]) {
      const osc = audioContext.createOscillator(), gain = audioContext.createGain();
      osc.type = 'sine'; osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t + start);
      gain.gain.exponentialRampToValueAtTime(0.35, t + start + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + start + 0.22);
      osc.connect(gain).connect(audioContext.destination);
      osc.start(t + start); osc.stop(t + start + 0.25);
    }
  } catch { /* visual call remains effective without audio */ }
}
function speak(text) {
  try {
    if (!('speechSynthesis' in window)) return;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'ar-SA'; utterance.rate = 0.95;
    speechSynthesis.speak(utterance);
  } catch { /* ignore */ }
}
function announce(event) {
  beep();
  const chair = event.room || event.chairName || '';
  const spoken = `${event.displayName || ''} رقم ${event.queueNumber}`.trim();
  speak(spoken + (chair ? `، ${chair}` : ''));
}
function timeOf(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleTimeString('ar-YE', { hour: '2-digit', minute: '2-digit' }); } catch { return ''; }
}
function setOffline(state) {
  if (offline === state) return;
  offline = state;
  $('#offline-banner').hidden = !state;
}
function render(data) {
  $('#lounge').innerHTML = `
  <div id="offline-banner" class="lounge-offline" hidden>انقطع الاتصال — جارٍ إعادة المحاولة</div>
  <header class="lounge-head"><div class="lounge-brand"><strong>${esc(data.branch)}</strong><small>عقلان سنتر برو</small></div>
  <div class="lounge-clock"><strong>${esc(timeOf(data.generatedAt) || '')}</strong><small>${weekdayNames[new Date().getDay()]}</small></div></header>
  ${data.activeCall ? `<section class="lounge-call" aria-live="assertive">
    <div class="lounge-call-number"><span class="lounge-label">الدور</span><strong>${esc(data.activeCall.queueNumber)}</strong></div>
    <div class="lounge-call-name">${esc(data.activeCall.displayName || '')}</div>
    <div class="lounge-call-chair">${esc([data.activeCall.room, data.activeCall.chairName].filter(Boolean).join(' · ') || 'الاستقبال')}</div>
    <div class="lounge-call-meta">${esc(timeOf(data.activeCall.calledAt))}${data.activeCall.repeats > 1 ? ` · تكرار النداء ${esc(data.activeCall.repeats)}` : ''}</div>
  </section>` : `<section class="lounge-idle"><p>يرجى الانتظار — سيتم النداء بالتناوب</p><small>لمراجعة الموعد أو التأخير تفضلوا بالتوجه إلى الاستقبال</small></section>`}
  <footer class="lounge-foot">
    <div class="lounge-waiting">في الانتظار: <strong>${esc(data.waitingCount)}</strong></div>
    <div class="lounge-recent">${(data.events || []).slice(-4).reverse().map(e => `<span>رقم ${esc(e.queueNumber)}${e.displayName ? ` · ${esc(e.displayName)}` : ''}</span>`).join('')}</div>
    <div class="lounge-updated">آخر تحديث: ${esc(new Date().toLocaleTimeString('ar-YE', { hour: '2-digit', minute: '2-digit', second: '2-digit' }))}</div>
  </footer>`;
}
function tick() {
  if (!branchId) return;
  fetch(`/api/public/lounge/${encodeURIComponent(branchId)}?since=${lastSequence}`)
    .then(r => { if (!r.ok) throw new Error('bad'); return r.json(); })
    .then(data => {
      setOffline(false); lastUpdate = Date.now(); render(data);
      for (const event of data.events || []) {
        const seen = announced.get(event.eventId) || 0;
        if ((event.repeats || 1) > seen) { announce(event); announced.set(event.eventId, event.repeats || 1); }
        if (Number(event.sequence) > lastSequence) lastSequence = Number(event.sequence);
      }
    })
    .catch(() => setOffline(true));
}
function boot() {
  if (!branchId) { $('.lounge-setup').insertAdjacentHTML('beforeend', '<p class="error">معرف الفرع مفقود في الرابط.</p>'); return; }
  document.title = `شاشة الصالة — ${decodeURIComponent(params.get('n') || 'عقلان سنتر برو')}`;
  tick(); setInterval(tick, 5000);
  // Browsers require one interaction before audio; the first touch enables sound.
  ['click', 'keydown', 'touchstart'].forEach(type => window.addEventListener(type, beep, { once: true }));
}
boot();
