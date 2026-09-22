/* journal-page.js —— 交易日誌頁。紀錄存 localStorage，統計委派給 JOURNAL。 */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var KEY = 'btc-journal-v1';
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function num(id) { var v = parseFloat($(id).value); return isFinite(v) ? v : NaN; }
  function f(v, d) {
    return isNum(v) ? v.toLocaleString('en-US', { minimumFractionDigits: d == null ? 2 : d,
                                                  maximumFractionDigits: d == null ? 2 : d }) : '—';
  }
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

  var trades = [];

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      trades = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(trades)) trades = [];
    } catch (e) { trades = []; }
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(trades)); }
    catch (e) {
      $('io-status').textContent = '存不進瀏覽器（可能是無痕模式），請用匯出保存。';
    }
  }

  /* ---------- 統計 ---------- */
  function renderStats() {
    var s = JOURNAL.stats(trades);
    if (!s.n) {
      $('stats').innerHTML = kv('紀錄筆數', '0', '', '先加入幾筆再看');
      $('stat-warn').innerHTML = '';
      drawCurve();
      return;
    }
    $('stats').innerHTML =
      kv('筆數', String(s.n), s.enough ? 'safe' : 'warn', s.enough ? '樣本足夠' : '未滿 30 筆') +
      kv('勝率', s.winRate.toFixed(1) + '%', s.winRate >= 50 ? 'safe' : '') +
      kv('總計', (s.totalR >= 0 ? '+' : '') + s.totalR.toFixed(2) + ' R',
         s.totalR > 0 ? 'safe' : 'danger') +
      kv('平均每筆', (s.avgR >= 0 ? '+' : '') + s.avgR.toFixed(3) + ' R',
         s.avgR > 0 ? 'safe' : 'danger') +
      kv('期望值', (s.expectancy >= 0 ? '+' : '') + s.expectancy.toFixed(3) + ' R',
         s.expectancy > 0 ? 'safe' : 'danger', '用實際賺賠算') +
      kv('賺賠比', s.payoff !== null ? s.payoff.toFixed(2) : '—', '',
         '平均賺 ' + s.avgWinR.toFixed(2) + 'R / 虧 ' + s.avgLossR.toFixed(2) + 'R') +
      kv('最大回撤', s.maxDD.toFixed(2) + ' R', s.maxDD > 6 ? 'danger' : 'warn') +
      kv('最長連敗', String(s.maxLossStreak) + ' 筆', s.maxLossStreak >= 6 ? 'danger' : '');

    var w = [];
    if (!s.enough) {
      w.push(alertBox('warn', '樣本還不夠',
        '目前 ' + s.n + ' 筆。30 筆以下的勝率波動非常大，看起來很好或很差都可能只是運氣。' +
        '繼續記，別急著改策略。'));
    } else if (s.expectancy <= 0) {
      w.push(alertBox('danger', '期望值是負的',
        '做滿 ' + s.n + ' 筆，平均每筆 ' + s.expectancy.toFixed(3) +
        ' R。這代表這套流程目前沒有優勢 —— 要改的是進場條件或出場規則，' +
        '不是把部位開大一點去拚。'));
    } else {
      w.push(alertBox('safe', '期望值是正的',
        '做滿 ' + s.n + ' 筆，平均每筆 +' + s.expectancy.toFixed(3) + ' R。' +
        '在這個基礎上放大部位才有意義。'));
    }
    if (s.bySide.long && s.bySide.short) {
      w.push(alertBox('info', '',
        '做多 ' + s.bySide.long.n + ' 筆／勝率 ' + s.bySide.long.winRate.toFixed(0) +
        '%／合計 ' + (s.bySide.long.totalR >= 0 ? '+' : '') + s.bySide.long.totalR.toFixed(1) + 'R　·　' +
        '做空 ' + s.bySide.short.n + ' 筆／勝率 ' + s.bySide.short.winRate.toFixed(0) +
        '%／合計 ' + (s.bySide.short.totalR >= 0 ? '+' : '') + s.bySide.short.totalR.toFixed(1) + 'R'));
    }
    $('stat-warn').innerHTML = w.join('');
    drawCurve();
  }

  /* ---------- R 曲線 ---------- */
  function drawCurve() {
    var cv = $('rcurve');
    if (!cv) return;
    var w = Math.max(1, cv.clientWidth || 320);
    var h = Math.max(120, Math.min(240, Math.round(w * 0.35)));
    var dpr = window.devicePixelRatio || 1;
    cv.width = Math.max(1, Math.round(w * dpr));
    cv.height = Math.max(1, Math.round(h * dpr));
    cv.style.height = h + 'px';
    var ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    var s = JOURNAL.stats(trades);
    if (!s.curve.length) {
      ctx.fillStyle = C('--text-dim'); ctx.font = '13px sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('還沒有紀錄', w / 2, h / 2);
      $('rlegend').innerHTML = '';
      return;
    }

    var padL = 6, padR = 44, padT = 10, padB = 14;
    var pw = Math.max(10, w - padL - padR), ph = Math.max(10, h - padT - padB);
    var lo = Math.min(0, Math.min.apply(null, s.curve));
    var hi = Math.max(0, Math.max.apply(null, s.curve));
    var pad = (hi - lo) * 0.1 || 1;
    lo -= pad; hi += pad;
    var yOf = function (v) { return padT + (hi - v) / Math.max(hi - lo, 1e-9) * ph; };
    var xOf = function (i) { return padL + (s.curve.length === 1 ? pw / 2 : i / (s.curve.length - 1) * pw); };

    var y0 = yOf(0);
    ctx.save(); ctx.setLineDash([3, 3]); ctx.strokeStyle = C('--text-dim');
    ctx.beginPath(); ctx.moveTo(padL, y0); ctx.lineTo(padL + pw, y0); ctx.stroke(); ctx.restore();

    ctx.strokeStyle = s.totalR >= 0 ? C('--long') : C('--short');
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    s.curve.forEach(function (v, i) { i ? ctx.lineTo(xOf(i), yOf(v)) : ctx.moveTo(xOf(i), yOf(v)); });
    ctx.stroke();

    ctx.font = '10px ' + C('--mono'); ctx.fillStyle = C('--text-dim');
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(hi.toFixed(1) + 'R', padL + pw + 5, yOf(hi) + 6);
    ctx.fillText('0', padL + pw + 5, y0);
    ctx.fillText(lo.toFixed(1) + 'R', padL + pw + 5, yOf(lo) - 6);
    $('rlegend').innerHTML = '<span>累積 R 曲線（' + s.curve.length + ' 筆）</span>';
  }

  /* ---------- 列表 ---------- */
  function renderList() {
    if (!trades.length) {
      $('list').innerHTML = '<div class="empty">還沒有紀錄。做完一筆就馬上記下來，' +
                            '隔天再補會記錯當初的理由。</div>';
      return;
    }
    var body = trades.slice().reverse().map(function (t, revIdx) {
      var idx = trades.length - 1 - revIdx;
      var r = isNum(t.r) ? t.r : JOURNAL.rOf(t);
      return '<tr class="' + t.side + '-row">' +
        '<td>' + (t.date || '—') + '</td>' +
        '<td>' + (t.symbol || '—').replace('USDT', '') + '</td>' +
        '<td>' + (t.side === 'long' ? '多' : '空') + '</td>' +
        '<td>' + f(t.entry, 1) + '</td>' +
        '<td>' + f(t.stop, 1) + '</td>' +
        '<td>' + f(t.exit, 1) + '</td>' +
        '<td style="color:' + (r > 0 ? 'var(--long)' : 'var(--short)') + '">' +
          (isNum(r) ? (r >= 0 ? '+' : '') + r.toFixed(2) + 'R' : '—') + '</td>' +
        '<td style="text-align:left;white-space:normal;font-family:inherit;max-width:200px">' +
          (t.note || '') + '</td>' +
        '<td><button class="ghost-btn" data-del="' + idx + '" type="button">刪</button></td>' +
        '</tr>';
    }).join('');
    $('list').innerHTML =
      '<table class="tbl"><thead><tr><th>日期</th><th>幣</th><th>方向</th><th>進場</th>' +
      '<th>止損</th><th>出場</th><th>R</th><th style="text-align:left">依據</th><th></th>' +
      '</tr></thead><tbody>' + body + '</tbody></table>';
  }

  /* ---------- 新增 ---------- */
  function currentInput() {
    return {
      date: $('j-date').value || new Date().toISOString().slice(0, 10),
      symbol: $('j-symbol').value.trim() || 'BTCUSDT',
      side: $('j-side').value,
      entry: num('j-entry'), stop: num('j-stop'), exit: num('j-exit'),
      note: $('j-note').value.trim()
    };
  }

  function preview() {
    var t = currentInput();
    var errs = JOURNAL.validate(t);
    if (errs.length) { $('preview').textContent = ''; $('form-warn').innerHTML = ''; return; }
    var r = JOURNAL.rOf(t);
    $('preview').textContent = '這筆是 ' + (r >= 0 ? '+' : '') + r.toFixed(2) + ' R';
    $('form-warn').innerHTML = '';
  }

  $('add').addEventListener('click', function () {
    var t = currentInput();
    var errs = JOURNAL.validate(t);
    if (errs.length) {
      $('form-warn').innerHTML = alertBox('danger', '還不能加入', errs.join('<br>'));
      return;
    }
    t.r = JOURNAL.rOf(t);
    trades.push(t);
    save();
    ['j-entry', 'j-stop', 'j-exit', 'j-note'].forEach(function (id) { $(id).value = ''; });
    $('preview').textContent = '';
    $('form-warn').innerHTML = '';
    renderAll();
  });

  $('list').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-del]');
    if (!b) return;
    var i = parseInt(b.dataset.del, 10);
    if (!(i >= 0 && i < trades.length)) return;
    var t = trades[i];
    if (!confirm('刪除這筆？\n' + (t.date || '') + ' ' + (t.symbol || '') + ' ' +
                 (t.side === 'long' ? '做多' : '做空') + ' ' + f(t.entry, 1) + ' → ' + f(t.exit, 1))) return;
    trades.splice(i, 1);
    save();
    renderAll();
  });

  ['j-entry', 'j-stop', 'j-exit', 'j-side'].forEach(function (id) {
    $(id).addEventListener('input', preview);
    $(id).addEventListener('change', preview);
  });

  /* ---------- 匯出／匯入 ---------- */
  $('export').addEventListener('click', function () {
    var blob = new Blob([JSON.stringify(trades, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'btc-journal-' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    $('io-status').textContent = '已匯出 ' + trades.length + ' 筆';
  });

  $('import-btn').addEventListener('click', function () { $('import-file').click(); });
  $('import-file').addEventListener('change', function (e) {
    var file = e.target.files && e.target.files[0];
    if (!file) return;
    var fr = new FileReader();
    fr.onload = function () {
      try {
        var data = JSON.parse(fr.result);
        if (!Array.isArray(data)) throw new Error('格式不對，應該是一個陣列');
        var valid = data.filter(function (t) { return JOURNAL.validate(t).length === 0; });
        trades = trades.concat(valid);
        save();
        renderAll();
        $('io-status').textContent = '匯入 ' + valid.length + ' 筆' +
          (valid.length < data.length ? '（' + (data.length - valid.length) + ' 筆格式不完整被略過）' : '');
      } catch (err) {
        $('io-status').textContent = '匯入失敗：' + err.message;
      }
      e.target.value = '';
    };
    fr.readAsText(file);
  });

  function renderAll() { renderStats(); renderList(); }

  var rT;
  window.addEventListener('resize', function () {
    clearTimeout(rT); rT = setTimeout(drawCurve, 120);
  });

  $('j-date').value = new Date().toISOString().slice(0, 10);
  load();
  THEME.init(function () { drawCurve(); });
  renderAll();
})();
