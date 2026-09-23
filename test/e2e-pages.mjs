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

await browser.close();
console.log(failures === 0 ? '\n三頁全部通過' : `\n${failures} 項失敗`);
process.exit(failures ? 1 : 0);
