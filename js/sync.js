// Accounts + cross-device sync through Supabase (auth + one `progress` row per user).
// Disabled unless js/config.js has a project URL and anon key; the app then runs local-only.
(() => {
  'use strict';

  const cfg = window.ML4T_CONFIG || {};
  const enabled = !!(cfg.supabaseUrl && cfg.supabaseAnonKey);
  const LIB = 'js/vendor/supabase.js'; // supabase-js UMD build, version in js/vendor/SUPABASE_VERSION

  let client = null;
  let user = null;
  let rev = null;           // server revision this device last saw
  let status = enabled ? 'loading' : 'off'; // off | loading | signed-out | syncing | synced | offline | error
  let lastError = '';
  let lastSynced = 0;
  let recovery = false;     // arrived through a password-reset link
  let pushTimer = null;
  let chain = Promise.resolve();
  const listeners = new Set();

  const emit = () => listeners.forEach(fn => { try { fn(); } catch (e) { console.error(e); } });
  const setStatus = (s, err = '') => { status = s; lastError = err; if (s === 'synced') lastSynced = Date.now(); emit(); };
  // Run sync operations one at a time.
  const serial = fn => (chain = chain.then(() => fn()).catch(fail));

  function fail(e) {
    console.warn('sync:', e);
    if (!navigator.onLine) setStatus('offline');
    else setStatus('error', (e && e.message) || String(e));
  }

  function loadLib() {
    return new Promise((resolve, reject) => {
      if (window.supabase) return resolve();
      const s = document.createElement('script');
      s.src = LIB;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Could not load js/vendor/supabase.js.'));
      document.head.appendChild(s);
    });
  }

  async function init() {
    if (!enabled) return;
    try {
      await loadLib();
      client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit' },
      });
      client.auth.onAuthStateChange((event, session) => {
        if (event === 'PASSWORD_RECOVERY') recovery = true;
        const prev = user && user.id;
        user = session ? session.user : null;
        if (!user) { rev = null; setStatus('signed-out'); return; }
        if (user.id !== prev) { rev = null; serial(pull); } else emit();
      });
      const { data } = await client.auth.getSession();
      user = data.session ? data.session.user : null;
      if (user) serial(pull); else setStatus('signed-out');
    } catch (e) { fail(e); }

    window.Store.onChange(ev => { if (ev.type === 'changed') schedulePush(); });
    window.addEventListener('online', () => user && serial(pull));
    document.addEventListener('visibilitychange', () => {
      // Pick up progress made on another device when coming back to this tab.
      if (document.visibilityState === 'visible' && user && Date.now() - lastSynced > 30000) serial(pull);
    });
  }

  function schedulePush() {
    if (!user) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => serial(push), 1500);
  }

  // Fetch the server copy, merge it with this device's, and write back if anything is new.
  async function pull(depth = 0) {
    if (!user) return;
    setStatus('syncing');
    const { data, error } = await client.from('progress').select('data, rev').eq('user_id', user.id).maybeSingle();
    if (error) throw error;
    const local = window.Store.synced;
    if (!data) {
      const { error: e2 } = await client.from('progress').insert({ user_id: user.id, data: local, rev: 1 });
      if (e2) { if (e2.code === '23505' && depth < 3) return pull(depth + 1); throw e2; }
      rev = 1;
      return setStatus('synced');
    }
    rev = data.rev;
    const remote = data.data && data.data.v === 2 ? data.data : {};
    const merged = window.Store.merge(local, remote);
    const mergedJson = JSON.stringify(merged);
    if (mergedJson !== JSON.stringify(local)) window.Store.replaceSynced(merged);
    if (mergedJson !== JSON.stringify(remote)) return push(depth);
    setStatus('synced');
  }

  // Write this device's state, but only if nobody else wrote since we last read (rev check).
  async function push(depth = 0) {
    if (!user) return;
    if (rev == null) return pull(depth);
    setStatus('syncing');
    const { data, error } = await client.from('progress')
      .update({ data: window.Store.synced, rev: rev + 1, updated_at: new Date().toISOString() })
      .eq('user_id', user.id).eq('rev', rev).select('rev');
    if (error) throw error;
    if (!data.length) {
      if (depth >= 3) throw new Error('Could not save: progress keeps changing on another device. Try again.');
      return pull(depth + 1); // another device wrote first: merge its changes, then retry
    }
    rev = data[0].rev;
    setStatus('synced');
  }

  const redirectTo = () => location.origin + location.pathname;
  const authError = e => { throw new Error(e.message || String(e)); };

  window.Sync = {
    enabled,
    init,
    get status() { return status; },
    get error() { return lastError; },
    get user() { return user; },
    get lastSynced() { return lastSynced; },
    get recovery() { return recovery; },
    on: fn => listeners.add(fn),
    syncNow: () => serial(pull),
    async signUp(email, password) {
      const { data, error } = await client.auth.signUp({ email, password, options: { emailRedirectTo: redirectTo() } });
      if (error) authError(error);
      return { needsConfirm: !data.session };
    },
    async signIn(email, password) {
      const { error } = await client.auth.signInWithPassword({ email, password });
      if (error) authError(error);
    },
    async signOut() {
      clearTimeout(pushTimer);
      await chain; // let a pending save finish first
      const { error } = await client.auth.signOut();
      if (error) authError(error);
    },
    async sendReset(email) {
      const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo: redirectTo() });
      if (error) authError(error);
    },
    async updatePassword(password) {
      const { error } = await client.auth.updateUser({ password });
      if (error) authError(error);
      recovery = false; emit();
    },
    // The question pool is readable only by signed-in users (RLS). Returns {version, data},
    // or null when the server copy matches `knownVersion` (the device's cached copy).
    async fetchPool(knownVersion) {
      const head = await client.from('question_pool').select('version').eq('id', 'current').maybeSingle();
      if (head.error) throw head.error;
      if (!head.data) throw new Error('The question pool hasn’t been uploaded yet. Run tools/upload_pool.py (see README).');
      if (head.data.version === knownVersion) return null;
      const full = await client.from('question_pool').select('version, data').eq('id', 'current').single();
      if (full.error) throw full.error;
      return full.data;
    },
    async deleteCloudCopy() {
      const { error } = await client.from('progress').delete().eq('user_id', user.id);
      if (error) authError(error);
      rev = null;
    },
  };
})();
