'use strict';
/* ========== 常數 ========== */
const INST = 'XAU-USDT-SWAP';
const CT_VAL = 0.001;            // OKX XAU-USDT-SWAP 每張 = 0.001 XAU
const TICK = 0.1;
const API = 'https://www.okx.com/api/v5';
const WS_URL = 'wss://ws.okx.com:8443/ws/v5/public';
const STORE_KEY = 'xau-journal-v1';
const TZ_OFF = -new Date().getTimezoneOffset() * 60; // 圖表顯示本地時間
const BAR_MS = { '1m': 60e3, '5m': 300e3, '15m': 900e3, '1H': 3600e3, '4H': 14400e3 };

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (n, d = 2) => (n == null || !isFinite(n)) ? '—' : Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtPx = (n) => fmt(n, 1);
const sign = (n, d = 2) => (n > 0 ? '+' : '') + fmt(n, d);
const cls = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : '');
const roundTick = (p) => Math.round(p / TICK) * TICK;
const num = (v) => { const x = parseFloat(String(v).replace(/,/g, '')); return isFinite(x) ? x : null; };
const fmtTime = (ts) => { const d = new Date(ts); const p = (x) => String(x).padStart(2, '0'); return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`; };
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/* ========== 狀態 ========== */
let state = load();
let lastPrice = null;
let lastTickTs = 0;

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (s && s.trades) return s;
  } catch (e) {}
  return { settings: { initial: 100, riskPct: 10 }, trades: [] };
}
let saveTimer = null;
function save(now = true) {
  const doSave = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) {} };
  if (now) { clearTimeout(saveTimer); saveTimer = null; doSave(); }
  else if (!saveTimer) saveTimer = setTimeout(() => { saveTimer = null; doSave(); }, 3000);
}

/* ========== 帳戶計算 ========== */
const isClosed = (t) => t.status === 'closed';
function account() {
  const closed = state.trades.filter(isClosed).sort((a, b) => a.closedAt - b.closedAt);
  let eq = state.settings.initial, peak = eq;
  const curve = [{ t: closed.length ? closed[0].closedAt - 1 : Date.now(), v: eq }];
  for (const t of closed) { eq += t.pnl; peak = Math.max(peak, eq); curve.push({ t: t.closedAt, v: eq }); }
  return { equity: eq, peak, risk: peak * state.settings.riskPct / 100, closed, curve };
}

function stats() {
  const { equity, peak, risk, closed } = account();
  const n = closed.length;
  const wins = closed.filter((t) => t.pnl > 0);
  const losses = closed.filter((t) => t.pnl < 0);
  const total = closed.reduce((s, t) => s + t.pnl, 0);
  const avgRR = n ? closed.reduce((s, t) => s + t.rr, 0) / n : null;
  const avgR = n ? closed.reduce((s, t) => s + t.pnl / t.risk, 0) / n : null;
  const avgWin = wins.length ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : null;
  const avgLoss = losses.length ? -losses.reduce((s, t) => s + t.pnl, 0) / losses.length : null;
  return {
    equity, peak, risk, n, total,
    winRate: n ? wins.length / n * 100 : null,
    wins: wins.length, losses: losses.length, be: n - wins.length - losses.length,
    avgRR, avgR,
    realRR: avgWin != null && avgLoss ? avgWin / avgLoss : null,
    dd: peak > 0 ? (equity - peak) / peak * 100 : 0,
  };
}

/* ========== 下單計算（依規則） ========== */
function plan(entry, sl, tp) {
  if (!(entry > 0 && sl > 0 && tp > 0)) return null;
  const side = sl < entry ? 'long' : sl > entry ? 'short' : null;
  if (!side) return { err: '止損不能等於進場價' };
  if (side === 'long' && !(tp > entry)) return { err: '做多（止損在下方）時止盈必須高於進場價' };
  if (side === 'short' && !(tp < entry)) return { err: '做空（止損在上方）時止盈必須低於進場價' };
  const slDist = Math.abs(entry - sl);
  const tpDist = Math.abs(tp - entry);
  const rr = tpDist / slDist;
  const { risk, equity } = account();
  const qty = risk / slDist;                      // XAU 數量
  const contracts = Math.floor(qty / CT_VAL);     // OKX 張數
  const notional = qty * entry;                   // 名義價值 U
  return {
    side, rr, risk, reward: risk * rr, qty, contracts, notional,
    slPct: slDist / entry * 100, lev: equity > 0 ? notional / equity : null,
    actualRisk: contracts * CT_VAL * slDist,
  };
}

/* ========== 表單 ========== */
let orderType = 'market';
let lastEdited = 'tp';
const fEntry = $('fEntry'), fSl = $('fSl'), fTp = $('fTp'), fRr = $('fRr');

function syncForm(src) {
  if (src === 'tp' || src === 'rr') lastEdited = src;
  const e = num(fEntry.value), s = num(fSl.value);
  if (e > 0 && s > 0 && e !== s) {
    const d = Math.abs(e - s), dir = s < e ? 1 : -1;
    if (lastEdited === 'rr') {
      const rr = num(fRr.value);
      if (rr > 0 && src !== 'tp') fTp.value = roundTick(e + dir * d * rr).toFixed(1);
    } else {
      const t = num(fTp.value);
      if (t > 0 && src !== 'rr') fRr.value = (Math.abs(t - e) / d).toFixed(2);
    }
  }
  renderPreview();
}
fEntry.addEventListener('input', () => syncForm('entry'));
fSl.addEventListener('input', () => syncForm('sl'));
fTp.addEventListener('input', () => syncForm('tp'));
fRr.addEventListener('input', () => syncForm('rr'));
$('useLast').onclick = () => { if (lastPrice) { fEntry.value = lastPrice.toFixed(1); syncForm('entry'); } };
document.querySelectorAll('#orderType button').forEach((b) => b.onclick = () => {
  orderType = b.dataset.v;
  document.querySelectorAll('#orderType button').forEach((x) => x.classList.toggle('on', x === b));
  renderPreview();
});

function renderPreview() {
  const e = num(fEntry.value), s = num(fSl.value), t = num(fTp.value);
  const p = plan(e, s, t);
  const box = $('preview');
  const btn = $('submitBtn');
  const { risk, peak } = account();
  if (!p) {
    box.innerHTML = `<div><span>帳戶最高點</span><b>${fmt(peak)} U</b></div><div><span>本單可虧</span><b class="down">${fmt(risk)} U</b></div><div><span>風險</span><b>${state.settings.riskPct}%</b></div>`;
    btn.disabled = true; drawPreviewLines(null); return;
  }
  if (p.err) { box.innerHTML = `<div class="err">${p.err}</div>`; btn.disabled = true; drawPreviewLines(null); return; }
  let warn = '';
  if (orderType === 'market' && lastPrice) {
    const hitSl = p.side === 'long' ? lastPrice <= s : lastPrice >= s;
    const hitTp = p.side === 'long' ? lastPrice >= t : lastPrice <= t;
    if (hitSl) warn = '現價已經在止損之外，送出後會立刻判定止損';
    else if (hitTp) warn = '現價已經超過止盈，送出後會立刻判定止盈';
  }
  box.innerHTML = `
    <div><span>方向</span><b class="${p.side === 'long' ? 'up' : 'down'}">${p.side === 'long' ? '做多' : '做空'}</b></div>
    <div><span>RR</span><b>${fmt(p.rr)}</b></div>
    <div><span>止損距離</span><b>${fmt(Math.abs(e - s), 1)} (${fmt(p.slPct)}%)</b></div>
    <div><span>止損虧</span><b class="down">-${fmt(p.risk)} U</b></div>
    <div><span>止盈賺</span><b class="up">+${fmt(p.reward)} U</b></div>
    <div><span>名義價值</span><b>${fmt(p.notional)} U</b></div>
    <div><span>數量</span><b>${fmt(p.qty, 4)} XAU</b></div>
    <div><span>OKX 張數</span><b>${p.contracts.toLocaleString()} 張</b></div>
    <div><span>相對權益槓桿</span><b>${fmt(p.lev, 1)}x</b></div>
    ${warn ? `<div class="warn">⚠ ${warn}</div>` : ''}`;
  btn.disabled = false;
  drawPreviewLines({ e, s, t });
}

$('orderForm').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const e = num(fEntry.value), s = num(fSl.value), t = num(fTp.value);
  const p = plan(e, s, t);
  if (!p || p.err) return;
  const now = Date.now();
  const tr = {
    id: uid(), createdAt: now, orderType, side: p.side,
    entry: e, sl: s, tp: t, slOrig: s, rr: p.rr,
    risk: p.risk, qty: p.qty, contracts: p.contracts, notional: p.notional,
    peakAtOpen: account().peak,
    status: orderType === 'market' ? 'open' : 'pending',
    openedAt: orderType === 'market' ? now : null,
    fillDir: orderType === 'limit' && lastPrice ? (lastPrice > e ? 'down' : 'up') : null,
    lastChecked: now, note: $('fNote').value.trim(),
  };
  state.trades.push(tr);
  save();
  fEntry.value = fSl.value = fTp.value = fRr.value = $('fNote').value = '';
  renderAll();
  toast(tr.status === 'open' ? '已記錄持倉' : '已記錄掛單');
  if (lastPrice) checkTrades(lastPrice, Date.now());
});

/* ========== 結單判斷 ========== */
const pnlAt = (t, px) => t.qty * (px - t.entry) * (t.side === 'long' ? 1 : -1);

function closeTrade(t, px, ts, reason, extra = '') {
  t.status = 'closed';
  t.exit = px; t.closedAt = ts; t.reason = reason;
  t.pnl = pnlAt(t, px);
  if (extra) t.closeNote = extra;
  const label = reason === 'TP' ? '止盈' : reason === 'SL' ? '止損' : '手動平倉';
  notify(`${t.side === 'long' ? '多' : '空'}單${label} @ ${fmtPx(px)}，${sign(t.pnl)} U`);
}

// 用即時價格判斷
function checkTrades(px, ts) {
  let changed = false, needBackfill = false;
  for (const t of state.trades) {
    if (t.status !== 'pending' && t.status !== 'open') continue;
    // 太久沒檢查的單（網頁關著的期間）要先用 K 線回補，不能直接用現價判斷
    if (Date.now() - (t.lastChecked || 0) > 70e3) { needBackfill = true; continue; }
    if (t.status === 'pending') {
      const hit = t.fillDir === 'down' ? px <= t.entry : t.fillDir === 'up' ? px >= t.entry : Math.abs(px - t.entry) < TICK / 2;
      if (hit) { t.status = 'open'; t.openedAt = ts; changed = true; notify(`掛單成交 @ ${fmtPx(t.entry)}`); }
      t.lastChecked = ts;
      continue;
    }
    if (t.status !== 'open') continue;
    const L = t.side === 'long';
    if (L ? px <= t.sl : px >= t.sl) { closeTrade(t, t.sl, ts, 'SL'); changed = true; }
    else if (L ? px >= t.tp : px <= t.tp) { closeTrade(t, t.tp, ts, 'TP'); changed = true; }
    else t.lastChecked = ts;
  }
  if (changed) { save(); renderAll(); } else save(false);
  if (needBackfill) backfill();
}

// 網頁關著的期間：用 1 分 K 回補判斷
async function fetchCandles(startMs) {
  const out = [];
  let after = Date.now() + 60e3, ep = 'candles', guard = 0;
  while (guard++ < 600) {
    const lim = ep === 'candles' ? 300 : 100;
    const r = await fetch(`${API}/market/${ep}?instId=${INST}&bar=1m&limit=${lim}&after=${after}`).then((x) => x.json());
    const rows = r.data || [];
    if (!rows.length) { if (ep === 'candles') { ep = 'history-candles'; continue; } break; }
    for (const k of rows) out.push({ ts: +k[0], h: +k[2], l: +k[3] });
    const oldest = +rows[rows.length - 1][0];
    if (oldest <= startMs) break;
    after = oldest;
    await sleep(ep === 'candles' ? 60 : 120);
  }
  return out.filter((c) => c.ts >= startMs).sort((a, b) => a.ts - b.ts);
}

let backfilling = false, lastBackfillTry = 0;
async function backfill() {
  if (backfilling || Date.now() - lastBackfillTry < 8000) return;
  lastBackfillTry = Date.now();
  const active = state.trades.filter((t) => t.status === 'open' || t.status === 'pending');
  if (!active.length) return;
  const now = Date.now();
  const startOf = (t) => {
    const lc = t.lastChecked || t.createdAt;
    const base = t.status === 'open' ? t.openedAt : t.createdAt;
    // 監控過的分鐘可以含進來；剛開單的那一分鐘從下一根開始，避免進場前的價格誤判
    return lc - base > 1000 ? Math.floor(lc / 60e3) * 60e3 : Math.floor(base / 60e3) * 60e3 + 60e3;
  };
  const stale = active.filter((t) => now - (t.lastChecked || 0) > 70e3);
  if (!stale.length) return;
  backfilling = true;
  setStatus('回補離線期間價格中…');
  try {
    const start = Math.min(...stale.map(startOf));
    const candles = await fetchCandles(start);
    let changed = false;
    for (const t of stale) {
      const from = startOf(t);
      let skipTs = null;
      for (const c of candles) {
        if (c.ts < from) continue;
        if (t.status === 'pending') {
          if (c.l <= t.entry && t.entry <= c.h) { t.status = 'open'; t.openedAt = c.ts; skipTs = c.ts; changed = true; }
          continue;
        }
        if (t.status !== 'open' || c.ts === skipTs) continue;
        const L = t.side === 'long';
        const hitSl = L ? c.l <= t.sl : c.h >= t.sl;
        const hitTp = L ? c.h >= t.tp : c.l <= t.tp;
        if (hitSl && hitTp) { closeTrade(t, t.sl, c.ts, 'SL', '同一根 1 分 K 同時碰到止盈止損，保守判定止損'); changed = true; }
        else if (hitSl) { closeTrade(t, t.sl, c.ts, 'SL'); changed = true; }
        else if (hitTp) { closeTrade(t, t.tp, c.ts, 'TP'); changed = true; }
      }
      if ((t.status === 'open' || t.status === 'pending') && candles.length) {
        t.lastChecked = Math.max(t.lastChecked || 0, candles[candles.length - 1].ts);
      }
    }
    save();
    if (changed) renderAll();
  } catch (e) {
    console.error(e);
  } finally {
    backfilling = false;
    setStatus('');
  }
}

/* ========== 即時行情 ========== */
let ws, pingTimer, wsAlive = false;
function connectWS() {
  try { ws && ws.close(); } catch (e) {}
  ws = new WebSocket(WS_URL);
  ws.onopen = () => {
    ws.send(JSON.stringify({ op: 'subscribe', args: [{ channel: 'tickers', instId: INST }] }));
    clearInterval(pingTimer);
    pingTimer = setInterval(() => { try { ws.send('ping'); } catch (e) {} }, 20e3);
  };
  ws.onmessage = (m) => {
    if (m.data === 'pong') return;
    const d = JSON.parse(m.data);
    if (d.data && d.data[0]) onTicker(d.data[0]);
  };
  ws.onclose = () => { wsAlive = false; setConn(false); clearInterval(pingTimer); setTimeout(connectWS, 3000); };
  ws.onerror = () => { try { ws.close(); } catch (e) {} };
}

function onTicker(k) {
  const px = +k.last, ts = +k.ts || Date.now();
  if (!isFinite(px)) return;
  const prev = lastPrice;
  lastPrice = px; lastTickTs = Date.now(); wsAlive = true; setConn(true);
  const el = $('lastPx');
  el.textContent = fmtPx(px);
  el.className = 'px ' + (prev == null ? '' : px > prev ? 'up' : px < prev ? 'down' : el.className.replace('px', '').trim());
  const open = +k.sodUtc8 || +k.open24h;
  const ch = (px - open) / open * 100;
  $('chg24').innerHTML = `<span class="${cls(ch)}">${sign(px - open, 1)} (${sign(ch)}%)</span>`;
  $('hi24').textContent = fmtPx(+k.high24h);
  $('lo24').textContent = fmtPx(+k.low24h);
  document.title = `${fmtPx(px)} XAU 交易紀錄`;
  updateBar(px, ts);
  checkTrades(px, ts);
  renderOpenPnl();
}

// WS 斷掉時用 REST 補
setInterval(async () => {
  if (Date.now() - lastTickTs < 5000) return;
  try {
    const r = await fetch(`${API}/market/ticker?instId=${INST}`).then((x) => x.json());
    if (r.data && r.data[0]) onTicker(r.data[0]);
  } catch (e) {}
}, 3000);

function setConn(ok) { $('connDot').className = 'dot ' + (ok ? 'ok' : 'bad'); }
function setStatus(s) { if (s) toast(s); }

/* ========== 圖表 ========== */
let chart, series, bar = '5m', curBar = null;
let tradeLines = [], previewLines = [];
let eqChart, eqSeries;

function initChart() {
  if (!window.LightweightCharts) return;
  const opts = {
    layout: { background: { color: 'transparent' }, textColor: '#8a93a3' },
    grid: { vertLines: { color: '#1e222b' }, horzLines: { color: '#1e222b' } },
    rightPriceScale: { borderColor: '#262b35' },
    timeScale: { borderColor: '#262b35', timeVisible: true, secondsVisible: false },
    crosshair: { mode: 0 },
    autoSize: true,
  };
  chart = LightweightCharts.createChart($('chart'), opts);
  series = chart.addCandlestickSeries({
    upColor: '#22c55e', downColor: '#ef4444', borderVisible: false,
    wickUpColor: '#22c55e', wickDownColor: '#ef4444',
    priceFormat: { type: 'price', precision: 1, minMove: 0.1 },
  });
  eqChart = LightweightCharts.createChart($('equityChart'), opts);
  eqSeries = eqChart.addAreaSeries({ lineColor: '#e8b84a', topColor: 'rgba(232,184,74,.3)', bottomColor: 'rgba(232,184,74,0)', lineWidth: 2 });
  loadBars();
}

async function loadBars() {
  if (!series) return;
  try {
    const r = await fetch(`${API}/market/candles?instId=${INST}&bar=${bar}&limit=300`).then((x) => x.json());
    const rows = (r.data || []).map((k) => ({ time: +k[0] / 1000 + TZ_OFF, open: +k[1], high: +k[2], low: +k[3], close: +k[4] })).reverse();
    series.setData(rows);
    curBar = rows[rows.length - 1] || null;
  } catch (e) { console.error(e); }
  drawTradeLines();
}

function updateBar(px, ts) {
  if (!series) return;
  const t = Math.floor(ts / BAR_MS[bar]) * BAR_MS[bar] / 1000 + TZ_OFF;
  if (curBar && curBar.time === t) {
    curBar.high = Math.max(curBar.high, px); curBar.low = Math.min(curBar.low, px); curBar.close = px;
  } else if (!curBar || t > curBar.time) {
    curBar = { time: t, open: px, high: px, low: px, close: px };
  } else return;
  series.update({ ...curBar });
}

document.querySelectorAll('#tfs button').forEach((b) => b.onclick = () => {
  bar = b.dataset.bar;
  document.querySelectorAll('#tfs button').forEach((x) => x.classList.toggle('on', x === b));
  loadBars();
});

$('toggleEquity').onclick = () => {
  const showEq = $('equityChart').classList.toggle('hidden') === false;
  $('chart').classList.toggle('hidden', showEq);
  $('tfs').style.visibility = showEq ? 'hidden' : '';
  $('toggleEquity').textContent = showEq ? 'K 線圖' : '權益曲線';
  if (showEq) renderEquity();
};

function renderEquity() {
  if (!eqSeries) return;
  const { curve } = account();
  const pts = [];
  for (const p of curve) {
    let t = Math.floor(p.t / 1000) + TZ_OFF;
    if (pts.length && t <= pts[pts.length - 1].time) t = pts[pts.length - 1].time + 1;
    pts.push({ time: t, value: +p.v.toFixed(2) });
  }
  eqSeries.setData(pts);
  eqChart.timeScale().fitContent();
}

function drawTradeLines() {
  if (!series) return;
  tradeLines.forEach((l) => series.removePriceLine(l));
  tradeLines = [];
  for (const t of state.trades) {
    if (t.status !== 'open' && t.status !== 'pending') continue;
    const tag = t.side === 'long' ? '多' : '空';
    const pend = t.status === 'pending';
    tradeLines.push(series.createPriceLine({ price: t.entry, color: pend ? '#8a93a3' : '#3b82f6', lineWidth: 1, lineStyle: pend ? 2 : 0, title: `${tag}${pend ? '掛單' : '進場'}` }));
    tradeLines.push(series.createPriceLine({ price: t.tp, color: '#22c55e', lineWidth: 1, lineStyle: 0, title: `${tag}止盈` }));
    tradeLines.push(series.createPriceLine({ price: t.sl, color: '#ef4444', lineWidth: 1, lineStyle: 0, title: `${tag}止損` }));
  }
}

function drawPreviewLines(v) {
  if (!series) return;
  previewLines.forEach((l) => series.removePriceLine(l));
  previewLines = [];
  if (!v) return;
  previewLines.push(series.createPriceLine({ price: v.e, color: '#8a93a3', lineWidth: 1, lineStyle: 2, title: '預覽進場' }));
  previewLines.push(series.createPriceLine({ price: v.t, color: 'rgba(34,197,94,.6)', lineWidth: 1, lineStyle: 2, title: '預覽止盈' }));
  previewLines.push(series.createPriceLine({ price: v.s, color: 'rgba(239,68,68,.6)', lineWidth: 1, lineStyle: 2, title: '預覽止損' }));
}

/* ========== 畫面 ========== */
function renderStats() {
  const s = stats();
  $('stats').innerHTML = `
    <div class="stat big"><span>總營利</span><b class="${cls(s.total)}">${sign(s.total)} U</b></div>
    <div class="stat big"><span>勝率</span><b>${s.winRate == null ? '—' : fmt(s.winRate, 1) + '%'}</b></div>
    <div class="stat big"><span>平均 RR</span><b>${s.avgRR == null ? '—' : fmt(s.avgRR)}</b></div>
    <div class="stat big"><span>總單數</span><b>${s.n}</b><span>${s.wins} 勝 / ${s.losses} 敗${s.be ? ` / ${s.be} 平` : ''}</span></div>
    <div class="stat"><span>目前權益</span><b>${fmt(s.equity)} U</b></div>
    <div class="stat"><span>帳戶最高點</span><b>${fmt(s.peak)} U</b></div>
    <div class="stat"><span>下一單可虧（${state.settings.riskPct}%）</span><b class="down">${fmt(s.risk)} U</b></div>
    <div class="stat"><span>距最高點回撤</span><b class="${cls(s.dd)}">${fmt(s.dd)}%</b></div>
    <div class="stat"><span>平均每單 R</span><b class="${cls(s.avgR)}">${s.avgR == null ? '—' : sign(s.avgR) + 'R'}</b></div>
    <div class="stat"><span>實際盈虧比</span><b>${s.realRR == null ? '—' : fmt(s.realRR)}</b></div>`;
}

function tradeCard(t) {
  const L = t.side === 'long';
  const closed = t.status === 'closed';
  const st = t.status === 'pending' ? '掛單中' : t.status === 'open' ? '持倉中' : t.reason === 'TP' ? '止盈' : t.reason === 'SL' ? (t.pnl > 0 ? '移動止損' : t.pnl === 0 ? '保本' : '止損') : '手動平倉';
  const stCls = closed ? (t.pnl > 0 ? 'b-win' : t.pnl < 0 ? 'b-loss' : 'b-st') : 'b-st';
  const right = closed
    ? `<span class="pnl ${cls(t.pnl)}">${sign(t.pnl)} U <small>(${sign(t.pnl / t.risk)}R)</small></span>`
    : t.status === 'open' ? `<span class="pnl live" data-id="${t.id}">—</span>` : '';
  const kv = [
    ['進場', fmtPx(t.entry)], ['止損', fmtPx(t.sl) + (t.sl !== t.slOrig ? ` <small class="muted">(原 ${fmtPx(t.slOrig)})</small>` : '')],
    ['止盈', fmtPx(t.tp)], ['RR', fmt(t.rr)],
    ['風險', fmt(t.risk) + ' U'], ['名義價值', fmt(t.notional) + ' U'],
    ['張數', t.contracts.toLocaleString()],
    closed ? ['出場', fmtPx(t.exit)] : ['建立', fmtTime(t.createdAt)],
  ];
  if (closed) kv.push(['進場時間', t.openedAt ? fmtTime(t.openedAt) : '—'], ['結單時間', fmtTime(t.closedAt)]);
  const acts = closed
    ? `<button class="ghost small" data-act="del" data-id="${t.id}">刪除</button>`
    : `${t.status === 'open' ? `<button class="ghost small" data-act="close" data-id="${t.id}">以現價平倉</button><button class="ghost small" data-act="be" data-id="${t.id}">止損移到保本</button>` : ''}
       <button class="ghost small" data-act="edit" data-id="${t.id}">改止盈止損</button>
       <button class="ghost small" data-act="${t.status === 'pending' ? 'cancel' : 'del'}" data-id="${t.id}">${t.status === 'pending' ? '取消掛單' : '刪除'}</button>`;
  return `<div class="trade">
    <div class="head">
      <div class="row gap"><span class="badge ${L ? 'b-long' : 'b-short'}">${L ? '多' : '空'}</span><span class="badge ${stCls}">${st}</span><span class="muted">${fmtTime(closed ? t.closedAt : t.createdAt)}</span></div>
      ${right}
    </div>
    <div class="kv">${kv.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('')}</div>
    ${t.note ? `<div class="note">📝 ${escapeHtml(t.note)}</div>` : ''}
    ${t.closeNote ? `<div class="note">ℹ ${escapeHtml(t.closeNote)}</div>` : ''}
    <div class="acts">${acts}</div>
  </div>`;
}

function renderLists() {
  const active = state.trades.filter((t) => t.status === 'open' || t.status === 'pending').sort((a, b) => b.createdAt - a.createdAt);
  const hist = state.trades.filter(isClosed).sort((a, b) => b.closedAt - a.closedAt);
  $('openList').innerHTML = active.length ? active.map(tradeCard).join('') : '<div class="empty">沒有持倉</div>';
  $('histList').innerHTML = hist.length ? hist.map(tradeCard).join('') : '<div class="empty">還沒有結單紀錄</div>';
  renderOpenPnl();
}

function renderOpenPnl() {
  if (lastPrice == null) return;
  document.querySelectorAll('.pnl.live').forEach((el) => {
    const t = state.trades.find((x) => x.id === el.dataset.id);
    if (!t) return;
    const p = pnlAt(t, lastPrice);
    el.className = `pnl live ${cls(p)}`;
    el.innerHTML = `${sign(p)} U <small>(${sign(p / t.risk)}R)</small>`;
  });
}

function renderSettings() {
  $('sInitial').value = state.settings.initial;
  $('sRisk').value = state.settings.riskPct;
}

function renderAll() {
  renderStats(); renderLists(); renderPreview(); drawTradeLines();
  if (!$('equityChart').classList.contains('hidden')) renderEquity();
}

/* ========== 動作 ========== */
document.addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-act]');
  if (!b) return;
  const t = state.trades.find((x) => x.id === b.dataset.id);
  if (!t) return;
  const act = b.dataset.act;
  if (act === 'close') {
    if (lastPrice == null) return toast('還沒有即時價格');
    if (!confirm(`以現價 ${fmtPx(lastPrice)} 平倉？`)) return;
    closeTrade(t, lastPrice, Date.now(), 'manual');
  } else if (act === 'be') {
    t.sl = t.entry; t.closeNote = undefined;
    toast('止損已移到進場價');
  } else if (act === 'edit') {
    const s = num(prompt('新的止損價', t.sl)); if (s == null) return;
    const p = num(prompt('新的止盈價', t.tp)); if (p == null) return;
    const L = t.side === 'long';
    if (L ? !(p > s) : !(p < s)) return toast('止盈止損方向不對');
    t.sl = s; t.tp = p;
  } else if (act === 'cancel') {
    if (!confirm('取消這張掛單？')) return;
    state.trades = state.trades.filter((x) => x !== t);
  } else if (act === 'del') {
    if (!confirm('刪除這筆紀錄？會影響統計與帳戶最高點。')) return;
    state.trades = state.trades.filter((x) => x !== t);
  }
  save(); renderAll();
  if (lastPrice && act === 'edit') checkTrades(lastPrice, Date.now());
});

function onSettings() {
  const i = num($('sInitial').value), r = num($('sRisk').value);
  if (i > 0) state.settings.initial = i;
  if (r > 0 && r <= 100) state.settings.riskPct = r;
  save(); renderStats(); renderPreview();
}
$('sInitial').addEventListener('change', onSettings);
$('sRisk').addEventListener('change', onSettings);

$('exportBtn').onclick = () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `xau-journal-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
$('importFile').onchange = async (ev) => {
  const f = ev.target.files[0]; if (!f) return;
  try {
    const s = JSON.parse(await f.text());
    if (!s.trades || !s.settings) throw new Error('格式不對');
    if (!confirm(`匯入 ${s.trades.length} 筆紀錄，會覆蓋目前資料，確定？`)) return;
    state = s; save(); renderSettings(); renderAll(); backfill();
    toast('匯入完成');
  } catch (e) { toast('匯入失敗：' + e.message); }
  ev.target.value = '';
};

$('notifyBtn').onclick = async () => {
  if (!('Notification' in window)) return toast('這個瀏覽器不支援通知');
  const p = await Notification.requestPermission();
  toast(p === 'granted' ? '已開啟結單通知' : '通知被拒絕');
};

let toastTimer;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}
function notify(msg) {
  toast(msg);
  try { if (Notification.permission === 'granted') new Notification('XAU 交易紀錄', { body: msg }); } catch (e) {}
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination); o.frequency.value = 880; g.gain.value = 0.08;
    o.start(); o.stop(ctx.currentTime + 0.25);
  } catch (e) {}
}
function escapeHtml(s) { return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

/* ========== 啟動 ========== */
renderSettings();
renderAll();
initChart();
connectWS();
backfill();
setInterval(backfill, 30e3);
document.addEventListener('visibilitychange', () => { if (!document.hidden) backfill(); });
