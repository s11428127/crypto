/* 長歷史抓取（Bitstamp）的驗算：翻頁、去重、丟掉未收盤的 K 棒、上市比較晚的幣 */
import assert from 'node:assert/strict';
import { bitstampKlines, bitstampPair } from '../bot/history.mjs';

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); }
}

const STEP4H = 14400;
const NOW = 1_790_000_000;                    // 秒
/* 假的 Bitstamp：從 listedAt 開始才有資料，每頁最多 limit 根，回傳 end 以前（含）的最後 limit 根 */
function fakeBitstamp({ listedAt = NOW - 5000 * STEP4H, step = STEP4H, log = [] } = {}) {
  return async (url) => {
    const u = new URL(url);
    log.push(u.search);
    const end = +u.searchParams.get('end');
    const limit = +u.searchParams.get('limit');
    const s = +u.searchParams.get('step');
    assert.equal(s, step, '週期參數錯誤');
    const last = Math.floor(end / step) * step;
    const rows = [];
    for (let ts = last; ts >= listedAt && rows.length < limit; ts -= step) {
      rows.push({ timestamp: String(ts), open: '100', high: '110', low: '90', close: String(100 + ts % 7), volume: '5' });
    }
    rows.reverse();
    return { ok: true, status: 200, json: async () => ({ data: { pair: 'X/USD', ohlc: rows } }) };
  };
}

console.log('\nbitstampPair');
await t('BTCUSDT → btcusd', () => assert.equal(bitstampPair('BTCUSDT'), 'btcusd'));
await t('DOGEUSDT → dogeusd（Bitstamp 不用 XDG 那種舊代號）', () => assert.equal(bitstampPair('DOGEUSDT'), 'dogeusd'));

console.log('\nbitstampKlines');
await t('往回翻頁湊滿指定根數，由舊到新、沒有重複', async () => {
  const log = [];
  const k = await bitstampKlines('BTCUSDT', '4h', 2500, { fetch: fakeBitstamp({ log }), gapMs: 0, now: NOW * 1000 });
  assert.equal(k.length, 2500);
  assert.ok(log.length >= 3, '應該要翻至少 3 頁，實際 ' + log.length);
  for (let i = 1; i < k.length; i++) {
    assert.equal(k[i].t - k[i - 1].t, STEP4H * 1000, '第 ' + i + ' 根間隔不對（有缺或重複）');
  }
});
await t('時間轉成毫秒、數字欄位都是 number', async () => {
  const k = await bitstampKlines('BTCUSDT', '4h', 10, { fetch: fakeBitstamp(), gapMs: 0, now: NOW * 1000 });
  assert.ok(k[0].t > 1e12);
  ['o', 'h', 'l', 'c', 'v'].forEach(f => assert.equal(typeof k[0][f], 'number'));
});
await t('還沒收盤的最後一根要丟掉（不然回測等於偷看）', async () => {
  // now 落在某根 4H 的中間 → 那一根還沒收盤
  const mid = (Math.floor(NOW / STEP4H) * STEP4H + 3600) * 1000;
  const k = await bitstampKlines('BTCUSDT', '4h', 50, { fetch: fakeBitstamp(), gapMs: 0, now: mid });
  const last = k[k.length - 1];
  assert.ok(last.t / 1000 + STEP4H <= mid / 1000, '最後一根應該已經收盤');
});
await t('上市比較晚的幣：翻到沒資料就停，不會無窮迴圈', async () => {
  const listedAt = NOW - 1500 * STEP4H;
  const log = [];
  const k = await bitstampKlines('SOLUSDT', '4h', 6000, { fetch: fakeBitstamp({ listedAt, log }), gapMs: 0, now: NOW * 1000 });
  assert.ok(k.length <= 1501 && k.length >= 1499, '應該只有上市以來的 ~1500 根，實際 ' + k.length);
  assert.ok(log.length <= 4, '翻頁次數不該失控，實際 ' + log.length);
});
await t('Bitstamp 回傳錯誤時要拋錯，不能當成空資料', async () => {
  const bad = async () => ({ ok: true, status: 200, json: async () => ({ status: 'error', reason: { pair: 'unknown' } }) });
  await assert.rejects(() => bitstampKlines('XXXUSDT', '4h', 10, { fetch: bad, gapMs: 0 }), /unknown/);
});
await t('HTTP 失敗要拋錯', async () => {
  const bad = async () => ({ ok: false, status: 404, json: async () => ({}) });
  await assert.rejects(() => bitstampKlines('BTCUSDT', '1d', 10, { fetch: bad, gapMs: 0 }), /HTTP 404/);
});
await t('日線用 86400 秒的週期', async () => {
  const k = await bitstampKlines('BTCUSDT', '1d', 20,
    { fetch: fakeBitstamp({ step: 86400, listedAt: NOW - 3000 * 86400 }), gapMs: 0, now: NOW * 1000 });
  assert.equal(k[1].t - k[0].t, 86400000);
});

console.log('\n' + (fail === 0 ? `全部通過（${pass} 項）` : `${pass} 通過 / ${fail} 失敗`));
process.exit(fail === 0 ? 0 : 1);
