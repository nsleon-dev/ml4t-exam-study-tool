// Progress model. The synced state is an append-only attempt log plus a few small maps;
// every statistic (per question, per statement, spaced-review schedule, readiness) is
// derived by replaying the log, so two devices merge by simply taking the union.
(() => {
  'use strict';

  const KEY = 'ml4t-study-v2';
  const LOCAL_KEY = 'ml4t-local-v2';
  const V1_KEY = 'ml4t-study-v1';
  const DAY = 86400000;
  // A missed item starts at box 0 (due now). Each clean answer moves it up a box and
  // schedules it this many days out; clearing the last box graduates it.
  const SRS_DAYS = [0, 1, 3, 7];

  const freshSettings = () => ({
    dailyExam: 1, preferUnseen: true, strict: false, forwardOnly: false,
    drill: { parts: ['ML1'], domains: {}, order: 'unseen', count: 10, type: 'all' },
  });
  // Synced across devices.
  const freshSynced = () => ({
    v: 2, attempts: [], pins: {}, notes: {}, exams: [], legacy: {}, settings: freshSettings(), settingsT: 0,
  });
  // This device only: in-progress exam and practice sessions.
  const freshLocal = () => ({ active: null, sessions: {} });

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  // ------------------------------------------------------------ load / save
  let S, L, D;
  const listeners = new Set();

  function read(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; }
  }
  function load() {
    S = read(KEY);
    L = read(LOCAL_KEY) || freshLocal();
    if (!S || S.v !== 2) {
      S = freshSynced();
      const old = read(V1_KEY);
      if (old && old.v === 1) migrateV1(old);
    }
    const f = freshSynced();
    S = { ...f, ...S, settings: { ...f.settings, ...S.settings, drill: { ...f.settings.drill, ...(S.settings || {}).drill } } };
    L = { ...freshLocal(), ...L };
    derive();
  }
  // v1 kept only per-question counters; carry them over as "legacy" stats (no per-statement detail).
  function migrateV1(old) {
    for (const [id, s] of Object.entries(old.q || {})) {
      S.legacy[id] = { n: s.n, c: s.c, t: s.t, last: s.last, lastScore: s.lastScore, srs: s.srs || null };
    }
    for (const [id, t] of Object.entries(old.pins || {})) S.pins[id] = { on: true, t: typeof t === 'number' ? t : Date.now() };
    S.exams = (old.exams || []).map(x => ({ ...x, items: x.items.map(it => ({ ...it, guess: it.guess || [0, 0, 0, 0, 0] })) }));
    S.settings = { ...freshSettings(), ...old.settings };
    L.active = old.active ? { ...old.active, items: old.active.items.map(it => ({ ...it, guess: [0, 0, 0, 0, 0] })) } : null;
  }

  let saveTimer = null;
  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(S));
      localStorage.setItem(LOCAL_KEY, JSON.stringify(L));
    } catch (e) {
      listeners.forEach(fn => fn({ type: 'error', message: 'Could not save progress — browser storage is full or blocked.' }));
    }
  }
  // Synced changes notify the sync layer; local-only changes don't.
  function changed() {
    save();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => listeners.forEach(fn => fn({ type: 'changed' })), 50);
  }
  const saveLocal = () => { try { localStorage.setItem(LOCAL_KEY, JSON.stringify(L)); } catch (e) { /* ignore */ } };

  // ------------------------------------------------------------ derivation
  const newStmt = () => ({ n: 0, c: 0, g: 0, gc: 0, w: 0, last: null, lastGuess: false, lastT: 0, misc: false, srs: null });
  const newQ = () => ({ n: 0, c: 0, t: 0, last: 0, lastScore: null, srs: null, st: [newStmt(), newStmt(), newStmt(), newStmt(), newStmt()] });

  function bump(srs, t) {
    if (!srs) return null;
    const b = srs.box + 1;
    return b >= SRS_DAYS.length ? null : { box: b, due: t + SRS_DAYS[b] * DAY };
  }
  function applyStmt(s, r, guessed, t) {
    s.n++;
    const ok = r === '1';
    if (ok) s.c++;
    if (guessed) { s.g++; if (ok) s.gc++; }
    else if (r === '0') s.w++;
    s.last = r; s.lastGuess = guessed; s.lastT = t;
    // A misconception = answered confidently and got it wrong; cleared by a confident correct answer.
    if (r === '0' && !guessed) s.misc = true;
    else if (ok && !guessed) s.misc = false;
    s.srs = !ok || guessed ? { box: 0, due: t } : bump(s.srs, t);
  }
  function applyAttempt(a) {
    const q = D.q[a.q] || (D.q[a.q] = newQ());
    if (a.k == null) {
      const correct = [...a.r].filter(x => x === '1').length;
      const guessed = a.g.includes('1');
      q.n++; q.c += correct; q.t += 5; q.last = Math.max(q.last, a.t); q.lastScore = correct;
      // A correct guess still sends the question to review.
      q.srs = correct < 5 || guessed ? { box: 0, due: a.t } : bump(q.srs, a.t);
      for (let k = 0; k < 5; k++) applyStmt(q.st[k], a.r[k], a.g[k] === '1', a.t);
    } else {
      q.last = Math.max(q.last, a.t);
      applyStmt(q.st[a.k], a.r, a.g === '1', a.t);
    }
  }
  function derive() {
    D = { q: {} };
    for (const [id, l] of Object.entries(S.legacy)) {
      D.q[id] = { ...newQ(), n: l.n, c: l.c, t: l.t, last: l.last || 0, lastScore: l.lastScore, srs: l.srs };
    }
    S.attempts.sort((a, b) => a.t - b.t);
    for (const a of S.attempts) applyAttempt(a);
  }

  // ------------------------------------------------------------ recording
  // order[k] = original statement index shown at position k; ans/guess are by shown position.
  function recordQuestion(qid, order, ans, guess, source, statements) {
    const r = ['-', '-', '-', '-', '-'], g = ['0', '0', '0', '0', '0'];
    for (let k = 0; k < 5; k++) {
      const si = order[k];
      r[si] = ans[k] === null ? '-' : ans[k] === statements[si].answer ? '1' : '0';
      g[si] = guess && guess[k] ? '1' : '0';
    }
    const a = { i: uid(), q: qid, t: Date.now(), r: r.join(''), g: g.join(''), s: source };
    S.attempts.push(a);
    applyAttempt(a);
    changed();
    return r.filter(x => x === '1').length;
  }
  function recordStatement(qid, k, ok, guessed) {
    const a = { i: uid(), q: qid, k, t: Date.now(), r: ok === null ? '-' : ok ? '1' : '0', g: guessed ? '1' : '0', s: 'card' };
    S.attempts.push(a);
    applyAttempt(a);
    changed();
  }

  // ------------------------------------------------------------ pins, notes, settings, exams
  const isPinned = id => !!(S.pins[id] && S.pins[id].on);
  function togglePin(id) { S.pins[id] = { on: !isPinned(id), t: Date.now() }; changed(); return isPinned(id); }
  const note = id => (S.notes[id] && S.notes[id].text) || '';
  function setNote(id, text) {
    if (note(id) === text) return;
    S.notes[id] = { text, t: Date.now() };
    changed();
  }
  function setting(path, value) {
    let o = S.settings;
    const keys = path.split('.');
    for (const k of keys.slice(0, -1)) o = o[k];
    o[keys[keys.length - 1]] = value;
    S.settingsT = Date.now();
    changed();
  }
  function addExam(result) {
    S.exams.push(result);
    S.exams.sort((a, b) => a.finished - b.finished);
    changed();
  }

  // ------------------------------------------------------------ merge (for sync)
  function merge(a, b) {
    const out = freshSynced();
    const seen = new Set();
    for (const x of [...(a.attempts || []), ...(b.attempts || [])]) {
      if (!seen.has(x.i)) { seen.add(x.i); out.attempts.push(x); }
    }
    out.attempts.sort((x, y) => x.t - y.t);
    for (const key of ['pins', 'notes']) {
      out[key] = { ...(a[key] || {}) };
      for (const [id, v] of Object.entries(b[key] || {})) {
        if (!out[key][id] || v.t > out[key][id].t) out[key][id] = v;
      }
    }
    const ex = new Map();
    for (const x of [...(a.exams || []), ...(b.exams || [])]) ex.set(x.id, x);
    out.exams = [...ex.values()].sort((x, y) => x.finished - y.finished);
    out.legacy = { ...(b.legacy || {}) };
    for (const [id, v] of Object.entries(a.legacy || {})) {
      if (!out.legacy[id] || v.n > out.legacy[id].n) out.legacy[id] = v;
    }
    const newer = (b.settingsT || 0) > (a.settingsT || 0) ? b : a;
    out.settings = { ...freshSettings(), ...(newer.settings || {}) };
    out.settingsT = newer.settingsT || 0;
    return out;
  }
  // Replace the synced state (after a merge with the server copy).
  function replaceSynced(next) {
    S = next;
    save();
    derive();
    listeners.forEach(fn => fn({ type: 'replaced' }));
  }

  function reset() {
    S = freshSynced(); L = freshLocal();
    save(); derive(); changed();
  }
  function importData(data) {
    if (!data || typeof data !== 'object') throw new Error('bad file');
    let next;
    if (data.v === 2 && Array.isArray(data.attempts)) next = data;
    else if (data.v === 1 && data.q) {
      const keep = S; S = freshSynced(); migrateV1(data); next = S; S = keep;
    } else throw new Error('bad file');
    replaceSynced(merge(S, next));
    changed();
  }

  load();

  window.Store = {
    DAY, SRS_DAYS,
    get synced() { return S; },
    get local() { return L; },
    q: id => D.q[id],
    stmt: (id, k) => D.q[id] && D.q[id].st[k],
    recordQuestion, recordStatement, isPinned, togglePin, note, setNote, setting, addExam,
    saveLocal, merge, replaceSynced, reset, importData,
    onChange: fn => listeners.add(fn),
  };
})();
