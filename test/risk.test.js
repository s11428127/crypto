/* 風險計算的驗算。執行：npm test */
import '../assets/risk.js';
import assert from 'node:assert/strict';

const R = globalThis.RISK;
let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); }
}
const near = (a, b, tol = 1e-6) =>
  assert.ok(Math.abs(a - b) <= tol, `expected ${a} ≈ ${b} (tol ${tol})`);

console.log('\nceilToStep');
t('進位到 step', () => { near(R.ceilToStep(0.00124, 0.001), 0.002); });
t('剛好整除不多跳一格', () => { near(R.ceilToStep(0.002, 0.001), 0.002); });
t('不產生浮點殘渣', () => { assert.equal(R.ceilToStep(0.0000001, 0.001), 0.001); });

console.log('\nliqPrice —— 對照手算');
t('做多 20x：E(1-1/L)/(1-MMR)', () => {
  // 80606 × 0.95 / 0.996
  near(R.liqPrice({ entry: 80606, leverage: 20, side: 'long' }), 80606 * 0.95 / 0.996, 1e-6);
});
t('做空 20x：E(1+1/L)/(1+MMR)', () => {
  near(R.liqPrice({ entry: 80606, leverage: 20, side: 'short' }), 80606 * 1.05 / 1.004, 1e-6);
});
t('1 倍做多不會爆倉（價格歸零才爆）', () => {
  near(R.liqPrice({ entry: 80606, leverage: 1, side: 'long' }), 0);
});
t('槓桿越高爆倉價離進場越近', () => {
  const a = R.liqPrice({ entry: 80606, leverage: 5, side: 'long' });
  const b = R.liqPrice({ entry: 80606, leverage: 20, side: 'long' });
  assert.ok(b > a, '20x 的爆倉價應該比 5x 更靠近進場價');
});

console.log('\ninspectPosition —— 使用者當下這筆倉（$44 / 20x / 80606 多單）');
const pos = R.inspectPosition({ entry: 80606, leverage: 20, equity: 44, side: 'long' });
t('名目 = 保證金 × 槓桿 = 880', () => near(pos.notional, 880));
t('數量 ≈ 0.010917 BTC', () => near(pos.qty, 880 / 80606, 1e-9));
t('爆倉價 = 76,883.23', () => near(pos.liqPrice, 76883.23, 0.01));
t('距離爆倉約 4.6%', () => near(pos.liqDistPct, 4.61, 0.02));
t('價格每動 1%，帳戶動 20%', () => near(pos.accountMovePerPct, 20));
t('帳戶腰斬只需要 2.5% 的逆向波動', () => near(pos.halveAtPct, 2.5));

console.log('\nsizeFromRisk —— 從止損反推');
t('1% 風險 + 2% 止損 → 隱含槓桿 0.5 倍', () => {
  const s = R.sizeFromRisk({ equity: 44, riskPct: 1, entry: 80606, stop: 80606 * 0.98 });
  near(s.impliedLev, 0.5, 1e-9);
  near(s.riskAmt, 0.44, 1e-9);
});
t('隱含槓桿 = 風險% ÷ 止損距離%', () => {
  const s = R.sizeFromRisk({ equity: 1000, riskPct: 2, entry: 50000, stop: 49000 });
  near(s.stopDistPct, 2);
  near(s.impliedLev, 1, 1e-9);
});
t('虧損金額確實等於設定的風險', () => {
  const s = R.sizeFromRisk({ equity: 500, riskPct: 1.5, entry: 60000, stop: 58800 });
  near(s.qty * Math.abs(60000 - 58800), 7.5, 1e-9);
});
t('止損等於進場價時回傳 null（不能除以零）', () => {
  assert.equal(R.sizeFromRisk({ equity: 44, riskPct: 1, entry: 80606, stop: 80606 }), null);
});

console.log('\nfeasibility —— 最小下單限制');
const fz = R.feasibility({
  equity: 44, entry: 80606, stop: 80606 * 0.98,
  filters: { minQty: 0.001, stepSize: 0.001, minNotional: 100 }
});
t('0.001 BTC 名目只有 $80.6，不足 $100 → 被迫跳到 0.002', () => near(fz.minQty, 0.002));
t('最小名目因此是 $161.2', () => near(fz.minNotional, 0.002 * 80606, 1e-6));
t('用 $44 開最小倉，槓桿被迫 ≈ 3.66 倍', () => near(fz.minLeverage, 0.002 * 80606 / 44, 1e-9));
t('配 2% 止損，最小風險 ≈ 帳戶的 7.3%（遠高於 1%）', () => {
  near(fz.minRiskPct, 0.002 * 80606 * 0.02 / 44 * 100, 1e-6);
  assert.ok(fz.minRiskPct > 7, '應該 > 7%');
});
t('本金夠大時，最小限制就不再是問題', () => {
  const big = R.feasibility({
    equity: 5000, entry: 80606, stop: 80606 * 0.98,
    filters: { minQty: 0.001, stepSize: 0.001, minNotional: 100 }
  });
  assert.ok(big.minRiskPct < 1, '$5000 帳戶的最小風險應該 < 1%');
});

console.log('\nliqBeforeStop —— 最致命的設定錯誤');
t('20x 多單配 5% 止損 → 先爆倉才輪到止損', () => {
  const r = R.liqBeforeStop({ entry: 80606, leverage: 20, side: 'long', stop: 80606 * 0.95 });
  assert.equal(r.liquidatedFirst, true);
});
t('20x 多單配 2% 止損 → 止損先觸發，安全', () => {
  const r = R.liqBeforeStop({ entry: 80606, leverage: 20, side: 'long', stop: 80606 * 0.98 });
  assert.equal(r.liquidatedFirst, false);
});
t('空單方向相反也要判斷正確', () => {
  const r = R.liqBeforeStop({ entry: 80606, leverage: 20, side: 'short', stop: 80606 * 1.05 });
  assert.equal(r.liquidatedFirst, true);
});

console.log('\ntargets —— R 倍數止盈');
t('做多 2R 的價位', () => {
  const ts = R.targets({ entry: 80606, stop: 79000, rMultiples: [1, 2] });
  near(ts[0].price, 82212);
  near(ts[1].price, 83818);
});
t('做空（止損在上方）方向自動反轉', () => {
  const ts = R.targets({ entry: 80606, stop: 82000, rMultiples: [1] });
  assert.ok(ts[0].price < 80606, '空單的止盈應該在進場價下方');
});

console.log('\nexpectancy / fees');
t('勝率 50%、盈虧比 1:2 → 每筆 +0.5R', () => {
  near(R.expectancy({ winRate: 0.5, rr: 2 }).rawR, 0.5);
});
t('勝率 50%、盈虧比 1:1 → 期望值 0，扣掉手續費就是負的', () => {
  const e = R.expectancy({ winRate: 0.5, rr: 1, feeR: 0.1 });
  near(e.rawR, 0);
  assert.ok(e.netR < 0, '扣費後必須是負期望值');
});
t('高槓桿下手續費吃掉的 R 特別兇', () => {
  // $880 名目、風險金額只有 $0.44 → 來回手續費 $0.792 = 1.8R
  const f = R.feeInR({ notional: 880, riskAmt: 0.44 });
  near(f.feeUsd, 880 * 0.00045 * 2, 1e-9);
  assert.ok(f.feeR > 1, '手續費超過 1R 代表這筆交易數學上就不該做');
});

console.log('\n' + (fail === 0 ? `全部通過（${pass} 項）` : `${pass} 通過 / ${fail} 失敗`));
process.exit(fail === 0 ? 0 : 1);
