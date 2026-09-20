/* 指標驗算。對照 Wilder 原著的 RSI 範例資料與手算值。 */
import '../assets/indicators.js';
import assert from 'node:assert/strict';

const I = globalThis.IND;
let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); }
}
const near = (a, b, tol = 1e-6) =>
  assert.ok(a !== null && Math.abs(a - b) <= tol, `expected ${a} ≈ ${b} (tol ${tol})`);

// Wilder《New Concepts in Technical Trading Systems》的 RSI 範例序列
const W = [44.34,44.09,44.15,43.61,44.33,44.83,45.10,45.42,45.84,46.08,45.89,46.03,
           45.61,46.28,46.28,46.00,46.03,46.41,46.22,45.64,46.21,46.25,45.71,46.45,
           45.78,45.35,44.03,44.18,44.22,44.57,43.42,42.66,43.13];

console.log('\nsma / ema');
t('SMA 暖身期為 null，第 n 根才有值', () => {
  const s = I.sma([1,2,3,4,5], 3);
  assert.equal(s[0], null); assert.equal(s[1], null);
  near(s[2], 2); near(s[3], 3); near(s[4], 4);
});
t('EMA 種子 = 前 n 根的 SMA', () => {
  const e = I.ema([1,2,3,4,5], 3);
  assert.equal(e[1], null);
  near(e[2], 2);                       // (1+2+3)/3
  near(e[3], 4 * 0.5 + 2 * 0.5);       // k = 2/(3+1) = 0.5
  near(e[4], 5 * 0.5 + 3 * 0.5);
});
t('EMA 對常數序列等於該常數', () => {
  const e = I.ema(new Array(40).fill(7), 20);
  near(e[39], 7, 1e-9);
});

console.log('\nrsi —— 對照 Wilder 原著');
t('RSI(14) 第一個值 = 70.4641', () => {
  const r = I.rsi(W, 14);
  assert.equal(r[13], null, '第 14 根之前不該有值');
  near(r[14], 70.4641, 0.001);   // 手算核對過：avgGain 0.238571 / avgLoss 0.1
});
t('RSI(14) 後續值對得上（66.25 / 66.48 / 69.35）', () => {
  const r = I.rsi(W, 14);
  near(r[15], 66.2496, 0.001);
  near(r[16], 66.4809, 0.001);
  near(r[17], 69.3469, 0.001);
});
t('RSI 永遠落在 0~100', () => {
  const r = I.rsi(W, 14).filter(v => v !== null);
  assert.ok(r.every(v => v >= 0 && v <= 100));
});
t('單調上漲序列的 RSI = 100', () => {
  const up = Array.from({ length: 30 }, (_, i) => 100 + i);
  const r = I.rsi(up, 14);
  near(r[29], 100, 1e-9);
});

console.log('\nmacd');
t('MACD 線 = EMA12 − EMA26，索引對得上', () => {
  const closes = Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i / 5) * 10);
  const m = I.macd(closes);
  const e12 = I.ema(closes, 12), e26 = I.ema(closes, 26);
  assert.equal(m.line[24], null, 'EMA26 未成形前 MACD 應為 null');
  near(m.line[79], e12[79] - e26[79], 1e-9);
});
t('柱狀體 = MACD 線 − 訊號線', () => {
  const closes = Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i / 5) * 10);
  const m = I.macd(closes);
  near(m.hist[79], m.line[79] - m.signal[79], 1e-9);
});
t('常數序列的 MACD 收斂到 0', () => {
  const m = I.macd(new Array(100).fill(50));
  near(m.line[99], 0, 1e-9);
  near(m.hist[99], 0, 1e-9);
});

console.log('\natr');
t('TR 取三者最大：當根振幅、與前收的上下跳空', () => {
  const tr = I.trueRange([10, 12], [8, 11], [9, 11.5]);
  near(tr[0], 2);                 // 第一根只有 h−l
  near(tr[1], Math.max(1, 3, 2)); // 12−11 / |12−9| / |11−9|
});
t('ATR 對固定振幅序列等於該振幅', () => {
  const n = 40;
  const h = new Array(n).fill(105), l = new Array(n).fill(100), c = new Array(n).fill(102);
  const a = I.atr(h, l, c, 14);
  near(a[39], 5, 1e-6);
});
t('ATR 永遠為正', () => {
  const n = 60;
  const c = Array.from({ length: n }, (_, i) => 100 + Math.sin(i) * 5);
  const h = c.map(x => x + 1), l = c.map(x => x - 1);
  assert.ok(I.atr(h, l, c, 14).filter(v => v !== null).every(v => v > 0));
});

console.log('\nbollinger');
t('常數序列的上下軌貼在中軌上（標準差 0）', () => {
  const b = I.bollinger(new Array(30).fill(100), 20, 2);
  near(b.mid[29], 100); near(b.upper[29], 100); near(b.lower[29], 100);
});
t('上軌 > 中軌 > 下軌', () => {
  const c = Array.from({ length: 40 }, (_, i) => 100 + Math.sin(i / 3) * 8);
  const b = I.bollinger(c, 20, 2);
  assert.ok(b.upper[39] > b.mid[39] && b.mid[39] > b.lower[39]);
});

console.log('\npivots / trend');
t('抓得到明顯的擺盪高低點', () => {
  const h = [1,2,3,9,3,2,1,2,3,2,1];
  const l = [1,2,3,3,3,2,0,2,3,2,1];
  const p = I.pivots(h, l, 3);
  assert.ok(p.highs.some(x => x.i === 3), '索引 3 應為擺盪高點');
  assert.ok(p.lows.some(x => x.i === 6), '索引 6 應為擺盪低點');
});
t('多頭排列判為 up', () => {
  const n = 250;
  const c = Array.from({ length: n }, (_, i) => 100 + i);   // 穩定上升
  const r = I.trend(c, I.ema(c, 20), I.ema(c, 50), I.ema(c, 200));
  assert.equal(r.dir, 'up');
});
t('空頭排列判為 down', () => {
  const n = 250;
  const c = Array.from({ length: n }, (_, i) => 1000 - i);
  const r = I.trend(c, I.ema(c, 20), I.ema(c, 50), I.ema(c, 200));
  assert.equal(r.dir, 'down');
});
t('橫盤判為 range', () => {
  const n = 250;
  const c = Array.from({ length: n }, (_, i) => 100 + Math.sin(i / 2) * 0.5);
  const r = I.trend(c, I.ema(c, 20), I.ema(c, 50), I.ema(c, 200));
  assert.equal(r.dir, 'range');
});

console.log('\nanalyze —— 整合輸出');
t('回傳的每個序列都和 K 線等長', () => {
  const n = 300;
  const k = Array.from({ length: n }, (_, i) => {
    const c = 100 + Math.sin(i / 8) * 10 + i * 0.05;
    return { t: i * 60000, o: c - 0.3, h: c + 1, l: c - 1, c, v: 100 };
  });
  const a = I.analyze(k);
  [a.closes, a.ema20, a.ema50, a.ema200, a.atr, a.rsi, a.macd.line].forEach(arr =>
    assert.equal(arr.length, n));
  assert.ok(a.last.close > 0 && a.last.atr > 0);
  assert.ok(['up', 'down', 'range'].includes(a.trend.dir));
});
t('資料不足時不丟例外，指標回傳 null', () => {
  const k = Array.from({ length: 5 }, (_, i) => ({ t: i, o: 1, h: 2, l: 0.5, c: 1, v: 1 }));
  const a = I.analyze(k);
  assert.equal(a.last.ema200, null);
  assert.equal(a.trend.dir, 'range');
});

console.log('\n' + (fail === 0 ? `全部通過（${pass} 項）` : `${pass} 通過 / ${fail} 失敗`));
process.exit(fail === 0 ? 0 : 1);
