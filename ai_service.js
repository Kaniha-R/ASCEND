/* ASCEND ai_service.js — local Ollama (qwen2.5:3b). Stage 1-5: connectivity + CMA Study Coach.
   No backend. Never called automatically: only on explicit user action. */
(function () {
  'use strict';
  const CFG = {
    url: 'http://localhost:11434',
    model: 'qwen2.5:3b',
    keepAlive: '30m',            // keeps model loaded between requests (no repeated cold loads)
    numCtx: 4096,
    temperature: 0.4,
    timeouts: { quick: 60000, standard: 90000, study: 180000 },   // ms, editable
    maxTokens: { quick: 350, standard: 650, study: 1100 },
    availability: { weekday: 4, weekend: 6 },                     // hours/day => 32 h/week
    thresholds: { weak: 70, minProvisional: 10, minReliable: 20, drop: 10 }
  };
  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const inflight = new Map();   // key -> AbortController (prevents duplicates, enables cancel)

  class AIError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
  const sum = a => a.reduce((x, y) => x + y, 0);
  const pct = (a, b) => (b ? Math.round(a / b * 100) : null);
  const iso = d => d.toLocaleDateString('en-CA');
  const daysAgo = n => { const d = new Date(); d.setDate(d.getDate() - n); return iso(d); };

  /* ---------- transport ---------- */
  async function chat(key, system, user, tier = 'standard') {
    if (inflight.has(key)) throw new AIError('busy', 'A request for this section is already running.');
    const ctl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, CFG.timeouts[tier]);
    inflight.set(key, ctl);
    try {
      const r = await fetch(CFG.url + '/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctl.signal,
        body: JSON.stringify({
          model: CFG.model, stream: false, keep_alive: CFG.keepAlive,
          options: { temperature: CFG.temperature, num_ctx: CFG.numCtx, num_predict: CFG.maxTokens[tier] },
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }]
        })
      });
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        if (r.status === 404 || /not found/i.test(t)) throw new AIError('model', `Model "${CFG.model}" is not installed. Run: ollama pull ${CFG.model}`);
        if (r.status === 403) throw new AIError('cors', 'Ollama blocked this page (CORS). Restart Ollama with OLLAMA_ORIGINS=*');
        throw new AIError('http', `Ollama returned an error (${r.status}).`);
      }
      const j = await r.json();
      const out = ((j.message && j.message.content) || '').trim();
      if (!out) throw new AIError('empty', 'The model returned an empty answer. Try again.');
      return out;
    } catch (e) {
      if (e instanceof AIError) throw e;
      if (e.name === 'AbortError') throw new AIError(timedOut ? 'timeout' : 'cancelled',
        timedOut ? `Timed out after ${CFG.timeouts[tier] / 1000}s. The model may be loading; try again.` : 'Request cancelled.');
      throw new AIError('network', `Cannot reach Ollama at ${CFG.url}. Start Ollama and allow this page: OLLAMA_ORIGINS=*`);
    } finally { clearTimeout(timer); inflight.delete(key); }
  }
  const cancel = key => { const c = inflight.get(key); if (c) c.abort(); };
  const isBusy = key => inflight.has(key);

  async function ping() {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 4000);
    try {
      const r = await fetch(CFG.url + '/api/tags', { signal: ctl.signal });
      if (!r.ok) return { ok: false, msg: `Ollama responded with ${r.status}.` };
      const j = await r.json();
      const has = (j.models || []).some(m => m.name === CFG.model || m.name.startsWith(CFG.model));
      return has ? { ok: true, msg: `Connected. ${CFG.model} is ready.` }
                 : { ok: false, msg: `Ollama is running but ${CFG.model} is missing. Run: ollama pull ${CFG.model}` };
    } catch (e) {
      return { ok: false, msg: 'Ollama not reachable. Start it and set OLLAMA_ORIGINS=* (needed when opening the file directly).' };
    } finally { clearTimeout(t); }
  }

  /* ---------- CMA study context (only study-relevant data leaves the browser) ---------- */
  function buildStudyContext(S) {
    const T = CFG.thresholds, syl = S.syl || [];
    const mcq = (S.mcq || []).filter(q => +q.att > 0).slice().sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
    const map = {};
    mcq.forEach(q => { (map[q.topic] = map[q.topic] || { topic: q.topic, sub: q.sub, s: [] }).s.push({ a: +q.att, c: +q.cor }); });
    const topics = Object.values(map).map(t => {
      const a = sum(t.s.map(x => x.a)), c = sum(t.s.map(x => x.c)), acc = pct(c, a);
      let trend = 'n/a', delta = null;
      if (t.s.length >= 2) {
        const last = t.s[t.s.length - 1], prev = t.s.slice(0, -1), pa = sum(prev.map(x => x.a)), pcor = sum(prev.map(x => x.c));
        if (last.a >= 5 && pa >= 5) {
          delta = pct(last.c, last.a) - pct(pcor, pa);
          trend = delta <= -T.drop ? 'declining' : delta >= T.drop ? 'improving' : 'steady';
        }
      }
      const conf = a >= T.minReliable ? 'reliable' : a >= T.minProvisional ? 'provisional' : 'too few';
      return { topic: t.topic, sub: t.sub, att: a, cor: c, wrong: a - c, acc, sessions: t.s.length, trend, delta, conf,
               weak: conf !== 'too few' && acc < T.weak, strong: conf === 'reliable' && acc >= 80 };
    }).sort((x, y) => x.acc - y.acc);
    const att = sum(mcq.map(q => +q.att)), cor = sum(mcq.map(q => +q.cor));
    const wkStart = daysAgo(6);
    const w = mcq.filter(q => q.d >= wkStart);
    const hours7 = Math.round(sum((S.slog || []).filter(l => l.d >= wkStart).map(l => +l.h || 0)) * 10) / 10;
    const done = syl.filter(x => x.done), studying = syl.filter(x => !x.done && map[x.ch]), notStarted = syl.filter(x => !x.done && !map[x.ch]);
    const examDays = S.exam ? Math.ceil((new Date(S.exam + 'T12:00') - new Date()) / 864e5) : null;
    const weekly = CFG.availability.weekday * 5 + CFG.availability.weekend * 2;
    return {
      examDays, examDate: S.exam || '', weekly, hours7,
      overall: { att, cor, wrong: att - cor, acc: pct(cor, att), sessions: mcq.length },
      week: { att: sum(w.map(q => +q.att)), cor: sum(w.map(q => +q.cor)) },
      topics, reliable: topics.filter(t => t.conf !== 'too few').length,
      syl: { total: syl.length, done: done.length, pct: pct(done.length, syl.length),
             doneN: done.map(x => x.ch).slice(0, 10), studyingN: studying.map(x => x.ch).slice(0, 8), notStartedN: notStarted.map(x => x.ch).slice(0, 10) },
      mocks: (S.mocks || []).slice(-5).map(m => `${m.d} ${m.sub} ${m.sc}%`)
    };
  }

  function factsText(c) {
    const o = c.overall, L = [];
    L.push('ACTUAL (user-entered):');
    L.push(`Exam: ${c.examDays == null ? 'date not set' : c.examDays + ' days away (' + c.examDate + ')'}`);
    L.push(`Syllabus chapters marked done: ${c.syl.done}/${c.syl.total}. Done: ${c.syl.doneN.join('; ') || 'none'}. Studying: ${c.syl.studyingN.join('; ') || 'none'}. Not started: ${c.syl.notStartedN.join('; ') || 'none'}`);
    L.push(`MCQs overall: attempted ${o.att}, correct ${o.cor}, incorrect ${o.wrong}, accuracy ${o.acc == null ? 'n/a' : o.acc + '%'}`);
    L.push(`MCQs last 7 days: attempted ${c.week.att}, correct ${c.week.cor}`);
    L.push(`Study hours logged last 7 days: ${c.hours7}`);
    L.push('Practice tests (user-entered): ' + (c.mocks.join(' | ') || 'none'));
    L.push('Topic MCQ results (topic | attempted | correct | accuracy | trend | data quality):');
    c.topics.slice(0, 12).forEach(t => L.push(`- ${t.topic} | ${t.att} | ${t.cor} | ${t.acc}% | ${t.trend}${t.delta != null ? ' (' + (t.delta > 0 ? '+' : '') + t.delta + ' pts vs earlier)' : ''} | ${t.conf}`));
    if (!c.topics.length) L.push('- none logged');
    L.push('CALCULATED by app (threshold: accuracy under ' + CFG.thresholds.weak + '% with at least ' + CFG.thresholds.minProvisional + ' questions):');
    L.push('Weak topics: ' + (c.topics.filter(t => t.weak).map(t => `${t.topic} (${t.acc}%, ${t.wrong} wrong)`).join('; ') || 'none identified'));
    L.push('Declining topics: ' + (c.topics.filter(t => t.trend === 'declining').map(t => t.topic).join('; ') || 'none identified'));
    L.push('Strong topics: ' + (c.topics.filter(t => t.strong).map(t => `${t.topic} (${t.acc}%)`).join('; ') || 'none identified'));
    L.push(`Syllabus completion: ${c.syl.pct == null ? 'n/a' : c.syl.pct + '%'}`);
    L.push(`Study availability: ${CFG.availability.weekday}h Mon-Fri, ${CFG.availability.weekend}h Sat-Sun = ${c.weekly}h/week if all days available. Hours logged in last 7 days: ${c.hours7}/${c.weekly}.`);
    return L.join('\n');
  }

  const CMA_SYSTEM =
    'You are the CMA (US) study coach inside the ASCEND app, helping one self-studying candidate. ' +
    'Use ONLY the data provided. Never invent scores, syllabus items, or exam rules. ' +
    'Label content as "Your data", "Calculated", or "Suggestion" where it matters. ' +
    'Never call a subject weak from overall accuracy alone; rely on topic-level results, and if they are missing say what to log. ' +
    'Never guarantee exam success. Generated questions are practice questions, not official IMA questions. ' +
    'Be specific and practical. Use short bullets and show calculation steps.';

  const budget = () => DAYS.map((d, i) => `${d} ${i < 5 ? CFG.availability.weekday : CFG.availability.weekend}h`).join(', ');

  const KIND = {
    analysis: 'Write a performance analysis with these headings: 1) Current performance (quote the ACTUAL numbers) 2) Strong topics 3) Weak topics 4) Topics with declining accuracy 5) Revise first (max 3, say why) 6) Recommended practice target for next week (label as Suggestion) 7) Next week study priorities. If a heading has no supporting data, write "Insufficient data" and state what the user should log.',
    timetable: () => `Create a personalised weekly study timetable, then a one-day detailed example for today. Daily hour budget (each day must add up exactly): ${budget()} = 32h. Put weak/declining topics first, then topics currently being studied, then not-started topics in syllabus order. Include one mixed MCQ session, one revision block, and a brief end-of-week review. Recommend a full mock test only if syllabus completion is above 80% or the exam is within 30 days; otherwise say it is not yet needed. Format: a line per day with time blocks.`,
    revision: 'Plan 3 to 5 revision sessions based on the mistakes. Prioritise topics with the most incorrect answers or declining trend. For each: topic, number wrong (ACTUAL), what to review, and how many fresh MCQs to attempt. Spread them over the week within the hour budget: ',
    weekly: 'Write a weekly performance report: hours logged vs planned (Calculated), MCQ volume and accuracy in the last 7 days, topics that changed, what went well, and 3 actions for next week. Do not invent trends that are not in the data.'
  };

  async function studyCoach(S, kind) {
    const c = buildStudyContext(S);
    if ((kind === 'analysis' || kind === 'revision') && !c.overall.att)
      return 'Not enough data yet. Log MCQ sessions in the MCQs tab (topic, questions attempted, correct) and try again.';
    if ((kind === 'analysis' || kind === 'revision') && !c.reliable)
      return `You have ${c.overall.att} questions logged (${c.overall.acc}% overall), but no single topic has ${CFG.thresholds.minProvisional}+ questions yet. Overall accuracy alone cannot show which subject is weak. Log topic-level results (at least ${CFG.thresholds.minProvisional} questions per topic) and try again.`;
    let instr = KIND[kind];
    if (typeof instr === 'function') instr = instr();
    if (kind === 'revision') instr += budget();
    if (!instr) throw new AIError('kind', 'Unknown request type.');
    return chat('study', CMA_SYSTEM, factsText(c) + '\n\nTASK: ' + instr, 'study');
  }

  const explain = text => chat('explain', CMA_SYSTEM,
    'The user pasted a question they got wrong, or a concept to learn:\n"""' + String(text).slice(0, 1500) + '"""\n' +
    'TASK: Explain step by step: (1) the concept in simple words, (2) the formula, (3) a worked calculation with each line shown, (4) the common mistake, (5) a short practical example. If the correct answer was not given, state your assumptions. End with: "Verify calculations against your study materials."', 'study');

  const generateQuizQuestions = (subject, topic, n = 3) => chat('quiz', CMA_SYSTEM,
    `Create ${n} ORIGINAL CMA-style multiple-choice practice questions on "${topic}" (subject: ${subject}). At least one should be numerical if the topic allows. For each: question, options A-D, "Answer:", and a step-by-step "Explanation:". Start with the line: "Practice questions (AI-generated, not official IMA exam questions)".`, 'study');

  /* ---------- existing generic helpers (kept so current screens keep working; replaced in later stages) ---------- */
  const legacy = (key, role, obj, instr) => chat(key,
    `You are ASCEND's ${role}. Use only the data given; do not invent records. Be concise and practical (short bullets, under 200 words). Never guarantee outcomes.`,
    instr + '\nDATA: ' + JSON.stringify(obj), 'quick');

  window.aiService = {
    config: CFG, ping, cancel, isBusy, AIError,
    buildStudyContext, studyCoach, explain, generateQuizQuestions,
    generateStudyPlan: d => legacy('study', 'study planner', d, 'Give a focused study plan for the week.'),
    generateDailyPlan: d => legacy('home', 'daily planner', d, 'Create a short prioritised plan for today.'),
    generateTaskSuggestions: d => legacy('tasks', 'task prioritiser', d, 'Prioritise tasks and break the biggest into 3 steps.'),
    generateHealthInsights: d => legacy('health', 'wellness assistant', d, 'Give 3 simple observations and actions. No medical claims.'),
    generateFitnessPlan: d => legacy('fitness', 'fitness assistant', d, 'Comment on consistency and suggest today\'s session. Only use the logged entries.'),
    generateWeeklyInsights: d => legacy('insights', 'weekly reviewer', d, 'Summarise the week and give 3 actions.')
  };
})();