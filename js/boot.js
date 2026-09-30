// Startup: with Supabase configured, the question pool is only served to signed-in users,
// so show a sign-in screen first, then load the pool (device cache → Supabase) and start the app.
// Without Supabase, load the local copy from private/questions.js.
(() => {
  'use strict';

  const app = document.getElementById('app');
  const Sync = window.Sync;
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ------------------------------------------------------------ theme (works on the sign-in screen too)
  const applyTheme = t => { if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; };
  try { applyTheme(localStorage.getItem('ml4t-theme')); } catch (e) { /* storage blocked */ }
  document.getElementById('themeToggle').onclick = () => {
    const cur = document.documentElement.dataset.theme;
    const dark = cur ? cur === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    applyTheme(dark ? 'light' : 'dark');
    try { localStorage.setItem('ml4t-theme', dark ? 'light' : 'dark'); } catch (e) { /* storage blocked */ }
  };

  // ------------------------------------------------------------ pool cache (IndexedDB)
  const DB = 'ml4t-cache', STORE = 'kv', POOL = 'pool';
  const idb = () => new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  async function cache(mode, fn) {
    try {
      const db = await idb();
      return await new Promise(resolve => {
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(req && req.result);
        tx.onerror = tx.onabort = () => resolve(undefined);
      });
    } catch (e) { return undefined; } // private mode / storage blocked: just skip caching
  }
  const cacheGet = () => cache('readonly', s => s.get(POOL));
  const cacheSet = v => cache('readwrite', s => s.put(v, POOL));
  const clearPool = () => cache('readwrite', s => s.delete(POOL));

  async function loadPool() {
    const cached = await cacheGet();
    try {
      const fresh = await Sync.fetchPool(cached && cached.version);
      if (fresh) { await cacheSet(fresh); return fresh.data; }
    } catch (e) {
      if (!cached) throw e; // offline with a cached copy: keep going
    }
    return cached.data;
  }

  const loadScript = src => new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });

  // ------------------------------------------------------------ sign-in forms (also used by the Account page)
  let mode = 'signin';
  function renderAuth(el, { intro } = {}) {
    const m = mode;
    el.innerHTML = `<div class="card auth-card">
      <div class="eyebrow">ML4T Study</div>
      <h1>${m === 'signup' ? 'Create an account' : m === 'reset' ? 'Reset your password' : 'Sign in'}</h1>
      <p class="muted small">${m === 'reset' ? 'We’ll email you a link to choose a new password.' : esc(intro || 'Sign in to load the question pool and sync your progress across devices.')}</p>
      ${Sync.status === 'error' ? `<p class="small" style="color:var(--bad)">${esc(Sync.error)}</p>` : ''}
      <form class="auth-form">
        <label>Email<input type="email" name="email" required autocomplete="email"></label>
        ${m === 'reset' ? '' : `<label>Password<input type="password" name="pw" required minlength="${m === 'signup' ? 8 : 1}" autocomplete="${m === 'signup' ? 'new-password' : 'current-password'}"></label>`}
        <button class="btn primary" type="submit">${m === 'signup' ? 'Create account' : m === 'reset' ? 'Send reset link' : 'Sign in'}</button>
        <div class="form-msg"></div>
      </form>
      <div class="row small" style="margin-top:14px">
        ${m !== 'signin' ? '<a href="#" data-mode="signin">Have an account? Sign in</a>' : '<a href="#" data-mode="signup">New here? Create an account</a>'}
        <span class="spacer"></span>${m === 'signin' ? '<a href="#" data-mode="reset">Forgot password?</a>' : ''}
      </div></div>`;
    el.querySelectorAll('[data-mode]').forEach(a => a.addEventListener('click', e => {
      e.preventDefault(); mode = a.dataset.mode; renderAuth(el, { intro });
    }));
    const form = el.querySelector('form');
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const msg = form.querySelector('.form-msg'), btn = form.querySelector('button');
      const email = form.email.value.trim(), pw = m === 'reset' ? '' : form.pw.value;
      btn.disabled = true; msg.className = 'form-msg'; msg.textContent = 'Working…';
      try {
        if (m === 'signup') {
          const { needsConfirm } = await Sync.signUp(email, pw);
          msg.textContent = needsConfirm ? 'Check your email to confirm your account, then sign in.' : 'Account created — loading…';
          msg.className = 'form-msg ok';
        } else if (m === 'reset') {
          await Sync.sendReset(email);
          msg.textContent = 'If that email has an account, a reset link is on its way.'; msg.className = 'form-msg ok';
        } else {
          await Sync.signIn(email, pw);
          msg.textContent = 'Signed in — loading…'; msg.className = 'form-msg ok';
        }
      } catch (err) { msg.textContent = err.message; msg.className = 'form-msg err'; }
      btn.disabled = false;
    });
  }
  function renderRecovery(el, onDone) {
    el.innerHTML = `<div class="card auth-card"><div class="eyebrow">Account</div><h1>Choose a new password</h1>
      <form class="auth-form"><label>New password<input type="password" name="pw" minlength="8" required autocomplete="new-password"></label>
      <button class="btn primary" type="submit">Save password</button><div class="form-msg"></div></form></div>`;
    const form = el.querySelector('form');
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const msg = form.querySelector('.form-msg');
      try { await Sync.updatePassword(form.pw.value); onDone(); }
      catch (err) { msg.textContent = err.message; msg.className = 'form-msg err'; }
    });
  }

  // ------------------------------------------------------------ boot
  function showError(title, detail) {
    app.innerHTML = `<div class="card auth-card"><h1>${esc(title)}</h1><p class="muted">${esc(detail)}</p>
      <div class="row" style="margin-top:12px"><button class="btn primary" id="retry">Try again</button>
      ${Sync.user ? '<button class="btn" id="signout">Sign out</button>' : ''}</div></div>`;
    document.getElementById('retry').onclick = () => location.reload();
    const so = document.getElementById('signout');
    if (so) so.onclick = async () => { await Sync.signOut(); await clearPool(); location.reload(); };
  }

  async function boot() {
    if (!Sync.enabled) {
      try { await loadScript('private/questions.js'); }
      catch (e) {
        return showError('No question data', 'Run tools/parse_pool.py to create private/questions.js, or configure Supabase in js/config.js.');
      }
      return window.ML4TApp.start(window.ML4T_DATA);
    }

    document.body.classList.add('gated');
    app.innerHTML = '<div class="empty">Connecting…</div>';
    // Email-confirmation and password-reset links arrive with tokens in the URL hash.
    const authRedirect = /access_token=|error_description=|type=recovery/.test(location.hash);
    await Sync.init();
    if (authRedirect) history.replaceState(null, '', location.pathname + location.search + '#/');

    if (!Sync.user) {
      if (Sync.status === 'error' && !navigator.onLine) return showError('You’re offline', 'Connect to the internet to sign in.');
      renderAuth(app);
      await new Promise(resolve => Sync.on(() => { if (Sync.user) resolve(); }));
    }

    app.innerHTML = '<div class="empty">Loading questions…</div>';
    let data;
    try { data = await loadPool(); }
    catch (e) { return showError('Couldn’t load the question pool', e.message || String(e)); }
    document.body.classList.remove('gated');
    window.ML4TApp.start(data);
    // Signed out here or on another tab (or the session expired): back to the sign-in screen.
    Sync.on(() => { if (!Sync.user && Sync.status === 'signed-out') clearPool().then(() => location.reload()); });
  }

  window.Boot = { renderAuth, renderRecovery, clearPool };
  boot();
})();
