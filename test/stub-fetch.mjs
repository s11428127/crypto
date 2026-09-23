/* 給 `node --import` 用：在載入任何程式之前換掉 fetch，餵假的 Kraken 回應。
   只在測試時透過 NODE_OPTIONS 掛上，正式程式裡沒有任何測試用的分支。 */
const T0 = Date.UTC(2026, 8, 1);
const MIN = { '15': 15, '60': 60, '240': 240, '1440': 1440 };
function ohlc(n, stepMin, start, drift) {
  const rows = []; let c = start;
  for (let i = 0; i < n; i++) {
    const o = c; c += drift;
    rows.push([Math.floor((T0 + i * stepMin * 60000) / 1000), o.toFixed(1),
      (Math.max(o, c) + 50).toFixed(1), (Math.min(o, c) - 50).toFixed(1),
      c.toFixed(1), c.toFixed(1), '12.5', 100]);
  }
  return rows;
}
globalThis.fetch = async (url) => {
  const u = String(url);
  const bad = { ok: false, status: 403, json: async () => ({}) };
  if (!/api\.kraken\.com/.test(u)) return bad;
  if (/\/0\/public\/OHLC/.test(u)) {
    const iv = new URL(u).searchParams.get('interval');
    if (!MIN[iv]) return bad;
    return { ok: true, status: 200, json: async () => ({
      error: [], result: { XXBTZUSD: ohlc(300, MIN[iv], 60000, 20), last: 1 } }) };
  }
  if (/\/0\/public\/Ticker/.test(u)) {
    return { ok: true, status: 200, json: async () => ({ error: [], result: { XXBTZUSD: {
      a: ['80210.0', '1', '1.0'], b: ['80200.0', '1', '1.0'], c: ['80205.5', '0.01'],
      v: ['100.0', '2500.0'], p: ['80100.0', '79900.0'], t: [100, 2000],
      l: ['79000.0', '78000.0'], h: ['81000.0', '82000.0'], o: '79500.0' } } }) };
  }
  return bad;
};
