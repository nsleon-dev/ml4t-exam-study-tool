// The app itself. js/boot.js calls ML4TApp.start(data) once the question pool is available.
window.ML4TApp = { start(DATA) {
  'use strict';

  const Store = window.Store;
  const Sync = window.Sync;
  const app = document.getElementById('app');

  // ---------------------------------------------------------------- constants
  const Q = DATA.questions;
  const BY_ID = Object.fromEntries(Q.map(q => [q.id, q]));
  const META = DATA.meta.parts;
  const PARTS = ['ML1', 'QF1', 'ML2', 'QF2'];
  const EXAM_PARTS = { 1: ['ML1', 'QF1'], 2: ['ML2', 'QF2'] };
  const EXAM_MINUTES = 90;
  const DAY = Store.DAY;
  const LETTERS = 'ABCDE';
  const S = () => Store.synced;
  const L = () => Store.local;
  const settings = () => Store.synced.settings;

  // ---------------------------------------------------------------- helpers
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // Question text uses _{x} for subscripts and ^{x} for superscripts (may nest); expand innermost first.
  const expandScripts = (s, sub, sup) => {
    let prev;
    do {
      prev = s;
      s = s.replace(/_\{([^{}]*)\}/g, sub).replace(/\^\{([^{}]*)\}/g, sup);
    } while (s !== prev);
    return s;
  };
  const fmt = s => expandScripts(esc(s), '<sub>$1</sub>', '<sup>$1</sup>');
  const plain = s => expandScripts(String(s), '$1', '^$1');
  const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0);
  const today = () => new Date().toLocaleDateString('en-CA');
  const domainName = (part, d) => META[part].domains[d]?.name || `Domain ${d}`;
  const groupName = q => META[q.part].domains[q.domain]?.groups?.[q.group] || '';
  const sectionOf = part => part.slice(0, 2);
  const secCls = part => sectionOf(part).toLowerCase();
  const qsFor = (part, d) => Q.filter(q => q.part === part && (d == null || q.domain === d));
  const clock = ms => {
    const t = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
  };
  const dateStr = ts => new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const ago = ts => {
    const s = Math.round((Date.now() - ts) / 1000);
    return s < 60 ? 'just now' : s < 3600 ? Math.round(s / 60) + ' min ago' : s < 86400 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' d ago';
  };

  function rngFrom(seed) {
    let h = 1779033703 ^ seed.length;
    for (let i = 0; i < seed.length; i++) { h = Math.imul(h ^ seed.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
    return () => {
      h = Math.imul(h ^ (h >>> 16), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909);
      return ((h ^= h >>> 16) >>> 0) / 4294967296;
    };
  }
  function shuffle(arr, rnd = Math.random) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }
  const blank5 = () => [null, null, null, null, null];
  const zero5 = () => [0, 0, 0, 0, 0];

  function toast(msg) {
    document.querySelectorAll('.toast').forEach(t => t.remove());
    const el = document.createElement('div');
    el.className = 'toast'; el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2600);
  }

  // ---------------------------------------------------------------- derived progress
  const stat = id => Store.q(id);
  const seen = id => !!Store.q(id);
  const seenCount = ids => ids.filter(seen).length;
  const isDue = id => { const s = Store.q(id); return !!(s && s.srs && s.srs.due <= Date.now()); };
  const inReview = id => !!(Store.q(id) && Store.q(id).srs);
  const dueIds = () => Q.filter(q => isDue(q.id)).map(q => q.id);
  const reviewIds = () => Q.filter(q => inReview(q.id)).map(q => q.id);
  const pinIds = () => Q.filter(q => Store.isPinned(q.id)).map(q => q.id);
  const noteIds = () => Q.filter(q => Store.note(q.id)).map(q => q.id);

  function eachStmt(fn, ids = null) {
    for (const q of ids ? ids.map(id => BY_ID[id]) : Q) {
      const s = Store.q(q.id);
      if (s) s.st.forEach((st, k) => { if (st.n) fn(q, k, st); });
    }
  }
  const stmtsWhere = pred => { const out = []; eachStmt((q, k, st) => { if (pred(st)) out.push({ id: q.id, k }); }); return out; };
  const dueStmts = () => stmtsWhere(st => st.srs && st.srs.due <= Date.now());
  const reviewStmts = () => stmtsWhere(st => !!st.srs);
  const miscStmts = () => stmtsWhere(st => st.misc);

  function accuracy(ids) {
    let c = 0, t = 0;
    for (const id of ids) { const s = Store.q(id); if (s) { c += s.c; t += s.t; } }
    return { c, t, pct: t ? pct(c, t) : null };
  }

  // Projected exam score: each domain contributes 2 questions × 5 statements = 10 points.
  // A domain's accuracy uses the latest answer to each statement, shrunk toward the overall
  // average so thinly-practiced domains don't swing the estimate.
  function readiness(n) {
    const doms = [];
    let tc = 0, tn = 0;
    for (const part of EXAM_PARTS[n]) {
      for (const d of Object.keys(META[part].domains).map(Number)) {
        let c = 0, m = 0;
        eachStmt((q, k, st) => { m++; if (st.last === '1') c++; }, qsFor(part, d).map(q => q.id));
        doms.push({ part, d, c, n: m });
        tc += c; tn += m;
      }
    }
    if (tn < 25) return null;
    const prior = tc / tn, K = 8;
    let mean = 0, variance = 0;
    for (const x of doms) {
      const p = (x.c + K * prior) / (x.n + K);
      x.p = p;
      x.points = 10 * p;
      mean += 10 * p;
      variance += 10 * p * (1 - p) + 100 * (p * (1 - p)) / (x.n + K + 1);
    }
    const sd = Math.sqrt(variance);
    return {
      mean: Math.round(mean), lo: Math.max(0, Math.round(mean - 1.645 * sd)), hi: Math.min(200, Math.round(mean + 1.645 * sd)),
      answered: tn, practiced: doms.filter(x => x.n).length, doms,
    };
  }

  // ---------------------------------------------------------------- session builders
  function buildExam(n) {
    const picked = [];
    for (const part of EXAM_PARTS[n]) {
      for (let d = 1; d <= 10; d++) {
        let pool = shuffle(qsFor(part, d));
        if (settings().preferUnseen) pool.sort((a, b) => (seen(a.id) ? 1 : 0) - (seen(b.id) ? 1 : 0));
        picked.push(...pool.slice(0, 2));
      }
    }
    return {
      exam: n, id: 'x' + Date.now(), created: Date.now(), elapsed: 0, limit: EXAM_MINUTES * 60000, cur: 0,
      strict: !!settings().strict, forwardOnly: !!settings().forwardOnly, warned: {},
      items: shuffle(picked).map(q => ({ id: q.id, order: shuffle([0, 1, 2, 3, 4]), ans: blank5(), guess: zero5() })),
    };
  }

  function newSession(key, title, ids, extra = {}) {
    const sess = { key, title, ids, idx: 0, created: Date.now(), orders: {}, ans: {}, guess: {}, checked: {}, results: {}, ...extra };
    for (const id of ids) { sess.orders[id] = shuffle([0, 1, 2, 3, 4]); sess.ans[id] = blank5(); sess.guess[id] = zero5(); }
    L().sessions[key] = sess;
    Store.saveLocal();
    return sess;
  }

  function newCardSession(title, items) {
    const sess = { key: 'cards', kind: 'cards', title, items, idx: 0, created: Date.now(), ans: {}, guess: {}, checked: {}, results: {} };
    L().sessions.cards = sess;
    Store.saveLocal();
    return sess;
  }

  function dailySession(n) {
    const key = 'daily' + n, date = today();
    const existing = L().sessions[key];
    if (existing && existing.date === date) return existing;
    const rnd = rngFrom(date + ':' + n);
    const pool = Q.filter(q => EXAM_PARTS[n].includes(q.part));
    const due = shuffle(pool.filter(q => isDue(q.id)), rnd).slice(0, 2);
    const taken = new Set(due.map(q => q.id));
    const unseen = shuffle(pool.filter(q => !seen(q.id) && !taken.has(q.id)), rnd);
    const acc = q => stat(q.id).c / stat(q.id).t;
    const weak = shuffle(pool.filter(q => seen(q.id) && !taken.has(q.id) && stat(q.id).t), rnd).sort((a, b) => acc(a) - acc(b));
    // Keep the daily set balanced between ML and QF where possible.
    const out = [...due];
    const rest = [...unseen, ...weak];
    for (const sec of ['ML', 'QF', 'ML', 'QF', 'ML']) {
      if (out.length >= 5) break;
      const i = rest.findIndex(q => q.section === sec && !out.includes(q));
      if (i >= 0) out.push(rest.splice(i, 1)[0]);
    }
    for (const q of rest) { if (out.length >= 5) break; if (!out.includes(q)) out.push(q); }
    return newSession(key, `Daily 5 · Exam ${n}`, shuffle(out, rnd).map(q => q.id), { date, exam: n });
  }

  function drillIds(cfg) {
    let pool = Q.filter(q => cfg.parts.includes(q.part)
      && (!cfg.domains[q.part] || !cfg.domains[q.part].length || cfg.domains[q.part].includes(q.domain))
      && (cfg.type === 'all' || (cfg.type === 'reversed') === q.flipped));
    if (cfg.order === 'order') pool = pool.slice();
    else if (cfg.order === 'unseen') pool = shuffle(pool).sort((a, b) => (seen(a.id) ? 1 : 0) - (seen(b.id) ? 1 : 0));
    else if (cfg.order === 'weak') {
      const acc = q => (stat(q.id) && stat(q.id).t ? stat(q.id).c / stat(q.id).t : 0.5);
      pool = shuffle(pool).sort((a, b) => acc(a) - acc(b));
    } else pool = shuffle(pool);
    return cfg.count === 'all' ? pool.map(q => q.id) : pool.slice(0, cfg.count).map(q => q.id);
  }

  // ---------------------------------------------------------------- rendering pieces
  const isEq = line => line.length < 90 && line.includes('=') && !/[.?:]$/.test(line) && !/\b(the|is|of)\b/.test(line);
  function stemHtml(q) {
    return q.stem.map(line => line.startsWith('• ')
      ? `<p class="bullet">• ${fmt(line.slice(2))}</p>`
      : `<p class="${isEq(line) ? 'eq' : ''}">${fmt(line)}</p>`).join('');
  }

  const FLIP_TEXT = 'Reversed scoring: mark a statement <b>True if it is incorrect</b> and <b>False if it is accurate</b>.';
  const flipBanner = q => (q.flipped ? `<div class="flip-banner">⚠ <span>${FLIP_TEXT}</span></div>` : '');
  const keyLabel = (q, v) => (v ? 'True' : 'False') + (q.flipped ? (v ? ' (claim is incorrect)' : ' (claim is accurate)') : '');

  function tfButtons(k, a, g, disabled) {
    return `<span class="tf">
      <button data-act="ans" data-k="${k}" data-v="1" class="${a === true ? 'sel' : ''}" ${disabled ? 'disabled' : ''}>True</button>
      <button data-act="ans" data-k="${k}" data-v="0" class="${a === false ? 'sel' : ''}" ${disabled ? 'disabled' : ''}>False</button>
      <button data-act="guess" data-k="${k}" class="guess ${g ? 'on' : ''}" title="Mark as a guess (G)" aria-pressed="${!!g}" ${disabled ? 'disabled' : ''}>?</button>
    </span>`;
  }

  function stmtHtml(q, st, k, a, g, { reveal, keyOnly, focus }) {
    let cls = 'stmt', expl = '';
    if (keyOnly) {
      cls += ' key';
      expl = `<div class="expl"><span class="verdict key-${st.answer}">Key: ${keyLabel(q, st.answer)}.</span> ${fmt(st.explanation)}</div>`;
    } else if (reveal) {
      cls += a === null ? ' blank' : a === st.answer ? ' correct' : ' wrong';
      const verdict = a === null ? 'Unanswered' : a === st.answer ? 'Correct' : 'Incorrect';
      const conf = g ? ' <span class="pill warn">guess</span>' : a !== null && a !== st.answer ? ' <span class="pill bad">confident miss</span>' : '';
      expl = `<div class="expl"><span class="verdict">${verdict} · Key: ${keyLabel(q, st.answer)}.</span>${conf} ${fmt(st.explanation)}</div>`;
    }
    const focusCls = k === focus && !reveal && !keyOnly ? ' focus' : '';
    return `<li class="${cls}${focusCls}">
      <div class="stmt-main">
        <span class="stmt-letter">${LETTERS[k] || ''}</span>
        <span class="stmt-text">${fmt(st.text)}</span>
        ${keyOnly ? '' : tfButtons(k, a, g, reveal)}
      </div>${expl}
    </li>`;
  }

  function qHead(q, label = '') {
    return `<div class="q-head">
        ${label ? `<span class="eyebrow">${label}</span>` : ''}
        <span class="pill ${q.section.toLowerCase()}">${q.part} · D${q.domain}</span>
        <span class="small muted">${esc(domainName(q.part, q.domain))}</span>
        ${q.flipped ? '<span class="pill warn">reversed</span>' : ''}
        <span class="spacer"></span>
        <span class="q-id">${q.id}</span>
      </div>
      ${groupName(q) ? `<div class="small muted" style="margin:-6px 0 10px">G${q.group}: ${esc(groupName(q))}</div>` : ''}`;
  }

  function questionHtml(q, order, ans, guess, opts = {}) {
    const stmts = order.map((si, k) => stmtHtml(q, q.statements[si], k, ans ? ans[k] : null, guess ? guess[k] : 0, { ...opts, focus: opts.focus ?? -1 })).join('');
    return `${qHead(q, opts.label)}${flipBanner(q)}<div class="q-stem">${stemHtml(q)}</div><ul class="stmts">${stmts}</ul>`;
  }

  function noteHtml(id) {
    const text = Store.note(id);
    return `<div class="note" data-note="${id}">
      ${text
        ? `<div class="note-view"><span class="eyebrow">Your note</span><div class="note-text">${esc(text)}</div><button class="btn small ghost" data-act="note-edit" data-id="${id}">Edit note</button></div>`
        : `<button class="btn small ghost" data-act="note-edit" data-id="${id}">+ Add note</button>`}
    </div>`;
  }
  function openNoteEditor(id) {
    const box = app.querySelector(`[data-note="${id}"]`);
    if (!box) return;
    box.innerHTML = `<textarea class="note-input" data-id="${id}" rows="3" placeholder="Your note on this question — shown whenever it comes back.">${esc(Store.note(id))}</textarea>
      <div class="row small muted" style="margin-top:4px"><span>Saved automatically</span><span class="spacer"></span><button class="btn small" data-act="note-done" data-id="${id}">Done</button></div>`;
    const ta = box.querySelector('textarea');
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }
  // Notes save as you type (debounced) and on blur; handled once for the whole app.
  let noteTimer = null;
  app.addEventListener('input', e => {
    if (!e.target.matches('.note-input')) return;
    clearTimeout(noteTimer);
    const { id } = e.target.dataset, v = e.target.value;
    noteTimer = setTimeout(() => Store.setNote(id, v.trim()), 500);
  });
  app.addEventListener('focusout', e => {
    if (e.target.matches('.note-input')) { clearTimeout(noteTimer); Store.setNote(e.target.dataset.id, e.target.value.trim()); }
  });
  function handleNoteAct(t) {
    if (t.dataset.act === 'note-edit') { openNoteEditor(t.dataset.id); return true; }
    if (t.dataset.act === 'note-done') {
      const id = t.dataset.id;
      const ta = app.querySelector(`.note-input[data-id="${id}"]`);
      if (ta) Store.setNote(id, ta.value.trim());
      const box = app.querySelector(`[data-note="${id}"]`);
      if (box) box.outerHTML = noteHtml(id);
      return true;
    }
    return false;
  }
  const pinBtn = id => `<button class="btn small pin-btn ${Store.isPinned(id) ? 'on' : ''}" data-act="pin" data-id="${id}">${Store.isPinned(id) ? '★ Pinned' : '☆ Pin'}</button>`;
  function togglePin(id) {
    const on = Store.togglePin(id);
    toast(on ? 'Pinned for review' : 'Unpinned');
    return on;
  }

  function ring(score, max, size = 120) {
    const r = size / 2 - 8, c = 2 * Math.PI * r, p = max ? score / max : 0;
    const color = p >= 0.8 ? 'var(--good)' : p >= 0.6 ? 'var(--warn)' : 'var(--bad)';
    return `<svg class="score-ring" viewBox="0 0 ${size} ${size}" style="width:${size}px;height:${size}px" role="img" aria-label="${score} of ${max}">
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--surface-2)" stroke-width="10"/>
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${color}" stroke-width="10" stroke-linecap="round"
        stroke-dasharray="${c * p} ${c}" transform="rotate(-90 ${size / 2} ${size / 2})"/>
      <text x="50%" y="47%" text-anchor="middle" font-size="${size / 5}" font-weight="700" fill="var(--text)">${pct(score, max)}%</text>
      <text x="50%" y="66%" text-anchor="middle" font-size="${size / 10}" fill="var(--muted)">${score}/${max}</text>
    </svg>`;
  }
  const bar = (p, cls = '') => `<div class="bar ${cls}"><span style="width:${p || 0}%"></span></div>`;

  function readinessHtml(n, compact = false) {
    const r = readiness(n);
    if (!r) return `<div class="small muted">Projected score appears after you've answered ~25 statements from this exam's parts.</div>`;
    const w = x => (x / 200) * 100;
    return `<div class="readiness">
      <div class="row" style="align-items:baseline;gap:8px"><span class="${compact ? '' : 'big-num'}" style="${compact ? 'font-weight:700;font-size:18px' : ''}">${r.mean}</span><span class="muted small">/ 200 projected · 90% range ${r.lo}–${r.hi}</span></div>
      <div class="range-bar" title="Projected ${r.mean} (range ${r.lo}–${r.hi})"><span class="rb-range" style="left:${w(r.lo)}%;width:${w(r.hi - r.lo)}%"></span><span class="rb-mean" style="left:${w(r.mean)}%"></span></div>
      <div class="small muted">Based on your latest answer to ${r.answered} statements · ${r.practiced}/20 domains practiced${r.practiced < 20 ? ' (unpracticed domains assume your average)' : ''}</div>
    </div>`;
  }

  // ---------------------------------------------------------------- router
  let cleanup = null;
  let keyHandler = null;
  let currentView = null;
  const routes = [
    [/^\/?$/, viewHome],
    [/^\/exam\/([12])$/, m => viewExamIntro(+m[1])],
    [/^\/exam\/run$/, viewExamRun],
    [/^\/result\/(\w+)$/, m => viewResult(m[1])],
    [/^\/daily\/([12])$/, m => { dailySession(+m[1]); location.replace('#/practice/daily' + m[1]); }],
    [/^\/drill$/, viewDrill],
    [/^\/review$/, viewReview],
    [/^\/cards$/, viewCards],
    [/^\/practice\/(\w+)$/, m => viewPractice(m[1])],
    [/^\/browse$/, viewBrowse],
    [/^\/stats$/, viewStats],
    [/^\/account$/, viewAccount],
  ];
  function route() {
    if (cleanup) { cleanup(); cleanup = null; }
    keyHandler = null;
    app.onclick = null; app.onchange = null;
    const path = location.hash.replace(/^#/, '') || '/';
    document.querySelectorAll('[data-nav]').forEach(a => {
      const n = a.dataset.nav;
      a.classList.toggle('active', n === 'home' ? path === '/' : path.startsWith('/' + n));
    });
    for (const [re, fn] of routes) {
      const m = path.match(re);
      if (m) { currentView = path; fn(m); window.scrollTo(0, 0); return; }
    }
    location.replace('#/');
  }
  window.addEventListener('hashchange', route);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { const m = document.querySelector('.modal-backdrop'); if (m) m.remove(); }
    if (!keyHandler || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target.matches('input, textarea, select')) return;
    keyHandler(e);
  });
  // When another device's progress arrives, refresh read-only views (never mid-question).
  Store.onChange(ev => {
    if (ev.type === 'replaced' && /^\/(|stats|review|browse|drill)$/.test(currentView || '/') && !app.querySelector('.note-input:focus')) route();
  });

  // ---------------------------------------------------------------- home
  function viewHome() {
    const seenN = Q.filter(q => seen(q.id)).length;
    const a = L().active;
    const activeBanner = a ? (() => {
      const answered = a.items.filter(it => it.ans.every(v => v !== null)).length;
      const left = a.limit - (a.strict ? Date.now() - a.created : a.elapsed);
      return `<div class="card row" style="border-color:var(--accent)">
        <div><b>Exam ${a.exam} in progress${a.strict ? ' · strict' : ''}</b><div class="small muted">${answered}/40 questions answered · ${left > 0 ? clock(left) + ' left' : 'time is up'}</div></div>
        <span class="spacer"></span><a class="btn primary" href="#/exam/run">${left > 0 ? 'Resume exam' : 'Submit exam'}</a></div>`;
    })() : '';

    const dn = settings().dailyExam;
    const dsess = L().sessions['daily' + dn];
    const dailyFresh = dsess && dsess.date === today() ? dsess : null;
    const dailyItems = dailyFresh ? dailyFresh.ids.map(id => {
      const q = BY_ID[id], r = dailyFresh.results[id];
      const dot = r == null ? '' : r === 5 ? 'done' : 'part';
      return `<li><span class="dot ${dot}"></span><span class="pill ${q.section.toLowerCase()}">${q.part}·D${q.domain}</span><span class="muted ellipsis" style="flex:1">${esc(domainName(q.part, q.domain))}</span>${r != null ? `<span class="small">${r}/5</span>` : ''}</li>`;
    }).join('') : '';
    const dailyDone = dailyFresh ? Object.keys(dailyFresh.results).length : 0;

    const due = dueIds().length, dueS = dueStmts().length, pins = pinIds().length;

    const examCard = n => {
      const hist = S().exams.filter(x => x.exam === n);
      const best = hist.length ? Math.max(...hist.map(x => x.score)) : null;
      const [ml, qf] = EXAM_PARTS[n];
      const ids = Q.filter(q => q.exam === n).map(q => q.id);
      const cov = seenCount(ids);
      return `<div class="card exam-card">
        <div class="eyebrow">Practice exam</div>
        <h2>Exam ${n}</h2>
        <div class="muted small">${ml} + ${qf} · 40 questions · ${EXAM_MINUTES} minutes · 200 points</div>
        <div class="split"><span class="pill ml">ML · 10 domains × 2</span><span class="pill qf">QF · 10 domains × 2</span></div>
        ${readinessHtml(n, true)}
        <div class="row small muted" style="margin:12px 0 6px"><span>Pool coverage</span><span class="spacer"></span><span>${cov}/${ids.length} seen</span></div>
        ${bar(pct(cov, ids.length))}
        <div class="row" style="margin-top:16px">
          <a class="btn primary" href="#/exam/${n}">${a && a.exam === n ? 'Resume' : 'Start exam'}</a>
          <span class="small muted">${hist.length ? `${hist.length} attempt${hist.length > 1 ? 's' : ''} · best ${best}/200` : 'No attempts yet'}</span>
        </div>
      </div>`;
    };

    const partCard = p => {
      const ids = qsFor(p).map(q => q.id);
      const cov = seenCount(ids), acc = accuracy(ids);
      return `<a class="card ${secCls(p)}" href="#/drill" data-act="drill-part" data-part="${p}" style="text-decoration:none;color:inherit">
        <div class="row"><b>${p}</b><span class="spacer"></span><span class="small muted">${acc.pct == null ? '—' : acc.pct + '%'}</span></div>
        <div class="small muted" style="margin:2px 0 10px">${esc(META[p].title)}</div>
        ${bar(pct(cov, ids.length), secCls(p))}
        <div class="small muted" style="margin-top:6px">${cov}/${ids.length} seen</div>
      </a>`;
    };

    const recent = S().exams.slice(-5).reverse();

    app.innerHTML = `
      <div class="hero">
        <div>
          <div class="eyebrow">CS 7646 · Machine Learning for Trading</div>
          <h1>Study the exam question pool</h1>
          <div class="muted">${Q.length} questions · ${Q.length * 5} graded statements · Exam 1 = ML1 + QF1 · Exam 2 = ML2 + QF2</div>
        </div>
        <div class="row"><span class="pill good">${seenN} seen</span><span class="pill">${Q.length - seenN} unseen</span></div>
      </div>
      <div class="stack">
        ${activeBanner}
        <div class="grid grid-2">
          <div class="card">
            <div class="row"><div><div class="eyebrow">Daily 5</div><h2 style="margin:2px 0 0">Today's questions</h2></div><span class="spacer"></span>
              <div class="seg" role="group" aria-label="Daily exam">
                <button data-act="daily-exam" data-n="1" class="${dn === 1 ? 'on' : ''}">Exam 1</button>
                <button data-act="daily-exam" data-n="2" class="${dn === 2 ? 'on' : ''}">Exam 2</button>
              </div></div>
            ${dailyFresh ? `<ul class="daily-list">${dailyItems}</ul>` : `<p class="muted">Five questions picked for today — due reviews first, then unseen questions, balanced across ML and QF.</p>`}
            <a class="btn primary" href="#/daily/${dn}">${!dailyFresh ? 'Start Daily 5' : dailyDone >= 5 ? 'Review today\'s set' : dailyDone ? 'Continue' : 'Start Daily 5'}</a>
            ${dailyFresh ? `<span class="small muted" style="margin-left:10px">${dailyDone}/5 done</span>` : ''}
          </div>
          <div class="card">
            <div class="eyebrow">Spaced review</div>
            <h2 style="margin:2px 0 12px">Missed, guessed & pinned</h2>
            <div class="kpis" style="grid-template-columns:repeat(3,1fr)">
              <div class="kpi"><div class="label">Questions due</div><div class="value">${due}</div></div>
              <div class="kpi"><div class="label">Statements due</div><div class="value">${dueS}</div></div>
              <div class="kpi"><div class="label">Pinned</div><div class="value">${pins}</div></div>
            </div>
            <div class="row" style="margin-top:16px">
              <a class="btn ${due ? 'primary' : ''}" href="#/review">${due ? `Review ${due} due` : 'Open review'}</a>
              ${dueS ? `<a class="btn" href="#/cards" data-act="cards-due">Flashcards (${dueS})</a>` : ''}
            </div>
          </div>
        </div>
        <div class="section"><h2>Practice exams</h2><div class="grid grid-2">${examCard(1)}${examCard(2)}</div></div>
        <div class="section"><div class="row" style="margin-bottom:12px"><h2 style="margin:0">Domain drill</h2><span class="spacer"></span><a href="#/drill" class="small">Custom drill →</a></div>
          <div class="grid grid-3" style="grid-template-columns:repeat(auto-fit,minmax(200px,1fr))">${PARTS.map(partCard).join('')}</div></div>
        ${recent.length ? `<div class="section"><div class="row" style="margin-bottom:12px"><h2 style="margin:0">Recent exams</h2><span class="spacer"></span><a href="#/stats" class="small">All history →</a></div>
          <div class="card" style="padding:4px 8px"><div class="table-wrap">${historyTable(recent)}</div></div></div>` : ''}
      </div>`;

    app.onclick = e => {
      const t = e.target.closest('[data-act]');
      if (!t) return;
      if (t.dataset.act === 'daily-exam') { Store.setting('dailyExam', +t.dataset.n); viewHome(); }
      if (t.dataset.act === 'drill-part') Store.setting('drill.parts', [t.dataset.part]);
      if (t.dataset.act === 'cards-due') newCardSession('Flashcards · due statements', shuffle(dueStmts()));
    };
  }

  function historyTable(list) {
    return `<table class="table"><thead><tr><th>Date</th><th>Exam</th><th class="num">ML</th><th class="num">QF</th><th class="num">Score</th><th class="num">Time</th><th></th></tr></thead><tbody>
      ${list.map(x => `<tr>
        <td>${dateStr(x.finished)}${x.strict ? ' <span class="pill">strict</span>' : ''}</td><td>Exam ${x.exam}</td>
        <td class="num">${x.bySection.ML}/100</td><td class="num">${x.bySection.QF}/100</td>
        <td class="num"><b>${x.score}</b>/200 <span class="muted small">(${pct(x.score, 200)}%)</span></td>
        <td class="num">${clock(x.elapsed)}</td>
        <td class="num"><a href="#/result/${x.id}">Review</a></td></tr>`).join('')}
    </tbody></table>`;
  }

  // ---------------------------------------------------------------- exam
  function viewExamIntro(n) {
    const a = L().active;
    if (a && a.exam === n) { location.replace('#/exam/run'); return; }
    const [ml, qf] = EXAM_PARTS[n];
    const st = settings();
    app.innerHTML = `
      <div class="card" style="max-width:740px;margin:0 auto">
        <div class="eyebrow">Practice exam</div>
        <h1>Exam ${n}: ${ml} + ${qf}</h1>
        <p class="muted">40 questions — two from each of the 10 ${ml} domains and 10 ${qf} domains. Questions and statements are shuffled on every attempt.</p>
        <div class="kpis" style="margin:16px 0">
          <div class="kpi"><div class="label">Questions</div><div class="value">40</div></div>
          <div class="kpi"><div class="label">Time limit</div><div class="value">${EXAM_MINUTES} min</div></div>
          <div class="kpi"><div class="label">Points</div><div class="value">200</div></div>
        </div>
        <ul class="muted small" style="padding-left:18px">
          <li>Each question has five True/False statements, each graded individually: 1 point if correct, 0 if wrong or blank.</li>
          <li>Questions flagged <span class="pill warn">reversed</span> ask you to mark True when a statement is <i>incorrect</i>.</li>
          <li>Tap <span class="kbd">?</span> next to an answer to mark it as a guess — it doesn't change your score, but guessed statements come back for review and feed your confidence stats.</li>
          <li>Keyboard: <span class="kbd">T</span>/<span class="kbd">F</span> answer, <span class="kbd">G</span> guess, <span class="kbd">↑</span><span class="kbd">↓</span> move between statements, <span class="kbd">←</span><span class="kbd">→</span> change question, <span class="kbd">P</span> pin.</li>
        </ul>
        <div class="options">
          <label class="opt"><input type="checkbox" id="optStrict" ${st.strict ? 'checked' : ''}><span><b>Strict timing</b><br><span class="small muted">The clock keeps running if you close or leave the page, like the real exam. Otherwise it pauses while the exam isn't open.</span></span></label>
          <label class="opt"><input type="checkbox" id="optForward" ${st.forwardOnly ? 'checked' : ''}><span><b>No going back</b><br><span class="small muted">Once you move past a question you can't return to it. Pinning is disabled.</span></span></label>
          <label class="opt"><input type="checkbox" id="optUnseen" ${st.preferUnseen ? 'checked' : ''}><span><b>Prefer questions I haven't seen</b></span></label>
        </div>
        ${a ? `<p class="small" style="color:var(--bad)">Starting this exam will discard your in-progress Exam ${a.exam}.</p>` : ''}
        <div class="row"><button class="btn primary" id="startExam">Start Exam ${n}</button><a class="btn ghost" href="#/">Cancel</a></div>
      </div>`;
    document.getElementById('optStrict').onchange = e => Store.setting('strict', e.target.checked);
    document.getElementById('optForward').onchange = e => Store.setting('forwardOnly', e.target.checked);
    document.getElementById('optUnseen').onchange = e => Store.setting('preferUnseen', e.target.checked);
    document.getElementById('startExam').onclick = () => {
      if (a && !confirm(`Discard your in-progress Exam ${a.exam}?`)) return;
      L().active = buildExam(n);
      Store.saveLocal();
      location.hash = '#/exam/run';
    };
  }

  function viewExamRun() {
    const ex = L().active;
    if (!ex) { location.replace('#/'); return; }
    let focus = 0;
    let last = performance.now();
    const elapsed = () => (ex.strict ? Math.min(ex.limit, Date.now() - ex.created) : ex.elapsed);

    const tick = () => {
      if (!ex.strict) { const now = performance.now(); ex.elapsed += now - last; last = now; }
      const left = ex.limit - elapsed();
      for (const el of document.querySelectorAll('#timer, .mobile-timer')) {
        el.textContent = clock(left); el.classList.toggle('low', left < 5 * 60000);
      }
      for (const mins of [10, 5]) {
        if (left <= mins * 60000 && left > 0 && !ex.warned[mins]) { ex.warned[mins] = true; toast(`${mins} minutes left`); }
      }
      if (left <= 0) submitExam(true);
    };
    const timer = setInterval(tick, 1000);
    const saver = setInterval(Store.saveLocal, 5000);
    const onHide = () => { tick(); Store.saveLocal(); };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('beforeunload', onHide);
    cleanup = () => {
      clearInterval(timer); clearInterval(saver);
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('beforeunload', onHide);
      if (L().active) { tick(); Store.saveLocal(); }
    };

    function render() {
      const it = ex.items[ex.cur];
      const q = BY_ID[it.id];
      const answered = ex.items.filter(x => x.ans.every(v => v !== null)).length;
      const nav = ex.items.map((x, i) => {
        const n = x.ans.filter(v => v !== null).length;
        const locked = ex.forwardOnly && i < ex.cur;
        const cls = [n === 5 ? 'done' : n ? 'partial' : '', i === ex.cur ? 'cur' : '', Store.isPinned(x.id) && !ex.forwardOnly ? 'pinned' : '', locked ? 'locked' : ''].join(' ');
        return `<button data-act="go" data-i="${i}" class="${cls}" ${locked ? 'disabled' : ''} title="Question ${i + 1}">${i + 1}</button>`;
      }).join('');
      const left = ex.limit - elapsed();
      app.innerHTML = `
        <div class="q-layout">
          <div class="card">
            <div class="mobile-timer" style="margin-bottom:8px">${clock(left)}</div>
            ${questionHtml(q, it.order, it.ans, it.guess, { focus, label: `Question ${ex.cur + 1} of 40` })}
            <div class="q-actions">
              ${ex.forwardOnly ? '' : `<button class="btn" data-act="prev" ${ex.cur === 0 ? 'disabled' : ''}>← Prev</button>`}
              <button class="btn primary" data-act="next" ${ex.cur === 39 ? 'disabled' : ''}>Next →</button>
              <span class="spacer"></span>
              ${ex.forwardOnly ? '' : pinBtn(q.id)}
              <button class="btn small ghost" data-act="clear">Clear answers</button>
            </div>
          </div>
          <aside class="q-side card">
            <div class="eyebrow">Exam ${ex.exam}${ex.strict ? ' · strict' : ''} · time left</div>
            <div class="timer ${left < 5 * 60000 ? 'low' : ''}" id="timer">${clock(left)}</div>
            <div class="small muted">${answered}/40 complete${ex.forwardOnly ? ' · no going back' : ''}</div>
            <div class="navgrid">${nav}</div>
            <div class="legend"><span><i style="background:var(--ml-soft);border-color:var(--ml)"></i>Done</span><span><i style="background:var(--warn-soft);border-color:var(--warn)"></i>Partial</span><span><i></i>Empty</span></div>
            <div class="row" style="margin-top:16px">
              <button class="btn primary" data-act="submit" style="flex:1">Submit exam</button>
            </div>
            <div class="row" style="margin-top:8px">
              <a class="btn small ghost" href="#/">${ex.strict ? 'Leave (clock keeps running)' : 'Save & exit'}</a><span class="spacer"></span>
              <button class="btn small ghost" data-act="abandon" style="color:var(--bad)">Abandon</button>
            </div>
          </aside>
        </div>`;
    }

    const go = i => {
      i = Math.max(0, Math.min(39, i));
      if (ex.forwardOnly && i < ex.cur) return;
      if (ex.forwardOnly && i > ex.cur) {
        const skipped = ex.items.slice(ex.cur, i).filter(x => x.ans.some(v => v === null)).length;
        if (skipped && !confirm(`You can't come back to ${i - ex.cur > 1 ? 'these questions' : 'this question'}, and ${skipped > 1 ? 'some have' : 'it has'} blank statements. Continue?`)) return;
      }
      ex.cur = i; focus = 0; Store.saveLocal(); render(); window.scrollTo(0, 0);
    };
    const setAns = (k, v) => {
      const it = ex.items[ex.cur];
      it.ans[k] = it.ans[k] === v ? null : v;
      focus = Math.min(4, k + 1);
      render();
    };
    const toggleGuess = k => { const it = ex.items[ex.cur]; it.guess[k] = it.guess[k] ? 0 : 1; render(); };

    app.onclick = e => {
      const t = e.target.closest('[data-act]');
      if (!t) return;
      const act = t.dataset.act;
      if (act === 'ans') setAns(+t.dataset.k, t.dataset.v === '1');
      else if (act === 'guess') toggleGuess(+t.dataset.k);
      else if (act === 'go') go(+t.dataset.i);
      else if (act === 'prev') go(ex.cur - 1);
      else if (act === 'next') go(ex.cur + 1);
      else if (act === 'pin') { togglePin(ex.items[ex.cur].id); render(); }
      else if (act === 'clear') { const it = ex.items[ex.cur]; it.ans = blank5(); it.guess = zero5(); focus = 0; render(); }
      else if (act === 'submit') submitExam(false);
      else if (act === 'abandon') {
        if (confirm('Abandon this exam? Your answers will be discarded and nothing is recorded.')) { L().active = null; Store.saveLocal(); location.hash = '#/'; }
      }
    };
    keyHandler = e => {
      const k = e.key.toLowerCase();
      if (k === 't' || k === 'f') { setAns(focus, k === 't'); e.preventDefault(); }
      else if (k === 'g') { toggleGuess(focus); e.preventDefault(); }
      else if (k === 'arrowdown' || k === 'j') { focus = Math.min(4, focus + 1); render(); e.preventDefault(); }
      else if (k === 'arrowup' || k === 'k') { focus = Math.max(0, focus - 1); render(); e.preventDefault(); }
      else if (k === 'arrowright') go(ex.cur + 1);
      else if (k === 'arrowleft') go(ex.cur - 1);
      else if (k === 'p' && !ex.forwardOnly) { togglePin(ex.items[ex.cur].id); render(); }
    };

    function submitExam(timeUp) {
      if (!L().active) return;
      if (!timeUp) {
        const blanks = ex.items.reduce((n, it) => n + it.ans.filter(v => v === null).length, 0);
        const msg = blanks ? `You have ${blanks} unanswered statement${blanks > 1 ? 's' : ''} (scored as 0). Submit anyway?` : 'Submit your exam?';
        if (!confirm(msg)) return;
      }
      const used = Math.min(elapsed(), ex.limit);
      const bySection = { ML: 0, QF: 0 };
      let score = 0;
      for (const it of ex.items) {
        const q = BY_ID[it.id];
        it.score = Store.recordQuestion(it.id, it.order, it.ans, it.guess, 'exam', q.statements);
        score += it.score;
        bySection[q.section] += it.score;
      }
      const result = {
        id: ex.id, exam: ex.exam, created: ex.created, finished: Date.now(), elapsed: used, score, bySection,
        items: ex.items.map(({ id, order, ans, guess, score: s }) => ({ id, order, ans, guess, score: s })),
        timeUp, strict: ex.strict, forwardOnly: ex.forwardOnly,
      };
      L().active = null;
      Store.saveLocal();
      Store.addExam(result);
      if (timeUp) toast('Time is up — exam submitted.');
      location.hash = '#/result/' + result.id;
    }

    if (ex.limit - elapsed() <= 0) { submitExam(true); return; }
    render();
  }

  function viewResult(id) {
    const x = S().exams.find(e => e.id === id);
    if (!x) { app.innerHTML = '<div class="empty">Exam not found. <a href="#/">Go home</a></div>'; return; }
    let filter = 'all';
    const dom = {};
    let gN = 0, gC = 0, confMiss = 0;
    for (const it of x.items) {
      const q = BY_ID[it.id];
      const k = q.part + ':' + q.domain;
      (dom[k] = dom[k] || { part: q.part, d: q.domain, s: 0, n: 0 });
      dom[k].s += it.score; dom[k].n += 5;
      it.order.forEach((si, pos) => {
        const ok = it.ans[pos] === q.statements[si].answer;
        if (it.guess && it.guess[pos]) { gN++; if (ok) gC++; }
        else if (it.ans[pos] !== null && !ok) confMiss++;
      });
    }
    const domRows = Object.values(dom).sort((a, b) => PARTS.indexOf(a.part) - PARTS.indexOf(b.part) || a.d - b.d);

    function render() {
      const items = x.items.map((it, i) => ({ it, i })).filter(({ it }) =>
        filter === 'all' || (filter === 'missed' ? it.score < 5 : filter === 'guessed' ? (it.guess || []).some(Boolean) : Store.isPinned(it.id)));
      app.innerHTML = `
        <div class="card">
          <div class="result-head">
            ${ring(x.score, 200)}
            <div style="flex:1;min-width:220px">
              <div class="eyebrow">Exam ${x.exam} result${x.strict ? ' · strict timing' : ''}${x.timeUp ? ' · time expired' : ''}</div>
              <h1>${x.score} / 200</h1>
              <div class="muted">${dateStr(x.finished)} · ${clock(x.elapsed)} used of ${EXAM_MINUTES}:00</div>
              <div class="row" style="margin-top:12px">
                <span class="pill ml">ML ${x.bySection.ML}/100</span>
                <span class="pill qf">QF ${x.bySection.QF}/100</span>
                <span class="pill good">${x.items.filter(it => it.score === 5).length} perfect questions</span>
                ${gN ? `<span class="pill warn">${gN} guesses · ${gC} right</span>` : ''}
                ${confMiss ? `<span class="pill bad">${confMiss} confident misses</span>` : ''}
              </div>
            </div>
            <div class="row"><a class="btn primary" href="#/exam/${x.exam}">Retake</a><a class="btn" href="#/review">Review missed</a></div>
          </div>
        </div>
        <div class="section"><h2>By domain</h2>
          <div class="card" style="padding:4px 8px"><div class="table-wrap"><table class="table"><thead><tr><th>Domain</th><th style="width:30%"></th><th class="num">Score</th></tr></thead><tbody>
          ${domRows.map(r => `<tr><td><span class="pill ${secCls(r.part)}">${r.part}·D${r.d}</span> ${esc(domainName(r.part, r.d))}</td>
            <td>${bar(pct(r.s, r.n), secCls(r.part))}</td><td class="num">${r.s}/${r.n}</td></tr>`).join('')}
          </tbody></table></div></div></div>
        <div class="section">
          <div class="row" style="margin-bottom:4px"><h2 style="margin:0">Answer review</h2><span class="spacer"></span>
            <div class="seg">
              <button data-act="f" data-f="all" class="${filter === 'all' ? 'on' : ''}">All 40</button>
              <button data-act="f" data-f="missed" class="${filter === 'missed' ? 'on' : ''}">Missed (${x.items.filter(it => it.score < 5).length})</button>
              <button data-act="f" data-f="guessed" class="${filter === 'guessed' ? 'on' : ''}">Guessed</button>
              <button data-act="f" data-f="pinned" class="${filter === 'pinned' ? 'on' : ''}">Pinned</button>
            </div></div>
          ${items.length ? items.map(({ it, i }) => {
            const q = BY_ID[it.id];
            const cls = it.score === 5 ? 'good' : it.score >= 3 ? 'warn' : 'bad';
            return `<details class="review-q"><summary><b style="width:28px">${i + 1}</b><span class="pill ${cls}">${it.score}/5</span>
              <span class="pill ${q.section.toLowerCase()}">${q.part}·D${q.domain}</span><span class="sum-text">${esc(plain(q.stem[0]))}</span></summary>
              <div class="review-body">${questionHtml(q, it.order, it.ans, it.guess, { reveal: true })}
                <div class="q-actions">${pinBtn(q.id)}</div>${noteHtml(q.id)}
              </div></details>`;
          }).join('') : '<div class="empty">Nothing to show.</div>'}
        </div>`;
    }
    app.onclick = e => {
      const t = e.target.closest('[data-act]');
      if (!t || handleNoteAct(t)) return;
      if (t.dataset.act === 'f') { filter = t.dataset.f; render(); }
      if (t.dataset.act === 'pin') {
        togglePin(t.dataset.id);
        t.outerHTML = pinBtn(t.dataset.id);
      }
    };
    render();
  }

  // ---------------------------------------------------------------- practice runner (daily / drill / review)
  function viewPractice(key) {
    const sess = L().sessions[key];
    if (!sess || !sess.ids || !sess.ids.length) { location.replace(key.startsWith('daily') ? '#/' : key === 'review' ? '#/review' : '#/drill'); return; }
    let focus = 0;
    for (const id of sess.ids) if (!sess.guess[id]) sess.guess[id] = zero5();
    const source = key.startsWith('daily') ? 'daily' : key;

    function render() {
      if (sess.idx >= sess.ids.length) return renderSummary();
      const id = sess.ids[sess.idx];
      const q = BY_ID[id];
      const checked = !!sess.checked[id];
      const done = Object.keys(sess.results).length;
      const got = Object.values(sess.results).reduce((a, b) => a + b, 0);
      const nav = sess.ids.map((qid, i) => {
        const r = sess.results[qid];
        const cls = [r == null ? '' : r === 5 ? 'good' : r >= 3 ? 'mid' : 'bad', i === sess.idx ? 'cur' : '', Store.isPinned(qid) ? 'pinned' : ''].join(' ');
        return `<button data-act="go" data-i="${i}" class="${cls}">${i + 1}</button>`;
      }).join('');
      const s = stat(id);
      const history = s && s.n ? `Seen ${s.n}× · ${pct(s.c, s.t)}% of statements correct${s.srs ? ' · in review' : ''}` : 'First time seeing this question';
      app.innerHTML = `
        <div class="q-layout">
          <div class="card">
            ${questionHtml(q, sess.orders[id], sess.ans[id], sess.guess[id], { reveal: checked, focus, label: `${sess.idx + 1} / ${sess.ids.length}` })}
            ${checked ? `<div class="row" style="margin-top:14px"><span class="pill ${sess.results[id] === 5 ? 'good' : sess.results[id] >= 3 ? 'warn' : 'bad'}">${sess.results[id]}/5 correct</span></div>` : ''}
            <div class="q-actions">
              <button class="btn" data-act="prev" ${sess.idx === 0 ? 'disabled' : ''}>←</button>
              ${checked
                ? `<button class="btn primary" data-act="next">${sess.idx === sess.ids.length - 1 ? 'Finish' : 'Next →'}</button>`
                : `<button class="btn primary" data-act="check">Check answers</button><button class="btn ghost" data-act="next">Skip</button>`}
              <span class="spacer"></span>
              ${pinBtn(id)}
            </div>
            ${noteHtml(id)}
            <div class="small muted" style="margin-top:14px">${history} · <span class="kbd">T</span>/<span class="kbd">F</span> answer · <span class="kbd">G</span> guess · <span class="kbd">Enter</span> check / next</div>
          </div>
          <aside class="q-side card">
            <div class="eyebrow">${esc(sess.title)}</div>
            <div class="big-num" style="margin-top:6px">${done ? pct(got, done * 5) + '%' : '—'}</div>
            <div class="small muted">${got}/${done * 5} statements · ${done}/${sess.ids.length} checked</div>
            <div class="navgrid">${nav}</div>
            <div class="row"><button class="btn small" data-act="end">End session</button></div>
          </aside>
        </div>`;
    }

    function renderSummary() {
      const done = Object.keys(sess.results);
      const got = Object.values(sess.results).reduce((a, b) => a + b, 0);
      const missed = done.filter(id => sess.results[id] < 5);
      app.innerHTML = `
        <div class="card" style="max-width:760px;margin:0 auto">
          <div class="result-head">
            ${ring(got, done.length * 5)}
            <div style="flex:1">
              <div class="eyebrow">${esc(sess.title)} · complete</div>
              <h1>${done.length} question${done.length === 1 ? '' : 's'} checked</h1>
              <div class="muted">${got}/${done.length * 5} statements correct · ${missed.length} question${missed.length === 1 ? '' : 's'} added to spaced review</div>
            </div>
          </div>
          <div class="section">
            ${sess.ids.map((id, i) => {
              const q = BY_ID[id], r = sess.results[id];
              return `<div class="row" style="padding:8px 0;border-bottom:1px solid var(--border)"><b style="width:24px">${i + 1}</b>
                <span class="pill ${r == null ? '' : r === 5 ? 'good' : r >= 3 ? 'warn' : 'bad'}">${r == null ? 'skipped' : r + '/5'}</span>
                <span class="pill ${q.section.toLowerCase()}">${q.part}·D${q.domain}</span>
                <a href="#" data-act="go" data-i="${i}" class="ellipsis" style="flex:1">${esc(plain(q.stem[0]))}</a></div>`;
            }).join('')}
          </div>
          <div class="row" style="margin-top:20px">
            <a class="btn primary" href="#/">Home</a>
            ${key === 'drill' ? '<a class="btn" href="#/drill">New drill</a>' : ''}
            ${missed.length ? '<button class="btn" data-act="retry">Retry missed</button>' : ''}
          </div>
        </div>`;
    }

    const go = i => { sess.idx = Math.max(0, Math.min(sess.ids.length, i)); focus = 0; Store.saveLocal(); render(); window.scrollTo(0, 0); };
    const check = () => {
      const id = sess.ids[sess.idx];
      if (sess.checked[id]) return;
      const q = BY_ID[id];
      sess.results[id] = Store.recordQuestion(id, sess.orders[id], sess.ans[id], sess.guess[id], source, q.statements);
      sess.checked[id] = true;
      Store.saveLocal(); render();
    };
    const setAns = (k, v) => {
      const id = sess.ids[sess.idx];
      if (sess.checked[id]) return;
      sess.ans[id][k] = sess.ans[id][k] === v ? null : v;
      focus = Math.min(4, k + 1);
      Store.saveLocal(); render();
    };
    const toggleGuess = k => {
      const id = sess.ids[sess.idx];
      if (sess.checked[id]) return;
      sess.guess[id][k] = sess.guess[id][k] ? 0 : 1;
      Store.saveLocal(); render();
    };

    app.onclick = e => {
      const t = e.target.closest('[data-act]');
      if (!t || handleNoteAct(t)) return;
      const act = t.dataset.act;
      if (act === 'ans') setAns(+t.dataset.k, t.dataset.v === '1');
      else if (act === 'guess') toggleGuess(+t.dataset.k);
      else if (act === 'check') check();
      else if (act === 'next') go(sess.idx + 1);
      else if (act === 'prev') go(sess.idx - 1);
      else if (act === 'go') { e.preventDefault(); go(+t.dataset.i); }
      else if (act === 'pin') { togglePin(sess.ids[sess.idx]); render(); }
      else if (act === 'end') go(sess.ids.length);
      else if (act === 'retry') {
        const missed = sess.ids.filter(id => sess.results[id] != null && sess.results[id] < 5);
        newSession('drill', 'Retry missed', missed);
        if (key === 'drill') route(); else location.hash = '#/practice/drill';
      }
    };
    keyHandler = e => {
      if (sess.idx >= sess.ids.length) return;
      const k = e.key.toLowerCase();
      const checked = !!sess.checked[sess.ids[sess.idx]];
      if ((k === 't' || k === 'f') && !checked) { setAns(focus, k === 't'); e.preventDefault(); }
      else if (k === 'g' && !checked) { toggleGuess(focus); e.preventDefault(); }
      else if (k === 'enter') { checked ? go(sess.idx + 1) : check(); e.preventDefault(); }
      else if (k === 'arrowdown' || k === 'j') { focus = Math.min(4, focus + 1); render(); e.preventDefault(); }
      else if (k === 'arrowup' || k === 'k') { focus = Math.max(0, focus - 1); render(); e.preventDefault(); }
      else if (k === 'arrowright') go(sess.idx + 1);
      else if (k === 'arrowleft') go(sess.idx - 1);
      else if (k === 'p') { togglePin(sess.ids[sess.idx]); render(); }
    };
    render();
  }

  // ---------------------------------------------------------------- statement flashcards
  function viewCards() {
    const sess = L().sessions.cards;
    if (!sess || !sess.items.length) { location.replace('#/review'); return; }
    const keyOf = it => it.id + ':' + it.k;

    function render() {
      if (sess.idx >= sess.items.length) return renderSummary();
      const it = sess.items[sess.idx], key = keyOf(it);
      const q = BY_ID[it.id], st = q.statements[it.k];
      const checked = !!sess.checked[key];
      const a = sess.ans[key] ?? null, g = sess.guess[key] || 0;
      const done = Object.keys(sess.results).length;
      const got = Object.values(sess.results).filter(Boolean).length;
      const s = Store.stmt(it.id, it.k);
      const hist = s && s.n ? `Answered ${s.n}× · ${s.c} correct${s.misc ? ' · <span style="color:var(--bad)">last confident answer was wrong</span>' : ''}` : '';
      app.innerHTML = `
        <div class="q-layout">
          <div class="card">
            ${qHead(q, `Card ${sess.idx + 1} / ${sess.items.length}`)}
            ${flipBanner(q)}
            <details class="scenario" ${sess.hideScenario ? '' : 'open'}><summary class="small muted">Scenario</summary><div class="q-stem">${stemHtml(q)}</div></details>
            <ul class="stmts">${stmtHtml(q, st, 0, a, g, { reveal: checked, focus: 0 }).replace('<span class="stmt-letter">A</span>', `<span class="stmt-letter">${LETTERS[it.k]}</span>`)}</ul>
            <div class="q-actions">
              <button class="btn" data-act="prev" ${sess.idx === 0 ? 'disabled' : ''}>←</button>
              ${checked ? `<button class="btn primary" data-act="next">${sess.idx === sess.items.length - 1 ? 'Finish' : 'Next →'}</button>`
                : `<button class="btn primary" data-act="check" ${a === null ? 'disabled' : ''}>Check</button><button class="btn ghost" data-act="next">Skip</button>`}
              <span class="spacer"></span>${pinBtn(it.id)}
            </div>
            ${noteHtml(it.id)}
            <div class="small muted" style="margin-top:14px">${hist ? hist + ' · ' : ''}<span class="kbd">T</span>/<span class="kbd">F</span> answer · <span class="kbd">G</span> guess · <span class="kbd">Enter</span> check / next</div>
          </div>
          <aside class="q-side card">
            <div class="eyebrow">${esc(sess.title)}</div>
            <div class="big-num" style="margin-top:6px">${done ? pct(got, done) + '%' : '—'}</div>
            <div class="small muted">${got}/${done} correct · ${sess.items.length - done} to go</div>
            <label class="row small" style="margin-top:12px;gap:6px"><input type="checkbox" data-act="toggle-scenario" ${sess.hideScenario ? '' : 'checked'}> Show scenario by default</label>
            <div class="row" style="margin-top:12px"><button class="btn small" data-act="end">End session</button></div>
          </aside>
        </div>`;
    }
    function renderSummary() {
      const done = Object.keys(sess.results).length;
      const got = Object.values(sess.results).filter(Boolean).length;
      app.innerHTML = `<div class="card" style="max-width:640px;margin:0 auto"><div class="result-head">${ring(got, done)}
        <div><div class="eyebrow">${esc(sess.title)} · complete</div><h1>${done} statement${done === 1 ? '' : 's'} checked</h1>
        <div class="muted">Missed and guessed statements stay in review; confident correct answers move them to a later day.</div></div></div>
        <div class="row" style="margin-top:20px"><a class="btn primary" href="#/review">Back to review</a><a class="btn" href="#/">Home</a></div></div>`;
    }
    const cur = () => keyOf(sess.items[sess.idx]);
    const go = i => { sess.idx = Math.max(0, Math.min(sess.items.length, i)); Store.saveLocal(); render(); window.scrollTo(0, 0); };
    const setAns = v => { if (sess.checked[cur()]) return; sess.ans[cur()] = sess.ans[cur()] === v ? null : v; Store.saveLocal(); render(); };
    const toggleGuess = () => { if (sess.checked[cur()]) return; sess.guess[cur()] = sess.guess[cur()] ? 0 : 1; Store.saveLocal(); render(); };
    const check = () => {
      const it = sess.items[sess.idx], key = cur();
      const a = sess.ans[key] ?? null;
      if (sess.checked[key] || a === null) return;
      const ok = a === BY_ID[it.id].statements[it.k].answer;
      Store.recordStatement(it.id, it.k, ok, !!sess.guess[key]);
      sess.checked[key] = true; sess.results[key] = ok;
      Store.saveLocal(); render();
    };
    app.onclick = e => {
      const t = e.target.closest('[data-act]');
      if (!t || handleNoteAct(t)) return;
      const act = t.dataset.act;
      if (act === 'ans') setAns(t.dataset.v === '1');
      else if (act === 'guess') toggleGuess();
      else if (act === 'check') check();
      else if (act === 'next') go(sess.idx + 1);
      else if (act === 'prev') go(sess.idx - 1);
      else if (act === 'pin') { togglePin(sess.items[sess.idx].id); render(); }
      else if (act === 'end') go(sess.items.length);
      else if (act === 'toggle-scenario') { sess.hideScenario = !t.checked; Store.saveLocal(); }
    };
    keyHandler = e => {
      if (sess.idx >= sess.items.length) return;
      const k = e.key.toLowerCase();
      if (k === 't' || k === 'f') { setAns(k === 't'); e.preventDefault(); }
      else if (k === 'g') { toggleGuess(); e.preventDefault(); }
      else if (k === 'enter') { sess.checked[cur()] ? go(sess.idx + 1) : check(); e.preventDefault(); }
      else if (k === 'arrowright') go(sess.idx + 1);
      else if (k === 'arrowleft') go(sess.idx - 1);
      else if (k === 'p') { togglePin(sess.items[sess.idx].id); render(); }
    };
    render();
  }

  // ---------------------------------------------------------------- drill setup
  function viewDrill() {
    const cfg = settings().drill;
    const sess = L().sessions.drill;
    const resume = sess && sess.idx < sess.ids.length ? sess : null;
    const saveCfg = () => Store.setting('drill', cfg);

    function render() {
      const doms = cfg.parts.map(p => {
        const sel = cfg.domains[p] || [];
        const items = Object.keys(META[p].domains).map(Number).map(d => {
          const ids = qsFor(p, d).filter(q => cfg.type === 'all' || (cfg.type === 'reversed') === q.flipped).map(q => q.id);
          const cov = seenCount(ids), acc = accuracy(ids);
          return `<label class="domain-item ${ids.length ? '' : 'dim'}">
            <input type="checkbox" data-part="${p}" data-d="${d}" ${sel.includes(d) ? 'checked' : ''}>
            <span class="dn"><b>D${d}</b> ${esc(domainName(p, d))}<span class="small muted"> · ${cov}/${ids.length} seen</span></span>
            ${bar(acc.pct || 0, secCls(p))}
            <span class="cnt">${acc.pct == null ? '—' : acc.pct + '%'}</span>
          </label>`;
        }).join('');
        return `<div class="section" style="margin-top:20px"><div class="row" style="margin-bottom:8px"><h3 style="margin:0">${p} · ${esc(META[p].title)}</h3><span class="spacer"></span>
          <span class="small muted">${sel.length ? sel.length + ' selected' : 'all domains'}</span>
          ${sel.length ? `<button class="btn small ghost" data-act="clear-dom" data-part="${p}">Clear</button>` : ''}</div>
          <div class="domain-list">${items}</div></div>`;
      }).join('');
      const n = drillIds({ ...cfg, count: 'all', order: 'order' }).length;
      app.innerHTML = `
        <h1>Domain drill</h1>
        <p class="muted">Pick parts and domains, then practice with instant feedback and explanations after each question.</p>
        ${resume ? `<div class="card row" style="margin-bottom:16px;border-color:var(--accent)"><div><b>${esc(resume.title)}</b><div class="small muted">Question ${resume.idx + 1} of ${resume.ids.length}</div></div><span class="spacer"></span><a class="btn primary" href="#/practice/drill">Resume</a></div>` : ''}
        <div class="card">
          <div class="row" style="gap:20px;align-items:flex-start">
            <div><div class="eyebrow" style="margin-bottom:6px">Parts</div><div class="chips">
              ${PARTS.map(p => `<button class="chip ${cfg.parts.includes(p) ? 'on' : ''}" data-act="part" data-part="${p}">${p}</button>`).join('')}</div></div>
            <div><div class="eyebrow" style="margin-bottom:6px">Question type</div><div class="seg">
              ${[['all', 'All'], ['normal', 'Normal'], ['reversed', 'Reversed only']].map(([v, l]) => `<button data-act="type" data-v="${v}" class="${cfg.type === v ? 'on' : ''}">${l}</button>`).join('')}</div></div>
            <div><div class="eyebrow" style="margin-bottom:6px">Order</div><div class="seg">
              ${[['unseen', 'Unseen first'], ['weak', 'Weakest first'], ['random', 'Random'], ['order', 'In order']].map(([v, l]) => `<button data-act="order" data-v="${v}" class="${cfg.order === v ? 'on' : ''}">${l}</button>`).join('')}</div></div>
            <div><div class="eyebrow" style="margin-bottom:6px">Questions</div><div class="seg">
              ${[10, 20, 40, 'all'].map(v => `<button data-act="count" data-v="${v}" class="${cfg.count === v ? 'on' : ''}">${v === 'all' ? 'All' : v}</button>`).join('')}</div></div>
          </div>
          <div class="row" style="margin-top:18px"><button class="btn primary" data-act="start" ${n ? '' : 'disabled'}>Start drill · ${cfg.count === 'all' ? n : Math.min(n, cfg.count)} questions</button><span class="small muted">${n} in selection</span></div>
        </div>
        ${doms || '<div class="empty">Select at least one part.</div>'}`;
    }
    app.onclick = e => {
      const t = e.target.closest('[data-act]');
      if (!t) return;
      const act = t.dataset.act;
      if (act === 'part') {
        const p = t.dataset.part;
        cfg.parts = cfg.parts.includes(p) ? cfg.parts.filter(x => x !== p) : PARTS.filter(x => x === p || cfg.parts.includes(x));
      } else if (act === 'order') cfg.order = t.dataset.v;
      else if (act === 'type') cfg.type = t.dataset.v;
      else if (act === 'count') cfg.count = t.dataset.v === 'all' ? 'all' : +t.dataset.v;
      else if (act === 'clear-dom') cfg.domains[t.dataset.part] = [];
      else if (act === 'start') {
        const ids = drillIds(cfg);
        const oneDom = cfg.parts.length === 1 && (cfg.domains[cfg.parts[0]] || []).length === 1;
        const title = (oneDom ? `${cfg.parts[0]} · D${cfg.domains[cfg.parts[0]][0]} drill` : `Drill · ${cfg.parts.join(' + ')}`) + (cfg.type === 'reversed' ? ' · reversed' : '');
        newSession('drill', title, ids);
        location.hash = '#/practice/drill';
        return;
      } else return;
      saveCfg(); render();
    };
    app.onchange = e => {
      const t = e.target;
      if (!t.matches('.domain-item input')) return;
      const p = t.dataset.part, d = +t.dataset.d;
      const sel = new Set(cfg.domains[p] || []);
      t.checked ? sel.add(d) : sel.delete(d);
      cfg.domains[p] = [...sel].sort((a, b) => a - b);
      saveCfg(); render();
    };
    render();
  }

  // ---------------------------------------------------------------- review
  function viewReview() {
    const due = dueIds(), rot = reviewIds(), pins = pinIds();
    const dueS = dueStmts(), rotS = reviewStmts(), misc = miscStmts();
    const resume = ['review', 'cards'].map(k => L().sessions[k]).find(s => s && s.idx < (s.ids || s.items).length);
    const upcoming = rot.filter(id => !isDue(id)).sort((a, b) => stat(a).srs.due - stat(b).srs.due);
    const row = id => {
      const q = BY_ID[id], s = stat(id);
      const when = s && s.srs ? (s.srs.due <= Date.now() ? '<span class="pill bad">due</span>' : `<span class="pill">in ${Math.ceil((s.srs.due - Date.now()) / DAY)}d</span>`) : '';
      return `<tr><td><span class="pill ${q.section.toLowerCase()}">${q.part}·D${q.domain}</span></td>
        <td class="ellipsis" style="max-width:460px">${esc(plain(q.stem[0]))}</td>
        <td class="num">${s && s.lastScore != null ? s.lastScore + '/5' : '—'}</td><td class="num">${when}</td>
        <td class="num">${Store.isPinned(id) ? `<button class="btn small ghost" data-act="unpin" data-id="${id}">Unpin</button>` : ''}</td></tr>`;
    };
    app.innerHTML = `
      <h1>Spaced review</h1>
      <p class="muted">A question or statement enters review when you miss it or mark your answer as a guess. Answer it correctly (and confidently) and it comes back after 1, 3 and 7 days, then graduates. Pinned questions stay here until you unpin them.</p>
      ${resume ? `<div class="card row" style="margin-bottom:16px;border-color:var(--accent)"><div><b>${esc(resume.title)}</b><div class="small muted">${resume.idx + 1} of ${(resume.ids || resume.items).length}</div></div><span class="spacer"></span><a class="btn primary" href="${resume.kind === 'cards' ? '#/cards' : '#/practice/review'}">Resume</a></div>` : ''}
      <h2 style="margin-top:8px">Whole questions</h2>
      <div class="grid grid-3">
        <div class="card"><div class="eyebrow">Due now</div><div class="big-num">${due.length}</div><p class="small muted">Missed or guessed questions ready for another attempt.</p>
          <button class="btn primary" data-act="start" data-set="due" ${due.length ? '' : 'disabled'}>Review due</button></div>
        <div class="card"><div class="eyebrow">In rotation</div><div class="big-num">${rot.length}</div><p class="small muted">Everything in review, including items scheduled later.</p>
          <button class="btn" data-act="start" data-set="all" ${rot.length ? '' : 'disabled'}>Review all</button></div>
        <div class="card"><div class="eyebrow">Pinned</div><div class="big-num">${pins.length}</div><p class="small muted">Questions you flagged with ☆ Pin.</p>
          <button class="btn" data-act="start" data-set="pins" ${pins.length ? '' : 'disabled'}>Review pinned</button></div>
      </div>
      <div class="section"><h2>Statement flashcards</h2>
      <p class="small muted" style="margin-top:-6px">One statement at a time — only the ideas you actually got wrong or guessed.</p>
      <div class="grid grid-3">
        <div class="card"><div class="eyebrow">Statements due</div><div class="big-num">${dueS.length}</div>
          <button class="btn primary" data-act="cards" data-set="due" ${dueS.length ? '' : 'disabled'}>Study due</button></div>
        <div class="card"><div class="eyebrow">All missed / guessed</div><div class="big-num">${rotS.length}</div>
          <button class="btn" data-act="cards" data-set="all" ${rotS.length ? '' : 'disabled'}>Study all</button></div>
        <div class="card"><div class="eyebrow">Misconceptions</div><div class="big-num">${misc.length}</div><p class="small muted">Answered confidently — and wrong. The most important ones to fix.</p>
          <button class="btn" data-act="cards" data-set="misc" ${misc.length ? '' : 'disabled'}>Study misconceptions</button></div>
      </div></div>
      ${due.length + upcoming.length ? `<div class="section"><h2>Question queue</h2><div class="card" style="padding:4px 8px"><div class="table-wrap"><table class="table"><thead><tr><th>Domain</th><th>Question</th><th class="num">Last</th><th class="num">Next</th><th></th></tr></thead><tbody>
        ${[...due, ...upcoming].map(row).join('')}</tbody></table></div></div></div>` : ''}
      ${pins.length ? `<div class="section"><h2>Pinned</h2><div class="card" style="padding:4px 8px"><div class="table-wrap"><table class="table"><thead><tr><th>Domain</th><th>Question</th><th class="num">Last</th><th class="num">Next</th><th></th></tr></thead><tbody>
        ${pins.map(row).join('')}</tbody></table></div></div></div>` : ''}
      ${!rot.length && !pins.length && !rotS.length ? '<div class="empty">Nothing to review yet. Missed and guessed answers from exams, drills and the Daily 5 will show up here.</div>' : ''}`;
    app.onclick = e => {
      const t = e.target.closest('[data-act]');
      if (!t) return;
      if (t.dataset.act === 'unpin') { togglePin(t.dataset.id); viewReview(); }
      if (t.dataset.act === 'start') {
        const set = t.dataset.set;
        const ids = set === 'due' ? due : set === 'pins' ? pins : [...due, ...upcoming];
        newSession('review', set === 'due' ? 'Review · due' : set === 'pins' ? 'Review · pinned' : 'Review · all', shuffle(ids));
        location.hash = '#/practice/review';
      }
      if (t.dataset.act === 'cards') {
        const set = t.dataset.set;
        const items = set === 'due' ? dueS : set === 'misc' ? misc : rotS;
        newCardSession(set === 'due' ? 'Flashcards · due' : set === 'misc' ? 'Flashcards · misconceptions' : 'Flashcards · all missed', shuffle(items));
        location.hash = '#/cards';
      }
    };
  }

  // ---------------------------------------------------------------- browse & search
  const SEARCH = Q.map(q => ({
    id: q.id,
    text: [q.id, domainName(q.part, q.domain), groupName(q), ...q.stem, ...q.statements.flatMap(s => [s.text, s.explanation])].map(plain).join(' \n ').toLowerCase(),
  }));
  const browseState = { q: '', part: 'all', domain: 'all', type: 'all', status: 'all', shown: 25, open: null };

  function viewBrowse() {
    const bs = browseState;
    const statusOf = {
      all: () => true, unseen: id => !seen(id), seen: id => seen(id), review: id => inReview(id),
      pinned: id => Store.isPinned(id), noted: id => !!Store.note(id),
      misc: id => { const s = stat(id); return !!(s && s.st.some(x => x.misc)); },
    };
    function results() {
      const terms = bs.q.toLowerCase().split(/\s+/).filter(Boolean);
      return SEARCH.filter(({ id, text }) => {
        const q = BY_ID[id];
        if (bs.part !== 'all' && q.part !== bs.part) return false;
        if (bs.domain !== 'all' && q.domain !== +bs.domain) return false;
        if (bs.type !== 'all' && (bs.type === 'reversed') !== q.flipped) return false;
        if (!statusOf[bs.status](id)) return false;
        return terms.every(t => text.includes(t));
      }).map(x => x.id);
    }
    function snippet(id) {
      const q = BY_ID[id];
      const terms = bs.q.toLowerCase().split(/\s+/).filter(Boolean);
      const fields = [...q.stem, ...q.statements.flatMap(s => [s.text, s.explanation])].map(plain);
      let src = fields[0];
      if (terms.length) src = fields.find(f => f.toLowerCase().includes(terms[0])) || src;
      let start = 0;
      if (terms.length) { const i = src.toLowerCase().indexOf(terms[0]); start = Math.max(0, i - 60); }
      let s = (start ? '…' : '') + src.slice(start, start + 200) + (src.length > start + 200 ? '…' : '');
      s = esc(s);
      for (const t of terms) s = s.replace(new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), m => `<mark>${m}</mark>`);
      return s;
    }
    function renderList() {
      const ids = results();
      const list = ids.slice(0, bs.shown).map(id => {
        const q = BY_ID[id], s = stat(id);
        const badges = [
          s && s.n ? `<span class="pill ${s.lastScore === 5 ? 'good' : 'warn'}">${s.lastScore}/5</span>` : '<span class="pill">new</span>',
          Store.isPinned(id) ? '<span class="pill warn">★</span>' : '', Store.note(id) ? '<span class="pill">note</span>' : '',
          q.flipped ? '<span class="pill warn">reversed</span>' : '',
        ].join('');
        const open = bs.open === id;
        return `<div class="browse-item ${open ? 'open' : ''}">
          <button class="browse-head" data-act="open" data-id="${id}" aria-expanded="${open}">
            <span class="pill ${q.section.toLowerCase()}">${q.part}·D${q.domain}</span><span class="q-id">${id}</span>${badges}
            <span class="browse-snip">${snippet(id)}</span>
          </button>
          ${open ? `<div class="browse-body">${questionHtml(q, [0, 1, 2, 3, 4], null, null, { keyOnly: true })}
            <div class="q-actions"><button class="btn small primary" data-act="practice" data-id="${id}">Practice this question</button>${pinBtn(id)}</div>
            ${noteHtml(id)}</div>` : ''}
        </div>`;
      }).join('');
      document.getElementById('browseCount').textContent = `${ids.length} question${ids.length === 1 ? '' : 's'}`;
      document.getElementById('browseList').innerHTML = list || '<div class="empty">No matches.</div>';
      document.getElementById('browseMore').innerHTML = ids.length > bs.shown ? `<button class="btn" data-act="more">Show more (${ids.length - bs.shown} left)</button>` : '';
    }
    const domainOptions = () => bs.part === 'all' ? '' : Object.entries(META[bs.part].domains).map(([d, v]) => `<option value="${d}" ${String(bs.domain) === d ? 'selected' : ''}>D${d} · ${esc(v.name)}</option>`).join('');
    app.innerHTML = `
      <h1>Browse & search</h1>
      <p class="muted">Search every question, statement and explanation. Open a question to see its answer key.</p>
      <div class="card browse-controls">
        <input type="search" id="browseQ" placeholder="Search — e.g. Sharpe, Dyna, Bollinger, leakage…" value="${esc(bs.q)}" autocomplete="off">
        <div class="row" style="margin-top:10px;gap:8px">
          <select id="fPart"><option value="all">All parts</option>${PARTS.map(p => `<option ${bs.part === p ? 'selected' : ''}>${p}</option>`).join('')}</select>
          <select id="fDomain" ${bs.part === 'all' ? 'disabled' : ''}><option value="all">All domains</option>${domainOptions()}</select>
          <select id="fType"><option value="all">All types</option><option value="normal" ${bs.type === 'normal' ? 'selected' : ''}>Normal</option><option value="reversed" ${bs.type === 'reversed' ? 'selected' : ''}>Reversed</option></select>
          <select id="fStatus">${[['all', 'Any status'], ['unseen', 'Unseen'], ['seen', 'Seen'], ['review', 'In review'], ['misc', 'Has misconception'], ['pinned', 'Pinned'], ['noted', 'Has note']].map(([v, l]) => `<option value="${v}" ${bs.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
          <span class="spacer"></span><span class="small muted" id="browseCount"></span>
        </div>
      </div>
      <div id="browseList" class="browse-list"></div>
      <div id="browseMore" class="row" style="justify-content:center;margin-top:16px"></div>`;
    const qInput = document.getElementById('browseQ');
    let t = null;
    qInput.oninput = () => { clearTimeout(t); t = setTimeout(() => { bs.q = qInput.value.trim(); bs.shown = 25; renderList(); }, 150); };
    app.onchange = e => {
      const id = e.target.id;
      if (id === 'fPart') { bs.part = e.target.value; bs.domain = 'all'; viewBrowse(); return; }
      if (id === 'fDomain') bs.domain = e.target.value;
      if (id === 'fType') bs.type = e.target.value;
      if (id === 'fStatus') bs.status = e.target.value;
      if (id && id.startsWith('f')) { bs.shown = 25; renderList(); }
    };
    app.onclick = e => {
      const el = e.target.closest('[data-act]');
      if (!el || handleNoteAct(el)) return;
      const act = el.dataset.act;
      if (act === 'open') { bs.open = bs.open === el.dataset.id ? null : el.dataset.id; renderList(); }
      else if (act === 'more') { bs.shown += 25; renderList(); }
      else if (act === 'pin') { togglePin(el.dataset.id); renderList(); }
      else if (act === 'practice') { newSession('drill', `Practice · ${el.dataset.id}`, [el.dataset.id]); location.hash = '#/practice/drill'; }
    };
    keyHandler = e => { if (e.key === '/') { e.preventDefault(); qInput.focus(); } };
    renderList();
    if (!bs.q) qInput.focus();
  }

  // ---------------------------------------------------------------- stats
  function viewStats() {
    const seenN = Q.filter(q => seen(q.id)).length;
    const all = accuracy(Q.map(q => q.id));
    const best = n => { const h = S().exams.filter(x => x.exam === n); return h.length ? Math.max(...h.map(x => x.score)) : null; };
    // Confidence calibration and reversed-vs-normal, from per-statement history.
    let sureN = 0, sureC = 0, gN = 0, gC = 0;
    eachStmt((q, k, st) => { gN += st.g; gC += st.gc; sureN += st.n - st.g; sureC += st.c - st.gc; });
    const rev = accuracy(Q.filter(q => q.flipped).map(q => q.id));
    const norm = accuracy(Q.filter(q => !q.flipped).map(q => q.id));
    const miscN = miscStmts().length;
    const accCell = a => (a.pct == null ? '—' : `${a.pct}%`);

    const readyCard = n => {
      const r = readiness(n);
      const weakest = r ? r.doms.filter(x => x.n).sort((a, b) => a.p - b.p).slice(0, 4) : [];
      return `<div class="card"><div class="eyebrow">Exam ${n} readiness</div>${readinessHtml(n)}
        ${weakest.length ? `<div class="small" style="margin-top:12px"><b>Weakest domains</b>${weakest.map(x => `<div class="row" style="margin-top:6px"><span class="pill ${secCls(x.part)}">${x.part}·D${x.d}</span><span class="ellipsis muted" style="flex:1">${esc(domainName(x.part, x.d))}</span><span>${x.points.toFixed(1)}/10</span></div>`).join('')}</div>` : ''}
      </div>`;
    };

    const partTable = p => {
      const rows = Object.keys(META[p].domains).map(Number).map(d => {
        const ids = qsFor(p, d).map(q => q.id);
        const cov = seenCount(ids), acc = accuracy(ids);
        const due = ids.filter(isDue).length;
        const groups = Object.entries(META[p].domains[d].groups || {}).map(([g, name]) => {
          const gids = qsFor(p, d).filter(q => q.group === +g).map(q => q.id);
          if (!gids.length) return '';
          const ga = accuracy(gids);
          return `<tr class="group-row" data-parent="${p}-${d}" hidden><td class="small" style="padding-left:28px">G${g} · ${esc(name)}</td>
            <td class="num small">${seenCount(gids)}/${gids.length}</td><td>${bar(ga.pct || 0, secCls(p))}</td><td class="num small">${accCell(ga)}</td><td></td><td></td></tr>`;
        }).join('');
        return `<tr class="dom-row" data-act="toggle-groups" data-key="${p}-${d}"><td><span class="caret">▸</span> <b>D${d}</b> ${esc(domainName(p, d))}</td>
          <td class="num">${cov}/${ids.length}</td>
          <td style="width:22%">${bar(acc.pct || 0, secCls(p))}</td>
          <td class="num">${accCell(acc)}</td>
          <td class="num">${due ? `<span class="pill bad">${due}</span>` : ''}</td>
          <td class="num"><a href="#/drill" data-act="drill" data-part="${p}" data-d="${d}">Drill</a></td></tr>${groups}`;
      }).join('');
      const ids = qsFor(p).map(q => q.id), acc = accuracy(ids);
      return `<div class="section"><div class="row" style="margin-bottom:8px"><h2 style="margin:0">${p} · ${esc(META[p].title)}</h2><span class="spacer"></span>
        <span class="small muted">${seenCount(ids)}/${ids.length} seen · ${acc.pct == null ? '—' : acc.pct + '% correct'}</span></div>
        <div class="card" style="padding:4px 8px"><div class="table-wrap"><table class="table"><thead><tr><th>Domain <span class="muted" style="font-weight:400">(click for topic groups)</span></th><th class="num">Seen</th><th>Accuracy</th><th class="num"></th><th class="num">Due</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></div></div>`;
    };
    app.innerHTML = `
      <h1>Stats</h1>
      <div class="kpis" style="margin-top:12px">
        <div class="kpi"><div class="label">Questions seen</div><div class="value">${seenN}<span class="small muted">/${Q.length}</span></div></div>
        <div class="kpi"><div class="label">Statement accuracy</div><div class="value">${accCell(all)}</div></div>
        <div class="kpi"><div class="label">Exams taken</div><div class="value">${S().exams.length}</div></div>
        <div class="kpi"><div class="label">Best Exam 1</div><div class="value">${best(1) ?? '—'}<span class="small muted">${best(1) != null ? '/200' : ''}</span></div></div>
        <div class="kpi"><div class="label">Best Exam 2</div><div class="value">${best(2) ?? '—'}<span class="small muted">${best(2) != null ? '/200' : ''}</span></div></div>
        <div class="kpi"><div class="label">Due for review</div><div class="value">${dueIds().length}</div></div>
      </div>
      <div class="section"><div class="grid grid-2">${readyCard(1)}${readyCard(2)}</div></div>
      <div class="section"><h2>Confidence & question types</h2><div class="grid grid-2">
        <div class="card"><div class="eyebrow">Calibration</div>
          <table class="table"><tbody>
            <tr><td>Confident answers</td><td class="num">${sureN}</td><td class="num"><b>${sureN ? pct(sureC, sureN) + '%' : '—'}</b> correct</td></tr>
            <tr><td>Marked as guess</td><td class="num">${gN}</td><td class="num"><b>${gN ? pct(gC, gN) + '%' : '—'}</b> correct</td></tr>
            <tr><td>Open misconceptions</td><td class="num">${miscN}</td><td class="num">${miscN ? '<a href="#/review">Study them →</a>' : ''}</td></tr>
          </tbody></table>
          <p class="small muted">Well calibrated: confident answers are nearly always right, and guesses sit near 50%. Guesses scoring far above 50% mean you know more than you think.</p></div>
        <div class="card"><div class="eyebrow">Reversed vs normal questions</div>
          <table class="table"><tbody>
            <tr><td>Normal questions</td><td class="num">${norm.t / 5} answered</td><td class="num"><b>${accCell(norm)}</b></td></tr>
            <tr><td>Reversed questions <span class="pill warn">reversed</span></td><td class="num">${rev.t / 5} answered</td><td class="num"><b>${accCell(rev)}</b></td></tr>
          </tbody></table>
          <p class="small muted">${rev.pct != null && norm.pct != null && norm.pct - rev.pct >= 5 ? `You score ${norm.pct - rev.pct} points lower on reversed questions — the flip may be costing you. ` : ''}Drill them with <a href="#/drill" data-act="drill-reversed">Reversed only</a>.</p></div>
      </div></div>
      <div class="section"><h2>Exam history</h2>${S().exams.length
        ? `<div class="card" style="padding:4px 8px"><div class="table-wrap">${historyTable(S().exams.slice().reverse())}</div></div>`
        : '<div class="card empty">No exams yet. <a href="#/exam/1">Take Exam 1</a> or <a href="#/exam/2">Exam 2</a>.</div>'}</div>
      ${PARTS.map(partTable).join('')}
      <div class="section"><h2>Data</h2><div class="card row">
        <span class="small muted" style="flex:1;min-width:220px">${Sync.enabled ? 'Sign in on the <a href="#/account">Account</a> page to sync across devices. ' : ''}Export a backup file any time; importing merges it with your current progress.</span>
        <button class="btn small" data-act="export">Export progress</button>
        <label class="btn small">Import<input type="file" accept="application/json" id="importFile" hidden></label>
        <button class="btn small" data-act="reset" style="color:var(--bad)">Reset all progress</button>
      </div></div>`;
    app.onclick = e => {
      const t = e.target.closest('[data-act]');
      if (!t) return;
      const act = t.dataset.act;
      if (act === 'toggle-groups') {
        const rows = app.querySelectorAll(`.group-row[data-parent="${t.dataset.key}"]`);
        const open = rows.length && rows[0].hidden;
        rows.forEach(r => { r.hidden = !open; });
        t.classList.toggle('open', open);
      } else if (act === 'drill') {
        e.stopPropagation();
        Store.setting('drill', { ...settings().drill, parts: [t.dataset.part], domains: { [t.dataset.part]: [+t.dataset.d] } });
      } else if (act === 'drill-reversed') {
        Store.setting('drill', { ...settings().drill, type: 'reversed', parts: PARTS.slice(), domains: {} });
      } else if (act === 'export') {
        const blob = new Blob([JSON.stringify(S())], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob); a.download = `ml4t-study-progress-${today()}.json`; a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      } else if (act === 'reset') {
        const msg = Sync.user ? 'Erase all progress on this device AND in your account? This cannot be undone.' : 'Erase all progress, exam history, pins and notes? This cannot be undone.';
        if (!confirm(msg)) return;
        (Sync.user ? Sync.deleteCloudCopy() : Promise.resolve()).then(() => { Store.reset(); viewStats(); toast('Progress reset'); }, err => toast(err.message));
      }
    };
    document.getElementById('importFile').onchange = async e => {
      const f = e.target.files[0];
      if (!f) return;
      try {
        const data = JSON.parse(await f.text());
        if (!confirm('Merge the imported progress into your current progress?')) return;
        Store.importData(data);
        viewStats(); toast('Progress imported');
      } catch (err) { toast('That file is not a valid progress export.'); }
    };
  }

  // ---------------------------------------------------------------- account
  function viewAccount() {
    if (!Sync.enabled) {
      app.innerHTML = `<div class="card" style="max-width:640px;margin:0 auto">
        <div class="eyebrow">Account</div><h1>Sync isn't set up yet</h1>
        <p class="muted">Right now your progress is saved only in this browser and the questions load from your local <code>private/</code> folder. To add accounts, cross-device sync and a sign-in-protected question pool, connect a free Supabase project — see the README.</p></div>`;
      return;
    }
    const u = Sync.user;
    if (!u) { Boot.renderAuth(app); return; } // not normally reachable: boot shows sign-in first
    if (Sync.recovery) { Boot.renderRecovery(app, () => { toast('Password updated'); viewAccount(); }); return; }
    const st = Sync.status;
    app.innerHTML = `<div class="card auth-card">
      <div class="eyebrow">Account</div><h1>${esc(u.email || 'Signed in')}</h1>
      <div class="row" style="margin:8px 0 16px"><span class="sync-dot ${st}"></span><span>${syncLabel()}</span></div>
      ${st === 'error' ? `<p class="small" style="color:var(--bad)">${esc(Sync.error)}</p>` : ''}
      <p class="small muted">Your attempts, exam history, pins, notes and settings sync to this account. In-progress exams and practice sessions stay on the device where you started them.</p>
      <div class="row" style="margin-top:16px">
        <button class="btn" data-act="sync">Sync now</button>
        <button class="btn" data-act="signout">Sign out</button>
        <span class="spacer"></span>
        <button class="btn small ghost" data-act="delete" style="color:var(--bad)">Delete cloud copy</button>
      </div></div>`;
    app.onclick = async e => {
      const t = e.target.closest('[data-act]');
      if (!t) return;
      if (t.dataset.act === 'sync') Sync.syncNow();
      if (t.dataset.act === 'signout') {
        const keep = confirm('Keep a copy of your progress on this device after signing out?\n\nOK = keep it here · Cancel = clear it from this device (your account keeps it).\n\nThe question pool is removed from this device either way.');
        try {
          await Sync.signOut();
          if (!keep) Store.reset();
          await Boot.clearPool();
          location.reload();
        } catch (err) { toast(err.message); }
      }
      if (t.dataset.act === 'delete') {
        if (!confirm('Delete the copy of your progress stored in your account? This device keeps its local copy, and it will be uploaded again the next time it syncs. Sign out afterwards if you want to stop syncing.')) return;
        try { await Sync.deleteCloudCopy(); toast('Cloud copy deleted'); } catch (err) { toast(err.message); }
      }
    };
  }

  function syncLabel() {
    const st = Sync.status;
    return st === 'synced' ? `Synced ${ago(Sync.lastSynced)}` : st === 'syncing' ? 'Syncing…' : st === 'offline' ? 'Offline — will sync when you reconnect'
      : st === 'error' ? 'Sync error' : st === 'loading' ? 'Connecting…' : st === 'signed-out' ? 'Not signed in' : 'Local only';
  }
  function renderAccountButton() {
    const el = document.getElementById('accountBtn');
    if (!el) return;
    const u = Sync.user;
    el.innerHTML = Sync.enabled
      ? `<span class="sync-dot ${u ? Sync.status : 'signed-out'}"></span><span class="acct-label">${u ? esc((u.email || '').split('@')[0]) : 'Sign in'}</span>`
      : `<span class="sync-dot off"></span><span class="acct-label">Local</span>`;
    el.title = Sync.enabled ? (u ? `${u.email} · ${syncLabel()}` : 'Sign in to sync across devices') : 'Progress stored in this browser only';
  }
  Sync.on(() => {
    renderAccountButton();
    if (currentView === '/account' && !app.querySelector('input:focus')) viewAccount();
  });

  Store.onChange(ev => { if (ev.type === 'error') toast(ev.message); });

  // ---------------------------------------------------------------- start
  renderAccountButton();
  if (Sync.recovery) location.replace('#/account');
  route();
} };
