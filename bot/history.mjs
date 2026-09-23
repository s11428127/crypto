/*
 * bot/history.mjs —— 長歷史 K 線（回測專用）
 *
 * 為什麼另外寫：Kraken 只給最近 720 根（4H 約 120 天），剛好全落在一段行情裡，
 * 用它回測等於只看一種天氣。要看規則在多頭、空頭、盤整都站不站得住，需要好幾年。
 * Binance／Bybit 封鎖美國 IP（GitHub Actions 的機器在美國），Bitstamp 沒有，
 * 而且 OHLC 端點支援 4H（14400 秒）與日線，可以往回翻頁。
 *
 * 往回翻（用 end 參數）而不是往前翻：上市比較晚的幣，往回翻到沒資料就自然停住。
 */
const STEP = { '4h': 14400, '1d': 86400 };
const BASE = 'https://www.bitstamp.net/api/v2/ohlc/';

export function bitstampPair(sym) {
  return sym.replace(/USDT$/, '').replace(/USD$/, '').toLowerCase() + 'usd';
}

async function getJSON(url, fetchImpl) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetchImpl(url, { signal: ctl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 抓一段歷史 K 線，由舊到新，格式 { t, o, h, l, c, v }（t 為毫秒）。
 * bars：想要的根數（上市比較晚就會比較少）
 */
export async function bitstampKlines(sym, tf, bars, opts = {}) {
  const fetchImpl = opts.fetch || globalThis.fetch;
  const gap = opts.gapMs ?? 300;
  const step = STEP[tf];
  if (!step) throw new Error('不支援的週期 ' + tf);
  const pair = bitstampPair(sym);

  const byT = new Map();
  let end = Math.floor((opts.now ?? Date.now()) / 1000);
  for (let page = 0; page < 40 && byT.size < bars; page++) {
    if (page > 0 && gap) await new Promise(r => setTimeout(r, gap));
    const url = `${BASE}${pair}/?step=${step}&limit=1000&end=${end}`;
    const d = await getJSON(url, fetchImpl);
    if (d && d.status === 'error') throw new Error((d.reason && JSON.stringify(d.reason)) || 'Bitstamp 錯誤');
    const rows = (d && d.data && d.data.ohlc) || [];
    if (!rows.length) break;
    let oldest = Infinity;
    for (const r of rows) {
      const ts = +r.timestamp;
      oldest = Math.min(oldest, ts);
      byT.set(ts, { t: ts * 1000, o: +r.open, h: +r.high, l: +r.low, c: +r.close, v: +r.volume });
    }
    const next = oldest - step;
    if (!(next < end)) break;            // 沒有往回推進就停，避免無窮迴圈
    end = next;
  }

  const out = [...byT.values()].sort((a, b) => a.t - b.t);
  // 丟掉還沒收盤的最後一根：它的高低收還會變，拿來回測等於偷看
  const nowS = Math.floor((opts.now ?? Date.now()) / 1000);
  while (out.length && out[out.length - 1].t / 1000 + step > nowS) out.pop();
  return out.slice(-bars);
}

/** 回測要的兩段：4H 與日線。日線要多抓 250 根給 EMA200 暖身。 */
export async function longHistory(sym, opts = {}) {
  const years = opts.years ?? 3;
  const bars4h = Math.ceil(years * 365 * 6) + 250;
  const barsD = Math.ceil(years * 365) + 260;
  const k4 = await bitstampKlines(sym, '4h', bars4h, opts);
  const d1 = await bitstampKlines(sym, '1d', barsD, opts);
  return { k4, d1, source: 'Bitstamp' };
}
