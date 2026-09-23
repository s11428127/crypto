/* 規則 v2 的驗算：每一條規則單獨測，再測整段回測不偷看未來、成本算對 */
import '../assets/risk.js';
import '../assets/indicators.js';
import '../assets/backtest.js';
import '../assets/strategy.js';
import assert from 'node:assert/strict';

const S = globalThis.STRATEGY;
let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); }
}
const near = (a, b, tol = 1e-9) =>
  assert.ok(Number.isFinite(a) && Math.abs(a - b) <= tol, `expected ${a} ≈ ${b} (tol ${tol})`);
const H4 = 4 * 3600e3, DAY = 86400e3;

/* 手工的最小 ctx：第 5 根收盤時判斷。ATR=10、EMA20=100、EMA50=90 */
function ctx(over = {}) {
  const n = 6;
  const base = {
    c: Array(n).fill(105), h: Array(n).fill(108), l: Array(n).fill(106),
    e20: Array(n).fill(100), e50: Array(n).fill(90),
    atr: Array(n).fill(10), rsi: Array(n).fill(55),
    dIdx: Array(n).fill(0), dc: [200], dEma: [150]           // 日線在 EMA200 之上 → 多頭
  };
  base.l[3] = 102;                                            // 第 3 根回檔到 EMA20 附近
  return Object.assign(base, over);
}
const I5 = 5;

console.log('\nprepare —— 日線對齊不能偷看');
t('每根 4H 只用「收盤當下已經收盤」的日線', () => {
  const d1 = Array.from({ length: 10 }, (_, i) => ({ t: i * DAY, o: 1, h: 1, l: 1, c: 1, v: 1 }));
  const k4 = Array.from({ length: 60 }, (_, i) => ({ t: i * H4, o: 1, h: 1, l: 1, c: 1, v: 1 }));
  const c = S.prepare(k4, d1);
  for (let i = 0; i < k4.length; i++) {
    const d = c.dIdx[i];
    if (d >= 0) assert.ok(d1[d].t + DAY <= k4[i].t + H4, `第 ${i} 根用到還沒收盤的日線`);
    if (d + 1 < d1.length) assert.ok(d1[d + 1].t + DAY > k4[i].t + H4, `第 ${i} 根沒用到已經收盤的日線`);
  }
  assert.equal(c.dIdx[0], -1, '第一根 4H 收盤時還沒有任何日線收盤');
  assert.equal(c.dIdx[5], 0, '20:00–24:00 那根收盤時，當天的日線剛好收盤');
  assert.equal(c.dIdx[4], -1);
});

console.log('\nsignal —— 做多的每一條規則');
t('條件都滿足 → 做多', () => {
  const s = S.signal(ctx(), I5);
  assert.equal(s.side, 'long');
  assert.ok(s.stop < 105);
});
t('大方向過濾：日線在 EMA200 之下就不做多', () => {
  assert.equal(S.signal(ctx({ dc: [100], dEma: [150] }), I5), null);
});
t('日線 EMA200 還算不出來 → 不做', () => {
  assert.equal(S.signal(ctx({ dEma: [null] }), I5), null);
  assert.equal(S.signal(ctx({ dIdx: Array(6).fill(-1) }), I5), null);
});
t('4H 不是多頭排列就不做', () => {
  assert.equal(S.signal(ctx({ e50: Array(6).fill(101) }), I5), null);
});
t('沒有回檔就不進（不追）', () => {
  const c = ctx(); c.l = Array(6).fill(106);                 // 最低也離 EMA20 超過 0.5 ATR
  assert.equal(S.signal(c, I5), null);
});
t('回檔發生在 3 根以前也不算', () => {
  const c = ctx(); c.l = Array(6).fill(106); c.l[2] = 101;   // 第 2 根 → 不在最近 3 根內
  assert.equal(S.signal(c, I5), null);
});
t('還沒站回 EMA20 就不進', () => {
  assert.equal(S.signal(ctx({ c: Array(6).fill(99) }), I5), null);
});
t('離 EMA20 超過 1 ATR（追價）就不進', () => {
  assert.equal(S.signal(ctx({ c: Array(6).fill(111) }), I5), null);
  assert.ok(S.signal(ctx({ c: Array(6).fill(109) }), I5), '差 0.9 ATR 應該還可以');
});
t('RSI 過熱（> 70）就不進', () => {
  assert.equal(S.signal(ctx({ rsi: Array(6).fill(72) }), I5), null);
});
t('止損放在最近 5 根最低點外 0.25 ATR', () => {
  const c = ctx(); c.l = [106, 90, 102, 102, 104, 103];      // 最近 5 根（1..5）最低 90
  c.l[1] = 90;
  // 距離 = 105 − (90 − 2.5) = 17.5 → 在 1~3 ATR 之間
  near(S.signal(c, I5).stop, 87.5);
});
t('止損太近時撐開到 1 ATR、太遠時夾到 3 ATR', () => {
  const near1 = ctx(); near1.l = [106, 104.9, 104.9, 102, 104.9, 104.9];
  near1.l[3] = 104.5;                                         // 有碰到 EMA20+5=105
  near(S.signal(near1, I5).stop, 95);                         // 105 − 10
  const far = ctx(); far.l[1] = 20;
  near(S.signal(far, I5).stop, 75);                           // 105 − 30
});

console.log('\nsignal —— 做空是鏡像');
function sctx(over = {}) {
  const n = 6;
  const base = {
    c: Array(n).fill(95), h: Array(n).fill(94), l: Array(n).fill(92),
    e20: Array(n).fill(100), e50: Array(n).fill(110),
    atr: Array(n).fill(10), rsi: Array(n).fill(45),
    dIdx: Array(n).fill(0), dc: [100], dEma: [150]           // 日線在 EMA200 之下 → 空頭
  };
  base.h[4] = 98;                                             // 反彈到 EMA20 附近
  return Object.assign(base, over);
}
t('條件都滿足 → 做空，止損在上方', () => {
  const s = S.signal(sctx(), I5);
  assert.equal(s.side, 'short');
  assert.ok(s.stop > 95);
});
t('日線在 EMA200 之上就不做空', () => {
  assert.equal(S.signal(sctx({ dc: [200] }), I5), null);
});
t('RSI 過冷（< 30）就不追空', () => {
  assert.equal(S.signal(sctx({ rsi: Array(6).fill(25) }), I5), null);
});

console.log('\ntrail —— 止損只進不退');
const base = { side: 'long', entry: 100, stop: 90, initRisk: 10, best: 100 };
function tc(h, atr) { return { h: [h], l: [h - 5], atr: [atr] }; }
t('還沒賺到 1R：止損不動', () => {
  const r = S.trail(base, tc(105, 10), 0);
  near(r.stop, 90);
});
t('賺到 1R：止損移到成本', () => {
  const r = S.trail(base, tc(110, 10), 0);
  assert.ok(r.stop >= 100, '應該至少保本，實際 ' + r.stop);
});
t('繼續漲：止損跟著最高價 − 3 ATR 往上', () => {
  const r = S.trail(base, tc(140, 10), 0);
  near(r.stop, 110);
  near(r.best, 140);
});
t('價格回落時止損不會跟著往下', () => {
  const up = S.trail(base, tc(140, 10), 0);
  const down = S.trail(Object.assign({}, base, up), tc(115, 10), 0);
  assert.ok(down.stop >= up.stop, '止損後退了：' + up.stop + ' → ' + down.stop);
});
t('ATR 變大也不會讓止損後退', () => {
  const up = S.trail(base, tc(140, 10), 0);                   // 止損 110
  const wide = S.trail(Object.assign({}, base, up), tc(140, 30), 0);   // 140 − 90 = 50 < 110
  near(wide.stop, up.stop);
});
t('做空方向相反，止損只往下移', () => {
  const sp = { side: 'short', entry: 100, stop: 110, initRisk: 10, best: 100 };
  const a = S.trail(sp, { h: [95], l: [60], atr: [10] }, 0);
  near(a.stop, 90);                                            // 60 + 30
  const b = S.trail(Object.assign({}, sp, a), { h: [85], l: [80], atr: [10] }, 0);
  assert.ok(b.stop <= a.stop);
});

console.log('\nhitStop —— 跳空照實算');
t('盤中碰到止損 → 以止損價出場', () => {
  near(S.hitStop({ side: 'long', stop: 90 }, { o: 95, h: 96, l: 89, c: 94 }), 90);
});
t('開盤就跳空越過止損 → 以開盤價出場（更差）', () => {
  near(S.hitStop({ side: 'long', stop: 90 }, { o: 85, h: 88, l: 80, c: 86 }), 85);
  near(S.hitStop({ side: 'short', stop: 110 }, { o: 115, h: 118, l: 112, c: 116 }), 115);
});
t('沒碰到 → null', () => {
  assert.equal(S.hitStop({ side: 'long', stop: 90 }, { o: 95, h: 99, l: 91, c: 97 }), null);
});

console.log('\nsize —— 部位由風險決定');
const O = { riskPct: 1, maxRiskPct: 5, maxLeverage: 5,
            filters: { minQty: 0, stepSize: 0.001, minNotional: 5 } };
t('虧損金額不超過本金 1%（捨去）', () => {
  const s = S.size(100, 100, 95, O);
  assert.ok(s.riskUsd <= 1 + 1e-12, '風險 ' + s.riskUsd);
});
t('波動大（止損遠）→ 部位自動變小', () => {
  const tight = S.size(100, 100, 98, O), wide = S.size(100, 100, 90, O);
  assert.ok(wide.notional < tight.notional);
});
t('名目超過槓桿上限 → 擋下', () => {
  assert.equal(S.size(100, 100, 99.9, O).blocked, 'leverage');
});
t('最小下單量把風險頂超過上限 → 擋下', () => {
  const big = Object.assign({}, O, { filters: { minQty: 1, stepSize: 1, minNotional: 5 } });
  assert.equal(S.size(100, 100, 90, big).blocked, 'risk');   // 最少 1 顆，風險 $10 = 10%
});

console.log('\nbacktest —— 整段流程');
/* 同一條價格曲線取樣成日線與 4H，時間對齊 */
function series(fn, days, k4days) {
  const d1 = [], k4 = [];
  const t0 = Date.UTC(2023, 0, 1);
  for (let d = 0; d < days; d++) {
    const o = fn(d), c = fn(d + 1);
    d1.push({ t: t0 + d * DAY, o, h: Math.max(o, c) * 1.01, l: Math.min(o, c) * 0.99, c, v: 1 });
  }
  const s4 = days - k4days;
  for (let j = 0; j < k4days * 6; j++) {
    const d = s4 + j / 6, o = fn(d), c = fn(d + 1 / 6);
    k4.push({ t: t0 + d * DAY, o, h: Math.max(o, c) + 0.3, l: Math.min(o, c) - 0.3, c, v: 1 });
  }
  return { d1, k4 };
}
const bull = series(d => 100 + d * 0.25 + 6 * Math.sin(d / 2.3), 500, 150);
const bear = series(d => 300 - d * 0.25 + 6 * Math.sin(d / 2.3), 500, 150);
const OPT = { equity: 100, riskPct: 1, maxLeverage: 5, filters: { minQty: 0, stepSize: 0, minNotional: 5 } };

t('資料不足時回傳錯誤，不假裝跑完', () => {
  assert.ok(S.backtest(bull.k4.slice(0, 100), bull.d1, OPT).error);
  assert.ok(S.backtest(bull.k4, bull.d1.slice(0, 100), OPT).error);
});
const rb = S.backtest(bull.k4, bull.d1, OPT);
t('多頭行情有產生交易', () => {
  assert.ok(!rb.error, rb.error);
  assert.ok(rb.n > 5, '交易太少：' + rb.n);
});
t('多頭行情裡一筆空單都沒有（大方向過濾）', () => {
  assert.equal(rb.trades.filter(x => x.side === 'short').length, 0);
});
t('空頭行情裡一筆多單都沒有', () => {
  const r = S.backtest(bear.k4, bear.d1, OPT);
  assert.ok(r.n > 0, '空頭行情應該有空單');
  assert.equal(r.trades.filter(x => x.side === 'long').length, 0);
});
t('進場價一律是下一根的開盤', () => {
  const byT = new Map(bull.k4.map(b => [b.t, b]));
  rb.trades.forEach(tr => {
    const b = byT.get(tr.t);
    assert.ok(b, '進場時間對不上 K 棒');
    near(tr.entry, b.o);
  });
});
t('權益剛好等於起始 + 每筆損益（手續費、資金費都算進每一筆）', () => {
  near(rb.equity, 100 + rb.trades.reduce((a, x) => a + x.pnl, 0), 1e-6);
  near(rb.trades.reduce((a, x) => a + x.funding, 0), rb.fundingPaid, 1e-9);
});
t('止損後 24 小時內同一個幣不再進場（冷卻期）', () => {
  const sorted = rb.trades.slice().sort((a, b) => a.t - b.t);
  for (let k = 1; k < sorted.length; k++) {
    if (sorted[k - 1].pnl <= 0) {
      assert.ok(sorted[k].t - sorted[k - 1].exitT >= 7 * H4 - 1,
        '虧損後 ' + (sorted[k].t - sorted[k - 1].exitT) / H4 + ' 根就又進場');
    }
  }
});
t('同時只有一個部位（不會在持倉中又開）', () => {
  const sorted = rb.trades.slice().sort((a, b) => a.t - b.t);
  for (let k = 1; k < sorted.length; k++) assert.ok(sorted[k].t >= sorted[k - 1].exitT);
});
t('價格面的虧損不超過原始止損（−1R）；超出的部分只來自手續費與資金費', () => {
  // 這組測試資料的開盤價 = 前一根收盤，沒有跳空，所以價格面一定剛好停在止損或更好
  rb.trades.forEach(x => {
    const risk = Math.abs(x.entry - x.stop) * x.qty;
    const gross = (x.side === 'long' ? x.exit - x.entry : x.entry - x.exit) * x.qty;
    assert.ok(gross / risk >= -1 - 1e-9, '價格面虧了 ' + (gross / risk).toFixed(3) + ' R');
    assert.ok(x.pnl <= gross + 1e-12, '成本沒有被扣掉');
  });
});
t('同樣的輸入給同樣的結果', () => {
  const again = S.backtest(bull.k4, bull.d1, OPT);
  near(again.equity, rb.equity, 1e-12);
  assert.equal(again.n, rb.n);
});

console.log('\n' + (fail === 0 ? `全部通過（${pass} 項）` : `${pass} 通過 / ${fail} 失敗`));
process.exit(fail === 0 ? 0 : 1);
