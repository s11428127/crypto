/* 篩選器評分與交易日誌統計的驗算 */
import '../assets/risk.js';
import '../assets/indicators.js';
import '../assets/plan.js';
import '../assets/screener.js';
import '../assets/journal.js';
import assert from 'node:assert/strict';

const SC = globalThis.SCREENER, J = globalThis.JOURNAL, I = globalThis.IND;
let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); }
}
const near = (a, b, tol = 1e-6) =>
  assert.ok(a !== null && Math.abs(a - b) <= tol, `expected ${a} ≈ ${b} (tol ${tol})`);

function mk(n, start, drift, wob) {
  const out = []; let c = start;
  for (let i = 0; i < n; i++) {
    c += drift; const w = Math.sin(i / 3) * wob;
    out.push({ t: i * 3600000, o: c - drift, h: c + Math.abs(w) + wob, l: c - Math.abs(w) - wob, c: c + w, v: 100 });
  }
  return out;
}
const UP = I.analyze(mk(260, 50000, 60, 120));
const DOWN = I.analyze(mk(260, 90000, -60, 120));
const FLAT = I.analyze(mk(260, 50000, 0, 30));

console.log('\nscreener.score');
t('雙框架多頭 → 正分、偏多', () => {
  const r = SC.score(UP, UP, { changePct: 3, btcChangePct: 3, quoteVolume: 1e9, fundingRate: 0 });
  assert.ok(r.score > 0, '分數應為正，實際 ' + r.score);
  assert.equal(r.side, 'long');
});
t('雙框架空頭 → 負分、偏空', () => {
  const r = SC.score(DOWN, DOWN, { changePct: -3, btcChangePct: -3, quoteVolume: 1e9, fundingRate: 0 });
  assert.ok(r.score < 0, '分數應為負，實際 ' + r.score);
  assert.equal(r.side, 'short');
});
t('盤整 + 無其他訊號 → 中性', () => {
  const r = SC.score(FLAT, FLAT, { changePct: 0, btcChangePct: 0, quoteVolume: 1e9, fundingRate: 0 });
  assert.equal(r.side, 'neutral');
});
t('相對 BTC 越強，加分越多', () => {
  const weak = SC.score(UP, UP, { changePct: 0, btcChangePct: 6, quoteVolume: 1e9, fundingRate: 0 });
  const strong = SC.score(UP, UP, { changePct: 6, btcChangePct: 0, quoteVolume: 1e9, fundingRate: 0 });
  assert.ok(strong.score > weak.score, '強勢的分數應該比較高');
  near(strong.relStrength, 6);
  near(weak.relStrength, -6);
});
t('相對強度加分有上限 ±2（避免單一指標主導）', () => {
  const huge = SC.score(UP, UP, { changePct: 100, btcChangePct: 0, quoteVolume: 1e9, fundingRate: 0 });
  const mid = SC.score(UP, UP, { changePct: 6, btcChangePct: 0, quoteVolume: 1e9, fundingRate: 0 });
  near(huge.score - mid.score, 0, 1e-9);   // 都已經頂到 +2
});
t('資金費率極端正值是反指標：扣多方的分', () => {
  const calm = SC.score(UP, UP, { changePct: 3, btcChangePct: 3, quoteVolume: 1e9, fundingRate: 0 });
  const hot = SC.score(UP, UP, { changePct: 3, btcChangePct: 3, quoteVolume: 1e9, fundingRate: 0.002 });
  assert.ok(hot.score < calm.score, '多單擁擠時分數應該被扣，' + hot.score + ' vs ' + calm.score);
});
t('RSI 超買會扣分（追高風險）', () => {
  const hot = I.analyze(mk(260, 50000, 300, 50));   // 極陡上升，RSI 會爆
  const r = SC.score(hot, hot, { changePct: 3, btcChangePct: 3, quoteVolume: 1e9, fundingRate: 0 });
  const rsiReason = r.reasons.find(x => x.k === 'RSI');
  assert.ok(rsiReason, '應該有 RSI 這項');
  if (r.rsi > 75) assert.equal(rsiReason.v, '-1');
});
t('每一項評分都附理由', () => {
  const r = SC.score(UP, UP, { changePct: 3, btcChangePct: 1, quoteVolume: 1e9, fundingRate: 0.0001 });
  assert.ok(r.reasons.length >= 4, '至少要有趨勢／相對強度／RSI／資金費率四項');
  r.reasons.forEach(x => assert.ok(x.why && x.why.length > 0, x.k + ' 缺少理由'));
});

console.log('\nscreener.rank');
t('流動性不足的直接剔除', () => {
  const rows = [
    { side: 'long', score: 5, quoteVolume: 1e9 },
    { side: 'long', score: 9, quoteVolume: 1e5 },   // 量太小
    { side: 'short', score: -4, quoteVolume: 2e8 }
  ];
  const r = SC.rank(rows, { minQuoteVolume: 5e7 });
  assert.equal(r.longs.length, 1, '量太小的不該進榜');
  assert.equal(r.filteredOut, 1);
});
t('偏多由高到低、偏空由低到高', () => {
  const rows = [
    { side: 'long', score: 3, quoteVolume: 1e9 },
    { side: 'long', score: 7, quoteVolume: 1e9 },
    { side: 'short', score: -3, quoteVolume: 1e9 },
    { side: 'short', score: -8, quoteVolume: 1e9 }
  ];
  const r = SC.rank(rows);
  assert.equal(r.longs[0].score, 7);
  assert.equal(r.shorts[0].score, -8, '最空的要排最前面');
});

console.log('\njournal.rOf');
t('做多賺 2R', () => near(J.rOf({ side: 'long', entry: 100, stop: 90, exit: 120 }), 2));
t('做多虧滿 1R', () => near(J.rOf({ side: 'long', entry: 100, stop: 90, exit: 90 }), -1));
t('做空賺 2R（方向相反）', () => near(J.rOf({ side: 'short', entry: 100, stop: 110, exit: 80 }), 2));
t('止損等於進場價時回傳 null', () =>
  assert.equal(J.rOf({ side: 'long', entry: 100, stop: 100, exit: 120 }), null));

console.log('\njournal.stats');
const T = [
  { side: 'long', entry: 100, stop: 90, exit: 120 },   // +2R
  { side: 'long', entry: 100, stop: 90, exit: 90 },    // -1R
  { side: 'short', entry: 100, stop: 110, exit: 80 },  // +2R
  { side: 'long', entry: 100, stop: 90, exit: 90 }     // -1R
];
t('勝率、平均 R、總 R 正確', () => {
  const s = J.stats(T);
  assert.equal(s.n, 4);
  near(s.winRate, 50);
  near(s.totalR, 2);
  near(s.avgR, 0.5);
});
t('期望值用實際的平均賺賠算，不是用假設', () => {
  const s = J.stats(T);
  near(s.avgWinR, 2); near(s.avgLossR, 1);
  near(s.expectancy, 0.5 * 2 - 0.5 * 1);
});
t('最大連敗正確', () => {
  const s = J.stats([
    { side: 'long', entry: 100, stop: 90, exit: 90 },
    { side: 'long', entry: 100, stop: 90, exit: 90 },
    { side: 'long', entry: 100, stop: 90, exit: 90 },
    { side: 'long', entry: 100, stop: 90, exit: 120 }
  ]);
  assert.equal(s.maxLossStreak, 3);
  assert.equal(s.maxWinStreak, 1);
});
t('R 曲線的最大回撤正確', () => {
  // +2, -1, -1 → 曲線 2,1,0，峰值 2，最大回撤 2R
  const s = J.stats([
    { side: 'long', entry: 100, stop: 90, exit: 120 },
    { side: 'long', entry: 100, stop: 90, exit: 90 },
    { side: 'long', entry: 100, stop: 90, exit: 90 }
  ]);
  near(s.maxDD, 2);
});
t('多空分開統計', () => {
  const s = J.stats(T);
  assert.equal(s.bySide.long.n, 3);
  assert.equal(s.bySide.short.n, 1);
  near(s.bySide.short.totalR, 2);
});
t('不到 30 筆標記為樣本不足', () => {
  assert.equal(J.stats(T).enough, false);
  const many = Array.from({ length: 30 }, () => ({ side: 'long', entry: 100, stop: 90, exit: 120 }));
  assert.equal(J.stats(many).enough, true);
});
t('空陣列不丟例外', () => {
  const s = J.stats([]);
  assert.equal(s.n, 0);
  assert.equal(s.winRate, null);
});
t('資料不完整的那筆會被略過，不影響其他統計', () => {
  const s = J.stats(T.concat([{ side: 'long', entry: 100, stop: 100, exit: 120 }]));
  assert.equal(s.n, 4, '壞資料應該被略過');
});

console.log('\njournal.validate');
t('缺欄位會被抓出來', () => {
  assert.ok(J.validate({ side: 'long' }).length >= 3);
});
t('做多的止損放在進場價上方會被擋', () => {
  const e = J.validate({ side: 'long', entry: 100, stop: 110, exit: 120 });
  assert.ok(e.some(x => /做多的止損/.test(x)));
});
t('做空的止損放在進場價下方會被擋', () => {
  const e = J.validate({ side: 'short', entry: 100, stop: 90, exit: 80 });
  assert.ok(e.some(x => /做空的止損/.test(x)));
});
t('完整且合理的輸入沒有錯誤', () => {
  assert.equal(J.validate({ side: 'long', entry: 100, stop: 90, exit: 120 }).length, 0);
});

console.log('\n' + (fail === 0 ? `全部通過（${pass} 項）` : `${pass} 通過 / ${fail} 失敗`));
process.exit(fail === 0 ? 0 : 1);
