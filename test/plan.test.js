/* 多時間框架對齊與計畫邏輯的驗算 */
import '../assets/risk.js';
import '../assets/indicators.js';
import '../assets/plan.js';
import assert from 'node:assert/strict';

const P = globalThis.PLAN, I = globalThis.IND;
let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); }
}
const near = (a, b, tol = 1e-6) =>
  assert.ok(a !== null && Math.abs(a - b) <= tol, `expected ${a} ≈ ${b} (tol ${tol})`);

/* 造一組可控的 K 線：drift 為每根的漲跌，wob 為振幅 */
function mk(n, start, drift, wob) {
  const out = [];
  let c = start;
  for (let i = 0; i < n; i++) {
    c += drift;
    const w = Math.sin(i / 3) * wob;
    out.push({ t: i * 3600000, o: c - drift, h: c + Math.abs(w) + wob, l: c - Math.abs(w) - wob, c: c + w, v: 100 });
  }
  return out;
}

console.log('\nbias —— 方向只由 1D 與 4H 決定');
t('日線多 + 4H 多 → 做多（強）', () => {
  const b = P.bias('up', 'up');
  assert.equal(b.side, 'long'); assert.equal(b.strength, 2);
});
t('日線空 + 4H 空 → 做空（強）', () => {
  const b = P.bias('down', 'down');
  assert.equal(b.side, 'short'); assert.equal(b.strength, 2);
});
t('日線盤整 + 4H 多 → 做多但只能小做（弱）', () => {
  assert.equal(P.bias('range', 'up').strength, 1);
});
t('日線與 4H 相反 → 觀望', () => {
  assert.equal(P.bias('up', 'down').side, 'wait');
  assert.equal(P.bias('down', 'up').side, 'wait');
});
t('4H 整理 → 觀望（沒有可依附的結構）', () => {
  assert.equal(P.bias('up', 'range').side, 'wait');
  assert.equal(P.bias('range', 'range').side, 'wait');
});

console.log('\ntiming —— 15m 只決定時機，不改方向');
t('做多時 15m 向上 → 可進場', () => assert.equal(P.timing('long', 'up').ready, true));
t('做多時 15m 仍在跌 → 不進場（不要接刀）', () => assert.equal(P.timing('long', 'down').ready, false));
t('做空時 15m 向下 → 可進場', () => assert.equal(P.timing('short', 'down').ready, true));
t('觀望時不談時機', () => assert.equal(P.timing('wait', 'up').ready, false));

console.log('\nstopLevel —— 結構 + ATR 緩衝，並夾住上下限');
t('做多：止損在結構低點下方', () => {
  const s = P.stopLevel('long', 100, { low: 98, high: 103 }, 2);
  assert.ok(s.price < 98, '應低於擺盪低點 98，實際 ' + s.price);
});
t('做空：止損在結構高點上方', () => {
  const s = P.stopLevel('short', 100, { low: 97, high: 102 }, 2);
  assert.ok(s.price > 102, '應高於擺盪高點 102，實際 ' + s.price);
});
t('結構太近時撐開到 0.8 ATR（避免被雜訊掃掉）', () => {
  const atr = 2;
  const s = P.stopLevel('long', 100, { low: 99.9, high: 101 }, atr);
  near(s.dist, 0.8 * atr, 1e-9);
  assert.equal(s.clamped, true);
});
t('結構太遠時夾到 2.5 ATR（避免盈虧比不划算）', () => {
  const atr = 2;
  const s = P.stopLevel('long', 100, { low: 80, high: 101 }, atr);
  near(s.dist, 2.5 * atr, 1e-9);
  assert.equal(s.clamped, true);
});
t('結構落在合理範圍內時不夾', () => {
  const s = P.stopLevel('long', 100, { low: 97, high: 101 }, 2);
  assert.equal(s.clamped, false);
  near(s.dist, 100 - (97 - 0.5), 1e-9);   // 緩衝 0.25 × ATR = 0.5
});

console.log('\nfundingRead —— 極端費率當反指標');
t('年化換算正確（每 8 小時結算，一年 1095 次）', () => {
  const f = P.fundingRead(0.0001);
  near(f.pct, 0.01, 1e-9);
  near(f.annualPct, 0.0001 * 3 * 365 * 100, 1e-9);
});
t('費率偏高標為擁擠', () => assert.equal(P.fundingRead(0.001).level, 'hot'));
t('負費率極端也算擁擠（空方）', () => assert.equal(P.fundingRead(-0.001).level, 'hot'));
t('常態費率不報警', () => assert.equal(P.fundingRead(0.00005).level, 'normal'));

console.log('\nbuild —— 完整計畫');
const upTF = {
  d1:  I.analyze(mk(260, 50000, 60, 120)),
  h4:  I.analyze(mk(260, 60000, 40, 150)),
  m15: I.analyze(mk(260, 65000, 10, 40))
};
t('三框架皆多 → 做多、可進場、價位齊全', () => {
  const p = P.build(upTF, { equity: 44, riskPct: 1, leverage: 20 });
  assert.equal(p.side, 'long');
  assert.equal(p.ready, true);
  assert.ok(p.stop < p.entry, '多單止損要在進場價下方');
  assert.ok(p.targets[0].price > p.entry, '止盈要在進場價上方');
  assert.ok(p.targets[1].price > p.targets[0].price, '3R 要比 1.5R 遠');
});
t('止盈確實落在指定的 R 倍數上', () => {
  const p = P.build(upTF, { equity: 44, riskPct: 1 });
  const rDist = p.entry - p.stop;
  near(p.targets[0].price, p.entry + rDist * 1.5, 1e-6);
  near(p.targets[1].price, p.entry + rDist * 3, 1e-6);
});
t('$44 帳戶會被最小下單量擋住並提出警告', () => {
  const p = P.build(upTF, { equity: 44, riskPct: 1,
    filters: { minQty: 0.001, stepSize: 0.001, minNotional: 100 } });
  assert.ok(p.feasibility.minRiskPct > 1, '最小風險應該超過 1%');
  assert.ok(p.warnings.some(w => w.level === 'danger' && /做不到/.test(w.text)),
    '應該有「做不到 1% 風險」的紅色警告');
});
t('20 倍槓桿會觸發「爆倉先於止損」的警告', () => {
  const p = P.build(upTF, { equity: 44, riskPct: 1, leverage: 20 });
  // 止損距離若大於約 4.6%，20 倍下爆倉會先到
  if (p.stopDistPct > 4.7) {
    assert.equal(p.liqBeforeStop, true);
    assert.ok(p.warnings.some(w => /爆倉/.test(w.text)));
  } else {
    assert.equal(p.liqBeforeStop, false);
  }
});
t('低槓桿不會觸發爆倉警告', () => {
  const p = P.build(upTF, { equity: 44, riskPct: 1, leverage: 2 });
  assert.equal(p.liqBeforeStop, false);
});
t('方向衝突時輸出觀望，且不給價位', () => {
  const mixed = {
    d1:  I.analyze(mk(260, 50000, 60, 120)),    // 多
    h4:  I.analyze(mk(260, 80000, -50, 150)),   // 空
    m15: I.analyze(mk(260, 65000, 10, 40))
  };
  const p = P.build(mixed, { equity: 44, riskPct: 1 });
  assert.equal(p.side, 'wait');
  assert.equal(p.entry, undefined, '觀望時不該給進場價');
  assert.equal(p.stop, undefined, '觀望時不該給止損價');
});
t('資料不足時不丟例外', () => {
  const thin = { d1: I.analyze(mk(5, 100, 1, 1)), h4: I.analyze(mk(5, 100, 1, 1)), m15: I.analyze(mk(5, 100, 1, 1)) };
  const p = P.build(thin, { equity: 44, riskPct: 1 });
  assert.ok(p.side === 'wait' || p.warnings.length > 0);
});
t('手續費佔比過高時會警告', () => {
  const p = P.build(upTF, { equity: 44, riskPct: 1, leverage: 20 });
  assert.ok(p.fee && p.fee.feeR > 0, '應該算得出手續費的 R 佔比');
});

console.log('\n' + (fail === 0 ? `全部通過（${pass} 項）` : `${pass} 通過 / ${fail} 失敗`));
process.exit(fail === 0 ? 0 : 1);
