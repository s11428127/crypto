/*
 * 主控台的端對端檢查。
 * 這台機器連不到交易所，所以用 Playwright 攔截請求餵模擬行情，
 * 驗證「抓資料 → 算指標 → 出計畫 → 畫圖」整條流程。
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const WIDTHS = [320, 390, 680, 1180];
const PAGE = 'http://127.0.0.1:8099/index.html';

/* 造一段上升趨勢的 K 線，讓計畫卡走到「做多」分支 */
function klines(n, tfMs, start, drift, wob, seed = 1) {
  const rows = [];
  let c = start, s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.5;
  const t0 = Date.now() - n * tfMs;
  for (let i = 0; i < n; i++) {
    const o = c;
    c = c + drift + rnd() * wob;
    const h = Math.max(o, c) + Math.abs(rnd()) * wob;
    const l = Math.min(o, c) - Math.abs(rnd()) * wob;
    rows.push([t0 + i * tfMs, o.toFixed(1), h.toFixed(1), l.toFixed(1), c.toFixed(1),
               (50 + Math.abs(rnd()) * 100).toFixed(3),
               t0 + (i + 1) * tfMs - 1, '0', 0, '0', '0', '0']);
  }
  return rows;
}

const TF = {
  '15m': klines(300, 9e5, 78000, 10, 60, 7),
  '1h':  klines(300, 36e5, 74000, 25, 120, 11),
  '4h':  klines(300, 144e5, 66000, 55, 260, 13),
  '1d':  klines(300, 864e5, 42000, 140, 700, 17)
};
const LAST = +TF['15m'][299][4];

async function mock(page) {
  await page.route('**/fapi/v1/klines*', route => {
    const tf = new URL(route.request().url()).searchParams.get('interval');
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(TF[tf] || []) });
  });
  await page.route('**/fapi/v1/ticker/24hr*', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ lastPrice: String(LAST), priceChangePercent: '2.35',
      highPrice: String(LAST * 1.02), lowPrice: String(LAST * 0.97),
      volume: '48213.5', quoteVolume: '3821345678.1' })
  }));
  await page.route('**/fapi/v1/premiumIndex*', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ markPrice: String(LAST + 3), indexPrice: String(LAST),
      lastFundingRate: '0.00082', nextFundingTime: String(Date.now() + 3.5 * 3600e3) })
  }));
  await page.route('**/fapi/v1/openInterest*', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ openInterest: '81234.5', time: String(Date.now()) })
  }));
  await page.route('**/fapi/v1/exchangeInfo*', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ symbols: [{ symbol: 'BTCUSDT', pricePrecision: 1, filters: [
      { filterType: 'LOT_SIZE', minQty: '0.001', stepSize: '0.001' },
      { filterType: 'MIN_NOTIONAL', notional: '100' }] }] })
  }));
  // Bybit 備援不該被用到（Binance 都成功），若被打就讓它失敗以便發現問題
  await page.route('**/api.bybit.com/**', route => route.abort());
}

let failures = 0;
const browser = await chromium.launch();

for (const w of WIDTHS) {
  const ctx = await browser.newContext({ viewport: { width: w, height: 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errs = [];
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const txt = m.text();
    // WebSocket 在這個環境本來就連不出去，退回輪詢是預期行為
    if (/websocket|wss:|ERR_|net::/i.test(txt)) return;
    errs.push(txt);
  });
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));

  await mock(page);
  await page.goto(PAGE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => {
    const t = document.getElementById('px-last');
    return t && t.textContent.trim() !== '—';
  }, { timeout: 15000 });
  await page.waitForTimeout(600);

  const bad = [];

  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (overflow > 0) bad.push(`水平溢出 ${overflow}px`);

  const price = (await page.locator('#px-last').innerText()).trim();
  if (!/^[\d,]+\.?\d*$/.test(price)) bad.push('價格沒顯示: ' + price);

  const src = (await page.locator('#src-name').innerText()).trim();
  if (src !== 'Binance') bad.push('資料來源不是 Binance: ' + src);

  const side = (await page.locator('.plan-side').innerText()).trim();
  if (!/LONG|SHORT|WAIT/.test(side)) bad.push('計畫卡沒有方向: ' + side);

  // 進場區間必須以畫面上顯示的價格為中心 —— 不能拿幾小時前的 4H 收盤價當進場價
  if (side.includes('LONG') || side.includes('SHORT')) {
    const zone = (await page.locator('.prow').first().locator('.v').innerText()).trim();
    const m = zone.match(/([\d,]+\.?\d*)\s*~\s*([\d,]+\.?\d*)/);
    if (!m) bad.push('進場區間格式不對: ' + zone);
    else {
      const lo = +m[1].replace(/,/g, ''), hi = +m[2].replace(/,/g, '');
      const shown = +price.replace(/,/g, '');
      if (!(shown >= lo && shown <= hi)) {
        bad.push(`進場區間 ${lo}~${hi} 沒包住顯示價格 ${shown}（可能用了過期的收盤價）`);
      }
    }
  }

  // 指標列有算出實際數字
  const rsi = (await page.locator('#ind-row > div').first().locator('.v').innerText()).trim();
  if (!/^\d+\.\d$/.test(rsi)) bad.push('RSI 沒算出來: ' + rsi);

  // 三個時間框架都有判讀
  const mtfCount = await page.locator('#mtf .tf').count();
  if (mtfCount !== 3) bad.push('多框架區塊數量錯誤: ' + mtfCount);

  // 資金費率 0.082% 屬於擁擠，方向做多時應該出現警告
  const warnTxt = await page.locator('#warnings').innerText();
  if (side.includes('LONG') && !/資金費率/.test(warnTxt)) bad.push('擁擠的資金費率沒有觸發警告');

  // 畫布真的有畫東西（不是一片空白）
  const painted = await page.evaluate(() => {
    const c = document.getElementById('chart');
    if (!c || !c.width || !c.height) return -1;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const set = new Set();
    for (let i = 0; i < d.length; i += 4 * 97) set.add(`${d[i]},${d[i+1]},${d[i+2]},${d[i+3]}`);
    return set.size;
  });
  if (painted < 5) bad.push('K 線圖沒畫出內容（色彩數 ' + painted + '）');

  // 切換週期後圖與指標要跟著變
  const rsiBefore = rsi;
  await page.locator('#tfbar button[data-tf="1d"]').click();
  await page.waitForTimeout(300);
  const rsiAfter = (await page.locator('#ind-row > div').first().locator('.v').innerText()).trim();
  if (rsiAfter === rsiBefore) bad.push('切換到 1D 後指標沒變');
  await page.locator('#tfbar button[data-tf="4h"]').click();
  await page.waitForTimeout(200);

  // 改槓桿要即時反映在爆倉價上
  const liqBefore = await page.locator('.prow.liq .v').innerText().catch(() => null);
  await page.fill('#p-lev', '3');
  await page.waitForTimeout(250);
  const liqAfter = await page.locator('.prow.liq .v').innerText().catch(() => null);
  if (liqBefore && liqAfter === liqBefore) bad.push('改槓桿後爆倉價沒變');
  await page.fill('#p-lev', '20');
  await page.waitForTimeout(200);

  // 主題切換不能丟例外，且圖要重畫
  await page.click('#theme-toggle'); await page.waitForTimeout(250);
  await page.click('#theme-toggle'); await page.waitForTimeout(250);

  if (errs.length) bad.push('console: ' + errs.join(' | '));

  if (bad.length) { failures++; console.log(`✗ ${w}px  ` + bad.join('；')); }
  else console.log(`✓ ${w}px  價格=${price} 方向=${side} RSI=${rsi} 色彩數=${painted}`);

  await page.screenshot({ path: `/tmp/dash-${w}.png` });
  await ctx.close();
}

/* 全部來源失敗時要顯示明確錯誤，不能白畫面 */
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', e => { console.log('✗ 離線情境 pageerror: ' + e.message); failures++; });
  await page.route('**/fapi/**', r => r.abort());
  await page.route('**/api.bybit.com/**', r => r.abort());
  await page.goto(PAGE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  const warn = await page.locator('#warnings').innerText();
  if (/抓不到行情/.test(warn)) console.log('✓ 全部來源失敗時顯示明確錯誤，不是白畫面');
  else { failures++; console.log('✗ 離線時沒有顯示錯誤訊息，實際內容: ' + warn.slice(0, 80)); }
  await ctx.close();
}

/* Binance 失敗時應自動退到 Bybit */
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 900 } });
  const page = await ctx.newPage();
  await page.route('**/fapi/**', r => r.abort());
  await page.route('**/v5/market/kline*', route => {
    const iv = new URL(route.request().url()).searchParams.get('interval');
    const map = { '15': '15m', '60': '1h', '240': '4h', 'D': '1d' };
    const rows = (TF[map[iv]] || []).map(r => [String(r[0]), r[1], r[2], r[3], r[4], r[5], '0']).reverse();
    route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ result: { list: rows } }) });
  });
  await page.route('**/v5/market/tickers*', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ result: { list: [{ lastPrice: String(LAST), price24hPcnt: '0.0235',
      highPrice24h: String(LAST * 1.02), lowPrice24h: String(LAST * 0.97),
      volume24h: '48213', turnover24h: '3821345678', markPrice: String(LAST + 2),
      indexPrice: String(LAST), fundingRate: '0.0001',
      nextFundingTime: String(Date.now() + 3600e3), openInterest: '81234' }] } })
  }));
  await page.route('**/v5/market/instruments-info*', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ result: { list: [{ lotSizeFilter:
      { minOrderQty: '0.001', qtyStep: '0.001', minNotionalValue: '5' } }] } })
  }));
  await page.goto(PAGE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() =>
    document.getElementById('src-name').textContent.trim() === 'Bybit', { timeout: 15000 })
    .then(() => console.log('✓ Binance 掛掉時自動切到 Bybit'))
    .catch(async () => {
      failures++;
      console.log('✗ 備援沒生效，來源顯示為 ' +
        (await page.locator('#src-name').innerText()));
    });
  await ctx.close();
}

/* 只有 K 線、沒有 ticker：不能白畫面，也不能丟例外
   （isFinite(null) === true 的陷阱曾讓價格與 K 線圖整個掛掉） */
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 900 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  // Playwright 後註冊的 route 優先，所以攔截全部在前、K 線放行在後
  await page.route('**/fapi/**', r => r.abort());
  await page.route('**/api.bybit.com/**', r => r.abort());
  await page.route('**/fapi/v1/klines*', route => {
    const tf = new globalThis.URL(route.request().url()).searchParams.get('interval');
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(TF[tf] || []) });
  });
  await page.goto(PAGE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  const px = (await page.locator('#px-last').innerText()).trim();
  const bad = [];
  if (errs.length) bad.push('pageerror: ' + errs.join(' | '));
  if (!/^[\d,]+\.?\d*$/.test(px)) bad.push('沒有 ticker 時價格應退回最後收盤價，實際顯示 ' + px);
  const painted = await page.evaluate(() => {
    const c = document.getElementById('chart');
    if (!c || !c.width) return -1;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const set = new Set();
    for (let i = 0; i < d.length; i += 4 * 97) set.add(`${d[i]},${d[i+1]},${d[i+2]},${d[i+3]}`);
    return set.size;
  });
  if (painted < 5) bad.push('沒有 ticker 時 K 線圖沒畫出來');
  if (bad.length) { failures++; console.log('✗ 只有 K 線沒有 ticker：' + bad.join('；')); }
  else console.log('✓ 只有 K 線、沒有 ticker 時仍正常顯示（價格 ' + px + '）');
  await ctx.close();
}

await browser.close();
console.log(failures === 0 ? '\n主控台全部通過' : `\n${failures} 項失敗`);
process.exit(failures ? 1 : 0);
