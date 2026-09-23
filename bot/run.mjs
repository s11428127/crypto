/*
 * bot/run.mjs —— 模擬單機器人的執行器（多幣種）
 *
 * 跑一輪：每個幣依序抓真實行情 → 決定動作 → 更新共用帳戶的狀態檔。
 * **不下任何真實訂單、不需要 API 金鑰、不碰任何帳戶。**
 *
 * 用法：
 *   node bot/run.mjs           跑一輪並寫回狀態
 *   node bot/run.mjs --dry     跑一輪但不寫檔（測試用）
 *   node bot/run.mjs --reset   砍掉重練（會先備份舊狀態）
 */
import fs from 'node:fs';
import path from 'node:path';
import '../assets/risk.js';
import '../assets/indicators.js';
import '../assets/backtest.js';
import '../assets/strategy.js';
import '../assets/bot.js';
import '../assets/data.js';

const { BOT, STRATEGY, DATA } = globalThis;
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const STATE_FILE = path.join(ROOT, 'bot', 'state.json');
const CONFIG_FILE = path.join(ROOT, 'bot', 'config.json');

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const RESET = argv.includes('--reset');
// 每個幣之間稍微停一下，不要對 Kraken 連發（公開端點有頻率限制）
const GAP_MS = Number(process.env.BOT_GAP_MS ?? 1200);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const f = (v, d = 2) =>
  Number.isFinite(v) ? v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—';
const px = v => Number.isFinite(v) ? String(+v.toPrecision(6)) : '—';
const short = s => s.replace(/USDT$/, '');

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
}

function loadState(config) {
  if (RESET && fs.existsSync(STATE_FILE)) {
    const backup = STATE_FILE.replace(/\.json$/, `.${Date.now()}.bak.json`);
    fs.copyFileSync(STATE_FILE, backup);
    console.log('舊狀態備份到', path.basename(backup));
    fs.unlinkSync(STATE_FILE);
  }
  if (!fs.existsSync(STATE_FILE)) {
    console.log('沒有狀態檔，建立新的。起始本金 $' + config.startEquity);
    return BOT.newState(config);
  }
  // 舊版（單一部位）的狀態檔自動升級成多幣種
  const s = BOT.migrate(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')));
  // 設定檔改動時以設定檔為準，但不動已經累積的權益與紀錄
  const prevRules = s.config.rules || 'v1';
  s.config = Object.assign({}, s.config, config, { startEquity: s.config.startEquity });
  delete s.config.symbol;
  delete s.config.rMultiples;
  if (prevRules !== s.config.rules) {
    s.notes.unshift({ t: Date.now(), kind: 'open', symbol: '*',
      text: `規則從 ${prevRules} 換成 ${s.config.rules}${s.config.allowShort === false ? '（只做多）' : ''}，之後的成交都照新規則` });
  }
  return s;
}

async function fetchMarket(symbol, config) {
  // 規則 v2 只用 4H + 日線判斷；15 分 K 用來檢查持倉中有沒有碰到止損
  const snap = await DATA.snapshot(symbol, ['15m', '4h', '1d'], 300);
  const k4 = snap.klines['4h'] || [], d1 = snap.klines['1d'] || [], k15 = snap.klines['15m'] || [];
  if (k4.length < 60 || d1.length < 210 || !k15.length) {
    throw new Error(`K 線不足（4H ${k4.length}、日線 ${d1.length}、15m ${k15.length}）`);
  }
  const price = (snap.ticker && Number.isFinite(snap.ticker.last)) ? snap.ticker.last : k15[k15.length - 1].c;
  const now = Date.now();
  // 日線大方向，只是給報告看（決策在 BOT.decide 裡自己算）
  const closed4 = k4.filter(b => b.t + 4 * 3600e3 <= now), closedD = d1.filter(b => b.t + 86400e3 <= now);
  let regime = null;
  try { const ctx = STRATEGY.prepare(closed4, closedD); regime = STRATEGY.regime(ctx, closed4.length - 1); } catch (e) {}
  return {
    symbol, now, price, k4, d1, k15, regime,
    fundingRate: snap.funding && Number.isFinite(snap.funding.rate) ? snap.funding.rate : config.fundingPer8h,
    filters: BOT.filtersFor(config, symbol),
    source: snap.source
  };
}

const ACTION_TXT = { open: '開倉', close: '平倉', hold: '續抱', wait: '觀望', blocked: '不做', skip: '跳過', error: '錯誤' };

async function main() {
  const config = loadConfig();
  let state = loadState(config);
  const symbols = BOT.symbolsOf(state.config);
  const rows = [];
  const sources = new Set();
  let ok = 0;

  for (let i = 0; i < symbols.length; i++) {
    const sym = symbols[i];
    if (i > 0) await sleep(GAP_MS);
    let market;
    try {
      market = await fetchMarket(sym, state.config);
    } catch (e) {
      const msg = (e && e.message ? e.message : String(e)).slice(0, 160);
      state = BOT.setStatus(state, sym, Date.now(), 'error', '抓不到行情：' + msg);
      rows.push({ sym, act: 'error', txt: msg });
      continue;
    }
    ok++;
    sources.add(market.source);
    const r = BOT.tick(state, market, state.config);
    state = r.state;
    const fmt = a => a.type === 'open'
      ? `${a.plan.side === 'long' ? '開多' : '開空'} ${+a.plan.qty.toPrecision(6)} 止損 ${px(a.plan.stop)}（風險 $${a.plan.riskUsd.toFixed(2)}）`
      : a.type === 'close'
        ? `${a.why === 'trail' ? '移動止損' : '止損'}出場 @ ${px(a.price)}`
        : (a.reason || '');
    rows.push({
      sym, act: r.action.type, price: market.price,
      trend: market.regime === 'bull' ? '日線多頭' : market.regime === 'bear' ? '日線空頭' : '—',
      txt: fmt(r.action) + (r.then ? '；' + fmt(r.then) : '')
    });
  }

  if (ok === 0) {
    console.error('所有幣都抓不到行情，這一輪不寫入狀態。');
    rows.forEach(r => console.error(`  ${short(r.sym).padEnd(5)} ${r.txt}`));
    process.exit(1);
  }

  state = BOT.mark(state, Date.now());
  const st = BOT.stats(state);

  const L = [];
  L.push('─'.repeat(64));
  L.push(`時間 ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC　來源 ${[...sources].join('/')}　成功 ${ok}/${symbols.length}`);
  L.push('─'.repeat(64));
  L.push(`規則 ${state.config.rules || 'v2'}${state.config.allowShort === false ? '（只做多）' : ''}`);
  L.push('幣     大方向    報價         動作  說明');
  rows.forEach(r => {
    L.push(`${short(r.sym).padEnd(6)} ${(r.trend || '—').padEnd(8)} ${px(r.price).padEnd(12)} ${(ACTION_TXT[r.act] || r.act).padEnd(4)}  ${r.txt}`);
  });
  L.push('─'.repeat(64));
  L.push(`權益 $${f(state.equity)}（起始 $${f(st.startEquity)}，${st.returnPct >= 0 ? '+' : ''}${f(st.returnPct)}%）　持倉 ${st.openCount} 筆`);
  L.push(`成交 ${st.n} 筆` + (st.n ? `　勝率 ${f(st.winRate, 1)}%　平均 ${st.avgR >= 0 ? '+' : ''}${f(st.avgR, 3)} R　最大回撤 ${f(st.maxDD, 1)}%` : ''));
  L.push(`成本 手續費 $${f(st.feesPaid)} + 資金費 $${f(st.fundingPaid)}　第 ${st.ticks} 輪`);
  if (!st.enough) L.push('⚠ 未滿 30 筆，現在的勝率沒有統計意義');
  L.push('─'.repeat(64));
  console.log(L.join('\n'));

  if (DRY) { console.log('（--dry，沒有寫入狀態檔）'); return; }
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));
  console.log('狀態已寫入 ' + path.relative(ROOT, STATE_FILE));
}

main().catch(e => { console.error('執行失敗：', e); process.exit(1); });
