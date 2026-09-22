/* 回測引擎與模擬器的驗算。最重要的一條：不能偷看未來。 */
import '../assets/risk.js';
import '../assets/indicators.js';
import '../assets/plan.js';
import '../assets/backtest.js';
import '../assets/sim.js';
import assert from 'node:assert/strict';

const B = globalThis.BACKTEST, S = globalThis.SIM, R = globalThis.RISK;
let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); }
}
const near = (a, b, tol = 1e-6) =>
  assert.ok(a !== null && Math.abs(a - b) <= tol, `expected ${a} ≈ ${b} (tol ${tol})`);

const H4 = 4 * 3600 * 1000;

/* 造一段比 4H 更長的日線歷史（實際上交易所也是分開給的） */
function mkDaily(k4, extraDays = 400) {
  const merged = globalThis.BACKTEST.resampleToDaily(k4);
  const first = merged[0];
  const out = [];
  let c = first.o * 0.6;
  for (let i = extraDays; i > 0; i--) {
    const o = c; c = c + (first.o * 0.4) / extraDays;
    out.push({ t: first.t - i * 86400000, o, h: Math.max(o, c) * 1.01,
               l: Math.min(o, c) * 0.99, c, v: 500 });
  }
  return out.concat(merged);
}

/* 造 4H K 線：drift 為每根漲跌、wob 為振幅 */
function mk4h(n, start, drift, wob, seed = 1) {
  const out = []; let c = start, s = seed >>> 0 || 1;
  const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296 - 0.5; };
  // 從 UTC 整日開始，日線切割才乾淨
  const t0 = Math.floor((Date.now() - n * H4) / 86400000) * 86400000;
  for (let i = 0; i < n; i++) {
    const o = c;
    c = c + drift + rnd() * wob;
    out.push({ t: t0 + i * H4, o, h: Math.max(o, c) + Math.abs(rnd()) * wob,
               l: Math.min(o, c) - Math.abs(rnd()) * wob, c, v: 100 });
  }
  return out;
}

console.log('\nresampleToDaily');
t('6 根 4H 併成 1 根日線', () => {
  const k = mk4h(24, 100, 0, 1, 3);
  const d = B.resampleToDaily(k);
  assert.equal(d.length, 4, '24 根 4H 應該是 4 天');
});
t('日線的高低是當日 4H 的極值、收盤是最後一根', () => {
  const k = mk4h(12, 100, 0.5, 2, 5);
  const d = B.resampleToDaily(k);
  const day0 = k.filter(b => Math.floor(b.t / 86400000) === Math.floor(d[0].t / 86400000));
  near(d[0].h, Math.max(...day0.map(b => b.h)), 1e-9);
  near(d[0].l, Math.min(...day0.map(b => b.l)), 1e-9);
  near(d[0].c, day0[day0.length - 1].c, 1e-9);
  near(d[0].o, day0[0].o, 1e-9);
});
t('成交量是當日加總', () => {
  const k = mk4h(6, 100, 0, 1, 7);
  const d = B.resampleToDaily(k);
  near(d[0].v, k.reduce((a, b) => a + b.v, 0), 1e-9);
});

console.log('\nswingUpTo —— 不能用未來的 K 棒確認樞紐');
t('樞紐要左右各 3 根確認後才算數', () => {
  const highs = new Array(60).fill(10); const lows = new Array(60).fill(5);
  highs[20] = 99; highs[40] = 50;
  // 第 25 根時索引 20 已被確認，應該回傳它
  assert.equal(B.swingUpTo(highs, lows, 25, 3).high, 99);
});
t('回傳值永不超出 0..i 的範圍（這才是「不偷看未來」的定義）', () => {
  const highs = Array.from({ length: 60 }, (_, i) => 10 + i);   // 單調遞增
  const lows = Array.from({ length: 60 }, (_, i) => 5 + i);
  for (const i of [10, 25, 40, 55]) {
    const s = B.swingUpTo(highs, lows, i, 3);
    assert.ok(s.high <= Math.max(...highs.slice(0, i + 1)), `i=${i} 的高點超出已知範圍`);
    assert.ok(s.low >= Math.min(...lows.slice(0, i + 1)), `i=${i} 的低點超出已知範圍`);
  }
});
t('完全看不到 i 之後的資料', () => {
  const highs = new Array(60).fill(10); const lows = new Array(60).fill(5);
  highs[50] = 999;    // 遠在 i 之後的巨大高點
  const s = B.swingUpTo(highs, lows, 30, 3);
  assert.ok(s.high < 999, '不該把未來的高點算進來');
});

console.log('\nbacktest.run');
t('K 線不足時回傳錯誤而不是假裝跑完', () => {
  const r = B.run(mk4h(50, 100, 1, 1), { equity: 100 });
  assert.ok(r.error, '應該回傳 error');
});
t('上升趨勢能產生交易，且統計欄位齊全', () => {
  const k = mk4h(700, 20000, 45, 260, 11);
  const r = B.run(k, { equity: 100, riskPct: 1, daily: mkDaily(k) });
  assert.ok(!r.error, r.error);
  assert.ok(r.n > 0, '應該有交易，實際 ' + r.n);
  ['winRate', 'avgR', 'maxDD', 'profitFactor', 'feesPaid'].forEach(k =>
    assert.ok(k in r, '缺少欄位 ' + k));
});
t('進場價一律是「下一根的開盤」，不是當根收盤', () => {
  const k = mk4h(700, 20000, 45, 260, 11);
  const r = B.run(k, { equity: 100, riskPct: 1 });
  const byTime = new Map(k.map(b => [b.t, b]));
  r.trades.forEach(tr => {
    const bar = byTime.get(tr.t);
    assert.ok(bar, '交易時間應該對得上某根 K 線');
    near(tr.entry, bar.o, 1e-9);   // 用的是該根的開盤價
  });
});
t('同一根同時觸及止損與止盈時，算成止損（保守）', () => {
  const k = mk4h(700, 20000, 45, 400, 23);
  const r = B.run(k, { equity: 100, riskPct: 1 });
  const byTime = new Map(k.map(b => [b.t, b]));
  let checked = 0;
  r.trades.forEach(tr => {
    const bar = byTime.get(tr.exitT);
    if (!bar) return;
    const bothHit = tr.side === 'long'
      ? (bar.l <= tr.stop && bar.h >= tr.tp)
      : (bar.h >= tr.stop && bar.l <= tr.tp);
    if (bothHit) { checked++; assert.equal(tr.why, 'stop', '兩邊都碰到時應判為止損'); }
  });
  console.log('      （檢查到 ' + checked + ' 筆同根雙觸）');
});
t('每筆的損益與權益變化一致', () => {
  const r = B.run(mk4h(700, 20000, 45, 260, 11), { equity: 100, riskPct: 1 });
  let eq = 100;
  // 只檢查損益總和與最終權益的關係（資金費另外扣，所以用容差）
  const sumPnl = r.trades.reduce((a, x) => a + x.pnl, 0);
  near(r.equity, 100 + sumPnl - r.fundingPaid, 1e-6);
});
t('輸掉的交易 R 值為負、贏的為正', () => {
  const r = B.run(mk4h(700, 20000, 45, 260, 11), { equity: 100, riskPct: 1 });
  r.trades.forEach(tr => {
    if (tr.pnl > 0) assert.ok(tr.r > 0);
    else assert.ok(tr.r <= 0);
  });
});
t('手續費與資金費都被扣掉了（不是零）', () => {
  const r = B.run(mk4h(700, 20000, 45, 260, 11), { equity: 100, riskPct: 1 });
  assert.ok(r.feesPaid > 0, '手續費應該 > 0');
  assert.ok(r.fundingPaid > 0, '資金費應該 > 0');
});
t('同樣的輸入給同樣的結果（可重現）', () => {
  const k = mk4h(700, 20000, 45, 260, 11);
  const a = B.run(k, { equity: 100, riskPct: 1 });
  const b = B.run(k, { equity: 100, riskPct: 1 });
  assert.equal(a.n, b.n);
  near(a.equity, b.equity, 1e-12);
});
t('槓桿上限會擋掉超出的部位', () => {
  const k = mk4h(700, 20000, 45, 260, 11);
  const lo = B.run(k, { equity: 100, riskPct: 1, maxLeverage: 1 });
  const hi = B.run(k, { equity: 100, riskPct: 1, maxLeverage: 20 });
  assert.ok(lo.skipped.infeasible >= hi.skipped.infeasible,
    '槓桿上限越低，被擋掉的次數應該越多或相等');
});

console.log('\nsim.tradeSizing —— 小資金被最小下單量頂上去');
t('$100 想冒 1%，但最小下單量讓它做不到', () => {
  const s = S.tradeSizing(100, {
    riskPct: 1, price: 80000, stopPct: 2, maxLeverage: 20,
    filters: { minQty: 0.001, stepSize: 0.001, minNotional: 100 }
  });
  assert.equal(s.forcedUp, true, '應該被最小下單量頂上去');
  assert.ok(s.riskPctActual > 1, '實際風險應該大於 1%，實際 ' + s.riskPctActual.toFixed(2));
  near(s.qty, 0.002);                      // 0.001 只有 $80 名目，不足 $100
  near(s.notional, 160, 1e-9);
  near(s.riskAmt, 0.002 * 80000 * 0.02, 1e-9);
});
t('本金夠大時就不會被頂上去', () => {
  const s = S.tradeSizing(10000, {
    riskPct: 1, price: 80000, stopPct: 2, maxLeverage: 20,
    filters: { minQty: 0.001, stepSize: 0.001, minNotional: 100 }
  });
  assert.equal(s.forcedUp, false);
  assert.ok(Math.abs(s.riskPctActual - 1) < 0.35, '應該接近 1%，實際 ' + s.riskPctActual.toFixed(2));
});
t('槓桿超過上限時標記為不可交易', () => {
  const s = S.tradeSizing(20, {
    riskPct: 1, price: 80000, stopPct: 2, maxLeverage: 5,
    filters: { minQty: 0.001, stepSize: 0.001, minNotional: 100 }
  });
  assert.equal(s.tradeable, false);
});

console.log('\nsim.monteCarlo');
t('同樣的 seed 給同樣的結果', () => {
  const a = S.monteCarlo({ equity: 100, runs: 200, seed: 42 });
  const b = S.monteCarlo({ equity: 100, runs: 200, seed: 42 });
  near(a.median, b.median, 1e-12);
  near(a.ruinPct, b.ruinPct, 1e-12);
});
t('期望值公式正確', () => {
  const r = S.monteCarlo({ equity: 100, runs: 10, winRate: 0.5, rr: 2, seed: 1 });
  near(r.expectancyR, 0.5 * 2 - 0.5, 1e-12);
});
t('負期望值的設定會讓中位數低於起始本金', () => {
  const r = S.monteCarlo({ equity: 1000, runs: 1000, winRate: 0.4, rr: 1, nTrades: 100, seed: 9 });
  assert.ok(r.median < 1000, '中位數應該低於起始本金，實際 ' + r.median.toFixed(1));
});
t('正期望值 + 大本金（不受最小下單量影響）中位數會成長', () => {
  const r = S.monteCarlo({ equity: 50000, runs: 1000, winRate: 0.5, rr: 2,
                           nTrades: 100, riskPct: 1, seed: 9 });
  assert.ok(r.median > 50000, '中位數應該成長，實際 ' + r.median.toFixed(0));
});
t('破產率與翻倍率都在 0~100 之間且合理', () => {
  const r = S.monteCarlo({ equity: 100, runs: 500, seed: 3 });
  assert.ok(r.ruinPct >= 0 && r.ruinPct <= 100);
  assert.ok(r.doublePct >= 0 && r.doublePct <= 100);
});
t('百分位數有序', () => {
  const r = S.monteCarlo({ equity: 100, runs: 500, seed: 3 });
  assert.ok(r.p5 <= r.p25 && r.p25 <= r.median && r.median <= r.p75 && r.p75 <= r.p95,
    `百分位數順序錯誤: ${r.p5} ${r.p25} ${r.median} ${r.p75} ${r.p95}`);
});
t('風險開越大，結果分布越寬', () => {
  const lo = S.monteCarlo({ equity: 5000, runs: 800, riskPct: 1, seed: 5 });
  const hi = S.monteCarlo({ equity: 5000, runs: 800, riskPct: 5, seed: 5 });
  assert.ok((hi.p95 - hi.p5) > (lo.p95 - lo.p5), '高風險的分布應該更寬');
});

console.log('\n' + (fail === 0 ? `全部通過（${pass} 項）` : `${pass} 通過 / ${fail} 失敗`));
process.exit(fail === 0 ? 0 : 1);
