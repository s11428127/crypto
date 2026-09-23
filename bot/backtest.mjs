/*
 * bot/backtest.mjs —— 新舊規則在同一份真實長歷史上並排回測
 *
 * 資料：優先用 Bitstamp 的 3 年 4H + 日線（涵蓋多頭、空頭、盤整）；
 *       某個幣抓不到就退回 Kraken（只有最近約 120 天，會標註）。
 * 規則：v1 = 原本的規則（assets/backtest.js）
 *       v2 = 順大勢、等回檔、移動止損（assets/strategy.js）
 * 報告：各幣、合計、多空分開、同期買進持有、**按季拆分**（看不同行情下各自表現）
 *
 * 每個幣各用一個獨立的 $100 帳戶。
 */
import fs from 'node:fs';
import path from 'node:path';
import '../assets/risk.js';
import '../assets/indicators.js';
import '../assets/plan.js';
import '../assets/backtest.js';
import '../assets/strategy.js';
import '../assets/bot.js';
import '../assets/data.js';
import { longHistory } from './history.mjs';

const { BACKTEST, STRATEGY, BOT, DATA } = globalThis;
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, 'bot', 'backtest.json');
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'bot', 'config.json'), 'utf8'));
const DRY = process.argv.includes('--dry');
const YEARS = Number(process.env.BACKTEST_YEARS ?? 3);
const GAP_MS = Number(process.env.BOT_GAP_MS ?? 300);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const f = (v, d = 2) => Number.isFinite(v) ? v.toFixed(d) : '—';
const sgn = (v, d = 2) => Number.isFinite(v) ? (v >= 0 ? '+' : '') + v.toFixed(d) : '—';
const day = t => new Date(t).toISOString().slice(0, 10);
const short = s => s.replace(/USDT$/, '');
const quarter = t => { const d = new Date(t); return d.getUTCFullYear() + 'Q' + (Math.floor(d.getUTCMonth() / 3) + 1); };

function sideStats(trades) {
  if (!trades.length) return { n: 0 };
  const w = trades.filter(t => t.pnl > 0).length;
  const sumR = trades.reduce((a, t) => a + (Number.isFinite(t.r) ? t.r : 0), 0);
  return { n: trades.length, winRate: w / trades.length * 100, avgR: sumR / trades.length, totalR: sumR };
}

function pooled(trades) {
  const n = trades.length;
  if (!n) return { n: 0, long: { n: 0 }, short: { n: 0 } };
  const wins = trades.filter(t => t.pnl > 0);
  const sumR = trades.reduce((a, t) => a + (Number.isFinite(t.r) ? t.r : 0), 0);
  const gw = wins.reduce((a, t) => a + t.pnl, 0);
  const gl = Math.abs(trades.filter(t => t.pnl <= 0).reduce((a, t) => a + t.pnl, 0));
  const sorted = trades.slice().sort((a, b) => a.t - b.t);
  let streak = 0, maxStreak = 0, cum = 0, peak = 0, maxDDR = 0;
  sorted.forEach(t => {
    if (t.pnl <= 0) { streak++; maxStreak = Math.max(maxStreak, streak); } else streak = 0;
    cum += t.r; peak = Math.max(peak, cum); maxDDR = Math.max(maxDDR, peak - cum);
  });
  return {
    n, winRate: wins.length / n * 100, avgR: sumR / n, totalR: sumR,
    profitFactor: gl > 0 ? gw / gl : null, maxLossStreak: maxStreak, maxDDR,
    long: sideStats(trades.filter(t => t.side === 'long')),
    short: sideStats(trades.filter(t => t.side === 'short'))
  };
}

function summarize(sym, r, k4, source) {
  const i0 = Math.max(0, k4.findIndex(b => b.t >= r.from));
  return {
    symbol: sym, source, from: r.from, to: r.to, n: r.n, winRate: r.winRate, avgR: r.avgR,
    totalR: r.totalR, returnPct: r.returnPct, maxDD: r.maxDD, profitFactor: r.profitFactor,
    maxLossStreak: r.maxLossStreak, fees: r.feesPaid, funding: r.fundingPaid,
    buyHoldPct: (k4[k4.length - 1].c / k4[i0].c - 1) * 100,
    long: sideStats(r.trades.filter(t => t.side === 'long')),
    short: sideStats(r.trades.filter(t => t.side === 'short')),
    trades: r.trades.map(t => ({ t: t.t, exitT: t.exitT, side: t.side, entry: t.entry,
      exit: t.exit, r: t.r, pnl: t.pnl, why: t.why }))
  };
}

async function fetchHistory(sym) {
  try {
    const h = await longHistory(sym, { years: YEARS, gapMs: GAP_MS });
    if (h.k4.length >= 600 && h.d1.length >= 260) return h;
    throw new Error(`Bitstamp 資料太短（4H ${h.k4.length}、日線 ${h.d1.length}）`);
  } catch (e) {
    // 退回 Kraken：只有最近 720 根，v2 需要的日線 EMA200 還湊得出來，但期間很短
    const k = await DATA.history(sym, { bars4h: 1500, barsD: 1000 });
    return { k4: k.k4, d1: k.d1, source: k.source + '（Bitstamp 失敗：' + String(e.message || e).slice(0, 60) + '）' };
  }
}

async function main() {
  const symbols = BOT.symbolsOf(config);
  const common = {
    equity: config.startEquity, riskPct: config.riskPct, maxLeverage: config.maxLeverage,
    maxRiskPct: config.maxRiskPct, feeRate: config.feeRate, fundingPer8h: config.fundingPer8h
  };
  const out = { v1: [], v2: [] };
  const all = { v1: [], v2: [] };
  const qBuyHold = {};               // quarter → [各幣該季漲跌]
  const sources = new Set();

  for (let i = 0; i < symbols.length; i++) {
    const sym = symbols[i];
    if (i > 0) await sleep(GAP_MS);
    let h;
    try { h = await fetchHistory(sym); }
    catch (e) {
      const err = String(e && e.message || e).slice(0, 200);
      out.v1.push({ symbol: sym, error: err }); out.v2.push({ symbol: sym, error: err });
      continue;
    }
    sources.add(h.source.split('（')[0]);
    const filters = BOT.filtersFor(config, sym);

    const r1 = BACKTEST.run(h.k4, Object.assign({}, common, { daily: h.d1, filters, rMultiples: config.rMultiples }));
    const r2 = STRATEGY.backtest(h.k4, h.d1, Object.assign({}, common, { filters }));
    for (const [key, r] of [['v1', r1], ['v2', r2]]) {
      if (r.error) { out[key].push({ symbol: sym, source: h.source, error: r.error }); continue; }
      out[key].push(summarize(sym, r, h.k4, h.source));
      r.trades.forEach(t => all[key].push(Object.assign({ symbol: sym }, t)));
    }

    // 每一季的買進持有（用 4H 收盤）
    const byQ = {};
    h.k4.forEach(b => { const q = quarter(b.t); (byQ[q] = byQ[q] || []).push(b.c); });
    for (const q in byQ) {
      const arr = byQ[q];
      (qBuyHold[q] = qBuyHold[q] || []).push((arr[arr.length - 1] / arr[0] - 1) * 100);
    }
  }

  // 按季拆分：交易依進場時間歸季
  const qs = Object.keys(qBuyHold).sort();
  const quarters = qs.map(q => {
    const bh = qBuyHold[q];
    const row = { q, buyHold: bh.reduce((a, b) => a + b, 0) / bh.length };
    for (const key of ['v1', 'v2']) {
      const tr = all[key].filter(t => quarter(t.t) === q);
      row[key] = { n: tr.length, totalR: tr.reduce((a, t) => a + t.r, 0),
                   avgR: tr.length ? tr.reduce((a, t) => a + t.r, 0) / tr.length : null };
    }
    return row;
  });

  const ok2 = out.v2.filter(r => !r.error);
  const avgBH = rows => { const ok = rows.filter(r => !r.error); return ok.length ? ok.reduce((a, r) => a + r.buyHoldPct, 0) / ok.length : null; };
  const result = {
    generatedAt: Date.now(),
    source: [...sources].join('/'),
    years: YEARS,
    params: Object.assign({}, common),
    rules: {
      v1: { name: '原本的規則', desc: '日線 + 4H 同向就進場（回測沒有 15m 時機）；止損 = 4H 結構外 0.25 ATR；止盈 1.5R 全出',
            pooled: Object.assign(pooled(all.v1), { avgBuyHoldPct: avgBH(out.v1) }), symbols: out.v1 },
      v2: { name: '順大勢、等回檔、移動止損', desc: '日線 EMA200 定多空方向；4H 多頭排列且回檔到 EMA20 後站回才進；不追價（離 EMA20 > 1 ATR 或 RSI 過熱不進）；止損 = 近 5 根高低點外 0.25 ATR（1～3 ATR）；賺 1R 後保本、之後最高價 − 3 ATR 移動止損；止損後冷卻 24 小時',
            params: STRATEGY.PARAMS,
            pooled: Object.assign(pooled(all.v2), { avgBuyHoldPct: avgBH(out.v2) }), symbols: out.v2 }
    },
    quarters
  };
  // 相容舊版檢視頁：最上層放 v2
  result.pooled = result.rules.v2.pooled;
  result.symbols = result.rules.v2.symbols;

  // ── 終端機報告 ──
  const L = [];
  L.push('═'.repeat(88));
  L.push(`回測　來源 ${result.source}　${YEARS} 年　每幣 $${config.startEquity}、單筆風險 ${config.riskPct}%、手續費 ${f(config.feeRate * 100, 3)}%`);
  for (const key of ['v1', 'v2']) {
    const R = result.rules[key];
    L.push('═'.repeat(88));
    L.push(`${key}：${R.name}`);
    L.push('幣     來源      期間                    筆數  勝率    平均R    報酬     買進持有  多單R       空單R');
    R.symbols.forEach(r => {
      if (r.error) { L.push(`${short(r.symbol).padEnd(6)} ✗ ${r.error}`); return; }
      const sd = x => x.n ? `${sgn(x.avgR)}×${x.n}` : '—';
      L.push(`${short(r.symbol).padEnd(6)} ${r.source.split('（')[0].padEnd(9)} ${day(r.from)}~${day(r.to)} ${String(r.n).padStart(4)}  ` +
        `${(r.n ? f(r.winRate, 1) + '%' : '—').padStart(6)}  ${(r.n ? sgn(r.avgR, 3) : '—').padStart(7)}  ` +
        `${(sgn(r.returnPct, 1) + '%').padStart(7)}  ${(sgn(r.buyHoldPct, 1) + '%').padStart(8)}  ${sd(r.long).padStart(10)}  ${sd(r.short).padStart(10)}`);
    });
    const p = R.pooled;
    L.push('─'.repeat(88));
    L.push(p.n ? `合計 ${p.n} 筆　勝率 ${f(p.winRate, 1)}%　平均 ${sgn(p.avgR, 3)} R　總計 ${sgn(p.totalR, 1)} R　` +
      `獲利因子 ${p.profitFactor === null ? '∞' : f(p.profitFactor)}　最長連敗 ${p.maxLossStreak}　R 回撤 ${f(p.maxDDR, 1)}` : '合計 0 筆');
    if (p.n) L.push(`多單 ${p.long.n} 筆 ${sgn(p.long.avgR, 3)} R　空單 ${p.short.n} 筆 ${sgn(p.short.avgR, 3)} R`);
  }
  L.push('═'.repeat(88));
  L.push('按季拆分（各幣合計；買進持有為各幣該季平均漲跌）');
  L.push('季       買進持有   v1 筆數  v1 總R    v2 筆數  v2 總R');
  quarters.forEach(q => L.push(`${q.q.padEnd(8)} ${(sgn(q.buyHold, 1) + '%').padStart(8)}   ${String(q.v1.n).padStart(6)}  ${sgn(q.v1.totalR, 1).padStart(7)}   ${String(q.v2.n).padStart(6)}  ${sgn(q.v2.totalR, 1).padStart(7)}`));
  L.push('═'.repeat(88));
  console.log(L.join('\n'));

  if (!ok2.length) { console.error('全部幣都失敗，不寫檔'); process.exit(1); }
  if (DRY) { console.log('（--dry，沒有寫檔）'); return; }
  fs.writeFileSync(OUT, JSON.stringify(result));
  console.log('結果已寫入 ' + path.relative(ROOT, OUT));
}

main().catch(e => { console.error('執行失敗：', e); process.exit(1); });
