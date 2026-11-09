/* ==========================================================================
   ASCEND ai_study_ui.js — UI Glue for Stage 1-5 (Cloudflare Workers AI Edition)
   Load AFTER the main inline script and AFTER ai_service.js
   Provides: MCQ log, CMA AI Coach tab, safe rendering, cancel support, AI history.
   ========================================================================== */

(function () {
  'use strict';

  const AI = window.aiService;
  const HK = 'ascend.ai.v1';

  // AI History Storage (Stored separately from core user logs)
  let H = {};
  try {
    H = JSON.parse(localStorage.getItem(HK)) || {};
  } catch (e) {}

  const saveH = () => {
    try {
      localStorage.setItem(HK, JSON.stringify(H));
    } catch (e) {}
  };

  const addH = (k, kind, text) => {
    (H[k] = H[k] || []).unshift({ d: new Date().toISOString(), kind, text });
    H[k] = H[k].slice(0, 5); // Retain top 5 history items per section
    saveH();
  };

  const isLoad = c => typeof c === 'string' && c.startsWith('<span class="spinner">');
  const out = c => (isLoad(c) ? c : esc(c || ''));
  const spin = t => `<span class="spinner"></span> ${t}`;

  let aiStatus = '';
  aiState.explain = aiState.explain || '';
  aiState.explainIn = aiState.explainIn || '';

  /* Mobile-friendly and Responsive CSS Injection */
  const st = document.createElement('style');
  st.textContent = `
    .ai-box { max-height: 60vh; overflow: auto; overflow-wrap: anywhere; -webkit-overflow-scrolling: touch; }
    .aig { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 10px; }
    .aig button, .aic button { min-height: 44px; }
    .ai-err { color: var(--bad); border-color: var(--bad); border-style: solid; }
    details.h { margin-top: 8px; }
    details.h summary { cursor: pointer; color: var(--mut); font-size: 13px; padding: 6px 0; }
    @media (max-width: 480px) {
      .seg button { white-space: nowrap; }
      .cd { min-height: 40px; }
    }
  `;
  document.head.appendChild(st);

  /* Generic AI Card Renderer (Used across Home, Tasks, Health, Fitness, Insights) */
  window.renderAICard = function (id, title, key, fn) {
    if (key === 'study') return ''; // Dedicated rendering inside Study > AI Coach tab
    const c = aiState[key];
    const busy = AI.isBusy ? AI.isBusy(key) : false;
    const has = !!c && !isLoad(c);

    return card(
      '✨ AI ' + title,
      `<div class="row sp" style="margin-bottom:8px">
        <small class="m">Llama 3.2 3B · Cloudflare Workers AI</small>
        <div class="row">
          ${busy ? `<button class="sm bad" onclick="AI_cancel('${key}')">Cancel</button>` : `<button class="sm pri" onclick="${fn}">${has ? 'Regenerate' : 'Generate'}</button>`}
          ${has ? `<button class="sm gh" onclick="copyText(aiState['${key}'])">Copy</button>` : ''}
        </div>
      </div>
      <div class="${c ? 'ai-box' : 'm'} ${/^⚠️/.test(c || '') ? 'ai-err' : ''}">
        ${out(c) || 'Tap Generate to analyze your data with Cloudflare AI.'}
      </div>`
    );
  };

  window.AI_cancel = k => AI.cancel && AI.cancel(k);

  const _clear = window.clearAIHistory;
  window.clearAIHistory = function () {
    H = {};
    saveH();
    aiState.explain = aiState.quiz = aiState.study = '';
    if (typeof _clear === 'function') _clear();
  };

  /* --------------------------------------------------------------------------
     MCQ LOGGING (User-entered records & accuracy tracking)
     -------------------------------------------------------------------------- */
  const mcqs = () => (S.mcq = S.mcq || []);

  window.eq = function (id) {
    const q = mcqs().find(x => x.id == id);
    const ch = S.syl.map(x => x.ch);

    F(
      q ? 'Edit MCQ session' : 'Log MCQ session',
      [
        { k: 'd', l: 'Date', t: 'date', v: q ? q.d : td(), r: 1 },
        ch.length
          ? { k: 'topic', l: 'Topic', t: 'select', o: ch, v: q && q.topic }
          : { k: 'topic', l: 'Topic', v: q && q.topic, r: 1 },
        { k: 'att', l: 'Questions attempted', t: 'number', v: q && q.att, r: 1 },
        { k: 'cor', l: 'Correct answers', t: 'number', v: q && q.cor, r: 1 }
      ],
      o => {
        const att = Math.max(0, Math.round(+o.att));
        let cor = Math.min(att, Math.max(0, Math.round(+o.cor)));
        if (cor != +o.cor) toast('Correct answers cannot exceed attempted. Adjusted.');

        const s = S.syl.find(x => x.ch === o.topic);
        const r = {
          d: o.d,
          topic: o.topic,
          sub: s ? s.sub : 'General',
          part: s ? s.part : '',
          att,
          cor
        };

        if (q) {
          Object.assign(q, r);
        } else {
          mcqs().push({ id: uid(), ...r });
        }
      },
      q && (() => (S.mcq = S.mcq.filter(x => x != q)))
    );
  };

  V.s_mcq = () => {
    const c = AI.buildStudyContext(S);
    const o = c.overall;

    const rows = c.topics
      .map(
        t => `<tr>
          <td>${esc(t.topic)}</td>
          <td>${t.cor}/${t.att}</td>
          <td><b>${t.acc}%</b></td>
          <td>${{ declining: '↓', improving: '↑', steady: '→' }[t.trend] || '–'}</td>
        </tr>`
      )
      .join('');

    const list = mcqs()
      .slice()
      .sort((a, b) => b.d.localeCompare(a.d))
      .slice(0, 20)
      .map(
        q => `<div class="it">
          <span>${q.d} · ${esc(q.topic)}<br><small>${q.cor}/${q.att} correct (${pc(q.cor, q.att)}%)</small></span>
          <button class="sm gh" onclick="eq('${q.id}')">Edit</button>
        </div>`
      )
      .join('');

    return (
      card(
        'MCQ performance (calculated from your entries)',
        o.att
          ? `<div class="big">${o.acc}<small>% · ${o.cor}/${o.att} correct · ${o.wrong} incorrect</small></div>
             <p class="m">Topic accuracy needs ${AI.config.thresholds.minProvisional}+ questions to be meaningful. ↓ = latest session at least ${AI.config.thresholds.drop} pts below earlier ones.</p>
             <div class="sk">
               <table>
                 <tr><th>Topic</th><th>Score</th><th>Acc</th><th>Trend</th></tr>
                 ${rows}
               </table>
             </div>`
          : empty('No MCQ sessions yet. Log one with topic-level results.'),
        '<button class="sm pri" onclick="eq()">Log session</button>'
      ) + card('Sessions', list || empty('Nothing logged.'))
    );
  };

  /* --------------------------------------------------------------------------
     CMA AI COACH TAB & INTERACTION HANDLERS
     -------------------------------------------------------------------------- */
  let lastKind = 'analysis';
  const NAMES = {
    analysis: 'Performance analysis',
    timetable: 'Weekly timetable',
    revision: 'Revision plan',
    weekly: 'Weekly report'
  };

  window.lastKindGet = () => lastKind;

  window.runCoach = async function (kind) {
    if (AI.isBusy && AI.isBusy('study')) return;
    lastKind = kind;
    aiState.study = spin(`Working on ${NAMES[kind].toLowerCase()}…`);
    render();

    try {
      const t = await AI.studyCoach(S, kind);
      aiState.study = t;
      if (!/^Not enough data|^You have \d+ questions/.test(t)) {
        addH('study', NAMES[kind], t);
      }
    } catch (e) {
      aiState.study = '⚠️ ' + e.message;
    }
    render();
  };

  window.runAIStudyAssistant = () => runCoach('analysis');

  window.runExplain = async function () {
    const v = (aiState.explainIn || '').trim();
    if (!v) return toast('Paste a question or concept first.');
    if (AI.isBusy && AI.isBusy('explain')) return;

    aiState.explain = spin('Explaining step by step…');
    render();

    try {
      aiState.explain = await AI.explain(v);
      addH('explain', 'Explanation', aiState.explain);
    } catch (e) {
      aiState.explain = '⚠️ ' + e.message;
    }
    render();
  };

  window.runAIQuizGenerator = async function () {
    if (AI.isBusy && AI.isBusy('quiz')) return;
    const sel = (document.querySelector('#quiz-topic-select') || {}).value || aiState.quizTopic || 'General Revision';
    aiState.quizTopic = sel;
    aiState.quiz = spin(`Generating practice questions on "${esc(sel)}"…`);
    render();

    try {
      const s = S.syl.find(x => x.ch === sel);
      aiState.quiz = await AI.generateQuizQuestions(s ? s.sub : 'General', sel);
      addH('quiz', sel, aiState.quiz);
    } catch (e) {
      aiState.quiz = '⚠️ ' + e.message;
    }
    render();
  };

  window.checkAI = async function () {
    aiStatus = 'Checking API connection…';
    render();
    const r = await AI.ping();
    aiStatus = (r.ok ? '✅ ' : '⚠️ ') + r.msg;
    render();
  };

  window.renderAIQuizCard = () => ''; // Replaced by the dedicated tab view below

  const box = c => `<div class="${c ? 'ai-box' : 'm'} ${/^⚠️/.test(c || '') ? 'ai-err' : ''}">${out(c)}</div>`;

  const hist = k =>
    (H[k] || []).length
      ? `<details class="h">
          <summary>Previous (${H[k].length})</summary>
          ${H[k]
            .map(
              h => `<details class="h">
                <summary>${new Date(h.d).toLocaleString()} · ${esc(h.kind)}</summary>
                <div class="ai-box">${esc(h.text)}</div>
              </details>`
            )
            .join('')}
        </details>`
      : '';

  V.s_coach = () => {
    const c = AI.buildStudyContext(S);
    const busy = AI.isBusy ? AI.isBusy('study') : false;
    const txt = aiState.study;
    const has = txt && !isLoad(txt);
    const dis = busy ? 'disabled' : '';
    const topics = S.syl.map(x => x.ch);
    const o = c.overall;

    return (
      card(
        'CMA AI Coach',
        `<div class="aic">
          <div class="row sp" style="margin-bottom:8px">
            <small class="m">Llama 3.2 3B · Cloudflare Workers AI</small>
            <button class="sm" onclick="checkAI()">Check connection</button>
          </div>
          ${aiStatus ? `<p class="m">${esc(aiStatus)}</p>` : ''}
          <p class="m">Your data: ${
            o.att
              ? `${o.att} MCQs, ${o.acc}% accuracy, ${c.reliable} topic(s) with enough questions`
              : 'no MCQs logged yet'
          } · ${c.hours7}/${c.weekly} h logged in last 7 days.</p>

          <div class="aig">
            ${Object.keys(NAMES)
              .map(
                k =>
                  `<button ${dis} class="${k == lastKind && has ? 'on' : ''}" onclick="runCoach('${k}')">${NAMES[k]}</button>`
              )
              .join('')}
          </div>

          ${busy ? '<button class="bad" style="width:100%;margin-bottom:8px" onclick="AI_cancel(\'study\')">Cancel</button>' : ''}

          ${
            has && !busy
              ? `<div class="row" style="margin-bottom:6px">
                  <button class="sm pri" onclick="runCoach(lastKindGet())">Regenerate</button>
                  <button class="sm gh" onclick="copyText(aiState.study)">Copy</button>
                </div>`
              : ''
          }

          ${txt ? box(txt) : '<p class="m">Pick a report above. AI text is a suggestion; numbers marked “Your data” come from your entries.</p>'}
          ${hist('study')}
        </div>`
      ) +
      card(
        'Explain a mistake or concept',
        `<div class="aic">
          <textarea rows="4" placeholder="Paste a question you got wrong, your answer, and the correct one (if known), or a concept" oninput="aiState.explainIn=this.value">${esc(
            aiState.explainIn
          )}</textarea>
          <div class="row" style="margin:8px 0">
            ${
              AI.isBusy && AI.isBusy('explain')
                ? '<button class="bad" onclick="AI_cancel(\'explain\')">Cancel</button>'
                : '<button class="pri" onclick="runExplain()">Explain step by step</button>'
            }
          </div>
          ${box(aiState.explain)}
          <small class="m">Cloudflare Workers AI: verify calculations against official study materials.</small>
          ${hist('explain')}
        </div>`
      ) +
      card(
        'Practice questions',
        `<div class="aic">
          <label>Topic
            <select id="quiz-topic-select" onchange="aiState.quizTopic=this.value">
              ${
                topics.length
                  ? topics.map(t => `<option ${t == aiState.quizTopic ? 'selected' : ''}>${esc(t)}</option>`).join('')
                  : '<option>General Revision</option>'
              }
            </select>
          </label>
          <div class="row" style="margin-bottom:8px">
            ${
              AI.isBusy && AI.isBusy('quiz')
                ? '<button class="bad" onclick="AI_cancel(\'quiz\')">Cancel</button>'
                : '<button class="pri" onclick="runAIQuizGenerator()">Generate 3 MCQs</button>'
            }
          </div>
          ${box(aiState.quiz)}
          <small class="m">AI-generated practice questions, not official IMA exam questions.</small>
          ${hist('quiz')}
        </div>`
      )
    );
  };

  /* Navigation tab extensions for Study View */
  V.study = () =>
    `<h2>Study</h2>${seg('study', [
      ['plan', 'Planner'],
      ['coach', 'AI Coach'],
      ['mcq', 'MCQs'],
      ['syl', 'Syllabus'],
      ['mock', 'Mocks'],
      ['news', 'Knowledge hub']
    ])}${(V['s_' + ui.sub.study] || V.s_plan)()}`;

  render();
})();
