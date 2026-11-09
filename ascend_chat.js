/* ==========================================================================
   ASCEND ascend_chat.js — floating ASCEND AI chatbot + "do it now" reminders
   Load AFTER index.html's main inline script and ai_service.js.
   - Round bubble (bottom-right). Tap/click -> chat panel opens.
   - Uses your saved ASCEND records (S) as context for every answer.
   - Fires a notification AT the reminder time telling the student what to do.
   ========================================================================== */
(function () {
  'use strict';

  const CHAT_KEY = 'ascend.chat.v1';
  const FIRED_KEY = 'ascend.fired.v1';
  const ENDPOINT = (window.aiService && window.aiService.config && window.aiService.config.url) ||
    'https://ascend-ai-api.do-freelance-web.workers.dev';

  /* ---------- tiny helpers (safe even if app globals are missing) ---------- */
  const App = () => { try { return S; } catch (e) { return null; } };
  const pad2 = n => String(n).padStart(2, '0');
  const today = () => new Date().toLocaleDateString('en-CA');
  const escH = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) || d; } catch (e) { return d; } };
  const store = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
  const dayIdx = d => new Date(d + 'T12:00').getDay();

  let history = load(CHAT_KEY, []);   // [{r:'u'|'a', t:'text', ts}]
  let busy = false;
  let pendingReminder = null;

  /* ---------- styles ---------- */
  const css = `
  #ac-bubble{position:fixed;right:18px;bottom:calc(18px + env(safe-area-inset-bottom,0px));width:58px;height:58px;border-radius:50%;
    background:var(--ol,#5f6a43);color:#fff;border:0;z-index:30;font-size:26px;display:grid;place-items:center;cursor:pointer;
    box-shadow:0 6px 18px #0006;padding:0;touch-action:manipulation;-webkit-tap-highlight-color:transparent;transition:transform .15s}
  #ac-bubble:active{transform:scale(.92)}
  #ac-bubble.ring{animation:acPulse 1.2s ease-in-out infinite}
  #ac-bubble .dot{position:absolute;top:2px;right:2px;min-width:18px;height:18px;border-radius:9px;background:var(--bad,#a4523f);color:#fff;
    font-size:11px;font-weight:700;display:none;place-items:center;padding:0 4px;border:2px solid var(--bg,#111)}
  #ac-bubble.has .dot{display:grid}
  @keyframes acPulse{0%,100%{box-shadow:0 0 0 0 var(--ol,#5f6a43),0 6px 18px #0006}50%{box-shadow:0 0 0 14px #0000,0 6px 18px #0006}}
  #ac-panel{position:fixed;right:18px;bottom:calc(88px + env(safe-area-inset-bottom,0px));width:min(380px,calc(100vw - 24px));
    height:min(560px,calc(100vh - 120px));background:var(--cd,#191a18);color:var(--ink,#ecebe4);border:1px solid var(--ln,#2c2e2a);
    border-radius:16px;z-index:31;display:none;flex-direction:column;overflow:hidden;box-shadow:0 12px 40px #000a}
  #ac-panel.on{display:flex}
  #ac-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--ln,#2c2e2a);background:var(--ol2,#262a1d)}
  #ac-head b{flex:1;font-size:15px}#ac-head small{display:block;font-weight:400}
  #ac-head button{padding:4px 9px;font-size:13px}
  #ac-msgs{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px;-webkit-overflow-scrolling:touch}
  .ac-m{max-width:88%;padding:8px 11px;border-radius:12px;font-size:14px;line-height:1.5;overflow-wrap:anywhere;white-space:pre-wrap}
  .ac-m.u{align-self:flex-end;background:var(--ol,#5f6a43);color:#fff;border-bottom-right-radius:4px}
  .ac-m.a{align-self:flex-start;background:var(--bg,#0d0e0d);border:1px solid var(--ln,#2c2e2a);border-bottom-left-radius:4px}
  .ac-m.r{align-self:stretch;max-width:100%;background:var(--ol2,#262a1d);border:1px dashed var(--ol,#5f6a43)}
  .ac-chips{display:flex;gap:6px;overflow-x:auto;padding:6px 12px 0;flex:none}
  .ac-chips button{flex:none;white-space:nowrap;font-size:12px;padding:4px 10px;border-radius:16px}
  #ac-form{display:flex;gap:6px;padding:10px 12px calc(10px + env(safe-area-inset-bottom,0px))}
  #ac-in{flex:1;resize:none;height:40px;max-height:96px;border-radius:20px;padding:9px 14px;font-size:16px}
  #ac-send{border-radius:50%;width:40px;height:40px;padding:0;flex:none}
  #ac-notif{margin:8px 12px 0;padding:8px 10px;border-radius:10px;font-size:13px;background:var(--ol2,#262a1d);border:1px solid var(--ln,#2c2e2a);display:none}
  @media(max-width:480px){#ac-panel{right:12px;left:12px;width:auto;bottom:calc(84px + env(safe-area-inset-bottom,0px));height:calc(100vh - 110px)}}
  @media(prefers-reduced-motion:reduce){#ac-bubble.ring{animation:none}}`;
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  /* ---------- DOM ---------- */
  const bubble = document.createElement('button');
  bubble.id = 'ac-bubble'; bubble.type = 'button'; bubble.setAttribute('aria-label', 'Open ASCEND AI chat');
  bubble.innerHTML = '✦<span class="dot">1</span>';
  const panel = document.createElement('div');
  panel.id = 'ac-panel'; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'ASCEND AI chat');
  panel.innerHTML = `
    <div id="ac-head"><b>ASCEND AI<small class="m">CMA · fitness · food · routine</small></b>
      <button type="button" id="ac-clear" title="Clear chat">Clear</button>
      <button type="button" id="ac-x" aria-label="Close">✕</button></div>
    <div id="ac-notif"></div>
    <div id="ac-msgs" aria-live="polite"></div>
    <div class="ac-chips" id="ac-chips"></div>
    <form id="ac-form"><textarea id="ac-in" rows="1" placeholder="Ask about study, workout, food…" aria-label="Message"></textarea>
      <button class="pri" id="ac-send" aria-label="Send">➤</button></form>`;
  document.body.appendChild(bubble);
  document.body.appendChild(panel);
  const $m = panel.querySelector('#ac-msgs'), $in = panel.querySelector('#ac-in'), $n = panel.querySelector('#ac-notif');

  const CHIPS = [
    ['Plan my day', 'Plan the rest of my day using my study target, workout plan and pending tasks.'],
    ['Daily report', 'Give me my daily performance report for today.'],
    ['I\'m behind on study', 'I am behind on my study target today. What should I do?'],
    ['CMA practice MCQs', 'Give me 3 CMA practice MCQs on my weakest topic, with explanations.'],
    ['Workout today', 'What should I do for my workout today?'],
    ['Meal ideas', 'Suggest simple, affordable meals and a juice for today.']
  ];
  panel.querySelector('#ac-chips').innerHTML = CHIPS.map((c, i) => `<button type="button" data-i="${i}">${escH(c[0])}</button>`).join('');

  /* ---------- rendering ---------- */
  function fmt(t) {
    return escH(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/^\s*[*\-•]\s+/gm, '• ');
  }
  function draw() {
    if (!history.length) {
      const A = App(), nm = A && A.name ? ' ' + A.name : '';
      history.push({ r: 'a', t: `Hi${nm}! I'm ASCEND AI. I can help with CMA study, workouts, food, skincare and your daily routine, using what you've logged in ASCEND. What do you need?`, ts: Date.now() });
    }
    $m.innerHTML = history.map(m => `<div class="ac-m ${m.r}">${fmt(m.t)}</div>`).join('') +
      (busy ? '<div class="ac-m a"><span class="spinner"></span>Thinking…</div>' : '');
    $m.scrollTop = $m.scrollHeight;
  }
  const persist = () => { history = history.slice(-40); store(CHAT_KEY, history); };

  /* ---------- context from saved ASCEND records ---------- */
  function records() {
    const A = App(); if (!A) return 'No saved ASCEND records are available.';
    const L = [], d = today(), now = new Date();
    const safe = (fn, dflt) => { try { return fn(); } catch (e) { return dflt; } };
    const hrs = dt => safe(() => (A.slog || []).filter(l => l.d === dt).reduce((a, l) => a + (+l.h || 0), 0), 0);
    L.push(`Name: ${A.name || 'not set'}. Today: ${d} (${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][now.getDay()]}), time ${pad2(now.getHours())}:${pad2(now.getMinutes())}.`);
    const wkend = now.getDay() === 0 || now.getDay() === 6;
    L.push(`Study today: ${hrs(d)}h logged. Saved daily goal: ${A.sgoal || 'not set'}h (default targets: 4h weekdays, 6h weekends; today is a ${wkend ? 'weekend' : 'weekday'}).`);
    const last7 = []; for (let i = 6; i >= 0; i--) { const x = new Date(); x.setDate(x.getDate() - i); const k = x.toLocaleDateString('en-CA'); last7.push(`${k.slice(5)}:${hrs(k)}h`); }
    L.push('Study last 7 days: ' + last7.join(', '));
    L.push(`Exam date: ${A.exam || 'not set'}.`);
    const syl = A.syl || []; if (syl.length) L.push(`Syllabus chapters done: ${syl.filter(x => x.done).length}/${syl.length}. Not done (first 8): ${syl.filter(x => !x.done).slice(0, 8).map(x => x.ch).join('; ') || 'none'}.`);
    const c = safe(() => window.aiService.buildStudyContext(A), null);
    if (c && c.overall && c.overall.att) {
      L.push(`MCQs: ${c.overall.att} attempted, ${c.overall.acc}% accuracy overall.`);
      const weak = c.topics.filter(t => t.weak).map(t => `${t.topic} (${t.acc}%)`);
      L.push('Weak topics: ' + (weak.join('; ') || 'none identified yet'));
    } else L.push('MCQs: none recorded yet.');
    if ((A.mocks || []).length) L.push('Mock tests: ' + A.mocks.slice(-4).map(m => `${m.d} ${m.sub} ${m.sc}%`).join(' | '));
    else L.push('Mock tests: none recorded.');
    const plan = safe(() => A.fit.plan[dayIdx(d)], 'not set'), did = safe(() => A.fit.wk.some(w => w.d === d), false);
    L.push(`Workout today: planned "${plan}", ${plan === 'Rest' ? 'rest day (not a missed workout)' : did ? 'logged as done' : 'not logged yet'}.`);
    L.push(`Water today: ${(A.water || {})[d] || 0}/${A.wgoal || '?'} glasses. Protein: ${(A.prot || {})[d] || 0}/${A.pgoal || '?'}g. Fruit/veg servings: ${(A.fv || {})[d] || 0}. (Unrecorded meals are NOT skipped meals.)`);
    L.push(`Habits done today: ${safe(() => (A.hlog[d] || []).length, 0)}/${(A.habits || []).length}.`);
    const g = safe(() => A.groom, null);
    if (g) { const gl = (g.glog || {})[d] || { am: [], pm: [] }; L.push(`Skin: ${g.skin || '?'}, hair: ${g.hair || '?'}. Care steps done today: ${gl.am.length + gl.pm.length}/${g.am.length + g.pm.length}.`); }
    const tk = A.tasks || [];
    const pend = tk.filter(t => !t.done && t.due === d), over = tk.filter(t => !t.done && t.due < d);
    L.push('Pending tasks today: ' + (pend.map(t => t.t + (t.rem ? ' @' + t.rem : '')).slice(0, 6).join('; ') || 'none') + '. Overdue: ' + (over.map(t => t.t).slice(0, 4).join('; ') || 'none') + '.');
    L.push('Reminders: ' + ((A.rem || []).map(r => `${r.time} ${r.t}`).join('; ') || 'none'));
    return L.join('\n');
  }

  const SYSTEM = `You are ASCEND AI, a friendly personal assistant for a student preparing for the CMA (US) exam. You help with CMA study, fitness, food, skincare/haircare and daily routine.
RULES: Use ONLY the saved records below. Never invent study hours, MCQ scores, meals, workouts or sleep. If something is not recorded, say "not recorded" - never treat missing data as failure or a skipped meal/workout. Rest days are not missed workouts. Give the direct answer first, then short practical steps. Be supportive, realistic, never shame the student, no robotic tone. Use simple English, short paragraphs, bullets and calculations where helpful. Never promise a reminder was saved or sent. No medical diagnosis, no medicines or supplements, no extreme diets or exercise; suggest a doctor/dermatologist for persistent problems. Keep answers concise.`;

  function buildPrompt(q) {
    const recent = history.filter(m => m.r !== 'r').slice(-7, -1).map(m => (m.r === 'u' ? 'Student: ' : 'ASCEND AI: ') + m.t.slice(0, 500)).join('\n');
    return `${SYSTEM}\n\nSAVED ASCEND RECORDS:\n${records()}\n\nRECENT CHAT:\n${recent || '(none)'}\n\nStudent: ${q}\nASCEND AI:`;
  }

  async function ask(q) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 90000);
    try {
      const r = await fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: buildPrompt(q) }), signal: ctl.signal });
      let data = {}; try { data = await r.json(); } catch (e) {}
      if (!r.ok) throw new Error(data.error || `AI service error (${r.status}).`);
      const a = (data.answer || '').trim().replace(/^ASCEND AI:\s*/i, '');
      if (!a) throw new Error('The AI returned an empty reply. Please try again.');
      return a;
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('That took too long. Please try again.');
      if (navigator.onLine === false) throw new Error('You appear to be offline.');
      throw e;
    } finally { clearTimeout(timer); }
  }

  async function send(text) {
    text = (text || '').trim(); if (!text || busy) return;
    history.push({ r: 'u', t: text, ts: Date.now() }); persist();
    busy = true; draw(); $in.value = ''; $in.style.height = '40px';
    try { history.push({ r: 'a', t: await ask(text), ts: Date.now() }); }
    catch (e) { history.push({ r: 'a', t: '⚠️ ' + (e.message || 'Something went wrong.') + ' Tap send to retry.', ts: Date.now() }); }
    busy = false; persist(); draw();
  }

  /* ---------- open / close ---------- */
  function open() {
    panel.classList.add('on'); bubble.classList.remove('has', 'ring'); pendingReminder = null;
    draw(); updateNotifBanner(); setTimeout(() => $in.focus({ preventScroll: true }), 50);
  }
  const close = () => panel.classList.remove('on');
  bubble.addEventListener('click', () => (panel.classList.contains('on') ? close() : open()));
  panel.querySelector('#ac-x').onclick = close;
  panel.querySelector('#ac-clear').onclick = () => { history = []; persist(); draw(); };
  panel.querySelector('#ac-chips').onclick = e => { const b = e.target.closest('button'); if (b) send(CHIPS[+b.dataset.i][1]); };
  panel.querySelector('#ac-form').onsubmit = e => { e.preventDefault(); send($in.value); };
  $in.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send($in.value); } });
  $in.addEventListener('input', () => { $in.style.height = '40px'; $in.style.height = Math.min(96, $in.scrollHeight) + 'px'; });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });

  /* ---------- notification permission banner ---------- */
  function updateNotifBanner() {
    if (!('Notification' in window)) { $n.style.display = 'block'; $n.textContent = 'This browser does not support notifications. Reminders will show inside ASCEND.'; return; }
    if (Notification.permission === 'default') {
      $n.style.display = 'block';
      $n.innerHTML = '🔔 Get a notification at each reminder time. <button type="button" class="pri sm" id="ac-enable">Enable</button>';
      $n.querySelector('#ac-enable').onclick = () => Notification.requestPermission().then(p => { updateNotifBanner(); if (p === 'granted') notify('ASCEND', 'Notifications are on. You\'ll be told what to do at each reminder time.', 'ac-welcome'); });
    } else if (Notification.permission === 'denied') {
      $n.style.display = 'block'; $n.textContent = 'Notifications are blocked. Allow them in your browser site settings to get reminders.';
    } else $n.style.display = 'none';
  }

  /* ---------- service worker (makes notifications work on mobile) ---------- */
  let swReg = null;
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').then(r => { swReg = r; }).catch(() => {});
    navigator.serviceWorker.addEventListener('message', e => { if (e.data && e.data.type === 'ascend-open-chat') open(); });
  }

  function notify(title, body, tag) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const opts = { body, tag, icon: undefined, renotify: true, requireInteraction: false, vibrate: [200, 100, 200] };
    try {
      if (swReg && swReg.showNotification) swReg.showNotification(title, opts);
      else { const n = new Notification(title, opts); n.onclick = () => { window.focus(); open(); n.close(); }; }
    } catch (e) { try { new Notification(title, { body }); } catch (_) {} }
  }

  /* ---------- reminders: tell the student WHAT TO DO at that time ---------- */
  function actionFor(text, time) {
    const A = App(), d = today(), t = text.toLowerCase();
    const hrs = A ? (A.slog || []).filter(l => l.d === d).reduce((a, l) => a + (+l.h || 0), 0) : 0;
    if (/task:/.test(t)) return `${text} is due now. Do it first, then tick it off.`;
    if (/study|revis|mcq|cma|read/.test(t)) return `Start your CMA session now. ${A && A.sgoal ? `Today: ${hrs}h of ${A.sgoal}h done.` : ''} Pick one topic and do 25 focused minutes.`;
    if (/gym|workout|train|exercise|cardio|run/.test(t)) { const p = A && A.fit && A.fit.plan ? A.fit.plan[dayIdx(d)] : ''; return `Time to move${p && p !== 'Rest' ? ': today is ' + p : ''}. Warm up and start now. A short session still counts.`; }
    if (/water|drink|hydrat/.test(t)) return 'Drink a glass of water now.';
    if (/skin|face|hair|groom|sunscreen/.test(t)) return 'Do your care routine now. It only takes a few minutes.';
    if (/sleep|wind|bed/.test(t)) return 'Wind down: screens away, lights low, get ready for bed.';
    if (/meal|lunch|dinner|breakfast|eat|food/.test(t)) return 'Time to eat. Add some protein and a fruit or vegetable.';
    return `It's ${time}. Time to do it now.`;
  }

  function fire(time, text, id) {
    const act = actionFor(text, time), title = `⏰ ${time} · ${text}`;
    notify(title, act, 'ascend-' + id);
    try { if (typeof toast === 'function') toast(`Reminder: ${text}`); } catch (e) {}
    if (navigator.vibrate) { try { navigator.vibrate([150, 80, 150]); } catch (e) {} }
    history.push({ r: 'r', t: `⏰ ${time} — ${text}\n${act}`, ts: Date.now() }); persist();
    pendingReminder = { time, text };
    if (panel.classList.contains('on')) draw(); else bubble.classList.add('has', 'ring');
  }

  /* due = scheduled time was within the last 5 minutes and not fired yet
     (the window also catches reminders when the tab was asleep a moment) */
  function check() {
    const A = App(); if (!A) return;
    const now = new Date(), d = today(), nowMin = now.getHours() * 60 + now.getMinutes();
    let fired = load(FIRED_KEY, {});
    Object.keys(fired).forEach(k => { if (!k.startsWith(d)) delete fired[k]; });
    const items = [];
    let rems = [];
    try { rems = (typeof remDue === 'function') ? remDue(d) : []; } catch (e) {}
    rems.forEach(r => items.push({ time: r.time, text: r.t, id: 'r' + (r.id || r.t) }));
    (A.tasks || []).filter(t => !t.done && t.due === d && t.rem).forEach(t => items.push({ time: t.rem, text: 'Task: ' + t.t, id: 't' + (t.id || t.t) }));
    items.forEach(it => {
      if (!/^\d{1,2}:\d{2}$/.test(it.time || '')) return;
      const [h, m] = it.time.split(':').map(Number), diff = nowMin - (h * 60 + m), key = d + '|' + it.time + '|' + it.id;
      if (diff >= 0 && diff <= 5 && !fired[key]) { fired[key] = 1; fire(it.time, it.text, it.id); }
    });
    store(FIRED_KEY, fired);
  }
  setInterval(check, 15000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  window.addEventListener('focus', check);
  setTimeout(check, 1500);

  // opened from a notification tap (fallback when SW opens a new window)
  if (location.hash === '#chat') { setTimeout(open, 400); }

  window.ASCEND_CHAT = { open, close, send, check };
})();
