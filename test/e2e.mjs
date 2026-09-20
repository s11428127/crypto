import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const WIDTHS = [320, 390, 680, 1180];
const URL = 'http://127.0.0.1:8099/learn.html';
let failures = 0;

const browser = await chromium.launch();
for (const w of WIDTHS) {
  const ctx = await browser.newContext({ viewport: { width: w, height: 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errs = [];
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));

  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(250);

  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);

  // 主要輸出有沒有真的算出東西
  const liq = await page.locator('#i-out .stat').nth(1).locator('.v').innerText();
  const lev = await page.locator('#s-out .stat').nth(4).locator('.v').innerText();

  // 互動：切換做空，數字要改變
  await page.locator('#i-side button[data-side="short"]').click();
  await page.waitForTimeout(120);
  const liqShort = await page.locator('#i-out .stat').nth(1).locator('.v').innerText();
  await page.locator('#i-side button[data-side="long"]').click();

  // 互動：改槓桿
  await page.fill('#i-lev', '5');
  await page.waitForTimeout(120);
  const liq5 = await page.locator('#i-out .stat').nth(1).locator('.v').innerText();
  await page.fill('#i-lev', '20');

  // 展開所有 details（教學區）後再量一次溢出
  await page.evaluate(() => document.querySelectorAll('details').forEach(d => d.open = true));
  await page.waitForTimeout(200);
  const overflowOpen = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);

  // 主題切換不能丟例外
  await page.click('#theme-toggle');
  await page.waitForTimeout(150);
  await page.click('#theme-toggle');
  await page.waitForTimeout(150);

  const canvasOk = await page.evaluate(() => {
    const c = document.getElementById('ladder-canvas');
    return c && c.width > 0 && c.height > 0;
  });

  const bad = [];
  if (errs.length) bad.push('console: ' + errs.join(' | '));
  if (overflow > 0) bad.push('水平溢出 ' + overflow + 'px');
  if (overflowOpen > 0) bad.push('展開後水平溢出 ' + overflowOpen + 'px');
  if (!/^\$[\d,]/.test(liq)) bad.push('爆倉價沒算出來: ' + liq);
  if (liqShort === liq) bad.push('切換做空後爆倉價沒變');
  if (liq5 === liq) bad.push('改槓桿後爆倉價沒變');
  if (!/倍$/.test(lev)) bad.push('隱含槓桿沒算出來: ' + lev);
  if (!canvasOk) bad.push('canvas 尺寸異常');

  if (bad.length) { failures++; console.log(`✗ ${w}px  ` + bad.join('；')); }
  else console.log(`✓ ${w}px  爆倉=${liq} 隱含槓桿=${lev} (空單=${liqShort}, 5x=${liq5})`);

  await page.screenshot({ path: `/tmp/shot-${w}.png`, fullPage: w === 390 });
  await ctx.close();
}
await browser.close();
console.log(failures === 0 ? '\n四種寬度全部通過' : `\n${failures} 個寬度有問題`);
process.exit(failures ? 1 : 0);
