/*
 * bot/run.mjs —— 模擬單機器人的執行器
 *
 * 跑一輪：抓真實行情 → 決定動作 → 更新狀態檔。
 * **不下任何真實訂單、不需要 API 金鑰、不碰任何帳戶。**
 *
 * 用法：
 *   node bot/run.mjs           跑一輪並寫回狀態
 *   node bot/run.mjs --dry     跑一輪但不寫檔（測試用）
 *   node bot/run.mjs --reset    砍掉重練（會先備份舊狀態）
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

const f = (v, d = 2) =>
  Number.isFinite(v) ? v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—';

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
  const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  // 設定檔改動時以設定檔為準，但不動已經累積的權益與紀錄
  s.config = Object.assign({}, s.config, config, { startEquity: s.config.startEquity });
  return s;
}

async function fetchMarket(symbol, config) {
  const snap = await DATA.snapshot(symbol, ['15m', '1h', '4h', '1d'], 300);
  const missing = ['15m', '4h', '1d'].filter(tf => !snap.klines[tf] || snap.klines[tf].length < 60);
  if (missing.length) throw new Error('K 線不足的週期：' + missing.join('、'));

  const k15 = snap.klines['15m'];
  const price = (snap.ticker && Number.isFinite(snap.ticker.last))
    ? snap.ticker.last
    : k15[k15.length - 1].c;

  return {
    now: Date.now(),
    price,
    k15,
    analyses: {
      d1: IND.analyze(snap.klines['1d']),
      h4: IND.analyze(snap.klines['4h']),
      m15: IND.analyze(k15)
    },
    // 現貨來源（Kraken）沒有資金費率，退回設定檔的估計值
    fundingRate: snap.funding && Number.isFinite(snap.funding.rate)
      ? snap.funding.rate : config.fundingPer8h,
    // 下單限制一律以「實際會下單的交易所」為準，不是行情來源的
    filters: config.filters,
    source: snap.source,
    hasLiveFunding: !!(snap.funding && Number.isFinite(snap.funding.rate))
  };
}

function report(state, action, market) {
  const st = BOT.stats(state);
  const L = [];
  L.push('─'.repeat(52));
  L.push(`時間     ${new Date(market.now).toISOString().replace('T', ' ').slice(0, 19)} UTC`);
  L.push(`行情來源 ${market.source}${market.hasLiveFunding ? '' : '（無即時資金費率，用估計值）'}`);
  L.push(`報價     ${f(market.price, 1)}`);
  L.push(`動作     ${action.type}${action.reason ? ' — ' + action.reason : ''}${action.why ? ' — ' + action.why : ''}`);

  const T = ['d1', 'h4', 'm15'].map(k => {
    const a = market.analyses[k];
    return `${k}:${a ? a.trend.dir : '?'}`;
  }).join('  ');
  L.push(`趨勢     ${T}`);

  if (state.position) {
    const p = state.position;
    L.push(`持倉     ${p.side === 'long' ? '多' : '空'} ${p.qty} @ ${f(p.entry, 1)}`);
    L.push(`         止損 ${f(p.stop, 1)} / 止盈 ${f(p.tp, 1)} / 名目 $${f(p.notional)}`);
    const unreal = p.side === 'long'
      ? (market.price - p.entry) * p.qty
      : (p.entry - market.price) * p.qty;
    L.push(`         浮動 ${unreal >= 0 ? '+' : ''}${f(unreal)} U`);
  } else {
    L.push('持倉     空手');
  }

  L.push('─'.repeat(52));
  L.push(`權益     $${f(state.equity)}  (起始 $${f(st.startEquity)}, ${st.returnPct >= 0 ? '+' : ''}${f(st.returnPct)}%)`);
  L.push(`交易     ${st.n} 筆` + (st.n ? `  勝率 ${f(st.winRate, 1)}%  平均 ${st.avgR >= 0 ? '+' : ''}${f(st.avgR, 3)} R` : ''));
  if (st.n) {
    L.push(`         最大回撤 ${f(st.maxDD, 1)}%  最長連敗 ${st.maxLossStreak} 筆`);
    L.push(`         獲利因子 ${st.profitFactor === null ? '∞' : f(st.profitFactor)}`);
  }
  L.push(`成本     手續費 $${f(st.feesPaid)} + 資金費 $${f(st.fundingPaid)}`);
  L.push(`執行     第 ${st.ticks} 輪，已跑 ${f(st.runningDays, 1)} 天`);
  if (!st.enough) L.push(`⚠ 未滿 30 筆，現在的勝率沒有統計意義`);
  L.push('─'.repeat(52));
  return L.join('\n');
}

async function main() {
  const config = loadConfig();
  let state = loadState(config);

  let market;
  try {
    market = await fetchMarket(config.symbol, config);
  } catch (e) {
    console.error('抓不到行情，這一輪不動作：' + (e && e.message ? e.message : e));
    console.error('（所有來源都失敗。Binance／Bybit 封鎖美國 IP，Kraken 通常可用。）');
    process.exit(1);
  }

  const { state: next, action } = BOT.tick(state, market, state.config);
  console.log(report(next, action, market));

  if (DRY) {
    console.log('（--dry，沒有寫入狀態檔）');
    return;
  }
  fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 1));
  console.log('狀態已寫入 ' + path.relative(ROOT, STATE_FILE));
}

main().catch(e => {
  console.error('執行失敗：', e);
  process.exit(1);
});
