/* ==========================================================================
   ASCEND ai_service.js — Cloudflare Workers AI Endpoint Integration
   Model: @cf/meta/llama-3.2-3b-instruct via ascend-ai-api worker
   ========================================================================== */

(function () {
  'use strict';

  // Production Cloudflare Worker Endpoint URL
  const ASCEND_AI_URL = "https://ascend-ai-api.do-freelance-web.workers.dev";

  const CFG = {
    url: ASCEND_AI_URL,
    model: 'llama-3.2-3b-instruct',
    timeouts: { quick: 60000, standard: 90000, study: 120000 },
    availability: { weekday: 4, weekend: 6 }, // 32 hours/week
    thresholds: { weak: 70, minProvisional: 10, minReliable: 20, drop: 10 }
  };

  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const inflight = new Map(); // key -> AbortController

  class AIError extends Error {
    constructor(code, msg) {
      super(msg);
      this.code = code;
    }
  }

  const sum = a => a.reduce((x, y) => x + y, 0);
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : null);
  const iso = d => d.toLocaleDateString('en-CA');
  const daysAgo = n => {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return iso(d);
  };

  /* ---------- Core Network Transport (Cloudflare Workers AI Fetch) ---------- */
  async function askAscendAI(key, prompt, tier = 'standard') {
    if (inflight.has(key)) {
      throw new AIError('busy', 'A request for this section is already running.');
    }

    const controller = new AbortController();
    let timedOut = false;
    const timeoutMs = CFG.timeouts[tier] || 60000;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    inflight.set(key, controller);

    try {
      const response = await fetch(ASCEND_AI_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ prompt }),
        signal: controller.signal
      });

      let data = {};
      try {
        data = await response.json();
      } catch (_) {
        data = {}; // non-JSON body (e.g. HTML error page from the edge)
      }

      if (!response.ok) {
        if (response.status === 403) {
          throw new AIError('cors', data.error || 'This site is not allowed by the AI service (origin mismatch).');
        }
        throw new AIError('http', data.error || `Worker API returned error (${response.status}).`);
      }

      const answer = (data.answer || '').trim();
      if (!answer) {
        throw new AIError('empty', 'The AI returned an empty response. Please try again.');
      }

      return answer;
    } catch (e) {
      if (e instanceof AIError) throw e;
      if (e.name === 'AbortError') {
        throw new AIError(
          timedOut ? 'timeout' : 'cancelled',
          timedOut ? `Timed out after ${timeoutMs / 1000}s. Please retry.` : 'Request cancelled.'
        );
      }
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        throw new AIError('network', 'You appear to be offline. Check your internet connection and retry.');
      }
      const here = (typeof location !== 'undefined' && location.origin) || 'unknown';
      throw new AIError(
        'network',
        `The browser could not complete the request from ${here} to ${ASCEND_AI_URL}. ` +
          'This is usually the worker rejecting this site\'s origin (CORS), or the worker not being deployed.'
      );
    } finally {
      clearTimeout(timer);
      inflight.delete(key);
    }
  }

  const cancel = key => {
    const c = inflight.get(key);
    if (c) c.abort();
  };

  const isBusy = key => inflight.has(key);

  async function ping() {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 5000);
    try {
      const r = await fetch(ASCEND_AI_URL, { method: 'GET', signal: ctl.signal });
      if (r.ok || r.status === 405) {
        return { ok: true, msg: `Cloudflare Workers AI API is online and ready.` };
      }
      return { ok: false, msg: `API health check failed with status ${r.status}.` };
    } catch (e) {
      return { ok: false, msg: 'Cloudflare Workers AI API is unreachable.' };
    } finally {
      clearTimeout(t);
    }
  }

  /* ---------- CMA Study Context Synthesizer ---------- */
  function buildStudyContext(S) {
    const T = CFG.thresholds;
    const syl = S.syl || [];
    const mcq = (S.mcq || [])
      .filter(q => +q.att > 0)
      .slice()
      .sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));

    const map = {};
    mcq.forEach(q => {
      (map[q.topic] = map[q.topic] || { topic: q.topic, sub: q.sub, s: [] }).s.push({
        a: +q.att,
        c: +q.cor
      });
    });

    const topics = Object.values(map)
      .map(t => {
        const a = sum(t.s.map(x => x.a));
        const c = sum(t.s.map(x => x.c));
        const acc = pct(c, a);
        let trend = 'n/a';
        let delta = null;

        if (t.s.length >= 2) {
          const last = t.s[t.s.length - 1];
          const prev = t.s.slice(0, -1);
          const pa = sum(prev.map(x => x.a));
          const pcor = sum(prev.map(x => x.c));
          if (last.a >= 5 && pa >= 5) {
            delta = pct(last.c, last.a) - pct(pcor, pa);
            trend = delta <= -T.drop ? 'declining' : delta >= T.drop ? 'improving' : 'steady';
          }
        }

        const conf = a >= T.minReliable ? 'reliable' : a >= T.minProvisional ? 'provisional' : 'too few';
        return {
          topic: t.topic,
          sub: t.sub,
          att: a,
          cor: c,
          wrong: a - c,
          acc,
          sessions: t.s.length,
          trend,
          delta,
          conf,
          weak: conf !== 'too few' && acc < T.weak,
          strong: conf === 'reliable' && acc >= 80
        };
      })
      .sort((x, y) => x.acc - y.acc);

    const att = sum(mcq.map(q => +q.att));
    const cor = sum(mcq.map(q => +q.cor));
    const wkStart = daysAgo(6);
    const w = mcq.filter(q => q.d >= wkStart);
    const hours7 = Math.round(sum((S.slog || []).filter(l => l.d >= wkStart).map(l => +l.h || 0)) * 10) / 10;
    const done = syl.filter(x => x.done);
    const studying = syl.filter(x => !x.done && map[x.ch]);
    const notStarted = syl.filter(x => !x.done && !map[x.ch]);
    const examDays = S.exam ? Math.ceil((new Date(S.exam + 'T12:00') - new Date()) / 864e5) : null;
    const weekly = CFG.availability.weekday * 5 + CFG.availability.weekend * 2;

    return {
      examDays,
      examDate: S.exam || '',
      weekly,
      hours7,
      overall: { att, cor, wrong: att - cor, acc: pct(cor, att), sessions: mcq.length },
      week: { att: sum(w.map(q => +q.att)), cor: sum(w.map(q => +q.cor)) },
      topics,
      reliable: topics.filter(t => t.conf !== 'too few').length,
      syl: {
        total: syl.length,
        done: done.length,
        pct: pct(done.length, syl.length),
        doneN: done.map(x => x.ch).slice(0, 10),
        studyingN: studying.map(x => x.ch).slice(0, 8),
        notStartedN: notStarted.map(x => x.ch).slice(0, 10)
      },
      mocks: (S.mocks || []).slice(-5).map(m => `${m.d} ${m.sub} ${m.sc}%`)
    };
  }

  function factsText(c) {
    const o = c.overall;
    const L = [];
    L.push('ACTUAL USER DATA:');
    L.push(`Exam: ${c.examDays == null ? 'Date not set' : c.examDays + ' days away (' + c.examDate + ')'}`);
    L.push(`Syllabus chapters marked done: ${c.syl.done}/${c.syl.total}. Done: ${c.syl.doneN.join('; ') || 'none'}. Studying: ${c.syl.studyingN.join('; ') || 'none'}. Not started: ${c.syl.notStartedN.join('; ') || 'none'}`);
    L.push(`MCQs overall: Attempted ${o.att}, Correct ${o.cor}, Incorrect ${o.wrong}, Accuracy ${o.acc == null ? 'N/A' : o.acc + '%'}`);
    L.push(`MCQs last 7 days: Attempted ${c.week.att}, Correct ${c.week.cor}`);
    L.push(`Study hours logged last 7 days: ${c.hours7}`);
    L.push('Practice tests: ' + (c.mocks.join(' | ') || 'none'));
    L.push('Topic MCQ results:');
    c.topics.slice(0, 12).forEach(t => L.push(`- ${t.topic} | Att: ${t.att} | Cor: ${t.cor} | Acc: ${t.acc}% | Trend: ${t.trend}`));
    if (!c.topics.length) L.push('- None logged');
    L.push(`Weak topics: ${c.topics.filter(t => t.weak).map(t => `${t.topic} (${t.acc}%)`).join('; ') || 'None identified'}`);
    L.push(`Study availability target: ${c.weekly}h/week. Hours logged: ${c.hours7}/${c.weekly}.`);
    return L.join('\n');
  }

  const budget = () => DAYS.map((d, i) => `${d} ${i < 5 ? CFG.availability.weekday : CFG.availability.weekend}h`).join(', ');

  const KIND = {
    analysis: 'Write a performance analysis: 1) Current performance 2) Strong topics 3) Weak topics 4) Topics with declining accuracy 5) Revise first 6) Recommended practice target 7) Next week study priorities.',
    timetable: () => `Create a personalized weekly study timetable. Daily hour budget: ${budget()} = 32h total. Include mixed MCQ sessions and revision blocks.`,
    revision: 'Plan 3 to 5 revision sessions based on mistakes. Spread over the week within hour budget: ',
    weekly: 'Write a weekly performance report: hours logged vs planned, MCQ volume and accuracy in last 7 days, and 3 key actions for next week.'
  };

  /* ---------- Service Interface Functions ---------- */
  window.aiService = {
    config: CFG,
    ping,
    cancel,
    isBusy,
    AIError,
    buildStudyContext,

    async studyCoach(S, kind) {
      const c = buildStudyContext(S);
      if ((kind === 'analysis' || kind === 'revision') && !c.overall.att) {
        return 'Not enough data yet. Log MCQ sessions in the MCQs tab (topic, questions attempted, correct) and try again.';
      }
      if ((kind === 'analysis' || kind === 'revision') && !c.reliable) {
        return `You have ${c.overall.att} questions logged (${c.overall.acc}% overall), but no single topic has ${CFG.thresholds.minProvisional}+ questions yet. Log topic-level results and try again.`;
      }
      let instr = KIND[kind];
      if (typeof instr === 'function') instr = instr();
      if (kind === 'revision') instr += budget();
      if (!instr) throw new AIError('kind', 'Unknown request type.');

      const prompt = factsText(c) + '\n\nTASK: ' + instr;
      return await askAscendAI('study', prompt, 'study');
    },

    async explain(text) {
      const prompt = `Explain step-by-step this problem/concept:\n"""${String(text).slice(0, 1500)}"""\n1) Concept in simple words 2) Formula 3) Worked calculation step-by-step 4) Common pitfalls. End with: "Verify calculations against your official study materials."`;
      return await askAscendAI('explain', prompt, 'study');
    },

    async generateQuizQuestions(subject, topic, n = 3) {
      const prompt = `Generate ${n} ORIGINAL CMA-style practice multiple-choice questions (MCQs) on "${topic}" (Subject: ${subject}). Include 4 options (A, B, C, D), specify the correct answer, and provide a clear step-by-step explanation. Start response with "Practice questions (AI-generated, not official IMA exam questions):"`;
      return await askAscendAI('quiz', prompt, 'standard');
    },

    async generateDailyPlan(data) {
      const prompt = `Create a daily plan for ${data.name || 'User'}. Today is ${data.today}. Study goal: ${data.sgoal} hrs. Workout plan today: ${data.fitPlanToday}. Pending tasks: ${JSON.stringify(data.pendingTasks)}. Habits: ${(data.habits || []).join(', ')}. Keep it concise and motivating.`;
      return await askAscendAI('home', prompt, 'quick');
    },

    async generateTaskSuggestions(data) {
      const prompt = `Analyze my tasks for today (${data.today}). Pending: ${JSON.stringify(data.pending)}. Overdue: ${JSON.stringify(data.overdue)}. Provide a prioritized 3-step action plan for today.`;
      return await askAscendAI('tasks', prompt, 'quick');
    },

    async generateStudyPlan(data) {
      const prompt = `Exam in ${data.examDays || 'N/A'} days. Daily study target: ${data.sgoal} hrs. Syllabus completed: ${data.sylDone}/${data.sylTotal} chapters. Weakest topics: ${JSON.stringify(data.weakAreas)}. Suggest a structured 7-day study strategy.`;
      return await askAscendAI('study', prompt, 'standard');
    },

    async generateHealthInsights(data) {
      const prompt = `Analyze today's health metrics: Water ${data.water}/${data.wgoal} glasses, Protein ${data.prot}/${data.pgoal}g, Fruits/Veggies ${data.fv} servings. Consistency: ${data.healthyDays}/14 good days. Give 2 practical, non-medical lifestyle tips.`;
      return await askAscendAI('health', prompt, 'quick');
    },

    async generateFitnessPlan(data) {
      const prompt = `Today's planned workout: ${data.todayPlan}. Recent workout log: ${JSON.stringify(data.recentWorkouts)}. Goals: ${(data.goals || []).join(', ')}. Provide workout routine advice or recovery tips for today.`;
      return await askAscendAI('fitness', prompt, 'quick');
    },

    async generateWeeklyInsights(data) {
      const prompt = `Synthesize performance over the past ${data.period} days. Average score: ${data.avgScore}%, Previous period: ${data.prevScore}%. Study hours: ${data.studyHours}/${data.targetStudyHours} hrs. Tasks: ${data.completedTasks}/${data.totalTasks} completed (${data.missedTasks} overdue). Gym sessions: ${data.gymSessions}/${data.plannedGym}. Habit adherence: ${data.habitRate}%. Weakest dimension: ${data.lowestDimension}. Write a 3-bullet executive weekly productivity summary.`;
      return await askAscendAI('insights', prompt, 'standard');
    }
  };
})();
