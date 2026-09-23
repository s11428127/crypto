/* 端對端測試用的模擬行情。這台機器連不到交易所，所以攔截請求自己餵。 */
export function klines(n, tfMs, start, drift, wob, seed = 1) {
  const rows = []; let c = start, s = seed >>> 0 || 1;
  const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296 - 0.5; };
  const t0 = Math.floor((Date.now() - n * tfMs) / 86400000) * 86400000;
  for (let i = 0; i < n; i++) {
    const o = c;
    c = c + drift + rnd() * wob;
    const h = Math.max(o, c) + Math.abs(rnd()) * wob;
    const l = Math.min(o, c) - Math.abs(rnd()) * wob;
    rows.push([t0 + i * tfMs, o.toFixed(1), h.toFixed(1), l.toFixed(1), c.toFixed(1),
               (50 + Math.abs(rnd()) * 100).toFixed(3), t0 + (i + 1) * tfMs - 1,
               '0', 0, '0', '0', '0']);
  }
  return rows;
}

const M15 = 9e5, H1 = 36e5, H4 = 144e5, D1 = 864e5;
export const TF = {
  '15m': klines(300, M15, 78000, 10, 60, 7),
  '1h':  klines(300, H1, 74000, 25, 120, 11),
  '4h':  klines(1500, H4, 30000, 35, 260, 13),
  '1d':  klines(1000, D1, 8000, 75, 700, 17)
};
export const LAST = +TF['15m'][TF['15m'].length - 1][4];

const SYMS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT',
              'BNBUSDT', 'ADAUSDT', 'LINKUSDT', 'AVAXUSDT', 'TONUSDT'];

export async function mockBinance(page, opts = {}) {
  await page.route('**/fapi/v1/klines*', route => {
    const u = new globalThis.URL(route.request().url());
    const tf = u.searchParams.get('interval');
    const limit = parseInt(u.searchParams.get('limit'), 10) || 300;
    const rows = (TF[tf] || []).slice(-limit);
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) });
  });

  await page.route('**/fapi/v1/ticker/24hr*', route => {
    const u = new globalThis.URL(route.request().url());
    if (u.searchParams.get('symbol')) {
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ lastPrice: String(LAST), priceChangePercent: '2.35',
          highPrice: String(LAST * 1.02), lowPrice: String(LAST * 0.97),
          volume: '48213.5', quoteVolume: '3821345678.1' }) });
    }
    // 全市場：篩選器用
    const all = SYMS.map((s, i) => ({
      symbol: s, lastPrice: String(1000 - i * 50),
      priceChangePercent: String((i % 5) * 2.5 - 4),
      quoteVolume: String(5e9 / (i + 1))
    }));
    all.push({ symbol: 'TINYUSDT', lastPrice: '1', priceChangePercent: '1', quoteVolume: '1000' });
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(all) });
  });

  await page.route('**/fapi/v1/premiumIndex*', route => {
    const u = new globalThis.URL(route.request().url());
    if (u.searchParams.get('symbol')) {
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ markPrice: String(LAST + 3), indexPrice: String(LAST),
          lastFundingRate: String(opts.funding ?? 0.00082),
          nextFundingTime: String(Date.now() + 3.5 * 3600e3) }) });
    }
    route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify(SYMS.map((s, i) => ({ symbol: s, lastFundingRate: String((i - 4) * 0.0003) }))) });
  });

  await page.route('**/fapi/v1/openInterest*', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ openInterest: '81234.5', time: String(Date.now()) })
  }));

  // exchangeInfo 回全部的幣：BTC 的最小名目高（$100），山寨低（$5）——
  // 這個差異正是小資金帳戶「BTC 做不細、山寨做得細」的來源
  await page.route('**/fapi/v1/exchangeInfo*', route => {
    const syms = SYMS.map((s, i) => ({
      symbol: s, pricePrecision: 2,
      filters: s === 'BTCUSDT'
        ? [{ filterType: 'LOT_SIZE', minQty: '0.001', stepSize: '0.001' },
           { filterType: 'MIN_NOTIONAL', notional: '100' }]
        : [{ filterType: 'LOT_SIZE', minQty: '0.01', stepSize: '0.01' },
           { filterType: 'MIN_NOTIONAL', notional: '5' }]
    }));
    route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ symbols: syms }) });
  });

  await page.route('**/api.bybit.com/**', route => route.abort());
}
