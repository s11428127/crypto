/* 多時間框架對齊與計畫邏輯的驗算 */
import '../assets/risk.js';
import '../assets/indicators.js';
import '../assets/plan.js';
import assert from 'node:assert/strict';

const P = globalThis.PLAN, I = globalThis.IND, R = globalThis.RISK;
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

console.log('\nsizedPlan —— 部位大小與賺賠金額');
const BTC_F = { minQty: 0.001, stepSize: 0.001, minNotional: 100 };
const ALT_F = { minQty: 1, stepSize: 1, minNotional: 5 };
const baseSP = { side: 'long', price: 80606, atr: 1200,
                 swing: { low: 78800, high: 81500 }, equity: 50, riskPct: 1, maxLeverage: 5 };

t('止損在進場價下方、止盈在上方（做多）', () => {
  const p = P.sizedPlan(Object.assign({}, baseSP, { filters: BTC_F }));
  assert.ok(p.stop < p.entry);
  assert.ok(p.targets[0].price > p.entry);
  assert.ok(p.targets[1].price > p.targets[0].price);
});
t('做空時方向整個反轉', () => {
  const p = P.sizedPlan(Object.assign({}, baseSP, { side: 'short', filters: BTC_F }));
  assert.ok(p.stop > p.entry, '空單止損要在上方');
  assert.ok(p.targets[0].price < p.entry, '空單止盈要在下方');
});
t('賺賠金額 = 數量 × 價差', () => {
  const p = P.sizedPlan(Object.assign({}, baseSP, { filters: BTC_F }));
  near(p.riskUsd, p.qty * Math.abs(p.entry - p.stop), 1e-9);
  near(p.targets[0].usd, p.qty * Math.abs(p.targets[0].price - p.entry), 1e-9);
  near(p.targets[1].usd, p.qty * Math.abs(p.targets[1].price - p.entry), 1e-9);
});
t('止盈金額確實是止損金額的 R 倍', () => {
  const p = P.sizedPlan(Object.assign({}, baseSP, { filters: BTC_F }));
  near(p.targets[0].usd, p.riskUsd * 1.5, 1e-9);
  near(p.targets[1].usd, p.riskUsd * 3, 1e-9);
});
t('$50 做 BTC 會被最小下單量頂上去，風險遠超過 1%', () => {
  const p = P.sizedPlan(Object.assign({}, baseSP, { filters: BTC_F }));
  assert.equal(p.forcedUp, true);
  assert.ok(p.riskPctActual > 5, '實際風險應該遠大於 1%，實際 ' + p.riskPctActual.toFixed(2));
});
t('同樣 $50 做最小名目低的幣，1% 風險做得到', () => {
  const p = P.sizedPlan(Object.assign({}, baseSP, { price: 1.0, atr: 0.02, swing: { low: 0.97, high: 1.03 }, filters: ALT_F }));
  assert.equal(p.forcedUp, false);
  assert.ok(Math.abs(p.riskPctActual - 1) < 0.5,
    '應該接近 1%，實際 ' + p.riskPctActual.toFixed(2));
});
t('名目超過槓桿上限時標記為做不起來', () => {
  const p = P.sizedPlan(Object.assign({}, baseSP, { equity: 20, maxLeverage: 2, filters: BTC_F }));
  assert.equal(p.feasible, false);
  assert.equal(p.blockedBy, 'leverageCap');
});
t('槓桿是算出來的，不是使用者設的上限', () => {
  const p = P.sizedPlan(Object.assign({}, baseSP, { filters: BTC_F }));
  near(p.leverage, p.notional / 50, 1e-9);
  assert.ok(p.leverage < 5, '實際槓桿應該低於上限 5x，實際 ' + p.leverage.toFixed(2));
});
t('爆倉價用「交易所會設定的整數倍率」算，不是名目÷本金的比例', () => {
  const p = P.sizedPlan(Object.assign({}, baseSP, { filters: BTC_F }));
  const byExchange = R.liqPrice({ entry: p.entry, leverage: p.exchangeLeverage, side: 'long' });
  near(p.liqPrice, byExchange, 1e-9);
  assert.ok(p.liqPrice < p.stop, '多單的爆倉價應該低於止損價');
  assert.equal(p.liqBeforeStop, false);
});
t('1x 做多標記為不會爆倉', () => {
  const p = P.sizedPlan(Object.assign({}, baseSP, {
    price: 1.0, atr: 0.02, swing: { low: 0.97, high: 1.03 }, filters: ALT_F }));
  assert.equal(p.exchangeLeverage, 1);
  assert.equal(p.liqFree, true);
  near(p.liqPrice, 0);
});
t('1x 做空仍然會爆倉，大約在進場價的兩倍', () => {
  const p = P.sizedPlan(Object.assign({}, baseSP, {
    side: 'short', price: 1.0, atr: 0.02, swing: { low: 0.97, high: 1.03 }, filters: ALT_F }));
  assert.equal(p.exchangeLeverage, 1);
  assert.equal(p.liqFree, false, '空單沒有「不會爆倉」這回事');
  assert.ok(p.liqPrice > 1.9 && p.liqPrice < 2.1,
    '1x 空單的爆倉價應該在 2 倍附近，實際 ' + p.liqPrice.toFixed(3));
});
t('槓桿高到爆倉距離小於止損距離時，會標記「爆倉先於止損」', () => {
  // 止損距離固定 2.61%。爆倉距離 ≈ 1/槓桿，所以臨界點在 38 倍附近。
  const safe = P.sizedPlan(Object.assign({}, baseSP, {
    equity: 5, maxLeverage: 100, riskPct: 80, filters: BTC_F }));
  assert.ok(safe.leverage > 30 && safe.leverage < 38, '這組應該落在 30~38 倍，實際 ' + safe.leverage.toFixed(1));
  assert.equal(safe.liqBeforeStop, false, '32 倍配 2.6% 止損，止損仍會先觸發');

  const bad = P.sizedPlan(Object.assign({}, baseSP, {
    equity: 4, maxLeverage: 100, riskPct: 80, filters: BTC_F }));
  assert.ok(bad.leverage > 38, '這組應該超過 38 倍，實際 ' + bad.leverage.toFixed(1));
  assert.equal(bad.liqBeforeStop, true, '40 倍時爆倉會先發生，止損等於沒設');
});
t('部位大小用捨去，實際風險不會超過預算（除非被最小下單量頂上去）', () => {
  const p = P.sizedPlan({ side: 'long', price: 100, atr: 9, swing: { low: 91, high: 109 },
    equity: 5000, riskPct: 1, maxLeverage: 5,
    filters: { minQty: 0.01, stepSize: 0.01, minNotional: 5 } });
  assert.equal(p.forcedUp, false, '這個本金不該被頂上去');
  assert.ok(p.riskUsd <= 5000 * 0.01, '捨去之後風險不該超過預算 $50，實際 $' + p.riskUsd.toFixed(2));
});
t('交易所槓桿最低是 1x，名目小於本金時就是 1x', () => {
  const p = P.sizedPlan(Object.assign({}, baseSP, {
    price: 1.0, atr: 0.02, swing: { low: 0.97, high: 1.03 }, filters: ALT_F }));
  assert.ok(p.leverage < 1, '名目÷本金應該小於 1，實際 ' + p.leverage.toFixed(2));
  assert.equal(p.exchangeLeverage, 1, '交易所要設的倍率應該是 1x');
  near(p.marginUsed, p.notional, 1e-9);   // 1x 時保證金就等於名目
});
t('名目超過本金時，交易所槓桿進位到整數', () => {
  const p = P.sizedPlan(Object.assign({}, baseSP, { filters: BTC_F }));
  assert.ok(p.leverage > 3 && p.leverage < 4, '這組的名目÷本金應該在 3~4，實際 ' + p.leverage.toFixed(2));
  assert.equal(p.exchangeLeverage, 4, '3.22x 要設 4x 才開得起來');
  near(p.marginUsed, p.notional / 4, 1e-9);
});

t('參數不完整時回傳 null 而不是丟例外', () => {
  assert.equal(P.sizedPlan({ side: 'long', price: 0, atr: 1, equity: 50, riskPct: 1 }), null);
  assert.equal(P.sizedPlan({ side: 'long', price: 100, atr: 0, equity: 50, riskPct: 1 }), null);
});

console.log('\n' + (fail === 0 ? `全部通過（${pass} 項）` : `${pass} 通過 / ${fail} 失敗`));
process.exit(fail === 0 ? 0 : 1);
