/* 篩選器 / 模擬回測 / 交易日誌 三頁的端對端檢查 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { mockBinance } from './mock.mjs';

const BASE = 'http://127.0.0.1:8099/';
const WIDTHS = [320, 390, 680, 1180];
let failures = 0;
const browser = await chromium.launch();

function collectErrors(page, errs) {
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/websocket|wss:|ERR_|net::/i.test(t)) return;   // WS 在此環境本來就連不出去
    errs.push(t);
  });
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
}
async function overflow(page) {
  return page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
}
async function painted2(page, id) {
  return page.evaluate(sel => {
    const c = document.getElementById(sel);
    if (!c || !c.width || !c.height) return -1;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const set = new Set();
    for (let i = 0; i < d.length; i += 4 * 97) set.add(`${d[i]},${d[i+1]},${d[i+2]},${d[i+3]}`);
    return set.size;
  }, id);
}
async function painted(page, id) {
  return page.evaluate(sel => {
    const c = document.getElementById(sel);
    if (!c || !c.width || !c.height) return -1;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const set = new Set();
    for (let i = 0; i < d.length; i += 4 * 97) set.add(`${d[i]},${d[i+1]},${d[i+2]},${d[i+3]}`);
    return set.size;
  }, id);
}
function report(label, bad) {
  if (bad.length) { failures++; console.log('✗ ' + label + '  ' + bad.join('；')); }
  else console.log('✓ ' + label);
}

/* ═══ 模擬頁 ═══ */
for (const w of WIDTHS) {
  const ctx = await browser.newContext({ viewport: { width: w, height: 1000 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errs = []; collectErrors(page, errs);
  await mockBinance(page);
  await page.goto(BASE + 'sim.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(700);

  const bad = [];
  const of1 = await overflow(page);
  if (of1 > 0) bad.push('水平溢出 ' + of1 + 'px');

  // $100 / 想冒 1% → 應該被最小下單量頂上去並出現警告
  const sizing = await page.locator('#sizing-box').innerText();
  if (!/做不到你想要的風險/.test(sizing)) bad.push('$100 應該觸發「做不到 1% 風險」的警告');
  const actual = sizing.match(/(\d+\.\d+)%/g);
  if (!actual) bad.push('沒有顯示實際風險 %');

  const median = (await page.locator('#sim-out > div').nth(1).locator('.v').innerText()).trim();
  if (!/^\$[\d,]+$/.test(median)) bad.push('中位數沒算出來: ' + median);

  const hist = await painted(page, 'sim-hist');
  if (hist < 4) bad.push('分布圖沒畫出內容（色彩數 ' + hist + '）');

  // 改勝率，結果要跟著變
  await page.fill('#s-win', '60');
  await page.waitForTimeout(400);
  const median2 = (await page.locator('#sim-out > div').nth(1).locator('.v').innerText()).trim();
  if (median2 === median) bad.push('提高勝率後中位數沒變');
  await page.fill('#s-win', '45');

  // 負期望值要跳紅字
  await page.fill('#s-win', '30'); await page.fill('#s-rr', '1');
  await page.waitForTimeout(400);
  const warn = await page.locator('#sim-warn').innerText();
  if (!/負期望值/.test(warn)) bad.push('負期望值的組合沒有跳警告');
  await page.fill('#s-win', '45'); await page.fill('#s-rr', '2');
  await page.waitForTimeout(300);

  // 大本金不該被最小下單量卡住
  await page.fill('#s-equity', '20000');
  await page.waitForTimeout(400);
  const big = await page.locator('#sizing-box').innerText();
  if (/做不到你想要的風險/.test(big)) bad.push('$20000 不該被最小下單量頂上去');
  await page.fill('#s-equity', '100');
  await page.waitForTimeout(300);

  // 回測
  await page.click('#run-bt');
  await page.waitForFunction(() => {
    const el = document.querySelector('#bt-out > div');
    return el && el.querySelector('.v') && el.querySelector('.v').textContent.trim() !== '';
  }, { timeout: 30000 }).catch(() => bad.push('回測沒有產出結果'));
  await page.waitForTimeout(400);

  const btWarn = await page.locator('#bt-warn').innerText().catch(() => '');
  const btOut = await page.locator('#bt-out').innerText().catch(() => '');
  if (!/最終權益/.test(btOut)) bad.push('回測結果缺少「最終權益」');
  // 模擬資料是純上升趨勢，勝率會接近 100% —— 這種數字必須跳合理性警告
  const wr = parseFloat((btOut.match(/勝率\s*\n?\s*([\d.]+)%/) || [])[1]);
  if (isFinite(wr) && wr >= 90 && !/高得不合理/.test(btWarn)) {
    bad.push('勝率 ' + wr + '% 沒有觸發合理性警告');
  }
  const curve = await painted(page, 'bt-curve');
  if (curve < 3) bad.push('權益曲線沒畫出來（色彩數 ' + curve + '）');

  const of2 = await overflow(page);
  if (of2 > 0) bad.push('回測後水平溢出 ' + of2 + 'px');
  if (errs.length) bad.push('console: ' + errs.join(' | '));

  report(`sim.html ${w}px`, bad);
  if (w === 390) await page.screenshot({ path: '/tmp/p-sim.png' });
  await ctx.close();
}

/* ═══ 篩選器 ═══ */
for (const w of [320, 390, 1180]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: 1000 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errs = []; collectErrors(page, errs);
  await mockBinance(page);
  await page.goto(BASE + 'screener.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(300);

  const bad = [];
  await page.click('#run-scan');
  await page.waitForFunction(() =>
    !document.getElementById('run-scan').disabled, { timeout: 40000 })
    .catch(() => bad.push('掃描沒有結束'));
  await page.waitForTimeout(500);

  const status = await page.locator('#sc-status').innerText();
  if (!/掃描 \d+ 個幣/.test(status)) bad.push('掃描狀態不對: ' + status);

  const longRows = await page.locator('#longs tbody tr').count();
  const shortRows = await page.locator('#shorts tbody tr').count();
  if (longRows + shortRows === 0) bad.push('兩張清單都是空的');

  // 量太小的幣要被剔除
  const all = (await page.locator('#longs').innerText()) + (await page.locator('#shorts').innerText());
  if (/TINY/.test(all)) bad.push('成交量過低的幣不該進榜');

  // 每一列都要有可執行的價位與賺賠金額
  if (longRows + shortRows > 0) {
    const target = longRows > 0 ? '#longs tbody tr' : '#shorts tbody tr';
    const cells = await page.locator(target).first().locator('td').allInnerTexts();
    const [, , feas, entry, stop, tp1, tp2, loss, win, notional, lev] = cells;
    if (!/可做|風險被頂高|超過槓桿上限|風險過大/.test(feas)) bad.push('可行性欄位不對: ' + feas);
    if (!/[\d,]/.test(entry)) bad.push('沒有進場價: ' + entry);
    if (!/[\d,]/.test(stop)) bad.push('沒有止損價: ' + stop);
    if (!/^−\$[\d.,]+$/.test(loss)) bad.push('沒有顯示會虧幾 U: ' + loss);
    if (!/^\+\$[\d.,]+$/.test(win)) bad.push('沒有顯示會賺幾 U: ' + win);
    if (!/^\$[\d.,]+$/.test(notional)) bad.push('沒有顯示名目: ' + notional);
    // 交易所最低只能設 1 倍，這欄永遠不該出現 0.xx
    if (!/^\d+x$/.test(lev)) bad.push('設定槓桿必須是整數倍率: ' + lev);
    if (parseInt(lev, 10) < 1) bad.push('設定槓桿不該小於 1x: ' + lev);

    // TP1 的獲利金額必須是停損金額的 1.5 倍
    const lossN = parseFloat(loss.replace(/[−$,]/g, ''));
    const winN = parseFloat(win.replace(/[+$,]/g, ''));
    if (isFinite(lossN) && isFinite(winN) && lossN > 0) {
      const ratio = winN / lossN;
      if (Math.abs(ratio - 1.5) > 0.06) bad.push('TP1 應該是 1.5R，實際比值 ' + ratio.toFixed(2));
    }

    // 點開要看到完整計畫與評分理由
    await page.locator(target).first().click();
    await page.waitForTimeout(300);
    const d = await page.locator('#detail').innerText();
    if (!/完整計畫/.test(d)) bad.push('點選後沒有顯示完整計畫');
    if (!/爆倉價/.test(d)) bad.push('完整計畫缺少爆倉價');
    if (!/評分細項/.test(d)) bad.push('點選後沒有顯示評分理由');
    if (!/資金費率|趨勢/.test(d)) bad.push('評分理由缺少項目');
  }

  // 槓桿上限調低，原本開得起來的要變成開不起來（BTC 最小名目 $100）
  await page.fill('#sc-lev', '1');
  await page.waitForTimeout(400);
  const afterLev = (await page.locator('#longs').innerText()) + (await page.locator('#shorts').innerText());
  if (!/超過槓桿上限/.test(afterLev)) {
    bad.push('槓桿上限降到 1x 時，應該有幣變成「超過槓桿上限」');
  }
  await page.fill('#sc-lev', '5');
  await page.waitForTimeout(400);

  const of1 = await overflow(page);
  if (of1 > 0) bad.push('水平溢出 ' + of1 + 'px');
  if (errs.length) bad.push('console: ' + errs.join(' | '));
  report(`screener.html ${w}px`, bad);
  if (w === 390) await page.screenshot({ path: '/tmp/p-screener.png' });
  await ctx.close();
}

/* ═══ 交易日誌 ═══ */
for (const w of [320, 390, 1180]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: 1000 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errs = []; collectErrors(page, errs);
  page.on('dialog', d => d.accept());
  await page.goto(BASE + 'journal.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(300);

  const bad = [];
  if (!/還沒有紀錄/.test(await page.locator('#list').innerText())) bad.push('空狀態沒有提示');

  // 做多 100 → 止損 90 → 出場 120 = +2R
  async function add(side, entry, stop, exit) {
    await page.selectOption('#j-side', side);
    await page.fill('#j-entry', String(entry));
    await page.fill('#j-stop', String(stop));
    await page.fill('#j-exit', String(exit));
    await page.click('#add');
    await page.waitForTimeout(150);
  }
  await add('long', 100, 90, 120);
  let firstR = await page.locator('#list tbody tr').first().locator('td').nth(6).innerText();
  if (firstR.trim() !== '+2.00R') bad.push('R 值算錯: ' + firstR);

  await add('long', 100, 90, 90);    // -1R
  await add('short', 100, 110, 80);  // +2R
  await add('long', 100, 90, 90);    // -1R

  const stats = await page.locator('#stats').innerText();
  if (!/50\.0%/.test(stats)) bad.push('勝率應該是 50.0%，實際: ' + stats.replace(/\n/g, ' '));
  if (!/\+2\.00 R/.test(stats)) bad.push('總計應該是 +2.00 R');
  if (!/未滿 30 筆/.test(stats)) bad.push('應該標記樣本不足');

  const rc = await painted(page, 'rcurve');
  if (rc < 3) bad.push('R 曲線沒畫出來（色彩數 ' + rc + '）');

  // 不合理的輸入要被擋：做多但止損放在進場價上方
  await add('long', 100, 110, 120);
  const fw = await page.locator('#form-warn').innerText();
  if (!/做多的止損/.test(fw)) bad.push('不合理的止損沒有被擋下');
  if (await page.locator('#list tbody tr').count() !== 4) bad.push('被擋下的輸入不該進列表');

  // 重新整理後紀錄要還在（localStorage）
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(400);
  if (await page.locator('#list tbody tr').count() !== 4) bad.push('重新整理後紀錄不見了');

  // 刪除
  await page.locator('#list tbody tr').first().locator('button[data-del]').click();
  await page.waitForTimeout(300);
  if (await page.locator('#list tbody tr').count() !== 3) bad.push('刪除沒有生效');

  const of1 = await overflow(page);
  if (of1 > 0) bad.push('水平溢出 ' + of1 + 'px');
  if (errs.length) bad.push('console: ' + errs.join(' | '));
  report(`journal.html ${w}px`, bad);
  if (w === 390) await page.screenshot({ path: '/tmp/p-journal.png' });
  await ctx.close();
}

/* ═══ 機器人檢視頁 ═══ */
function fakeState(nTrades) {
  const start = 100, syms = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
  let eq = start, t0 = Date.UTC(2026, 8, 1), curve = [], trades = [], notes = [];
  for (let i = 0; i < nTrades; i++) {
    const win = i % 3 !== 0;                       // 勝率約 67%
    const risk = eq * 0.01;
    const pnl = win ? risk * 1.45 : -risk * 1.03;
    eq += pnl;
    const sym = syms[i % 3];
    const openedAt = t0 + i * 6 * 3600e3;
    trades.push({ symbol: sym, openedAt, closedAt: openedAt + 4 * 3600e3, side: i % 2 ? 'short' : 'long',
      entry: 80000 + i * 10, stop: 79000 + i * 10, tp: 81500 + i * 10,
      exit: win ? 81500 + i * 10 : 79000 + i * 10, qty: 0.002, notional: 160,
      pnl, r: pnl / risk, funding: 0.01, why: win ? 'tp' : 'stop', equityAfter: eq });
    curve.push({ t: openedAt, equity: eq, open: i % 4 === 0 ? 1 : 0 });
    notes.unshift({ t: openedAt, kind: win ? 'win' : 'loss', symbol: sym,
      text: sym.replace('USDT', '') + (win ? ' 止盈出場' : ' 止損出場') });
  }
  return {
    version: 2,
    config: { symbols: syms, startEquity: start, riskPct: 1, maxRiskPct: 5, maxPositions: 3,
              maxLeverage: 5, feeRate: 0.00045, fundingPer8h: 0.0001, rMultiples: [1.5, 3],
              filters: { '*': { minQty: 0, stepSize: 0, minNotional: 5 } } },
    equity: eq,
    positions: {
      ETHUSDT: { symbol: 'ETHUSDT', side: 'long', entry: 3000, stop: 2940, tp: 3090, qty: 0.3,
                 notional: 900, exchangeLeverage: 1, liqPrice: 0, riskUsd: 1.2, entryFee: 0.4,
                 openedAt: t0 + nTrades * 6 * 3600e3, nextFundingAt: t0 + nTrades * 6 * 3600e3 + 8 * 3600e3,
                 why: '日線與 4H 同為多頭；15m 同步轉強' }
    },
    status: {
      BTCUSDT: { t: Date.now(), type: 'wait', reason: '15m 仍在回落，等止跌再進，不要接刀' },
      ETHUSDT: { t: Date.now(), type: 'hold', reason: '續抱' },
      SOLUSDT: { t: Date.now(), type: 'blocked', reason: '加上這筆，帳戶總名目會超過 5 倍權益' }
    },
    trades, curve, notes,
    feesPaid: 1.4, fundingPaid: 0.6, ticks: nTrades * 6,
    lastTick: Date.now() - 20 * 60000,
    createdAt: t0
  };
}

function fakeBacktest() {
  const mkRow = (symbol, n, winRate, avgR) => ({ symbol, n, winRate, avgR, totalR: avgR * n,
    returnPct: avgR * n, maxDD: 6.2, profitFactor: avgR > 0 ? 1.2 : 0.8, maxLossStreak: 5,
    from: Date.UTC(2026, 5, 28), to: Date.UTC(2026, 8, 23), trades: [] });
  return {
    generatedAt: Date.now() - 3600e3, source: 'Kraken',
    pooled: { n: 60, winRate: 40, avgR: -0.047, totalR: -2.8, profitFactor: 0.91,
              maxLossStreak: 9, maxDDR: 12.5 },
    symbols: [mkRow('BTCUSDT', 27, 29.6, -0.376), mkRow('AVAXUSDT', 17, 52.9, 0.309),
              { symbol: 'DOTUSDT', error: 'EQuery:Unknown asset pair' }]
  };
}

for (const w of [320, 390, 1180]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: 1000 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errs = []; collectErrors(page, errs);
  const st = fakeState(35);
  await page.route('**/bot/state.json*', r => r.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(st) }));
  await page.route('**/bot/backtest.json*', r => r.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(fakeBacktest()) }));
  await page.goto(BASE + 'bot.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() =>
    document.querySelector('#stats > div'), { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(600);

  const bad = [];
  const stats = await page.locator('#stats').innerText();
  if (!/交易筆數/.test(stats)) bad.push('沒有顯示統計');
  if (!/35/.test(stats)) bad.push('交易筆數不對: ' + stats.replace(/\n/g, ' ').slice(0, 80));
  if (!/樣本足夠/.test(stats)) bad.push('35 筆應該標記樣本足夠');

  const posRows = await page.locator('#positions tbody tr').count();
  if (posRows !== 1) bad.push('持倉表應該有 1 列，實際 ' + posRows);
  const statusTxt = await page.locator('#status').innerText();
  if (!/觀望/.test(statusTxt) || !/持倉中/.test(statusTxt) || !/不做/.test(statusTxt)) {
    bad.push('各幣狀態沒有正確顯示');
  }
  const btTxt = await page.locator('#bt-pool').innerText();
  if (!/合計成交/.test(btTxt) || !/-0\.047 R/.test(btTxt)) bad.push('回測合計沒顯示: ' + btTxt.slice(0, 60));
  const btRows = await page.locator('#bt-table tbody tr').count();
  if (btRows !== 3) bad.push('回測表應該有 3 列，實際 ' + btRows);
  if (!/Unknown asset pair/.test(await page.locator('#bt-table').innerText())) {
    bad.push('回測失敗的幣沒有顯示原因');
  }

  const tradeRows = await page.locator('#trades tbody tr').count();
  if (tradeRows === 0) bad.push('成交紀錄是空的');

  const painted = await painted2(page, 'curve');
  if (painted < 4) bad.push('權益曲線沒畫出來（色彩數 ' + painted + '）');

  const of1 = await overflow(page);
  if (of1 > 0) bad.push('水平溢出 ' + of1 + 'px');
  // 五個分頁要能一行放完，不該需要橫捲才看得到最後一個
  const navScroll = await page.evaluate(() => {
    const n = document.querySelector('.nav');
    return n ? n.scrollWidth - n.clientWidth : 0;
  });
  if (navScroll > 0) bad.push('導覽列放不下，需要橫捲 ' + navScroll + 'px');
  if (errs.length) bad.push('console: ' + errs.join(' | '));
  report(`bot.html ${w}px`, bad);
  if (w === 390) await page.screenshot({ path: '/tmp/p-bot.png' });
  await ctx.close();
}

/* 還沒有狀態檔時不能白畫面 */
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 900 } });
  const page = await ctx.newPage();
  const errs = []; collectErrors(page, errs);
  await page.route('**/bot/state.json*', r => r.fulfill({ status: 404, body: 'not found' }));
  await page.route('**/bot/backtest.json*', r => r.fulfill({ status: 404, body: 'not found' }));
  await page.goto(BASE + 'bot.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  const bad = [];
  // 這個情境本來就會有一個 404，那是要驗的行為，不算錯誤
  const realErrs = errs.filter(x => !/Failed to load resource/.test(x));
  errs.length = 0; realErrs.forEach(x => errs.push(x));
  const warn = await page.locator('#warn').innerText();
  if (!/還沒有狀態檔/.test(warn)) bad.push('沒有顯示「還沒有狀態檔」的說明');
  const dot = await page.locator('#conn-dot').getAttribute('class');
  if (!/dead/.test(dot)) bad.push('連線指示燈應該是未載入狀態');
  if (!/還沒有回測結果/.test(await page.locator('#bt-table').innerText())) {
    bad.push('沒有回測結果時沒有說明');
  }
  if (errs.length) bad.push('console: ' + errs.join(' | '));
  report('bot.html 沒有狀態檔', bad);
  await ctx.close();
}

/* 舊版（v1 單一部位）的狀態檔也要能正常顯示 */
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 900 } });
  const page = await ctx.newPage();
  const errs = []; collectErrors(page, errs);
  const v1 = { version: 1, config: { symbol: 'BTCUSDT', startEquity: 100, riskPct: 1, maxLeverage: 5 },
    equity: 100, trades: [], notes: [], feesPaid: 0, fundingPaid: 0, ticks: 2, createdAt: Date.now(),
    lastTick: Date.now(), curve: [{ t: 1, equity: 100, hasPosition: true }, { t: 2, equity: 100, hasPosition: true }],
    position: { side: 'long', entry: 80000, stop: 78000, tp: 83000, qty: 0.002, notional: 160,
                riskUsd: 4, entryFee: 0.07, openedAt: Date.now(), exchangeLeverage: 2 } };
  await page.route('**/bot/state.json*', r => r.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(v1) }));
  await page.route('**/bot/backtest.json*', r => r.fulfill({ status: 404, body: '' }));
  await page.goto(BASE + 'bot.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(900);
  const bad = [];
  if ((await page.locator('#positions tbody tr').count()) !== 1) bad.push('v1 的部位沒有顯示出來');
  const real = errs.filter(x => !/Failed to load resource/.test(x));
  if (real.length) bad.push('console: ' + real.join(' | '));
  report('bot.html 讀舊版狀態檔', bad);
  await ctx.close();
}

/* 平均每筆是負的時候要跳紅字，不能默默放過 */
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 900 } });
  const page = await ctx.newPage();
  const st = fakeState(35);
  st.trades = st.trades.map(t => ({ ...t, pnl: -Math.abs(t.pnl), r: -Math.abs(t.r) }));
  await page.route('**/bot/state.json*', r => r.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(st) }));
  await page.route('**/bot/backtest.json*', r => r.fulfill({ status: 404, body: '' }));
  await page.goto(BASE + 'bot.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
  const warn = await page.locator('#warn').innerText();
  const bad = [];
  if (!/平均每筆是負的/.test(warn)) bad.push('負期望值沒有跳警告');
  if (!/別拿真錢/.test(warn)) bad.push('警告沒有講清楚結論');
  report('bot.html 負期望值警告', bad);
  await ctx.close();
}

await browser.close();
console.log(failures === 0 ? '\n全部通過' : `\n${failures} 項失敗`);
process.exit(failures ? 1 : 0);
