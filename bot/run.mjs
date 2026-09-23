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
import '../assets/plan.js';
import '../assets/bot.js';
import '../assets/data.js';

const { BOT, IND, DATA } = globalThis;
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
  s.config = Object.assign({}, s.config, config, { startEquity: s.config.startEquity });
  delete s.config.symbol;
  return s;
}

async function fetchMarket(symbol, config) {
  const snap = await DATA.snapshot(symbol, ['15m', '4h', '1d'], 300);
  const missing = ['15m', '4h', '1d'].filter(tf => !snap.klines[tf] || snap.klines[tf].length < 60);
  if (missing.length) throw new Error('K 線不足：' + missing.join('、'));

  const k15 = snap.klines['15m'];
  const price = (snap.ticker && Number.isFinite(snap.ticker.last)) ? snap.ticker.last : k15[k15.length - 1].c;
  return {
    symbol,
    now: Date.now(),
    price,
    k15,
    analyses: {
      d1: IND.analyze(snap.klines['1d']),
      h4: IND.analyze(snap.klines['4h']),
      m15: IND.analyze(k15)
    },
    // 現貨來源（Kraken）沒有資金費率，退回設定檔的估計值
    fundingRate: snap.funding && Number.isFinite(snap.funding.rate) ? snap.funding.rate : config.fundingPer8h,
    // 下單限制一律以「實際會下單的交易所」為準（設定檔），不是行情來源的
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
    const { state: next, action } = BOT.tick(state, market, state.config);
    state = next;
    const tr = ['d1', 'h4', 'm15'].map(k => market.analyses[k].trend.dir[0].toUpperCase()).join('');
    rows.push({
      sym, act: action.type, price: market.price, trend: tr,
      txt: action.type === 'open'
        ? `${action.plan.side === 'long' ? '多' : '空'} ${action.plan.qty} 止損 ${px(action.plan.stop)} 止盈 ${px(action.plan.targets[0].price)}`
        : action.type === 'close'
          ? `${action.why === 'tp' ? '止盈' : '止損'} @ ${px(action.price)}`
          : (action.reason || '')
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
  L.push('幣     趨勢(日/4H/15m)  報價         動作  說明');
  rows.forEach(r => {
    L.push(`${short(r.sym).padEnd(6)} ${(r.trend || '---').padEnd(16)} ${px(r.price).padEnd(12)} ${(ACTION_TXT[r.act] || r.act).padEnd(4)}  ${r.txt}`);
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
