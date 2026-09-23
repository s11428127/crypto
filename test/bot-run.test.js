/*
 * 資料來源解析與機器人整合的驗算。
 *
 * 重點在 Kraken：排程跑在美國機器上，Binance／Bybit 會被地區封鎖，
 * 實際會用到的是 Kraken，但這台機器連不到它，只能用假的 HTTP 回應驗證解析。
 */
import '../assets/risk.js';
import '../assets/indicators.js';
import '../assets/plan.js';
import '../assets/bot.js';
import '../assets/data.js';
import assert from 'node:assert/strict';

const { DATA, BOT, IND } = globalThis;
let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + (e && e.message ? e.message : e)); }
}
const near = (a, b, tol = 1e-6) =>
  assert.ok(Number.isFinite(a) && Math.abs(a - b) <= tol, `expected ${a} ≈ ${b} (tol ${tol})`);

/* ---------- 假的 HTTP 回應 ---------- */
const realFetch = globalThis.fetch;
function stub(handler) {
  globalThis.fetch = async (url) => {
    const res = handler(String(url));
    if (res === null) return { ok: false, status: 403, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => res };
  };
}
function restore() { globalThis.fetch = realFetch; }

const T0 = Date.UTC(2026, 8, 1);
function krakenOHLC(n, stepMin, start, drift) {
  const rows = []; let c = start;
  for (let i = 0; i < n; i++) {
    const o = c; c += drift;
    rows.push([Math.floor((T0 + i * stepMin * 60000) / 1000),
      o.toFixed(1), (Math.max(o, c) + 50).toFixed(1), (Math.min(o, c) - 50).toFixed(1),
      c.toFixed(1), c.toFixed(1), '12.5', 100]);
  }
  return rows;
}
const KRAKEN_INTERVAL_MIN = { '15': 15, '60': 60, '240': 240, '1440': 1440 };

function krakenHandler(url) {
  if (!/api\.kraken\.com/.test(url)) return null;          // 其他來源一律失敗
  if (/\/0\/public\/OHLC/.test(url)) {
    const iv = new URL(url).searchParams.get('interval');
    const min = KRAKEN_INTERVAL_MIN[iv];
    if (!min) throw new Error('沒預期到的週期 ' + iv);
    return { error: [], result: { XXBTZUSD: krakenOHLC(300, min, 60000, 20), last: 1 } };
  }
  if (/\/0\/public\/Ticker/.test(url)) {
    return { error: [], result: { XXBTZUSD: {
      a: ['80210.0', '1', '1.0'], b: ['80200.0', '1', '1.0'], c: ['80205.5', '0.01'],
      v: ['100.0', '2500.0'], p: ['80100.0', '79900.0'], t: [100, 2000],
      l: ['79000.0', '78000.0'], h: ['81000.0', '82000.0'], o: '79500.0'
    } } };
  }
  return null;
}

console.log('\nKraken 解析');
await t('代號轉換：BTCUSDT → XBTUSD', () => {
  const k = DATA.sources.find(s => s.id === 'kraken');
  assert.equal(k.pair('BTCUSDT'), 'XBTUSD');
  assert.equal(k.pair('ETHUSDT'), 'ETHUSD');
});
await t('K 線解析：秒轉毫秒、欄位對得上、由舊到新', async () => {
  stub(krakenHandler);
  const k = DATA.sources.find(s => s.id === 'kraken');
  const rows = await k.klines('BTCUSDT', '4h', 300);
  restore();
  assert.equal(rows.length, 300);
  assert.ok(rows[0].t > 1e12, '時間要是毫秒，實際 ' + rows[0].t);
  assert.ok(rows[1].t > rows[0].t, '要由舊排到新');
  near(rows[1].t - rows[0].t, 240 * 60000);
  ['o', 'h', 'l', 'c', 'v'].forEach(f => assert.ok(Number.isFinite(rows[0][f]), f + ' 不是數字'));
  assert.ok(rows[0].h >= rows[0].l, '高點要 >= 低點');
});
await t('K 線的成交量取的是第 7 欄（volume），不是 vwap', async () => {
  stub(krakenHandler);
  const k = DATA.sources.find(s => s.id === 'kraken');
  const rows = await k.klines('BTCUSDT', '1h', 10);
  restore();
  near(rows[0].v, 12.5);
});
await t('四個週期都對應得到 Kraken 的 interval', async () => {
  stub(krakenHandler);
  const k = DATA.sources.find(s => s.id === 'kraken');
  for (const tf of ['15m', '1h', '4h', '1d']) {
    const rows = await k.klines('BTCUSDT', tf, 5);
    assert.ok(rows.length > 0, tf + ' 抓不到');
  }
  restore();
});
await t('行情解析：最新價、24h 高低、漲跌幅', async () => {
  stub(krakenHandler);
  const k = DATA.sources.find(s => s.id === 'kraken');
  const tk = await k.ticker('BTCUSDT');
  restore();
  near(tk.last, 80205.5);
  near(tk.high, 82000);
  near(tk.low, 78000);
  near(tk.changePct, (80205.5 - 79500) / 79500 * 100, 1e-9);
});
await t('現貨沒有資金費率，明確拋錯而不是回傳 0', async () => {
  stub(krakenHandler);
  const k = DATA.sources.find(s => s.id === 'kraken');
  await assert.rejects(() => k.funding('BTCUSDT'));
  await assert.rejects(() => k.openInterest('BTCUSDT'));
  restore();
});
await t('Kraken 回傳 error 陣列時要拋錯，不能當成空資料', async () => {
  stub(url => /kraken/.test(url) ? { error: ['EQuery:Unknown asset pair'], result: {} } : null);
  const k = DATA.sources.find(s => s.id === 'kraken');
  await assert.rejects(() => k.klines('BTCUSDT', '4h', 10), /Unknown asset pair/);
  restore();
});

console.log('\n備援鏈');
await t('Binance 與 Bybit 都掛掉時，snapshot 會落到 Kraken', async () => {
  stub(krakenHandler);
  const snap = await DATA.snapshot('BTCUSDT', ['15m', '1h', '4h', '1d'], 300);
  restore();
  assert.equal(snap.source, 'Kraken');
  ['15m', '1h', '4h', '1d'].forEach(tf =>
    assert.ok(snap.klines[tf] && snap.klines[tf].length === 300, tf + ' 沒抓到'));
  assert.ok(snap.ticker && Number.isFinite(snap.ticker.last));
  assert.equal(snap.funding, null, '現貨沒有資金費率，應該是 null 不是丟例外');
  assert.equal(snap.openInterest, null);
});
await t('全部來源都掛掉時拋出明確錯誤', async () => {
  stub(() => null);
  await assert.rejects(() => DATA.snapshot('BTCUSDT', ['4h'], 100), /所有資料來源都連不上/);
  restore();
});

console.log('\n機器人整合（真實資料流程，假的 HTTP）');
await t('從 snapshot 到決策：資料齊全就能算出動作', async () => {
  stub(krakenHandler);
  const snap = await DATA.snapshot('BTCUSDT', ['15m', '1h', '4h', '1d'], 300);
  restore();

  const cfg = BOT.defaultConfig();
  const market = {
    now: Date.now(), price: snap.ticker.last, k15: snap.klines['15m'],
    analyses: {
      d1: IND.analyze(snap.klines['1d']),
      h4: IND.analyze(snap.klines['4h']),
      m15: IND.analyze(snap.klines['15m'])
    },
    fundingRate: snap.funding ? snap.funding.rate : cfg.fundingPer8h,
    filters: cfg.filters
  };
  const r = BOT.tick(BOT.newState(cfg), market, cfg);
  assert.ok(['open', 'wait', 'blocked', 'skip'].includes(r.action.type),
    '沒預期到的動作 ' + r.action.type);
  assert.ok(Number.isFinite(r.state.equity), '權益要是數字');
  // 假資料是穩定上升，三個週期都會判多 → 應該開倉
  assert.equal(r.action.type, 'open', '穩定上升的資料應該開多，實際 ' + r.action.type +
    '（' + (r.action.reason || '') + '）');
  assert.equal(r.action.plan.side, 'long');
});
await t('沒有即時資金費率時，退回設定檔的估計值而不是當成 0', async () => {
  const cfg = BOT.defaultConfig();
  const s0 = BOT.newState(cfg);
  // 先手動建一個部位
  const withPos = BOT.apply(s0, {
    type: 'open',
    plan: { side: 'long', entry: 80000, stop: 78000, qty: 0.002, notional: 160,
            exchangeLeverage: 2, liqPrice: 40000, riskUsd: 4,
            targets: [{ r: 1.5, price: 83000 }, { r: 3, price: 86000 }] },
    why: 'test'
  }, { now: T0, fundingRate: cfg.fundingPer8h });
  const after = BOT.apply(withPos, { type: 'hold' },
    { now: T0 + 8 * 3600000 + 1, fundingRate: cfg.fundingPer8h });
  near(after.fundingPaid, 160 * cfg.fundingPer8h, 1e-9);
  assert.ok(after.fundingPaid > 0, '資金費不能是 0');
});

restore();
console.log('\n' + (fail === 0 ? `全部通過（${pass} 項）` : `${pass} 通過 / ${fail} 失敗`));
process.exit(fail === 0 ? 0 : 1);
