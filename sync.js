'use strict';
/* ========== 雲端同步（Supabase + Google 登入） ==========
 * 跟資產 App 共用同一個 Supabase 專案與 Google 登入。
 * 資料表 xau_journal：每個帳號一列，data 放整份紀錄；合併規則見 merge.js。
 * anon / publishable 金鑰是公開金鑰，放在公開 repo 是安全的：資料靠 RLS 保護（只能讀寫自己的那一列）。
 */
(function () {
  const SUPABASE_URL = 'https://fchrqykvedemzxxkrrec.supabase.co';
  const SUPABASE_ANON_KEY = 'sb_publishable_YTMK7T_SVpfaweOfsIdmCQ_pBT1lF89';
  const TABLE = 'xau_journal';

  const el = (id) => document.getElementById(id);
  const setState = (text, kind = '') => { el('syncState').textContent = text; el('syncState').className = 'syncst ' + kind; };
  const hhmm = (ts) => { const d = new Date(ts); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`; };

  if (!window.supabase || !window.supabase.createClient) {
    setState('同步元件載入失敗', 'bad');
    el('loginBtn').disabled = true;
    return;
  }
  const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' },
  });

  let user = null, channel = null, pushTimer = null, busy = Promise.resolve(), lastOk = 0;

  function renderUI() {
    el('loginBtn').classList.toggle('hidden', !!user);
    el('logoutBtn').classList.toggle('hidden', !user);
    el('syncNowBtn').classList.toggle('hidden', !user);
    el('syncInfo').textContent = user
      ? `已登入 ${user.email}。在手機和電腦都用這個 Google 帳號登入，紀錄就會自動同步。`
      : '用 Google 帳號登入後，手機和電腦的紀錄會自動同步（跟你的資產 App 是同一個帳號）。';
    if (!user) setState('未登入');
  }

  const remoteOf = (state) => ({
    settings: state.settings, settingsUpdatedAt: state.settingsUpdatedAt || 0,
    trades: state.trades, trash: state.trash, purged: state.purged || {},
  });

  // 一次完整同步：拉雲端 → 合併 → 有差異就採用 / 推上去。排隊執行，不會同時跑兩個
  function syncNow() {
    busy = busy.then(doSync, doSync);
    return busy;
  }
  async function doSync() {
    if (!user) return;
    setState('同步中…');
    try {
      const { data: row, error } = await client.from(TABLE).select('data').eq('user_id', user.id).maybeSingle();
      if (error) throw error;
      const remote = row && row.data;
      const merged = mergeStates(remoteOf(state), remote);
      const localChanged = canon(merged) !== canon(remoteOf(state));
      if (localChanged) {
        adoptState(merged);
        renderSettings(); renderAll();
      }
      if (!remote || canon(merged) !== canon(remote)) {
        const { error: e2 } = await client.from(TABLE).upsert({ user_id: user.id, data: merged, updated_at: new Date().toISOString() });
        if (e2) throw e2;
      }
      lastOk = Date.now();
      setState(`已同步 ${hhmm(lastOk)}`, 'ok');
    } catch (e) {
      console.error('sync', e);
      const msg = String(e && (e.message || e.code) || e);
      if (/xau_journal|PGRST205|schema cache|does not exist/i.test(msg)) setState('雲端資料表還沒建立', 'bad');
      else if (/JWT|auth|401|403/i.test(msg)) setState('登入過期，請重新登入', 'bad');
      else setState('同步失敗，稍後自動重試', 'bad');
    }
  }

  // 本機資料有變動（app.js 的 save 偵測到）→ 1.5 秒後推上去
  window.onLocalChange = () => {
    if (!user) return;
    setState('待同步…');
    clearTimeout(pushTimer);
    pushTimer = setTimeout(syncNow, 1500);
  };

  function subscribe() {
    if (channel) client.removeChannel(channel);
    channel = client.channel('xau-' + user.id)
      .on('postgres_changes', { event: '*', schema: 'public', table: TABLE, filter: `user_id=eq.${user.id}` }, (payload) => {
        const remote = payload.new && payload.new.data;
        if (!remote) return;
        const merged = mergeStates(remoteOf(state), remote);
        if (canon(merged) !== canon(remoteOf(state))) {
          adoptState(merged);
          renderSettings(); renderAll();
          toast('已從另一台裝置同步');
        }
        // 合併後比雲端新（兩邊同時改）就再推一次
        if (canon(merged) !== canon(remote)) window.onLocalChange();
        else { lastOk = Date.now(); setState(`已同步 ${hhmm(lastOk)}`, 'ok'); }
      })
      .subscribe();
  }

  async function onSession(session) {
    const was = user && user.id;
    user = session ? session.user : null;
    renderUI();
    if (user && user.id !== was) {
      await syncNow();
      subscribe();
    }
    if (!user && channel) { client.removeChannel(channel); channel = null; }
  }

  // 啟動：先拿登入狀態並做第一次同步（app.js 的回補會等這個完成）
  window.initialSync = (async () => {
    renderUI();
    try {
      if (sessionStorage.getItem('xau-after-login')) {
        sessionStorage.removeItem('xau-after-login');
        if (location.hash !== '#settings') location.hash = '#settings';
      }
    } catch (e) {}
    const { data } = await client.auth.getSession();
    await onSession(data.session);
  })();
  client.auth.onAuthStateChange((_evt, session) => { setTimeout(() => onSession(session), 0); });

  el('loginBtn').onclick = async () => {
    // 轉址網址不帶 #，比對 Supabase 白名單比較穩；回來後再自動切到設定頁
    const redirectTo = location.origin + location.pathname;
    try { sessionStorage.setItem('xau-after-login', 'settings'); } catch (e) {}
    const { error } = await client.auth.signInWithOAuth({ provider: 'google', options: { redirectTo } });
    if (error) toast('登入失敗：' + error.message);
  };
  el('logoutBtn').onclick = async () => {
    await client.auth.signOut();
    toast('已登出（這台的紀錄還在，只是不再同步）');
  };
  el('syncNowBtn').onclick = () => syncNow();

  // 保險：回到頁面、或每 60 秒拉一次（即時推播斷線時也能跟上）
  document.addEventListener('visibilitychange', () => { if (!document.hidden && user) syncNow(); });
  setInterval(() => { if (user && Date.now() - lastOk > 55e3) syncNow(); }, 60e3);
})();
