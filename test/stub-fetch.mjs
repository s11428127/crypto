/* 給 `node --import` 用：在載入任何程式之前換掉 fetch，餵假的 Kraken 回應。
   只在測試時透過 NODE_OPTIONS 掛上，正式程式裡沒有任何測試用的分支。

   模仿真實 Kraken 的行為：每個週期都是「結束在現在、最多 720 根」。
   價格 = 緩升趨勢 + 大週期波動，讓回測同時出現賺與賠的單。 */
const T_END = Date.UTC(2026, 8, 23);
const MIN = { '15': 15, '60': 60, '240': 240, '1440': 1440 };
function ohlc(stepMin) {
  const n = 720, step = stepMin * 60000, rows = [];
  let prev = null;
  for (let i = 0; i < n; i++) {
    const t = T_END - (n - i) * step;
    const x = t / 86400000;                              // 以「天」為單位的時間軸
    const c = 60000 + x * 8 + 4000 * Math.sin(x / 9) + 900 * Math.sin(x / 1.7);
    const o = prev === null ? c : prev;
    const wick = 60 + stepMin * 1.2;
    rows.push([Math.floor(t / 1000), o.toFixed(1), (Math.max(o, c) + wick).toFixed(1),
      (Math.min(o, c) - wick).toFixed(1), c.toFixed(1), c.toFixed(1), '12.5', 100]);
    prev = c;
  }
  return rows;
}
/* 假的 Bitstamp：3.5 年、先漲再跌再漲，支援 end 參數往回翻頁 */
function bitstampPx(sec) {
  const d = (sec - Date.UTC(2023, 0, 1) / 1000) / 86400;
  const trend = d < 450 ? 20000 + d * 60 : d < 800 ? 47000 - (d - 450) * 50 : 29500 + (d - 800) * 55;
  return trend + 2500 * Math.sin(d / 11) + 700 * Math.sin(d / 2.1);
}
function bitstamp(u) {
  const step = +u.searchParams.get('step'), end = +u.searchParams.get('end');
  const limit = +u.searchParams.get('limit');
  const first = Date.UTC(2023, 0, 1) / 1000;
  const rows = [];
  for (let ts = Math.floor(end / step) * step; ts >= first && rows.length < limit; ts -= step) {
    const o = bitstampPx(ts), c = bitstampPx(ts + step);
    rows.push({ timestamp: String(ts), open: o.toFixed(2), close: c.toFixed(2),
      high: (Math.max(o, c) * 1.004).toFixed(2), low: (Math.min(o, c) * 0.996).toFixed(2), volume: '10' });
  }
  rows.reverse();
  return { ok: true, status: 200, json: async () => ({ data: { pair: 'X/USD', ohlc: rows } }) };
}

globalThis.fetch = async (url) => {
  const u = String(url);
  const bad = { ok: false, status: 403, json: async () => ({}) };
  if (/bitstamp\.net\/api\/v2\/ohlc/.test(u)) return bitstamp(new URL(u));
  if (!/api\.kraken\.com/.test(u)) return bad;
  if (/\/0\/public\/OHLC/.test(u)) {
    const iv = new URL(u).searchParams.get('interval');
    if (!MIN[iv]) return bad;
    return { ok: true, status: 200, json: async () => ({
      error: [], result: { XXBTZUSD: ohlc(MIN[iv]), last: 1 } }) };
  }
  if (/\/0\/public\/Ticker/.test(u)) {
    const last = ohlc(15).at(-1)[4];
    return { ok: true, status: 200, json: async () => ({ error: [], result: { XXBTZUSD: {
      a: [last, '1', '1.0'], b: [last, '1', '1.0'], c: [last, '0.01'],
      v: ['100.0', '2500.0'], p: [last, last], t: [100, 2000],
      l: ['1', '1'], h: ['1', '1'], o: last } } }) };
  }
  return bad;
};
