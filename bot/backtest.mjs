/*
 * bot/backtest.mjs —— 用真實歷史 K 線回測機器人的規則（多幣種）
 *
 * 不用等排程慢慢累積：直接抓各幣過去的真實 4H 與日線，把同一套規則逐根跑一遍。
 * 引擎是 assets/backtest.js（嚴格不偷看未來、同根雙觸算止損、扣手續費與資金費）。
 *
 * 跟即時機器人的差別（要講清楚）：
 *   - 回測只用「日線 + 4H」定方向，沒有 15m 的時機過濾
 *     （Kraken 只給最近 720 根，15m 只有 7.5 天，不夠回測）
 *   - 每個幣各自用一個 $100 的獨立帳戶，不是共用權益
 *
 * 輸出：bot/backtest.json + 終端機表格
 */
import fs from 'node:fs';
import path from 'node:path';
import '../assets/risk.js';
import '../assets/indicators.js';
import '../assets/plan.js';
import '../assets/backtest.js';
import '../assets/bot.js';
import '../assets/data.js';

const { BACKTEST, BOT, DATA } = globalThis;
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, 'bot', 'backtest.json');
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'bot', 'config.json'), 'utf8'));
const DRY = process.argv.includes('--dry');
const GAP_MS = Number(process.env.BOT_GAP_MS ?? 1500);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const f = (v, d = 2) => Number.isFinite(v) ? v.toFixed(d) : '—';
const day = t => new Date(t).toISOString().slice(0, 10);
const short = s => s.replace(/USDT$/, '');

function pooled(trades, equity0) {
  const n = trades.length;
  if (!n) return { n: 0 };
  const wins = trades.filter(t => t.pnl > 0);
  const sumR = trades.reduce((a, t) => a + (Number.isFinite(t.r) ? t.r : 0), 0);
  const gw = wins.reduce((a, t) => a + t.pnl, 0);
  const gl = Math.abs(trades.filter(t => t.pnl <= 0).reduce((a, t) => a + t.pnl, 0));
  // 依時間排序後算連敗與 R 曲線回撤
  const sorted = trades.slice().sort((a, b) => a.t - b.t);
  let streak = 0, maxStreak = 0, cum = 0, peak = 0, maxDDR = 0;
  sorted.forEach(t => {
    if (t.pnl <= 0) { streak++; maxStreak = Math.max(maxStreak, streak); } else streak = 0;
    cum += t.r; peak = Math.max(peak, cum); maxDDR = Math.max(maxDDR, peak - cum);
  });
  return {
    n, winRate: wins.length / n * 100, avgR: sumR / n, totalR: sumR,
    profitFactor: gl > 0 ? gw / gl : null, maxLossStreak: maxStreak, maxDDR
  };
}

async function main() {
  const symbols = BOT.symbolsOf(config);
  const rows = [];
  const allTrades = [];
  const sources = new Set();

  for (let i = 0; i < symbols.length; i++) {
    const sym = symbols[i];
    if (i > 0) await sleep(GAP_MS);
    try {
      const h = await DATA.history(sym, { bars4h: 1500, barsD: 1000 });
      sources.add(h.source);
      const r = BACKTEST.run(h.k4, {
        equity: config.startEquity, riskPct: config.riskPct,
        maxLeverage: config.maxLeverage, feeRate: config.feeRate,
        fundingPer8h: config.fundingPer8h, rMultiples: config.rMultiples,
        daily: h.d1, filters: BOT.filtersFor(config, sym)
      });
      if (r.error) { rows.push({ symbol: sym, error: r.error }); continue; }
      r.trades.forEach(t => allTrades.push(Object.assign({ symbol: sym }, t)));
      rows.push({
        symbol: sym, source: h.source, bars4h: h.k4.length, barsD: h.d1.length,
        from: r.from, to: r.to, n: r.n, winRate: r.winRate, avgR: r.avgR, totalR: r.totalR,
        returnPct: r.returnPct, maxDD: r.maxDD, profitFactor: r.profitFactor,
        maxLossStreak: r.maxLossStreak, fees: r.feesPaid, funding: r.fundingPaid,
        skipped: r.skipped,
        trades: r.trades.map(t => ({ t: t.t, exitT: t.exitT, side: t.side, entry: t.entry,
          exit: t.exit, r: t.r, pnl: t.pnl, why: t.why }))
      });
    } catch (e) {
      rows.push({ symbol: sym, error: (e && e.message ? e.message : String(e)).slice(0, 200) });
    }
  }

  const ok = rows.filter(r => !r.error);
  const pool = pooled(allTrades, config.startEquity);
  const out = {
    generatedAt: Date.now(),
    source: [...sources].join('/'),
    rule: '日線 + 4H 同向才進場（回測沒有 15m 時機過濾）；止損 = 4H 結構外 0.25 ATR，夾在 0.8～2.5 ATR；止盈 1.5R 全出',
    params: { startEquity: config.startEquity, riskPct: config.riskPct, maxLeverage: config.maxLeverage,
              feeRate: config.feeRate, fundingPer8h: config.fundingPer8h },
    pooled: pool,
    symbols: rows
  };

  // ── 終端機表格 ──
  const L = [];
  L.push('═'.repeat(78));
  L.push(`歷史回測　來源 ${out.source || '—'}　成功 ${ok.length}/${symbols.length} 個幣　每幣起始 $${config.startEquity}、單筆風險 ${config.riskPct}%`);
  L.push('═'.repeat(78));
  L.push('幣     期間                     筆數  勝率    平均R    報酬     最大回撤  獲利因子');
  rows.forEach(r => {
    if (r.error) { L.push(`${short(r.symbol).padEnd(6)} ✗ ${r.error}`); return; }
    L.push(`${short(r.symbol).padEnd(6)} ${day(r.from)}~${day(r.to)}  ${String(r.n).padStart(4)}  ` +
      `${(r.n ? f(r.winRate, 1) + '%' : '—').padStart(6)}  ${(r.n ? (r.avgR >= 0 ? '+' : '') + f(r.avgR, 3) : '—').padStart(7)}  ` +
      `${((r.returnPct >= 0 ? '+' : '') + f(r.returnPct, 1) + '%').padStart(7)}  ${(f(r.maxDD, 1) + '%').padStart(8)}  ` +
      `${(r.profitFactor === null ? (r.n ? '∞' : '—') : f(r.profitFactor)).padStart(7)}`);
  });
  L.push('─'.repeat(78));
  if (pool.n) {
    L.push(`合計 ${pool.n} 筆　勝率 ${f(pool.winRate, 1)}%　平均 ${pool.avgR >= 0 ? '+' : ''}${f(pool.avgR, 3)} R　` +
      `總計 ${pool.totalR >= 0 ? '+' : ''}${f(pool.totalR, 1)} R　獲利因子 ${pool.profitFactor === null ? '∞' : f(pool.profitFactor)}　` +
      `最長連敗 ${pool.maxLossStreak}　R 曲線最大回撤 ${f(pool.maxDDR, 1)} R`);
  } else {
    L.push('合計 0 筆');
  }
  L.push('═'.repeat(78));
  console.log(L.join('\n'));

  if (!ok.length) { console.error('全部幣都失敗，不寫檔'); process.exit(1); }
  if (DRY) { console.log('（--dry，沒有寫檔）'); return; }
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log('結果已寫入 ' + path.relative(ROOT, OUT));
}

main().catch(e => { console.error('執行失敗：', e); process.exit(1); });
