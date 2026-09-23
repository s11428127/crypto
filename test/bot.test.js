/* 模擬單機器人的驗算 */
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

const CFG = { startEquity: 100, riskPct: 1, maxLeverage: 5,
              filters: { minQty: 0.001, stepSize: 0.001, minNotional: 100 } };
const NOW = 1_700_000_000_000;
function market(over) {
  return Object.assign({
    now: NOW, price: 80000, k15: [], analyses: UP,
    fundingRate: 0.0001, filters: CFG.filters
  }, over || {});
}

console.log('\n初始狀態');
t('newState 帶入設定並從起始本金開始', () => {
  const s = B.newState(CFG);
  assert.equal(s.equity, 100);
  assert.equal(s.position, null);
  assert.deepEqual(s.trades, []);
  assert.equal(s.config.maxLeverage, 5);
});

console.log('\ndecide —— 空手時');
t('三框架同向且時機到位 → 開倉', () => {
  const a = B.decide(B.newState(CFG), market(), CFG);
  assert.equal(a.type, 'open');
  assert.equal(a.plan.side, 'long');
  assert.ok(a.plan.stop < a.plan.entry);
});
t('日線與 4H 不同調 → 觀望，不開倉', () => {
  const a = B.decide(B.newState(CFG), market({ analyses: MIXED }), CFG);
  assert.equal(a.type, 'wait');
});
t('沒有有效報價 → 跳過，不亂開', () => {
  assert.equal(B.decide(B.newState(CFG), market({ price: NaN }), CFG).type, 'skip');
  assert.equal(B.decide(B.newState(CFG), market({ price: 0 }), CFG).type, 'skip');
});
t('K 線資料不足 → 跳過', () => {
  assert.equal(B.decide(B.newState(CFG), market({ analyses: {} }), CFG).type, 'skip');
});
t('部位開不起來（超過槓桿上限）→ blocked 而不是硬開', () => {
  const tiny = Object.assign({}, CFG, { startEquity: 10, maxLeverage: 2 });
  const a = B.decide(B.newState(tiny), market(), tiny);
  assert.equal(a.type, 'blocked');
});

console.log('\nscanExit —— 止損止盈的判斷');
const pos = { side: 'long', entry: 80000, stop: 78000, tp: 83000, openedAt: NOW };
t('沒碰到任何價位 → 不出場', () => {
  assert.equal(B.scanExit(pos, [{ t: NOW + 1, h: 81000, l: 79000 }]), null);
});
t('最低價掃到止損 → 以止損價出場（即使收盤彈回來）', () => {
  const e = B.scanExit(pos, [{ t: NOW + 1, h: 81000, l: 77500 }]);
  assert.equal(e.why, 'stop');
  near(e.price, 78000);
});
t('最高價碰到止盈 → 以止盈價出場', () => {
  const e = B.scanExit(pos, [{ t: NOW + 1, h: 83500, l: 79500 }]);
  assert.equal(e.why, 'tp');
  near(e.price, 83000);
});
t('同一根兩邊都碰到 → 算止損（保守，不高估績效）', () => {
  const e = B.scanExit(pos, [{ t: NOW + 1, h: 84000, l: 77000 }]);
  assert.equal(e.why, 'stop');
});
t('開倉當根之前的 K 棒不算數（不能用進場前的價格）', () => {
  assert.equal(B.scanExit(pos, [{ t: NOW - 1000, h: 90000, l: 70000 }]), null);
});
t('做空的方向相反', () => {
  const sp = { side: 'short', entry: 80000, stop: 82000, tp: 77000, openedAt: NOW };
  assert.equal(B.scanExit(sp, [{ t: NOW + 1, h: 82500, l: 79000 }]).why, 'stop');
  assert.equal(B.scanExit(sp, [{ t: NOW + 1, h: 81000, l: 76500 }]).why, 'tp');
});

console.log('\napply —— 開倉');
const opened = (function () {
  const s0 = B.newState(CFG);
  return B.tick(s0, market(), CFG);
})();
t('開倉後有部位，且扣掉進場手續費', () => {
  const s = opened.state;
  assert.ok(s.position, '應該要有部位');
  assert.ok(s.feesPaid > 0, '應該扣了手續費');
  near(s.equity, 100 - s.position.entryFee, 1e-9);
});
t('部位的止損止盈和計畫一致', () => {
  const s = opened.state, p = opened.action.plan;
  near(s.position.stop, p.stop, 1e-9);
  near(s.position.tp, p.targets[0].price, 1e-9);
  near(s.position.qty, p.qty, 1e-12);
});
t('持倉中不會再開第二個部位', () => {
  const a = B.decide(opened.state, market(), CFG);
  assert.ok(a.type === 'hold' || a.type === 'close', '應該是續抱或出場，實際 ' + a.type);
});
t('apply 不會改到傳入的狀態（純函式）', () => {
  const s0 = B.newState(CFG);
  const before = JSON.stringify(s0);
  B.tick(s0, market(), CFG);
  assert.equal(JSON.stringify(s0), before, '原始狀態被改動了');
});

console.log('\napply —— 出場與損益');
t('止盈出場的損益 = 價差 × 數量 − 兩邊手續費', () => {
  const s1 = opened.state;
  const p = s1.position;
  const out = B.tick(s1, market({
    now: NOW + 3600000,
    k15: [{ t: NOW + 1800000, h: p.tp + 100, l: p.entry }]
  }), CFG);
  const tr = out.state.trades[0];
  assert.equal(tr.why, 'tp');
  const gross = (p.tp - p.entry) * p.qty;
  const exitFee = p.qty * p.tp * 0.00045;
  near(tr.pnl, gross - exitFee - p.entryFee, 1e-9);
  assert.ok(tr.pnl > 0, '止盈應該是賺的');
});
t('止盈的 R 值約等於設定的 1.5R', () => {
  const s1 = opened.state, p = s1.position;
  const out = B.tick(s1, market({ now: NOW + 3600000,
    k15: [{ t: NOW + 1800000, h: p.tp + 100, l: p.entry }] }), CFG);
  const r = out.state.trades[0].r;
  assert.ok(r > 1.2 && r < 1.5, 'R 應該略低於 1.5（扣掉手續費），實際 ' + r.toFixed(3));
});
t('止損出場的 R 值約等於 −1', () => {
  const s1 = opened.state, p = s1.position;
  const out = B.tick(s1, market({ now: NOW + 3600000,
    k15: [{ t: NOW + 1800000, h: p.entry, l: p.stop - 100 }] }), CFG);
  const r = out.state.trades[0].r;
  assert.ok(r < -1 && r > -1.15, 'R 應該略低於 −1（扣掉手續費），實際 ' + r.toFixed(3));
});
t('出場後部位清空、權益更新', () => {
  const s1 = opened.state, p = s1.position;
  const out = B.tick(s1, market({ now: NOW + 3600000,
    k15: [{ t: NOW + 1800000, h: p.tp + 100, l: p.entry }] }), CFG);
  assert.equal(out.state.position, null);
  near(out.state.equity, out.state.trades[0].equityAfter, 1e-12);
});

console.log('\n資金費');
t('持倉滿 8 小時收一次資金費', () => {
  const s1 = opened.state;
  const before = s1.equity;
  const out = B.apply(s1, { type: 'hold' },
    market({ now: NOW + 8 * 3600000 + 1000, fundingRate: 0.0002 }));
  near(out.fundingPaid, s1.position.notional * 0.0002, 1e-9);
  assert.ok(out.equity < before, '權益應該少掉資金費');
});
t('未滿 8 小時不收', () => {
  const out = B.apply(opened.state, { type: 'hold' }, market({ now: NOW + 3600000 }));
  near(out.fundingPaid, 0);
});
t('隔很久才跑也會把中間每一期補收（不會漏收）', () => {
  const out = B.apply(opened.state, { type: 'hold' },
    market({ now: NOW + 25 * 3600000, fundingRate: 0.0001 }));
  // 8h / 16h / 24h → 三期
  near(out.fundingPaid, opened.state.position.notional * 0.0001 * 3, 1e-9);
});
t('空手時不收資金費', () => {
  const out = B.apply(B.newState(CFG), { type: 'wait', reason: 'x' },
    market({ now: NOW + 100 * 3600000 }));
  near(out.fundingPaid, 0);
});

console.log('\nstats');
t('空的狀態不丟例外', () => {
  const s = B.stats(B.newState(CFG));
  assert.equal(s.n, 0);
  assert.equal(s.winRate, null);
  assert.equal(s.enough, false);
});
t('勝率與報酬率算得對', () => {
  let s = B.newState(CFG);
  s.trades = [
    { pnl: 2, r: 2, equityAfter: 102 },
    { pnl: -1, r: -1, equityAfter: 101 },
    { pnl: 2, r: 2, equityAfter: 103 },
    { pnl: -1, r: -1, equityAfter: 102 }
  ];
  s.equity = 102;
  s.curve = [{ equity: 100 }, { equity: 102 }, { equity: 101 }, { equity: 103 }, { equity: 102 }];
  const st = B.stats(s);
  near(st.winRate, 50);
  near(st.totalR, 2);
  near(st.avgR, 0.5);
  near(st.returnPct, 2);
  near(st.profitFactor, 2);
  // 最深的一段是 102 → 101，不是 103 → 102
  near(st.maxDD, (102 - 101) / 102 * 100, 1e-9);
});
t('未滿 30 筆標記樣本不足', () => {
  let s = B.newState(CFG);
  s.trades = Array.from({ length: 29 }, () => ({ pnl: 1, r: 1 }));
  assert.equal(B.stats(s).enough, false);
  s.trades.push({ pnl: 1, r: 1 });
  assert.equal(B.stats(s).enough, true);
});

console.log('\n整段流程');
t('開 → 抱 → 止盈 → 再開，狀態一路正確', () => {
  let s = B.newState(CFG);
  let r = B.tick(s, market(), CFG);
  assert.equal(r.action.type, 'open');
  s = r.state;
  const p = s.position;

  r = B.tick(s, market({ now: NOW + 3600000, k15: [{ t: NOW + 1000, h: p.entry + 10, l: p.entry - 10 }] }), CFG);
  assert.equal(r.action.type, 'hold');
  s = r.state;

  r = B.tick(s, market({ now: NOW + 7200000, k15: [{ t: NOW + 5400000, h: p.tp + 50, l: p.entry }] }), CFG);
  assert.equal(r.action.type, 'close');
  s = r.state;
  assert.equal(s.trades.length, 1);
  assert.equal(s.position, null);

  r = B.tick(s, market({ now: NOW + 10800000 }), CFG);
  assert.equal(r.action.type, 'open', '空手後應該能再開新倉');
  assert.ok(r.state.equity > 100, '賺了一筆，權益應該高於起始');
});
t('狀態可以序列化成 JSON 再讀回來（排程要靠這個存檔）', () => {
  let s = B.newState(CFG);
  s = B.tick(s, market(), CFG).state;
  const round = JSON.parse(JSON.stringify(s));
  assert.deepEqual(round, s);
  const a = B.decide(round, market({ now: NOW + 3600000 }), CFG);
  assert.ok(a.type === 'hold' || a.type === 'close');
});

console.log('\n' + (fail === 0 ? `全部通過（${pass} 項）` : `${pass} 通過 / ${fail} 失敗`));
process.exit(fail === 0 ? 0 : 1);
