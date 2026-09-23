/* 模擬單機器人（多幣種、規則 v2）的驗算 */
import '../assets/risk.js';
import '../assets/indicators.js';
import '../assets/backtest.js';
import '../assets/strategy.js';
import '../assets/bot.js';
import assert from 'node:assert/strict';

const B = globalThis.BOT, S = globalThis.STRATEGY;
let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); }
}
const near = (a, b, tol = 1e-9) =>
  assert.ok(Number.isFinite(a) && Math.abs(a - b) <= tol, `expected ${a} ≈ ${b} (tol ${tol})`);
const H4 = 4 * 3600e3, DAY = 86400e3, M15 = 15 * 60e3;

/* 同一條價格曲線取樣成日線與 4H（和 strategy.test 相同的產生方式） */
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
const mixed = series(d => 200 + 60 * Math.sin(d / 60) + 6 * Math.sin(d / 2.3), 700, 300);
// 趨勢明顯、回檔較淺：會出現抱上去、用移動止損出場的單
const trendy = series(d => 100 + 0.6 * d + 3 * Math.sin(d / 2), 500, 150);

const FILT = { minQty: 0, stepSize: 0, minNotional: 5 };
const CFG = {
  symbols: ['AAAUSDT', 'BBBUSDT', 'CCCUSDT', 'DDDUSDT'],
  startEquity: 100, riskPct: 1, maxRiskPct: 5, maxPositions: 3, maxLeverage: 5,
  feeRate: 0.00055, fundingPer8h: 0.0001, allowShort: false,
  filters: { BTCUSDT: { minQty: 0.001, stepSize: 0.001, minNotional: 100 }, '*': FILT }
};
const newS = (over) => B.newState(Object.assign({}, CFG, over || {}));

/* 找第一根有訊號的 4H，讓測試從「剛好有訊號」的時間點開始 */
function firstSignal(ser, side = 'long', from = 0) {
  const ctx = S.prepare(ser.k4, ser.d1);
  for (let i = Math.max(60, from); i < ser.k4.length - 1; i++) {
    const s = S.signal(ctx, i);
    if (s && s.side === side) return i;
  }
  throw new Error('找不到訊號');
}
/* 第 i 根收盤、第 i+1 根剛開盤的那一刻 */
function marketAt(ser, i, sym = 'AAAUSDT', over = {}) {
  const now = ser.k4[i + 1].t;
  return Object.assign({
    symbol: sym, now, price: ser.k4[i + 1].o,
    k4: ser.k4.slice(0, i + 2),                 // 含正在形成的那一根（應該被忽略）
    d1: ser.d1.filter(b => b.t < now),
    k15: ser.k4.slice(0, i + 1),               // 用 4H 當作「15 分 K」：一根 4H 一根
    fundingRate: 0.0001, filters: FILT
  }, over);
}
const I0 = firstSignal(bull);

console.log('\n設定與升級');
t('newState 是 v2、沒有部位', () => {
  const s = newS();
  assert.equal(s.version, 2); assert.deepEqual(s.positions, {}); assert.equal(s.equity, 100);
});
t('filtersFor：列出的幣用自己的，沒列的用 "*"', () => {
  assert.equal(B.filtersFor(CFG, 'BTCUSDT').minNotional, 100);
  assert.equal(B.filtersFor(CFG, 'AAAUSDT').minNotional, 5);
});
t('v1 單一部位的狀態檔升級：部位搬到 positions，補上移動止損需要的欄位', () => {
  const v1 = { version: 1, config: { symbol: 'BTCUSDT', startEquity: 100 }, equity: 99,
    position: { side: 'long', entry: 100, stop: 95, qty: 1, notional: 100, riskUsd: 5, entryFee: 0.05, openedAt: 1000 },
    trades: [{ pnl: 1, r: 1 }], curve: [{ t: 1, equity: 100, hasPosition: true }],
    notes: [{ kind: 'idle' }, { kind: 'open' }] };
  const s = B.migrate(v1);
  const p = s.positions.BTCUSDT;
  assert.equal(s.version, 2);
  assert.equal(p.initStop, 95); near(p.initRisk, 5); near(p.best, 100);
  assert.equal(s.trades[0].symbol, 'BTCUSDT');
  assert.equal(s.curve[0].open, 1);
  assert.equal(s.notes.length, 1);
});
t('migrate 不改到傳入的物件', () => {
  const s = newS(), before = JSON.stringify(s);
  B.migrate(s);
  assert.equal(JSON.stringify(s), before);
});

console.log('\ndecide —— 空手時（和回測同一套規則）');
t('4H 剛收盤、有訊號 → 用現價開倉，止損就是規則算的那個', () => {
  const a = B.decide(newS(), marketAt(bull, I0), CFG);
  assert.equal(a.type, 'open');
  const sig = S.signal(S.prepare(bull.k4.slice(0, I0 + 1), bull.d1.filter(b => b.t + DAY <= bull.k4[I0 + 1].t)), I0);
  near(a.plan.stop, sig.stop);
  near(a.plan.entry, bull.k4[I0 + 1].o);
});
t('還沒收盤的 K 棒不會影響判斷（只用已收盤的）', () => {
  const m = marketAt(bull, I0);
  const weird = m.k4.slice(); weird[weird.length - 1] = Object.assign({}, weird[weird.length - 1], { h: 1e9, l: 0, c: 1 });
  const a = B.decide(newS(), Object.assign({}, m, { k4: weird }), CFG);
  assert.equal(a.type, 'open');
});
t('同一根 4H 已經判斷過 → 等下一根，不會晚幾小時才追進去', () => {
  let s = newS();
  const m = marketAt(bull, I0, 'AAAUSDT');
  s = B.apply(s, { type: 'wait', reason: '測試', barT: bull.k4[I0].t }, m);
  const a = B.decide(s, Object.assign({}, m, { now: m.now + 3 * 3600e3 }), CFG);
  assert.equal(a.type, 'wait');
});
t('資料不足 → 跳過', () => {
  const m = marketAt(bull, I0);
  assert.equal(B.decide(newS(), Object.assign({}, m, { d1: m.d1.slice(-100) }), CFG).type, 'skip');
  assert.equal(B.decide(newS(), Object.assign({}, m, { price: NaN }), CFG).type, 'skip');
});
t('空單訊號在 allowShort=false 時不做', () => {
  const bear = series(d => 300 - d * 0.25 + 6 * Math.sin(d / 2.3), 500, 150);
  const i = firstSignal(bear, 'short');
  const a = B.decide(newS(), marketAt(bear, i), CFG);
  assert.equal(a.type, 'wait');
  assert.match(a.reason, /只驗證多單/);
  const b = B.decide(newS({ allowShort: true }), marketAt(bear, i), Object.assign({}, CFG, { allowShort: true }));
  assert.equal(b.type, 'open');
  assert.equal(b.plan.side, 'short');
});
t('冷卻期內不進場', () => {
  let s = newS();
  s.status.AAAUSDT = { cooldownUntil: bull.k4[I0].t + H4 };
  const a = B.decide(s, marketAt(bull, I0), CFG);
  assert.equal(a.type, 'wait');
  assert.match(a.reason, /冷卻/);
});
t('達到同時持倉上限就不加', () => {
  // 把總名目上限放寬，讓「持倉筆數上限」成為唯一的限制
  const cfg = Object.assign({}, CFG, { maxLeverage: 50 });
  let s = B.newState(cfg);
  ['BBBUSDT', 'CCCUSDT', 'DDDUSDT'].forEach(sym => { s = B.tick(s, marketAt(bull, I0, sym), cfg).state; });
  assert.equal(B.openCount(s), 3);
  const a = B.decide(s, marketAt(bull, I0, 'AAAUSDT'), cfg);
  assert.equal(a.type, 'wait');
  assert.match(a.reason, /同時持倉上限/);
});
t('帳戶總名目會超過上限 → 不做', () => {
  let s = newS();
  s.positions.BBBUSDT = { symbol: 'BBBUSDT', side: 'long', entry: 1, stop: 0.9, qty: 499.9, notional: 499.9,
                          riskUsd: 1, entryFee: 0, openedAt: 0 };
  const a = B.decide(B.migrate(s), marketAt(bull, I0), CFG);
  assert.equal(a.type, 'blocked');
  assert.match(a.reason, /總名目/);
});
t('最小下單量把風險頂超過上限 → 不做', () => {
  const big = Object.assign({}, CFG, { filters: { '*': { minQty: 10, stepSize: 1, minNotional: 5 } } });
  const m = marketAt(bull, I0, 'AAAUSDT', { filters: undefined });
  const a = B.decide(B.newState(big), m, big);
  assert.equal(a.type, 'blocked');
});

console.log('\n持倉中 —— 止損只進不退、只在 4H 收盤時移動');
const opened = B.tick(newS(), marketAt(bull, I0), CFG).state;
const P0 = opened.positions.AAAUSDT;
t('開倉後記錄原始止損、風險距離與進場時間', () => {
  assert.ok(P0);
  near(P0.initStop, P0.stop); near(P0.initRisk, Math.abs(P0.entry - P0.stop)); near(P0.best, P0.entry);
  near(opened.equity, 100 - P0.entryFee, 1e-9);
});
t('15 分 K 碰到止損 → 以止損價出場', () => {
  const m = marketAt(bull, I0 + 1, 'AAAUSDT', {
    k15: [{ t: bull.k4[I0 + 1].t, o: P0.entry, h: P0.entry + 0.1, l: P0.stop - 0.5, c: P0.entry }] });
  const a = B.decide(opened, m, CFG);
  assert.equal(a.type, 'close'); near(a.price, P0.stop); assert.equal(a.why, 'stop');
});
t('開盤就跳空越過止損 → 以開盤價出場（更差，照實算）', () => {
  const gap = P0.stop - 2;
  const m = marketAt(bull, I0 + 1, 'AAAUSDT', {
    k15: [{ t: bull.k4[I0 + 1].t, o: gap, h: gap + 0.1, l: gap - 1, c: gap }] });
  near(B.decide(opened, m, CFG).price, gap);
});
t('開倉以前的 K 棒不算（不能用進場前的價格出場）', () => {
  const m = marketAt(bull, I0 + 1, 'AAAUSDT', {
    k15: [{ t: bull.k4[I0].t, o: 1, h: 1, l: 0.001, c: 1 }] });
  assert.equal(B.decide(opened, m, CFG).type, 'hold');
});
t('一路上漲時止損跟著往上，而且從不後退', () => {
  // 挑回測裡確實抱上去、用移動止損出場的那一筆
  const bt = S.backtest(trendy.k4, trendy.d1, { equity: 100, riskPct: 1, maxLeverage: 5, feeRate: CFG.feeRate, filters: FILT });
  const win = bt.trades.find(x => x.why === 'trail' && x.r > 1);
  assert.ok(win, '回測裡找不到抱上去的單');
  const j = trendy.k4.findIndex(b => b.t === win.t) - 1;       // 訊號那根
  let s = B.tick(newS(), marketAt(trendy, j), CFG).state;
  const first = s.positions.AAAUSDT;
  assert.ok(first, '這根應該要開倉');
  let last = first.stop, moved = false;
  for (let k = j + 1; k < j + 400 && s.positions.AAAUSDT; k++) {
    s = B.tick(s, marketAt(trendy, k), CFG).state;
    const p = s.positions.AAAUSDT;
    if (!p) break;
    assert.ok(p.stop >= last - 1e-9, `第 ${k} 根止損後退：${last} → ${p.stop}`);
    if (p.stop > last + 1e-9) moved = true;
    last = p.stop;
  }
  assert.ok(moved, '上漲過程中止損應該有往上移過');
});
t('止損只在 4H 收盤時更新：形成中那根的新高不會提早移動止損', () => {
  const m = marketAt(bull, I0 + 1, 'AAAUSDT');
  // 在「還沒收盤的那一根」裡放一根衝很高的 15 分 K
  m.k15 = m.k15.concat([{ t: bull.k4[I0 + 2].t - M15 * 2, o: P0.entry, h: P0.entry * 2, l: P0.entry, c: P0.entry }]);
  m.k4 = bull.k4.slice(0, I0 + 2);           // 最後一根 4H 還沒收盤
  m.now = bull.k4[I0 + 2].t - M15;
  const a = B.decide(opened, m, CFG);
  assert.equal(a.type, 'hold');
  near(a.pos.best, P0.entry, 1e-9);          // 最高價沒有被那根形成中的 K 棒更新
});

console.log('\n出場與成本');
function closeNow(state) {
  const p = state.positions.AAAUSDT;
  const m = marketAt(bull, I0 + 1, 'AAAUSDT', {
    k15: [{ t: bull.k4[I0 + 1].t, o: p.entry, h: p.entry, l: p.stop - 0.5, c: p.entry }] });
  return B.tick(state, m, CFG).state;
}
t('損益 = 價差 − 兩邊手續費 − 資金費；權益剛好等於起始 + 損益', () => {
  const s = closeNow(opened);
  const tr = s.trades[0];
  const exp = (P0.stop - P0.entry) * P0.qty - P0.qty * P0.stop * CFG.feeRate - P0.entryFee - tr.funding;
  near(tr.pnl, exp, 1e-9);
  near(s.equity, 100 + tr.pnl, 1e-9);
});
t('虧損出場後進入冷卻期（6 根 4H）', () => {
  const s = closeNow(opened);
  assert.equal(s.trades[0].pnl <= 0, true);
  near(s.status.AAAUSDT.cooldownUntil, Math.floor(bull.k4[I0 + 1].t / H4) * H4 + 6 * H4);
});
t('資金費每 8 小時收一次，只收到出場那一刻為止', () => {
  const later = B.apply(opened, { type: 'hold', pos: P0 }, marketAt(bull, I0 + 2, 'AAAUSDT', { now: P0.openedAt + 17 * 3600e3 }));
  near(later.fundingPaid, P0.notional * 0.0001 * 2, 1e-12);
  const out = B.apply(later, { type: 'close', price: P0.entry, at: P0.openedAt + 18 * 3600e3, why: 'stop' },
                      marketAt(bull, I0 + 2, 'AAAUSDT', { now: P0.openedAt + 40 * 3600e3 }));
  near(out.fundingPaid, P0.notional * 0.0001 * 2, 1e-12);   // 出場後不再收
  near(out.equity, 100 + out.trades[0].pnl, 1e-9);
});

t('浮動損益 = 用現價平倉會記下的損益（含開倉費、資金費、平倉費）', () => {
  const later = B.apply(opened, { type: 'hold', pos: P0 }, marketAt(bull, I0 + 2, 'AAAUSDT', { now: P0.openedAt + 17 * 3600e3 }));
  const pos = later.positions.AAAUSDT, price = P0.entry * 1.013;
  const u = B.unrealized(pos, price, CFG.feeRate);
  const out = B.apply(later, { type: 'close', price, at: P0.openedAt + 18 * 3600e3, why: 'trail' },
                      marketAt(bull, I0 + 2, 'AAAUSDT', { now: P0.openedAt + 18 * 3600e3 }));
  near(u.pnl, out.trades[0].pnl, 1e-9);
  near(u.r, out.trades[0].r, 1e-9);
  near(later.equity + u.equityDelta, out.equity, 1e-9);
});
t('浮動損益：進場價不動也是負的（已付的手續費）；離止損的距離', () => {
  const u = B.unrealized(P0, P0.entry, CFG.feeRate);
  near(u.gross, 0); assert.ok(u.pnl < 0);
  near(u.pnl, -(P0.entryFee + P0.qty * P0.entry * CFG.feeRate), 1e-12);
  near(u.toStopPct, (P0.entry - P0.stop) / P0.entry * 100, 1e-9);
  const sh = Object.assign({}, P0, { side: 'short', stop: P0.entry * 1.02 });
  assert.ok(B.unrealized(sh, P0.entry * 0.99, 0).gross > 0);
  near(B.unrealized(sh, P0.entry, 0).toStopPct, 2, 1e-9);
  assert.equal(B.unrealized(P0, null, 0), null);
  assert.equal(B.unrealized(P0, 0, 0), null);
});

console.log('\n和回測逐筆一致（回測到什麼，就跑什麼）');
function replay(ser, cfg) {
  let s = B.newState(cfg);
  for (let i = 60; i < ser.k4.length - 1; i++) s = B.tick(s, marketAt(ser, i, 'AAAUSDT'), cfg).state;
  return s;
}
for (const [name, ser] of [['一路被掃的多頭', bull], ['漲跌來回的行情', mixed], ['趨勢明顯、會抱上去的行情', trendy]]) {
  t(name + '：即時機器人與回測引擎開出完全相同的交易', () => {
    const cfg = Object.assign({}, CFG, { allowShort: true, maxPositions: 1 });
    const live = replay(ser, cfg);
    const bt = S.backtest(ser.k4, ser.d1, { equity: 100, riskPct: 1, maxRiskPct: 5, maxLeverage: 5,
                                            feeRate: CFG.feeRate, filters: FILT });
    // 回測最後會把還開著的部位以收盤價平掉，即時機器人不會，比較時排除那一筆
    const btTrades = bt.trades.filter(x => x.why !== 'close');
    assert.ok(btTrades.length >= 3, '交易太少，比不出東西：' + btTrades.length);
    assert.equal(live.trades.length, btTrades.length, `筆數不同：即時 ${live.trades.length}、回測 ${btTrades.length}`);
    live.trades.forEach((x, k) => {
      const y = btTrades[k];
      assert.equal(x.side, y.side, `第 ${k} 筆方向不同`);
      near(x.entry, y.entry, 1e-9);
      near(x.exit, y.exit, 1e-9);
      near(x.stop, y.stop, 1e-9);
    });
  });
}

console.log('\nmark 與 stats');
t('mark 記一輪、推曲線點並記下持倉數', () => {
  const s = B.mark(opened, 12345);
  assert.equal(s.ticks, 1); assert.equal(s.lastTick, 12345); assert.equal(s.curve[0].open, 1);
});
t('空狀態 stats 不丟例外', () => {
  const st = B.stats(newS());
  assert.equal(st.n, 0); assert.equal(st.winRate, null);
});
t('勝率、報酬、每個幣分開統計', () => {
  const s = newS();
  s.trades = [{ symbol: 'A', pnl: 2, r: 2 }, { symbol: 'A', pnl: -1, r: -1 }, { symbol: 'B', pnl: 2, r: 2 }, { symbol: 'B', pnl: -1, r: -1 }];
  s.equity = 102;
  const st = B.stats(s);
  near(st.winRate, 50); near(st.totalR, 2); near(st.returnPct, 2); near(st.profitFactor, 2);
  assert.equal(st.bySymbol.A.n, 2);
});
t('狀態可以序列化成 JSON 再讀回來續抱', () => {
  const round = JSON.parse(JSON.stringify(opened));
  assert.deepEqual(round, opened);
  assert.ok(['hold', 'close'].includes(B.decide(round, marketAt(bull, I0 + 1), CFG).type));
});

console.log('\n' + (fail === 0 ? `全部通過（${pass} 項）` : `${pass} 通過 / ${fail} 失敗`));
process.exit(fail === 0 ? 0 : 1);
