/* ui.js —— DOM 接線與畫布。計算一律呼叫 RISK，這裡不重寫任何公式。 */
(function () {
  'use strict';
  var R = globalThis.RISK;
  var $ = function (id) { return document.getElementById(id); };

  /* ---------- 格式化 ---------- */
  function num(el) { var v = parseFloat(el.value); return isFinite(v) ? v : NaN; }
  function usd(v, d) {
    if (!isFinite(v)) return '—';
    return v.toLocaleString('en-US', { minimumFractionDigits: d == null ? 2 : d,
                                       maximumFractionDigits: d == null ? 2 : d });
  }
  function pct(v, d) { return isFinite(v) ? v.toFixed(d == null ? 2 : d) + '%' : '—'; }
  function qty(v) { return isFinite(v) ? v.toFixed(6) : '—'; }

  function stat(k, v, cls, sub) {
    return '<div class="stat"><div class="k">' + k + '</div>' +
           '<div class="v' + (cls ? ' ' + cls : '') + '">' + v + '</div>' +
           (sub ? '<div class="sub">' + sub + '</div>' : '') + '</div>';
  }
  function alertBox(kind, title, body) {
    return '<div class="alert ' + kind + '"><b>' + title + '</b>' + body + '</div>';
  }

  /* 主題色：畫布要從 CSS 變數取色，不寫死，否則切換主題會壞 */
  function C(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
  }

  /* ---------- 狀態 ---------- */
  var side = 'long';

  /* ═══════════ 1. 部位體檢 ═══════════ */
  function renderInspect() {
    var entry = num($('i-entry')), lev = num($('i-lev')), margin = num($('i-margin'));
    var out = $('i-out'), alerts = $('i-alerts');

    var p = R.inspectPosition({ entry: entry, leverage: lev, equity: margin, side: side });
    if (!p) {
      out.innerHTML = stat('請填入有效數值', '—');
      alerts.innerHTML = '';
      return;
    }

    var liqCls = p.liqDistPct < 3 ? 'danger' : (p.liqDistPct < 8 ? 'warn' : 'safe');
    var levCls = lev >= 20 ? 'danger' : (lev >= 10 ? 'warn' : 'safe');

    out.innerHTML =
      stat('部位名目', '$' + usd(p.notional), '', qty(p.qty) + ' BTC') +
      stat('爆倉價', '$' + usd(p.liqPrice), liqCls, side === 'long' ? '跌破即歸零' : '漲破即歸零') +
      stat('距離爆倉', (side === 'long' ? '−' : '+') + pct(p.liqDistPct), liqCls, '相對進場價') +
      stat('價格每動 1%', '±' + pct(p.accountMovePerPct, 0), levCls, '你的帳戶權益') +
      stat('帳戶腰斬於', pct(p.halveAtPct), levCls, '逆向波動幅度');

    var html = '';
    if (p.liqDistPct < 5) {
      html += alertBox('danger', '爆倉距離小於 BTC 的日常波動',
        'BTC 一天之內走 ' + pct(p.liqDistPct, 1) + ' 是很平常的事，4H 級別的 ATR 常常就有 1~2%。' +
        '這代表你<b>不需要看錯方向</b>，一個正常回調就可能讓你出局。');
    } else if (p.liqDistPct < 10) {
      html += alertBox('warn', '爆倉距離偏近',
        '距離 ' + pct(p.liqDistPct, 1) + '，遇到消息面的單根長 K 棒仍有風險。');
    }
    if (lev >= 10) {
      html += alertBox('warn', '高槓桿下，合理的止損會很痛',
        '在 ' + lev + ' 倍下，一個技術上合理的止損（−1.5%~−2%，放在結構低點下方）' +
        '會讓你虧掉帳戶的 <b>' + pct(1.75 * lev, 0) + '</b> 左右。<br>' +
        '看起來很痛，所以很多人選擇不掛止損 —— 然後吃到 −100%。<b>兩者之間只能選一個。</b>');
    }
    var fee = R.feeInR({ notional: p.notional, riskAmt: margin * 0.01 });
    if (fee && fee.feeR > 1) {
      html += alertBox('info', '手續費佔比偏高',
        '這個名目的來回吃單手續費約 <b>$' + usd(fee.feeUsd) + '</b>。' +
        '若你的單筆風險預算是本金的 1%（$' + usd(margin * 0.01) + '），' +
        '光手續費就等於 <b>' + fee.feeR.toFixed(1) + ' R</b> —— 你得先贏這麼多才回到原點。');
    }
    alerts.innerHTML = html;
  }

  /* ═══════════ 2. 部位大小 ═══════════ */
  function renderSizing() {
    var eq = num($('s-equity')), risk = num($('s-risk'));
    var entry = num($('s-entry')), stop = num($('s-stop'));
    var out = $('s-out'), alerts = $('s-alerts');

    var s = R.sizeFromRisk({ equity: eq, riskPct: risk, entry: entry, stop: stop });
    if (!s) {
      out.innerHTML = stat('請填入有效數值', '—', '', '止損價不能等於進場價');
      alerts.innerHTML = '';
      renderFeasibility(eq, entry, stop, null);
      return;
    }

    var levCls = s.impliedLev >= 10 ? 'danger' : (s.impliedLev >= 3 ? 'warn' : 'safe');
    out.innerHTML =
      stat('願意虧', '$' + usd(s.riskAmt), '', '本金的 ' + pct(risk)) +
      stat('止損距離', pct(s.stopDistPct), '', usd(s.stopDist) + ' USDT') +
      stat('應開數量', qty(s.qty), '', 'BTC') +
      stat('部位名目', '$' + usd(s.notional)) +
      stat('隱含槓桿', s.impliedLev.toFixed(2) + ' 倍', levCls, '風險% ÷ 止損距離%');

    var html = '';
    if (s.impliedLev < 1) {
      html += alertBox('safe', '算出來連 1 倍都不到',
        '要達成 ' + pct(risk) + ' 的單筆風險，正確部位是 <b>' + s.impliedLev.toFixed(2) +
        ' 倍</b>。這不是算錯 —— 正確的風險管理本來就常常用不完本金。' +
        '<br>對照一下：20 倍是這個數字的 <b>' + Math.round(20 / s.impliedLev) + ' 倍大</b>。');
    }
    alerts.innerHTML = html;
    renderFeasibility(eq, entry, stop, s);
  }

  /* 可行性檢查 */
  function renderFeasibility(eq, entry, stop, sized) {
    var box = $('feas-box');
    if (!box) return;
    var f = R.feasibility({ equity: eq, entry: entry, stop: stop });
    if (!f) { box.innerHTML = ''; return; }

    var html = '<div class="readout">' +
      stat('最小可下單', qty(f.minQty), '', 'BTC') +
      stat('對應名目', '$' + usd(f.minNotional)) +
      stat('被迫的最低槓桿', f.minLeverage.toFixed(2) + ' 倍',
           f.minLeverage > 3 ? 'warn' : 'safe', '用你的本金開最小倉') +
      (isFinite(f.minRiskPct)
        ? stat('這筆的最低風險', pct(f.minRiskPct), f.minRiskPct > 5 ? 'danger' : 'safe', '帳戶佔比')
        : '') +
      '</div>';

    if (sized && isFinite(f.minRiskPct)) {
      var target = sized.riskAmt / eq * 100;
      if (f.minRiskPct > target * 1.05) {
        html += alertBox('danger', '做不到你設定的風險',
          '你想冒 <b>' + pct(target) + '</b>，但交易所的最小下單限制讓你至少要冒 <b>' +
          pct(f.minRiskPct) + '</b>，是目標的 <b>' + (f.minRiskPct / target).toFixed(1) + ' 倍</b>。<br>' +
          '這不是紀律問題，是本金規模的限制。可行的做法：把止損放更近（但會更容易被雜訊掃到）、' +
          '改做最小名目較低的幣種、或先把本金加大。');
      } else {
        html += alertBox('safe', '這筆做得起來',
          '交易所的最小下單限制沒有擋住你，可以照算出來的部位執行。');
      }
    }
    box.innerHTML = html;
  }

  /* ═══════════ 3. 價格軸 ═══════════ */
  var canvas = $('ladder-canvas'), ctx = canvas ? canvas.getContext('2d') : null;

  function drawLadder() {
    if (!ctx) return;
    var cssW = canvas.clientWidth || 320;
    var cssH = Math.max(260, Math.min(380, Math.round(cssW * 0.62)));
    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(cssW * dpr));
    canvas.height = Math.max(1, Math.round(cssH * dpr));
    canvas.style.height = cssH + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    var entry = num($('i-entry')), lev = num($('i-lev'));
    var stop = num($('s-stop'));
    if (!isFinite(entry) || entry <= 0) return;

    var liq = R.liqPrice({ entry: entry, leverage: lev, side: side });
    var tps = R.targets({ entry: entry, stop: stop, rMultiples: [1, 2] });

    // 收集所有要畫的價位
    var marks = [{ p: entry, label: '進場', en: 'Entry', color: C('--accent'), w: 2 }];
    if (isFinite(liq) && liq > 0) marks.push({ p: liq, label: '爆倉', en: 'Liq', color: C('--danger'), w: 2 });
    if (isFinite(stop) && stop > 0) marks.push({ p: stop, label: '止損', en: 'Stop', color: C('--stop'), w: 2 });
    tps.forEach(function (t) {
      if (isFinite(t.price) && t.price > 0) {
        marks.push({ p: t.price, label: t.r + 'R 止盈', en: 'TP' + t.r, color: C('--safe'), w: 1, dash: true });
      }
    });

    // ATR 帶：4H 典型波動 ±1.5%
    var atrPct = 0.015;
    var bandHi = entry * (1 + atrPct), bandLo = entry * (1 - atrPct);

    var lo = Math.min(bandLo, Math.min.apply(null, marks.map(function (m) { return m.p; })));
    var hi = Math.max(bandHi, Math.max.apply(null, marks.map(function (m) { return m.p; })));
    var pad = Math.max((hi - lo) * 0.12, entry * 0.002);
    lo -= pad; hi += pad;
    var span = Math.max(hi - lo, 1e-6);

    var padT = 18, padB = 18;
    var plotH = Math.max(10, cssH - padT - padB);
    var yOf = function (p) { return padT + (hi - p) / span * plotH; };

    var narrow = cssW < 260;  // 畫布本身比視窗窄（扣掉 wrap 與 card 的內距）
    var labelX = 8;
    var priceX = cssW - 8;
    var lineL = narrow ? 4 : 6;
    var lineR = cssW - (narrow ? 4 : 6);

    // ATR 帶底色
    var yHi = yOf(bandHi), yLo = yOf(bandLo);
    ctx.fillStyle = C('--text-dim') + '22';
    ctx.fillRect(lineL, Math.min(yHi, yLo), Math.max(0, lineR - lineL), Math.max(0, Math.abs(yLo - yHi)));
    ctx.font = '11px ' + 'ui-monospace, monospace';
    ctx.fillStyle = C('--text-dim');
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText('4H 典型波動 ±1.5%', labelX, Math.min(yHi, yLo) + 3);

    // 由上而下排序後畫線，避免標籤互相蓋住
    marks.sort(function (a, b) { return b.p - a.p; });
    var lastY = -99;
    marks.forEach(function (m) {
      var y = yOf(m.p);
      ctx.save();
      ctx.strokeStyle = m.color;
      ctx.lineWidth = m.w;
      if (m.dash) ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(lineL, y);
      ctx.lineTo(lineR, y);
      ctx.stroke();
      ctx.restore();

      // 標籤上下擠在一起時稍微推開
      var ty = y;
      if (Math.abs(ty - lastY) < 13) ty = lastY + 13;
      lastY = ty;

      ctx.font = (narrow ? '11px ' : '12px ') + 'ui-monospace, monospace';
      ctx.fillStyle = m.color;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.fillText(narrow ? m.en : m.label + ' ' + m.en, labelX, ty - 8);
      ctx.textAlign = 'right';
      ctx.fillStyle = C('--text');
      ctx.fillText(usd(m.p, 0), priceX, ty - 8);
    });

    // 爆倉在止損之前 → 畫出危險區塊
    var warn = R.liqBeforeStop({ entry: entry, leverage: lev, side: side, stop: stop });
    var el = $('ladder-alerts');
    if (el) {
      if (warn && warn.liquidatedFirst) {
        el.innerHTML = alertBox('danger', '爆倉會發生在止損之前',
          '你的止損價（$' + usd(stop, 0) + '）落在爆倉價（$' + usd(warn.liqPrice, 0) + '）的外面，' +
          '代表價格還沒走到止損，交易所就已經把你強制平倉了。<b>這個止損等於沒設。</b><br>' +
          '解法只有兩個：把止損拉近到爆倉價之內，或把槓桿降下來讓爆倉價退遠。');
      } else if (warn) {
        el.innerHTML = alertBox('safe', '止損會先觸發',
          '止損價在爆倉價之內，這筆倉的出場由你決定，不是由交易所決定。這是正確的設定。');
      } else {
        el.innerHTML = '';
      }
    }
  }

  /* ═══════════ 接線 ═══════════ */
  function renderAll() {
    renderInspect();
    renderSizing();
    drawLadder();
  }

  ['i-entry', 'i-lev', 'i-margin', 's-equity', 's-risk', 's-entry', 's-stop'].forEach(function (id) {
    var el = $(id);
    if (el) el.addEventListener('input', renderAll);
  });

  var seg = $('i-side');
  if (seg) {
    seg.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-side]');
      if (!b) return;
      side = b.dataset.side;
      Array.prototype.forEach.call(seg.querySelectorAll('button'), function (x) {
        x.setAttribute('aria-pressed', String(x === b));
      });
      renderAll();
    });
  }

  // 進場價兩處同步：第 1 節改了，第 2 節跟著走（除非使用者自己動過）
  var entryTouched = false;
  if ($('s-entry')) $('s-entry').addEventListener('input', function () { entryTouched = true; });
  if ($('i-entry')) $('i-entry').addEventListener('input', function () {
    if (!entryTouched && $('s-entry')) $('s-entry').value = $('i-entry').value;
  });

  /* 主題切換 */
  var tbtn = $('theme-toggle');
  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    if (tbtn) tbtn.textContent = t === 'light' ? '深色' : '淺色';
    drawLadder();
  }
  var saved = 'dark';
  try { saved = localStorage.getItem('btcrisk-theme') || 'dark'; } catch (e) {}
  applyTheme(saved);
  if (tbtn) {
    tbtn.addEventListener('click', function () {
      var next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
      applyTheme(next);
      try { localStorage.setItem('btcrisk-theme', next); } catch (e) {}
    });
  }

  var rT;
  window.addEventListener('resize', function () {
    clearTimeout(rT); rT = setTimeout(drawLadder, 100);
  });

  renderAll();
})();
