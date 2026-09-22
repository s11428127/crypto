/* sim-page.js —— 模擬與回測頁的接線。計算全部委派給 SIM / BACKTEST。 */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function n(id) { return parseFloat($(id).value); }
  function f(v, d) {
    if (!isNum(v)) return '—';
    return v.toLocaleString('en-US', { minimumFractionDigits: d == null ? 0 : d,
                                       maximumFractionDigits: d == null ? 0 : d });
  }
  function pct(v, d) { return isNum(v) ? v.toFixed(d == null ? 1 : d) + '%' : '—'; }
  function kv(k, v, cls, s) {
    return '<div><div class="k">' + k + '</div><div class="v' + (cls ? ' ' + cls : '') + '">' +
           v + '</div>' + (s ? '<div class="s">' + s + '</div>' : '') + '</div>';
  }
  function alertBox(kind, title, body) {
    return '<div class="alert ' + kind + '">' + (title ? '<b>' + title + '</b>' : '') + body + '</div>';
  }
  function C(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
  }
  function fitCanvas(cv, ratio, minH, maxH) {
    var w = Math.max(1, cv.clientWidth || 320);
    var h = Math.max(minH, Math.min(maxH, Math.round(w * ratio)));
    var dpr = window.devicePixelRatio || 1;
    cv.width = Math.max(1, Math.round(w * dpr));
    cv.height = Math.max(1, Math.round(h * dpr));
    cv.style.height = h + 'px';
    var ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx: ctx, w: w, h: h };
  }

  var FILTERS = { minQty: 0.001, stepSize: 0.001, minNotional: 100 };
  var lastSim = null, lastBt = null;

  /* ═══════════ 模擬 ═══════════ */
  function runSim() {
    var o = {
      equity: n('s-equity'), riskPct: n('s-risk'),
      winRate: n('s-win') / 100, rr: n('s-rr'),
      nTrades: Math.round(n('s-n')), price: n('s-price'),
      stopPct: n('s-stop'), maxLeverage: n('s-lev'),
      filters: FILTERS, runs: 3000, seed: 20260922, keepFinals: true
    };
    if (!isNum(o.equity) || o.equity <= 0 || !isNum(o.winRate) || !isNum(o.rr)) {
      $('sim-out').innerHTML = ''; return;
    }
    var r = SIM.monteCarlo(o);
    lastSim = r;

    var s = r.sizing;
    var sizingHtml = '<div class="kv">' +
      kv('最小可下單', s.qty.toFixed(3), '', 'BTC（名目 $' + f(s.notional) + '）') +
      kv('被迫的槓桿', s.leverage.toFixed(2) + 'x', s.leverage > 10 ? 'danger' : '') +
      kv('實際冒的風險', pct(s.riskPctActual, 2),
         s.riskPctActual > o.riskPct * 1.5 ? 'warn' : 'safe',
         '你想冒 ' + pct(o.riskPct, 1)) +
      kv('手續費佔比', r.feeR !== null ? r.feeR.toFixed(2) + ' R' : '—',
         r.feeR > 0.3 ? 'warn' : '', '每筆來回') +
      '</div>';
    if (s.forcedUp) {
      sizingHtml += alertBox('warn', '做不到你想要的風險',
        '交易所最小下單量是 ' + FILTERS.minQty + ' BTC，而且名目不得低於 $' + FILTERS.minNotional +
        '，所以你最小只能開 ' + s.qty.toFixed(3) + ' BTC。<br>' +
        '這讓單筆風險從 ' + pct(o.riskPct, 1) + ' 被頂到 <b>' + pct(s.riskPctActual, 2) +
        '</b>。這不是紀律問題，是本金規模的物理限制。');
    }
    if (!s.tradeable) {
      sizingHtml += alertBox('danger', '這個本金開不了倉',
        '在 ' + o.maxLeverage + ' 倍上限下，$' + f(o.equity) + ' 連最小部位都開不起來。');
    }
    $('sizing-box').innerHTML = sizingHtml;

    var netR = r.expectancyR - (r.feeR || 0);
    $('sim-out').innerHTML =
      kv('每筆期望值', (netR >= 0 ? '+' : '') + netR.toFixed(3) + ' R',
         netR > 0 ? 'safe' : 'danger', '已扣手續費') +
      kv('中位數結果', '$' + f(r.median),
         r.median > o.equity ? 'safe' : 'danger',
         (r.median / o.equity * 100 - 100).toFixed(0) + '%') +
      kv('5% 最差', '$' + f(r.p5), 'danger', '20 次有 1 次比這更慘') +
      kv('95% 最好', '$' + f(r.p95), 'safe', '20 次有 1 次比這更好') +
      kv('剩不到一半', pct(r.ruinPct), r.ruinPct > 10 ? 'danger' : r.ruinPct > 2 ? 'warn' : 'safe') +
      kv('翻倍機率', pct(r.doublePct), 'safe') +
      kv('平均最大回撤', pct(r.avgMaxDD), r.avgMaxDD > 40 ? 'danger' : 'warn') +
      kv('平均手續費', '$' + f(r.avgFees, 2), '', '整個序列累計');

    if (netR <= 0) {
      $('sim-warn').innerHTML = alertBox('danger', '這組參數是負期望值',
        '扣掉手續費之後每筆平均是 ' + netR.toFixed(3) + ' R。做越多筆虧越多，' +
        '這種情況下部位大小怎麼調都救不回來 —— 要改的是勝率或盈虧比。');
    } else {
      $('sim-warn').innerHTML = '';
    }
    drawHist();
  }

  /** 結果分布直方圖 */
  function drawHist() {
    var cv = $('sim-hist');
    if (!cv || !lastSim || !lastSim.finals || !lastSim.finals.length) return;
    var g = fitCanvas(cv, 0.42, 150, 260);
    var ctx = g.ctx, W = g.w, H = g.h;
    var r = lastSim, vals = r.finals;   // 已排序

    // 用 p2~p98 當範圍，極端值不要把圖壓扁
    var lo = vals[Math.floor(vals.length * 0.02)];
    var hi = vals[Math.floor(vals.length * 0.98)];
    lo = Math.min(lo, r.input.equity * 0.5);
    hi = Math.max(hi, r.input.equity * 1.1);
    if (!(hi > lo)) hi = lo + 1;

    var padL = 6, padR = 6, padT = 10, padB = 24;
    var pw = Math.max(10, W - padL - padR), ph = Math.max(10, H - padT - padB);
    var bins = Math.max(12, Math.min(48, Math.floor(pw / 9)));
    var counts = new Array(bins).fill(0);
    vals.forEach(function (v) {
      var b = Math.floor((v - lo) / (hi - lo) * bins);
      if (b < 0) b = 0; if (b >= bins) b = bins - 1;
      counts[b]++;
    });
    var maxC = Math.max.apply(null, counts) || 1;
    var bw = pw / bins;
    var xOf = function (v) { return padL + (v - lo) / (hi - lo) * pw; };

    // 低於起始本金的柱子塗紅、高於塗綠 —— 一眼看出勝負比例
    for (var i = 0; i < bins; i++) {
      var h = Math.max(0, counts[i] / maxC * ph);
      var binMid = lo + (i + 0.5) / bins * (hi - lo);
      ctx.fillStyle = binMid >= r.input.equity ? C('--long') : C('--short');
      ctx.globalAlpha = 0.75;
      ctx.fillRect(padL + i * bw, padT + ph - h, Math.max(1, bw - 1), h);
    }
    ctx.globalAlpha = 1;

    // 起始本金與中位數
    function marker(v, color, label, dash) {
      var x = xOf(v);
      if (x < padL || x > padL + pw) return;
      ctx.save();
      if (dash) ctx.setLineDash([3, 3]);
      ctx.strokeStyle = color; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + ph); ctx.stroke();
      ctx.restore();
      ctx.fillStyle = color; ctx.font = '10px ' + C('--mono');
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillText(label, Math.max(padL + 18, Math.min(padL + pw - 18, x)), padT + ph + 5);
    }
    marker(r.input.equity, C('--text-dim'), '起始 $' + f(r.input.equity), true);
    marker(r.median, C('--accent'), '中位 $' + f(r.median), false);

    $('sim-legend').innerHTML =
      '<span style="color:var(--long)">綠 = 比起始本金多</span>' +
      '<span style="color:var(--short)">紅 = 比起始本金少</span>' +
      '<span>' + r.runs + ' 次模擬，各做 ' + r.input.nTrades + ' 筆</span>';
  }

  /* ═══════════ 回測 ═══════════ */
  function runBacktest() {
    var btn = $('run-bt');
    btn.disabled = true;
    $('bt-status').textContent = '抓取歷史 K 線…';
    $('bt-prog').hidden = false;
    $('bt-prog').querySelector('i').style.width = '30%';
    $('bt-warn').innerHTML = '';

    DATA.history('BTCUSDT', { bars4h: 1500, barsD: 1000 })
      .then(function (h) {
        $('bt-prog').querySelector('i').style.width = '70%';
        $('bt-status').textContent = '回測中…（' + h.source + '，4H ' + h.k4.length +
                                     ' 根、日線 ' + h.d1.length + ' 根）';
        return new Promise(function (res) {
          setTimeout(function () {
            res(BACKTEST.run(h.k4, {
              equity: n('b-equity'), riskPct: n('b-risk'), maxLeverage: n('b-lev'),
              daily: h.d1, filters: h.filters || FILTERS
            }));
          }, 30);
        });
      })
      .then(function (r) {
        if (r.error) {
          $('bt-warn').innerHTML = alertBox('warn', '回測跑不起來', r.error);
          $('bt-out').innerHTML = ''; $('bt-trades').innerHTML = '';
          return;
        }
        lastBt = r;
        renderBacktest(r);
      })
      .catch(function (e) {
        $('bt-warn').innerHTML = alertBox('danger', '抓不到歷史資料',
          (e && e.message ? e.message : String(e)) +
          '<br>可能是網路、交易所地區封鎖，或瀏覽器擋掉了請求。');
      })
      .finally(function () {
        btn.disabled = false;
        $('bt-prog').hidden = true;
        $('bt-prog').querySelector('i').style.width = '0';
        if (!$('bt-status').textContent.startsWith('抓')) {
          $('bt-status').textContent = lastBt
            ? new Date(lastBt.from).toLocaleDateString('en-CA') + ' ~ ' +
              new Date(lastBt.to).toLocaleDateString('en-CA')
            : '';
        }
      });
  }

  function renderBacktest(r) {
    $('bt-out').innerHTML =
      kv('最終權益', '$' + f(r.equity, 2), r.equity > r.equity0 ? 'safe' : 'danger',
         (r.returnPct >= 0 ? '+' : '') + r.returnPct.toFixed(1) + '%') +
      kv('交易筆數', String(r.n)) +
      kv('勝率', pct(r.winRate), r.winRate >= 50 ? 'safe' : '') +
      kv('平均每筆', (r.avgR >= 0 ? '+' : '') + (isNum(r.avgR) ? r.avgR.toFixed(3) : '—') + ' R',
         r.avgR > 0 ? 'safe' : 'danger') +
      kv('獲利因子',
         isNum(r.profitFactor) ? r.profitFactor.toFixed(2) : (r.n > 0 ? '∞' : '—'),
         (r.profitFactor > 1 || (!isNum(r.profitFactor) && r.n > 0)) ? 'safe' : 'danger',
         '總獲利 ÷ 總虧損') +
      kv('最大回撤', pct(r.maxDD), r.maxDD > 40 ? 'danger' : 'warn') +
      kv('最長連敗', String(r.maxLossStreak) + ' 筆', r.maxLossStreak >= 6 ? 'warn' : '') +
      kv('成本合計', '$' + f(r.feesPaid + r.fundingPaid, 2), '',
         '手續費 $' + f(r.feesPaid, 2) + ' + 資金費 $' + f(r.fundingPaid, 2));

    var notes = [];

    // 好得不像話的結果，先懷疑程式而不是慶祝
    if (r.n >= 10 && isNum(r.winRate) && r.winRate >= 90) {
      notes.push({ k: 'danger', t: '勝率 ' + r.winRate.toFixed(1) + '% —— 這個數字高得不合理。' +
        '真實市場不會這樣。通常代表回測偷看了未來、資料有問題，或這段歷史剛好是一面倒的單邊行情。' +
        '<b>不要照這個結果下真錢。</b>' });
    }
    if (r.n >= 20 && isNum(r.maxDD) && r.maxDD < 2) {
      notes.push({ k: 'warn', t: '最大回撤只有 ' + r.maxDD.toFixed(1) +
        '%，低得不尋常。正常的策略在 20 筆以上一定會遇到像樣的回撤。' });
    }
    if (r.n < 30) notes.push({ k: 'warn', t: '只有 ' + r.n + ' 筆交易，樣本太小，這個勝率沒有統計意義。' });
    if (r.skipped && r.skipped.infeasible > 0) {
      notes.push({ k: 'info', t: '有 ' + r.skipped.infeasible +
        ' 次訊號因為部位開不起來（最小下單量或槓桿上限）被跳過 —— 本金越小這個數字越大。' });
    }
    if (r.skipped && r.skipped.wait > 0) {
      notes.push({ k: 'info', t: '有 ' + r.skipped.wait + ' 根 4H 因為日線與 4H 方向不一致而觀望。' });
    }
    if (isNum(r.avgR) && r.avgR <= 0) {
      notes.push({ k: 'danger', t: '平均每筆是負的 —— 這套訊號在這段歷史上沒有優勢。' +
        '結論是別用它下真錢，不是把部位開大一點試試看。' });
    }
    $('bt-warn').innerHTML = notes.map(function (x) { return alertBox(x.k, '', x.t); }).join('');

    drawCurve();
    renderTrades(r);
  }

  function drawCurve() {
    var cv = $('bt-curve');
    if (!cv || !lastBt || !lastBt.curve || !lastBt.curve.length) return;
    var g = fitCanvas(cv, 0.42, 150, 280);
    var ctx = g.ctx, W = g.w, H = g.h;
    var c = lastBt.curve;
    var padL = 6, padR = 52, padT = 12, padB = 18;
    var pw = Math.max(10, W - padL - padR), ph = Math.max(10, H - padT - padB);

    var lo = Infinity, hi = -Infinity;
    c.forEach(function (p) { lo = Math.min(lo, p.equity); hi = Math.max(hi, p.equity); });
    lo = Math.min(lo, lastBt.equity0); hi = Math.max(hi, lastBt.equity0);
    var pad = (hi - lo) * 0.08 || 1;
    lo -= pad; hi += pad;
    var yOf = function (v) { return padT + (hi - v) / Math.max(hi - lo, 1e-9) * ph; };
    var xOf = function (i) { return padL + i / Math.max(1, c.length - 1) * pw; };

    // 起始本金基準線
    var y0 = yOf(lastBt.equity0);
    ctx.save(); ctx.setLineDash([3, 3]); ctx.strokeStyle = C('--text-dim'); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padL, y0); ctx.lineTo(padL + pw, y0); ctx.stroke(); ctx.restore();

    ctx.strokeStyle = lastBt.equity >= lastBt.equity0 ? C('--long') : C('--short');
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    c.forEach(function (p, i) { i ? ctx.lineTo(xOf(i), yOf(p.equity)) : ctx.moveTo(xOf(i), yOf(p.equity)); });
    ctx.stroke();

    ctx.font = '10px ' + C('--mono'); ctx.fillStyle = C('--text-dim');
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    var yHi = yOf(hi) + 6, yLo = yOf(lo) - 6;
    ctx.fillText('$' + f(hi), padL + pw + 5, yHi);
    ctx.fillText('$' + f(lo), padL + pw + 5, yLo);
    // 起始本金的標籤如果會疊到上下限，就不畫（虛線本身已經標示位置）
    if (Math.abs(y0 - yHi) > 12 && Math.abs(y0 - yLo) > 12) {
      ctx.fillText('$' + f(lastBt.equity0), padL + pw + 5, y0);
    }

    $('bt-legend').innerHTML = '<span>權益曲線（虛線 = 起始本金 $' + f(lastBt.equity0) + '）</span>' +
      '<span>' + new Date(lastBt.from).toLocaleDateString('en-CA') + ' ~ ' +
      new Date(lastBt.to).toLocaleDateString('en-CA') + '</span>';
  }

  function renderTrades(r) {
    if (!r.trades.length) {
      $('bt-trades').innerHTML = '<div class="empty">這段期間沒有產生任何交易訊號。</div>';
      return;
    }
    var rows = r.trades.slice(-40).reverse().map(function (t) {
      return '<tr class="' + t.side + '-row">' +
        '<td>' + new Date(t.t).toLocaleDateString('en-CA') + '</td>' +
        '<td>' + (t.side === 'long' ? '多' : '空') + '</td>' +
        '<td>' + f(t.entry, 1) + '</td>' +
        '<td>' + f(t.stop, 1) + '</td>' +
        '<td>' + f(t.exit, 1) + '</td>' +
        '<td style="color:' + (t.r > 0 ? 'var(--long)' : 'var(--short)') + '">' +
          (t.r >= 0 ? '+' : '') + t.r.toFixed(2) + 'R</td>' +
        '<td>' + (t.why === 'stop' ? '止損' : t.why === 'tp' ? '止盈' : '收盤平') + '</td>' +
        '<td>$' + f(t.equityAfter, 2) + '</td></tr>';
    }).join('');
    $('bt-trades').innerHTML =
      '<table class="tbl"><thead><tr><th>進場日</th><th>方向</th><th>進場</th><th>止損</th>' +
      '<th>出場</th><th>R</th><th>原因</th><th>權益</th></tr></thead><tbody>' + rows +
      '</tbody></table>' +
      (r.trades.length > 40 ? '<div class="empty">只顯示最近 40 筆（共 ' + r.trades.length + ' 筆）</div>' : '');
  }

  /* ═══════════ 接線 ═══════════ */
  ['s-equity', 's-risk', 's-win', 's-rr', 's-n', 's-price', 's-stop', 's-lev']
    .forEach(function (id) { $(id).addEventListener('input', runSim); });
  $('run-bt').addEventListener('click', runBacktest);

  THEME.init(function () { drawHist(); drawCurve(); });

  var rT;
  window.addEventListener('resize', function () {
    clearTimeout(rT);
    rT = setTimeout(function () { drawHist(); drawCurve(); }, 120);
  });

  runSim();
})();
