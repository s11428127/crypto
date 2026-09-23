/* bot-page.js —— 機器人成績的檢視頁。只讀狀態檔，不做任何交易決策。 */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function f(v, d) {
    return isNum(v) ? v.toLocaleString('en-US', { minimumFractionDigits: d == null ? 2 : d,
                                                  maximumFractionDigits: d == null ? 2 : d }) : '—';
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
  function when(ts) {
    if (!isNum(ts)) return '—';
    return new Date(ts).toISOString().replace('T', ' ').slice(0, 16);
  }

  var state = null;

  /* ---------- 成績 ---------- */
  function renderStats() {
    if (!state) { $('stats').innerHTML = ''; $('warn').innerHTML = ''; return; }
    var s = BOT.stats(state);
    $('stats').innerHTML =
      kv('權益', '$' + f(s.equity), s.equity >= s.startEquity ? 'safe' : 'danger',
         '起始 $' + f(s.startEquity, 0)) +
      kv('報酬', (s.returnPct >= 0 ? '+' : '') + pct(s.returnPct, 2),
         s.returnPct >= 0 ? 'safe' : 'danger') +
      kv('交易筆數', String(s.n), s.enough ? 'safe' : 'warn',
         s.enough ? '樣本足夠' : '未滿 30 筆') +
      kv('勝率', s.winRate === null ? '—' : pct(s.winRate), s.winRate >= 50 ? 'safe' : '') +
      kv('平均每筆', s.avgR === null ? '—' : (s.avgR >= 0 ? '+' : '') + s.avgR.toFixed(3) + ' R',
         s.avgR > 0 ? 'safe' : s.avgR === null ? '' : 'danger') +
      kv('獲利因子', s.profitFactor === null ? (s.n ? '∞' : '—') : f(s.profitFactor),
         s.profitFactor > 1 ? 'safe' : s.n ? 'danger' : '') +
      kv('最大回撤', pct(s.maxDD), s.maxDD > 30 ? 'danger' : 'warn') +
      kv('最長連敗', s.n ? s.maxLossStreak + ' 筆' : '—', s.maxLossStreak >= 6 ? 'danger' : '') +
      kv('成本合計', '$' + f(s.feesPaid + s.fundingPaid), '',
         '手續費 $' + f(s.feesPaid) + ' + 資金費 $' + f(s.fundingPaid)) +
      kv('已運行', f(s.runningDays, 1) + ' 天', '', '第 ' + s.ticks + ' 輪');

    var w = [];
    if (!s.n) {
      w.push(alertBox('info', '還沒有成交紀錄',
        '機器人只在「日線與 4H 同向、15m 時機到位」時才進場，多數時間是空手的。' +
        '這是設計，不是壞掉 —— 不做也是一種結論。'));
    } else if (!s.enough) {
      w.push(alertBox('warn', '樣本還不夠',
        '目前 ' + s.n + ' 筆。30 筆以下的勝率波動非常大，看起來很好或很差都可能只是運氣。'));
    } else if (s.avgR <= 0) {
      w.push(alertBox('danger', '平均每筆是負的',
        '做滿 ' + s.n + ' 筆，平均 ' + s.avgR.toFixed(3) +
        ' R。這套規則在這段期間沒有優勢 —— 結論是別拿真錢去跑，不是把部位開大。'));
    } else {
      w.push(alertBox('safe', '平均每筆是正的',
        '做滿 ' + s.n + ' 筆，平均 +' + s.avgR.toFixed(3) + ' R，最大回撤 ' + pct(s.maxDD) +
        '。這是可以拿來討論真實下單的基礎 —— 但模擬單沒有滑點，真實會比這個差。'));
    }
    $('warn').innerHTML = w.join('');
  }

  /* ---------- 權益曲線 ---------- */
  function drawCurve() {
    var cv = $('curve');
    if (!cv) return;
    var w = Math.max(1, cv.clientWidth || 320);
    var h = Math.max(130, Math.min(260, Math.round(w * 0.38)));
    var dpr = window.devicePixelRatio || 1;
    cv.width = Math.max(1, Math.round(w * dpr));
    cv.height = Math.max(1, Math.round(h * dpr));
    cv.style.height = h + 'px';
    var ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    var c = state && state.curve ? state.curve : [];
    if (c.length < 2) {
      ctx.fillStyle = C('--text-dim'); ctx.font = '13px sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(state ? '資料還太少，畫不出曲線' : '還沒載入狀態檔', w / 2, h / 2);
      $('legend').innerHTML = '';
      return;
    }

    var start = state.config.startEquity;
    var padL = 6, padR = 52, padT = 10, padB = 14;
    var pw = Math.max(10, w - padL - padR), ph = Math.max(10, h - padT - padB);
    var lo = Infinity, hi = -Infinity;
    c.forEach(function (p) { lo = Math.min(lo, p.equity); hi = Math.max(hi, p.equity); });
    lo = Math.min(lo, start); hi = Math.max(hi, start);
    var pad = (hi - lo) * 0.1 || 1;
    lo -= pad; hi += pad;
    var yOf = function (v) { return padT + (hi - v) / Math.max(hi - lo, 1e-9) * ph; };
    var xOf = function (i) { return padL + i / Math.max(1, c.length - 1) * pw; };

    var y0 = yOf(start);
    ctx.save(); ctx.setLineDash([3, 3]); ctx.strokeStyle = C('--text-dim'); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padL, y0); ctx.lineTo(padL + pw, y0); ctx.stroke(); ctx.restore();

    // 持倉中的區段用底色標出來，一眼看出多久在場上
    ctx.fillStyle = C('--accent') + '18';
    var segStart = null;
    c.forEach(function (p, i) {
      var on = p.open > 0 || p.hasPosition;
      if (on && segStart === null) segStart = i;
      if ((!on || i === c.length - 1) && segStart !== null) {
        ctx.fillRect(xOf(segStart), padT, Math.max(1, xOf(i) - xOf(segStart)), ph);
        segStart = null;
      }
    });

    ctx.strokeStyle = state.equity >= start ? C('--long') : C('--short');
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    c.forEach(function (p, i) { i ? ctx.lineTo(xOf(i), yOf(p.equity)) : ctx.moveTo(xOf(i), yOf(p.equity)); });
    ctx.stroke();

    ctx.font = '10px ' + C('--mono'); ctx.fillStyle = C('--text-dim');
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    var yHi = yOf(hi) + 6, yLo = yOf(lo) - 6;
    ctx.fillText('$' + f(hi), padL + pw + 5, yHi);
    ctx.fillText('$' + f(lo), padL + pw + 5, yLo);
    if (Math.abs(y0 - yHi) > 12 && Math.abs(y0 - yLo) > 12) {
      ctx.fillText('$' + f(start, 0), padL + pw + 5, y0);
    }
    $('legend').innerHTML = '<span>權益曲線（虛線 = 起始本金）</span>' +
      '<span style="color:var(--accent)">底色 = 持倉中</span>' +
      '<span>' + when(c[0].t) + ' ~ ' + when(c[c.length - 1].t) + '</span>';
  }

  /* ---------- 目前部位 ---------- */
  function renderPosition() {
    if (!state) { $('position').innerHTML = ''; return; }
    var p = state.position;
    if (!p) {
      $('position').innerHTML =
        '<div class="plan-head"><span class="plan-side wait">空手</span>' +
        '<span class="plan-why">' +
        (state.notes && state.notes.length ? state.notes[0].text : '等待訊號') +
        '</span></div>';
      return;
    }
    var rows = [
      ['方向', p.side === 'long' ? '做多' : '做空', 'hl'],
      ['進場', f(p.entry, 1), ''],
      ['止損', f(p.stop, 1), 'stop'],
      ['止盈', f(p.tp, 1), 'tp'],
      ['數量', String(p.qty), ''],
      ['名目', '$' + f(p.notional), ''],
      ['設定槓桿', p.exchangeLeverage + 'x', ''],
      ['爆倉價', p.liqPrice > 0 ? f(p.liqPrice, 1) : '不會爆倉', 'liq'],
      ['這筆的風險', '−$' + f(p.riskUsd), ''],
      ['開倉時間', when(p.openedAt), '']
    ];
    $('position').innerHTML =
      '<div class="plan-head"><span class="plan-side ' + p.side + '">' +
      (p.side === 'long' ? '持有多單' : '持有空單') + '</span>' +
      '<span class="plan-why">' + (p.why || '') + '</span></div>' +
      '<div class="plan-body">' + rows.map(function (r) {
        return '<div class="prow ' + r[2] + '"><span class="k">' + r[0] +
               '</span><span class="v">' + r[1] + '</span></div>';
      }).join('') + '</div>';
  }

  /* ---------- 動作紀錄 ---------- */
  function renderNotes() {
    var n = state && state.notes ? state.notes : [];
    if (!n.length) { $('notes').innerHTML = '<div class="empty">還沒有紀錄</div>'; return; }
    var color = { open: 'var(--accent)', win: 'var(--long)', loss: 'var(--short)', idle: 'var(--text-dim)' };
    $('notes').innerHTML =
      '<table class="tbl"><thead><tr><th>時間</th><th style="text-align:left">動作</th></tr></thead><tbody>' +
      n.slice(0, 40).map(function (x) {
        return '<tr><td>' + when(x.t) + '</td>' +
               '<td style="text-align:left;white-space:normal;font-family:inherit;color:' +
               (color[x.kind] || 'inherit') + '">' + x.text + '</td></tr>';
      }).join('') + '</tbody></table>';
  }

  /* ---------- 成交紀錄 ---------- */
  function renderTrades() {
    var t = state && state.trades ? state.trades : [];
    if (!t.length) {
      $('trades').innerHTML = '<div class="empty">還沒有平倉的交易</div>';
      return;
    }
    $('trades').innerHTML =
      '<table class="tbl"><thead><tr><th>開倉</th><th>方向</th><th>進場</th><th>出場</th>' +
      '<th>損益</th><th>R</th><th>原因</th><th>權益</th></tr></thead><tbody>' +
      t.slice().reverse().slice(0, 50).map(function (x) {
        var c = x.pnl > 0 ? 'var(--long)' : 'var(--short)';
        return '<tr class="' + x.side + '-row">' +
          '<td>' + when(x.openedAt) + '</td>' +
          '<td>' + (x.side === 'long' ? '多' : '空') + '</td>' +
          '<td>' + f(x.entry, 1) + '</td>' +
          '<td>' + f(x.exit, 1) + '</td>' +
          '<td style="color:' + c + '">' + (x.pnl >= 0 ? '+' : '') + f(x.pnl) + '</td>' +
          '<td style="color:' + c + '">' + (isNum(x.r) ? (x.r >= 0 ? '+' : '') + x.r.toFixed(2) : '—') + '</td>' +
          '<td>' + (x.why === 'tp' ? '止盈' : x.why === 'stop' ? '止損' : '平倉') + '</td>' +
          '<td>$' + f(x.equityAfter) + '</td></tr>';
      }).join('') + '</tbody></table>';
  }

  function renderAll() {
    renderStats(); drawCurve(); renderPosition(); renderNotes(); renderTrades();
    var dot = $('conn-dot');
    if (state) {
      var fresh = isNum(state.lastTick) && (Date.now() - state.lastTick) < 3 * 3600 * 1000;
      dot.className = 'dot ' + (fresh ? 'live' : 'poll');
      dot.title = fresh ? '最近一輪在三小時內' : '超過三小時沒有更新';
      $('src-name').textContent = '最後更新 ' + when(state.lastTick);
    } else {
      dot.className = 'dot dead';
      $('src-name').textContent = '未載入';
    }
  }

  /* ---------- 載入 ---------- */
  function adopt(raw, from) {
    if (!raw || typeof raw !== 'object' || !raw.config) throw new Error('不是有效的狀態檔');
    state = BOT.migrate(raw);      // 舊版單一部位的狀態檔也能讀
    $('load-status').textContent = '已載入（' + from + '）';
    renderAll();
  }

  function load() {
    $('load-status').textContent = '載入中…';
    fetch('bot/state.json?t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (j) { adopt(j, 'bot/state.json'); })
      .catch(function (e) {
        $('load-status').textContent = '讀不到 bot/state.json（' + e.message + '）';
        if (!state) {
          // 順序很重要：renderAll() 會清掉 #warn，提示訊息要在它之後才寫
          renderAll();
          $('warn').innerHTML = alertBox('info', '還沒有狀態檔',
            '機器人要跑過至少一輪才會產生 <code>bot/state.json</code>。' +
            '在 GitHub 的 Actions 分頁手動觸發「模擬單機器人」可以立刻跑一輪，' +
            '或等排程每小時自動跑。<br>' +
            '已經有檔案的話，也可以用下面的「選擇 state.json」手動載入。');
        }
      });
  }

  $('reload').addEventListener('click', load);
  $('pick').addEventListener('click', function () { $('file').click(); });
  $('file').addEventListener('change', function (e) {
    var file = e.target.files && e.target.files[0];
    if (!file) return;
    var fr = new FileReader();
    fr.onload = function () {
      try { adopt(JSON.parse(fr.result), file.name); }
      catch (err) { $('load-status').textContent = '讀取失敗：' + err.message; }
      e.target.value = '';
    };
    fr.readAsText(file);
  });

  var rT;
  window.addEventListener('resize', function () {
    clearTimeout(rT); rT = setTimeout(drawCurve, 120);
  });

  THEME.init(function () { drawCurve(); });
  renderAll();
  load();
})();
