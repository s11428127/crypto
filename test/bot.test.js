/* 模擬單機器人（v2 多幣種）的驗算 */
import '../assets/risk.js';
import '../assets/indicators.js';
import '../assets/plan.js';
import '../assets/bot.js';
import assert from 'node:assert/strict';

const B = globalThis.BOT, I = globalThis.IND;
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
    out.push({ t: i * 3600000, o: c - drift, h: c + Math.abs(w) + wob,
               l: c - Math.abs(w) - wob, c: c + w, v: 100 });
  }
  return out;
}
const UP = { d1: I.analyze(mk(260, 50000, 60, 120)),
             h4: I.analyze(mk(260, 60000, 40, 150)),
             m15: I.analyze(mk(260, 65000, 10, 40)) };
const MIXED = { d1: I.analyze(mk(260, 50000, 60, 120)),
                h4: I.analyze(mk(260, 80000, -50, 150)),
                m15: I.analyze(mk(260, 65000, 10, 40)) };

const CFG = {
  symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'],
  startEquity: 100, riskPct: 1, maxRiskPct: 5, maxPositions: 3, maxLeverage: 5,
  filters: {
    BTCUSDT: { minQty: 0.001, stepSize: 0.001, minNotional: 100 },
    '*': { minQty: 0, stepSize: 0, minNotional: 5 }
  }
};
const NOW = 1_700_000_000_000;
function market(over) {
  return Object.assign({
    symbol: 'ETHUSDT', now: NOW, price: 3000, k15: [], analyses: UP, fundingRate: 0.0001
  }, over || {});
}
const newS = () => B.newState(CFG);

console.log('\n初始狀態與設定');
t('newState 是 v2、沒有部位、從起始本金開始', () => {
  const s = newS();
  assert.equal(s.version, 2);
  assert.deepEqual(s.positions, {});
  assert.equal(s.equity, 100);
});
t('filtersFor：列出的幣用自己的，沒列的用 "*"', () => {
  assert.equal(B.filtersFor(CFG, 'BTCUSDT').minNotional, 100);
  assert.equal(B.filtersFor(CFG, 'SOLUSDT').minNotional, 5);
});
t('filtersFor：相容舊格式（整個 filters 就是一組）', () => {
  const old = { filters: { minQty: 0.001, stepSize: 0.001, minNotional: 100 } };
  assert.equal(B.filtersFor(old, 'ETHUSDT').minNotional, 100);
});
t('symbolsOf：舊設定只有 symbol 也能用', () => {
  assert.deepEqual(B.symbolsOf({ symbol: 'BTCUSDT' }), ['BTCUSDT']);
  assert.deepEqual(B.symbolsOf(CFG), CFG.symbols);
});

console.log('\nmigrate —— 舊狀態檔要能無痛升級');
const V1 = {
  version: 1,
  config: { symbol: 'BTCUSDT', startEquity: 100, riskPct: 1, maxLeverage: 5,
            filters: { minQty: 0.001, stepSize: 0.001, minNotional: 100 } },
  equity: 98.5,
  position: { side: 'long', entry: 80000, stop: 78000, tp: 83000, qty: 0.002, notional: 160,
              riskUsd: 4, entryFee: 0.07, openedAt: NOW, nextFundingAt: NOW + 8 * 3600e3 },
  trades: [{ pnl: -1.5, r: -1 }],
  curve: [{ t: NOW, equity: 100, hasPosition: false }, { t: NOW + 1, equity: 98.5, hasPosition: true }],
  notes: [{ t: NOW, kind: 'idle', text: '等待' }, { t: NOW, kind: 'open', text: '開多' }],
  feesPaid: 0.1, fundingPaid: 0, ticks: 2, lastTick: NOW, createdAt: NOW
};
t('單一部位搬到 positions[原本的幣]', () => {
  const s = B.migrate(V1);
  assert.equal(s.version, 2);
  assert.equal(s.position, undefined);
  assert.equal(s.positions.BTCUSDT.entry, 80000);
  assert.equal(s.positions.BTCUSDT.symbol, 'BTCUSDT');
});
t('權益、成交、成本原封不動', () => {
  const s = B.migrate(V1);
  assert.equal(s.equity, 98.5);
  assert.equal(s.trades.length, 1);
  assert.equal(s.trades[0].symbol, 'BTCUSDT');
  assert.equal(s.feesPaid, 0.1);
  assert.equal(s.ticks, 2);
});
t('舊的閒置紀錄清掉，只留開平倉事件', () => {
  const s = B.migrate(V1);
  assert.ok(s.notes.every(n => n.kind !== 'idle'));
  assert.equal(s.notes.length, 1);
});
t('曲線的 hasPosition 轉成 open 數量', () => {
  const s = B.migrate(V1);
  assert.equal(s.curve[0].open, 0);
  assert.equal(s.curve[1].open, 1);
});
t('空手的 v1 升級後 positions 是空的', () => {
  const s = B.migrate(Object.assign({}, V1, { position: null }));
  assert.deepEqual(s.positions, {});
});
t('已經是 v2 就不動，而且不改到傳入的物件', () => {
  const s = newS();
  const before = JSON.stringify(s);
  const m = B.migrate(s);
  assert.equal(JSON.stringify(s), before);
  assert.deepEqual(m, s);
});

console.log('\ndecide —— 空手時');
t('三框架同向且時機到位 → 開倉', () => {
  const a = B.decide(newS(), market(), CFG);
  assert.equal(a.type, 'open');
  assert.equal(a.plan.side, 'long');
});
t('日線與 4H 不同調 → 觀望', () => {
  assert.equal(B.decide(newS(), market({ analyses: MIXED }), CFG).type, 'wait');
});
t('沒有有效報價 → 跳過', () => {
  assert.equal(B.decide(newS(), market({ price: NaN }), CFG).type, 'skip');
  assert.equal(B.decide(newS(), market({ price: 0 }), CFG).type, 'skip');
});
t('K 線資料不足 → 跳過', () => {
  assert.equal(B.decide(newS(), market({ analyses: {} }), CFG).type, 'skip');
});
t('用的是這個幣自己的下單限制', () => {
  // BTC 最小名目 $100，$100 帳戶 1% 風險做不到 → 風險會被頂高
  const a = B.decide(newS(), market({ symbol: 'BTCUSDT', price: 80000 }), CFG);
  if (a.plan) assert.ok(a.plan.minNotional >= 100, 'BTC 應該套用 $100 的最小名目');
});
t('最小下單量把風險頂得超過 maxRiskPct → 不做', () => {
  const tight = Object.assign({}, CFG, { maxRiskPct: 1.5 });
  const a = B.decide(B.newState(tight), market({ symbol: 'BTCUSDT', price: 80000 }), tight);
  assert.equal(a.type, 'blocked');
  assert.match(a.reason, /最小下單量把風險頂到/);
});
t('部位開不起來（超過槓桿上限）→ blocked', () => {
  const tiny = Object.assign({}, CFG, { startEquity: 10, maxLeverage: 2 });
  const a = B.decide(B.newState(tiny), market({ symbol: 'BTCUSDT', price: 80000 }), tiny);
  assert.equal(a.type, 'blocked');
});

console.log('\n多幣種的帳戶規則');
function withOpen(syms) {
  let s = newS();
  syms.forEach((sym, i) => {
    s = B.tick(s, market({ symbol: sym, price: 3000 + i }), CFG).state;
  });
  return s;
}
t('不同幣可以各自持有部位', () => {
  const s = withOpen(['ETHUSDT', 'SOLUSDT']);
  assert.ok(s.positions.ETHUSDT && s.positions.SOLUSDT);
  assert.equal(B.openCount(s), 2);
});
t('同一個幣不會開第二個部位', () => {
  const s = withOpen(['ETHUSDT']);
  const a = B.decide(s, market({ symbol: 'ETHUSDT', price: 3000 }), CFG);
  assert.ok(a.type === 'hold' || a.type === 'close');
});
t('達到同時持倉上限後，其他幣的訊號也不加', () => {
  const s = withOpen(['ETHUSDT', 'SOLUSDT', 'XRPUSDT']);
  assert.equal(B.openCount(s), 3);
  const a = B.decide(s, market({ symbol: 'ADAUSDT', price: 3000 }), CFG);
  assert.equal(a.type, 'wait');
  assert.match(a.reason, /同時持倉上限/);
});
t('帳戶總名目會超過槓桿上限 → blocked（既有 $495 + 新單約 $7.6 > $500）', () => {
  let s = newS();
  s.positions.ETHUSDT = { symbol: 'ETHUSDT', side: 'long', entry: 1, stop: 0.9, tp: 1.2,
                          qty: 495, notional: 495, riskUsd: 1, entryFee: 0, openedAt: NOW };
  const a = B.decide(s, market({ symbol: 'SOLUSDT', price: 3000 }), CFG);
  assert.equal(a.type, 'blocked');
  assert.match(a.reason, /總名目/);
});

console.log('\nscanExit —— 止損止盈的判斷');
const pos = { side: 'long', entry: 80000, stop: 78000, tp: 83000, openedAt: NOW };
t('沒碰到任何價位 → 不出場', () => assert.equal(B.scanExit(pos, [{ t: NOW + 1, h: 81000, l: 79000 }]), null));
t('最低價掃到止損 → 以止損價出場', () => {
  const e = B.scanExit(pos, [{ t: NOW + 1, h: 81000, l: 77500 }]);
  assert.equal(e.why, 'stop'); near(e.price, 78000);
});
t('最高價碰到止盈 → 以止盈價出場', () => {
  const e = B.scanExit(pos, [{ t: NOW + 1, h: 83500, l: 79500 }]);
  assert.equal(e.why, 'tp'); near(e.price, 83000);
});
t('同一根兩邊都碰到 → 算止損', () => {
  assert.equal(B.scanExit(pos, [{ t: NOW + 1, h: 84000, l: 77000 }]).why, 'stop');
});
t('開倉當根之前的 K 棒不算數', () => {
  assert.equal(B.scanExit(pos, [{ t: NOW - 1000, h: 90000, l: 70000 }]), null);
});
t('做空的方向相反', () => {
  const sp = { side: 'short', entry: 80000, stop: 82000, tp: 77000, openedAt: NOW };
  assert.equal(B.scanExit(sp, [{ t: NOW + 1, h: 82500, l: 79000 }]).why, 'stop');
  assert.equal(B.scanExit(sp, [{ t: NOW + 1, h: 81000, l: 76500 }]).why, 'tp');
});

console.log('\napply —— 開倉與出場');
const opened = B.tick(newS(), market(), CFG);
t('開倉後這個幣有部位，且扣掉進場手續費', () => {
  const s = opened.state, p = s.positions.ETHUSDT;
  assert.ok(p, '應該有 ETH 部位');
  assert.equal(p.symbol, 'ETHUSDT');
  near(s.equity, 100 - p.entryFee, 1e-9);
});
t('開倉會寫一筆事件，閒置不會', () => {
  assert.equal(opened.state.notes.length, 1);
  assert.equal(opened.state.notes[0].kind, 'open');
  const idle = B.tick(newS(), market({ analyses: MIXED }), CFG).state;
  assert.equal(idle.notes.length, 0, '觀望不該寫進事件');
  assert.equal(idle.status.ETHUSDT.type, 'wait', '但要記在這個幣的狀態');
});
t('apply 不會改到傳入的狀態', () => {
  const s0 = newS(), before = JSON.stringify(s0);
  B.tick(s0, market(), CFG);
  assert.equal(JSON.stringify(s0), before);
});
function closeAt(state, sym, hi, lo) {
  return B.tick(state, market({ symbol: sym, now: NOW + 3600000,
    k15: [{ t: NOW + 1800000, h: hi, l: lo }] }), CFG);
}
t('止盈出場的損益 = 價差 × 數量 − 兩邊手續費', () => {
  const p = opened.state.positions.ETHUSDT;
  const out = closeAt(opened.state, 'ETHUSDT', p.tp + 1, p.entry);
  const tr = out.state.trades[0];
  assert.equal(tr.why, 'tp');
  assert.equal(tr.symbol, 'ETHUSDT');
  near(tr.pnl, (p.tp - p.entry) * p.qty - p.qty * p.tp * 0.00045 - p.entryFee, 1e-9);
});
t('止盈的 R 略低於 1.5、止損的 R 略低於 −1（扣手續費）', () => {
  const p = opened.state.positions.ETHUSDT;
  const win = closeAt(opened.state, 'ETHUSDT', p.tp + 1, p.entry).state.trades[0].r;
  const loss = closeAt(opened.state, 'ETHUSDT', p.entry, p.stop - 1).state.trades[0].r;
  assert.ok(win > 1.3 && win < 1.5, '止盈 R ' + win);
  assert.ok(loss < -1 && loss > -1.1, '止損 R ' + loss);
});
t('出場後這個幣的部位清掉，其他幣不受影響', () => {
  let s = withOpen(['ETHUSDT', 'SOLUSDT']);
  const p = s.positions.ETHUSDT;
  s = closeAt(s, 'ETHUSDT', p.tp + 1, p.entry).state;
  assert.equal(s.positions.ETHUSDT, undefined);
  assert.ok(s.positions.SOLUSDT, 'SOL 的部位應該還在');
});

console.log('\n資金費');
t('持倉滿 8 小時收一次', () => {
  const s1 = opened.state;
  const out = B.apply(s1, { type: 'hold' }, market({ now: NOW + 8 * 3600000 + 1, fundingRate: 0.0002 }));
  near(out.fundingPaid, s1.positions.ETHUSDT.notional * 0.0002, 1e-9);
});
t('隔很久才跑會補收每一期', () => {
  const out = B.apply(opened.state, { type: 'hold' }, market({ now: NOW + 25 * 3600000 }));
  near(out.fundingPaid, opened.state.positions.ETHUSDT.notional * 0.0001 * 3, 1e-9);
});
t('只收這一輪處理的那個幣的資金費', () => {
  const s = withOpen(['ETHUSDT', 'SOLUSDT']);
  const out = B.apply(s, { type: 'hold' }, market({ symbol: 'SOLUSDT', now: NOW + 9 * 3600000 }));
  near(out.fundingPaid, s.positions.SOLUSDT.notional * 0.0001, 1e-9);
  assert.equal(out.positions.ETHUSDT.nextFundingAt, s.positions.ETHUSDT.nextFundingAt,
    'ETH 的資金費時間不該被動到');
});
t('平倉那一筆的損益包含持倉期間付的資金費（R 不能高估）', () => {
  const s1 = B.apply(opened.state, { type: 'hold' },
    market({ now: NOW + 17 * 3600000, fundingRate: 0.0005 }));      // 收兩期
  const p = s1.positions.ETHUSDT;
  near(p.funding, p.notional * 0.0005 * 2, 1e-9);
  const out = B.apply(s1, { type: 'close', price: p.tp, why: 'tp', at: NOW + 18 * 3600000 },
    market({ now: NOW + 18 * 3600000 }));
  const tr = out.trades[0];
  const expected = (p.tp - p.entry) * p.qty - p.qty * p.tp * 0.00045 - p.entryFee - p.funding;
  near(tr.pnl, expected, 1e-9);
  near(tr.funding, p.funding, 1e-12);
  // 權益 = 起始 + 這一筆的損益（資金費不能被扣兩次）
  near(out.equity, 100 + tr.pnl, 1e-9);
});
t('空手不收', () => {
  near(B.apply(newS(), { type: 'wait', reason: 'x' }, market({ now: NOW + 100 * 3600000 })).fundingPaid, 0);
});

console.log('\nmark 與 stats');
t('mark 記一輪、推一個曲線點，並記下持倉數', () => {
  const s = B.mark(withOpen(['ETHUSDT', 'SOLUSDT']), NOW + 5);
  assert.equal(s.ticks, 1);
  assert.equal(s.lastTick, NOW + 5);
  assert.equal(s.curve.length, 1);
  assert.equal(s.curve[0].open, 2);
});
t('空狀態不丟例外', () => {
  const st = B.stats(newS());
  assert.equal(st.n, 0); assert.equal(st.winRate, null); assert.equal(st.enough, false);
});
t('勝率、報酬、回撤、每個幣分開統計', () => {
  const s = newS();
  s.trades = [
    { symbol: 'ETHUSDT', pnl: 2, r: 2 }, { symbol: 'ETHUSDT', pnl: -1, r: -1 },
    { symbol: 'SOLUSDT', pnl: 2, r: 2 }, { symbol: 'SOLUSDT', pnl: -1, r: -1 }
  ];
  s.equity = 102;
  s.curve = [{ equity: 100 }, { equity: 102 }, { equity: 101 }, { equity: 103 }, { equity: 102 }];
  const st = B.stats(s);
  near(st.winRate, 50); near(st.totalR, 2); near(st.returnPct, 2); near(st.profitFactor, 2);
  near(st.maxDD, (102 - 101) / 102 * 100, 1e-9);
  assert.equal(st.bySymbol.ETHUSDT.n, 2);
  near(st.bySymbol.SOLUSDT.totalR, 1);
});

console.log('\n整段流程');
t('多個幣輪流跑：開 → 抱 → 止盈 → 再開，狀態一路正確', () => {
  let s = newS();
  for (const sym of ['ETHUSDT', 'SOLUSDT']) s = B.tick(s, market({ symbol: sym, price: 3000 }), CFG).state;
  s = B.mark(s, NOW);
  assert.equal(B.openCount(s), 2);
  const p = s.positions.ETHUSDT;
  s = closeAt(s, 'ETHUSDT', p.tp + 1, p.entry).state;
  s = B.mark(s, NOW + 3600000);
  assert.equal(s.trades.length, 1);
  assert.equal(B.openCount(s), 1);
  s = B.tick(s, market({ symbol: 'ETHUSDT', now: NOW + 7200000, price: 3000 }), CFG).state;
  assert.ok(s.positions.ETHUSDT, '平倉後同一個幣可以再開');
  assert.equal(s.ticks, 2);
});
t('狀態可以序列化成 JSON 再讀回來', () => {
  const s = withOpen(['ETHUSDT']);
  const round = JSON.parse(JSON.stringify(s));
  assert.deepEqual(round, s);
  assert.ok(['hold', 'close'].includes(B.decide(round, market({ now: NOW + 3600000 }), CFG).type));
});

console.log('\n' + (fail === 0 ? `全部通過（${pass} 項）` : `${pass} 通過 / ${fail} 失敗`));
process.exit(fail === 0 ? 0 : 1);
