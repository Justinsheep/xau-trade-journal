'use strict';
/* 雲端同步的合併規則（純函式，瀏覽器與 node 測試共用）
 * - 每筆單（含垃圾桶裡的）各自用 updatedAt 比新舊，新的贏；一樣新時保留本機版本
 * - 永久刪除的單記在 purged[id] = 刪除時間，比該單最後修改還晚就不再出現
 * - 設定用 settingsUpdatedAt 比新舊
 * - lastChecked（最後檢查價格的時間）不算修改，取兩邊較大的值
 */
(function (root) {
  const stripKey = (t) => { const { lastChecked, updatedAt, ...r } = t; return JSON.stringify(r); };

  function mergeStates(local, remote) {
    if (!remote) return local;
    const purged = { ...(remote.purged || {}) };
    for (const [id, ts] of Object.entries(local.purged || {})) purged[id] = Math.max(purged[id] || 0, ts);

    const best = new Map();
    const maxChecked = new Map();
    // 先放遠端、再放本機：同樣新的時候本機覆蓋遠端
    const add = (t) => {
      maxChecked.set(t.id, Math.max(maxChecked.get(t.id) || 0, t.lastChecked || 0));
      const cur = best.get(t.id);
      if (!cur || (t.updatedAt || 0) >= (cur.updatedAt || 0)) best.set(t.id, t);
    };
    [...(remote.trades || []), ...(remote.trash || [])].forEach(add);
    [...(local.trades || []), ...(local.trash || [])].forEach(add);

    const trades = [], trash = [];
    for (const [id, t0] of best) {
      if (purged[id] != null && purged[id] >= (t0.updatedAt || 0)) continue;
      const t = { ...t0 };
      if (maxChecked.get(id)) t.lastChecked = maxChecked.get(id);
      (t.deletedAt != null ? trash : trades).push(t);
    }

    const lsu = local.settingsUpdatedAt || 0, rsu = remote.settingsUpdatedAt || 0;
    const useRemoteSettings = rsu > lsu && remote.settings;
    return {
      settings: useRemoteSettings ? { ...remote.settings } : { ...local.settings },
      settingsUpdatedAt: Math.max(lsu, rsu),
      trades, trash, purged,
    };
  }

  // 用來判斷兩份資料內容是否一樣（忽略 lastChecked 與順序）
  function canon(s) {
    const list = (a) => (a || []).map(stripKey).sort();
    const p = s.purged || {};
    return JSON.stringify({
      settings: s.settings, su: s.settingsUpdatedAt || 0,
      trades: list(s.trades), trash: list(s.trash),
      purged: Object.keys(p).sort().map((k) => [k, p[k]]),
    });
  }

  const api = { mergeStates, canon, stripKey };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof window !== 'undefined' ? window : globalThis);
