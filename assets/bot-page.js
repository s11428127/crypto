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
  // 一律用使用者電腦的時區（台灣就是 UTC+8），不要顯示 UTC —— 會以為機器人停在幾小時前
  function when(ts) {
    if (!isNum(ts)) return '—';
    var d = new Date(ts), z = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate()) + ' ' +
           z(d.getHours()) + ':' + z(d.getMinutes());
  }
  function hm(ts) { return when(ts).slice(11); }

  var state = null;

  /* ---------- 即時價格 ----------
   * 狀態檔只有機器人跑的時候（每小時一次）才會更新；持倉的現價與浮動損益在這裡每 10 秒抓一次。
   * 這只是顯示用，機器人的出場判斷不看這裡 —— 它每輪用 15 分 K 的最高最低價檢查止損。 */
  var LIVE_MS = 10000;
  var live = {};           // sym → { price, at }
  var liveErr = '';
  var liveBusy = false;

  function openSyms() { return state && state.positions ? Object.keys(state.positions) : []; }

  function pollLive() {
    var syms = openSyms();
    if (liveBusy || !syms.length || !window.DATA || document.hidden) return;
    liveBusy = true;
    Promise.all(syms.map(function (sym) {
      return DATA.ticker(sym)
        .then(function (t) {
          // WebSocket 在 3 秒內剛更新過就不要用 24hr ticker 蓋掉（ticker 可能慢一點）
          if (t && isNum(t.last) && t.last > 0 && !(live[sym] && Date.now() - live[sym].at < 3000)) {
            live[sym] = { price: t.last, at: Date.now() };
          }
        })
        .catch(function (e) { liveErr = e.message; });
    })).then(function () {
      liveBusy = false;
      renderStats(); renderPositions(); drawCurve();
    });
  }

  /* 持倉的幣各開一條 WebSocket，成交一筆就更新一次（跟交易所 App 一樣會跳）。
   * WebSocket 連不上時 DATA.livePrice 會自己退回每 5 秒輪詢；上面的 10 秒輪詢是再保險一層。 */
  var streams = {};        // sym → stop()
  var renderQ = null;
  function scheduleLiveRender() {
    if (renderQ) return;
    renderQ = setTimeout(function () { renderQ = null; renderStats(); renderPositions(); drawCurve(); }, 700);
  }
  function syncStreams() {
    if (!window.DATA || !DATA.livePrice) return;
    var want = openSyms();
    Object.keys(streams).forEach(function (sym) {
      if (want.indexOf(sym) < 0) { streams[sym](); delete streams[sym]; }
    });
    want.forEach(function (sym) {
      if (streams[sym]) return;
      streams[sym] = DATA.livePrice(sym, function (p) {
        if (!isNum(p) || p <= 0) return;
        live[sym] = { price: p, at: Date.now() };
        liveErr = '';
        scheduleLiveRender();
      });
    });
  }
  function clock(ts) {
    var d = new Date(ts), z = function (n) { return (n < 10 ? '0' : '') + n; };
    return z(d.getHours()) + ':' + z(d.getMinutes()) + ':' + z(d.getSeconds());
  }

  /** 全部持倉都有現價時，回傳含浮動損益的權益；少一個就回 null（不要拿一半的數字騙人） */
  function markedEquity() {
    if (!state) return null;
    var syms = openSyms(), eq = state.equity, fee = state.config.feeRate;
    for (var i = 0; i < syms.length; i++) {
      var u = BOT.unrealized(state.positions[syms[i]], live[syms[i]] && live[syms[i]].price, fee);
      if (!u) return null;
      eq += u.equityDelta;
    }
    return eq;
  }

  /** 排程是每小時第 7 分；GitHub 常常晚 5–20 分鐘 */
  function nextRun(last) {
    if (!isNum(last)) return null;
    var h = 3600e3, t = Math.floor(last / h) * h + 7 * 60e3;
    return t <= last ? t + h : t;
  }

  /* ---------- 成績 ---------- */
  function renderStats() {
    if (!state) { $('stats').innerHTML = ''; $('warn').innerHTML = ''; return; }
    var s = BOT.stats(state);
    var me = s.openCount ? markedEquity() : null;
    $('stats').innerHTML =
      kv(s.openCount ? '帳上權益' : '權益', '$' + f(s.equity), s.equity >= s.startEquity ? 'safe' : 'danger',
         s.openCount ? '已扣開倉手續費' : '起始 $' + f(s.startEquity, 0)) +
      (s.openCount ? kv('含浮動損益', me === null ? '—' : '$' + f(me),
         me === null ? '' : me >= s.startEquity ? 'safe' : 'danger',
         me === null ? (liveErr ? '抓不到現價' : '抓現價中…') : '現在全部平倉的話') : '') +
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
      kv('持倉中', s.openCount + ' 筆', '', '上限 ' + (state.config.maxPositions || 3)) +
      kv('已運行', f(s.runningDays, 1) + ' 天', '', '第 ' + s.ticks + ' 輪');

    var w = [];
    if (!s.n && s.openCount) {
      w.push(alertBox('info', '有持倉，但還沒有平倉的單',
        '「交易筆數」只算已經平倉的。帳上少的 $' + f(s.feesPaid + s.fundingPaid) + ' 是開倉手續費，不是虧損。' +
        '規則 v2 沒有固定止盈，只有打到止損或移動止損才出場，回測裡一筆的中位數大約抱 28 小時。<br>' +
        '機器人每小時跑一輪；持倉的現價在這頁每 10 秒更新。'));
    } else if (!s.n) {
      w.push(alertBox('info', '還沒有成交紀錄',
        '機器人只在「日線在 EMA200 之上、4H 多頭、回檔到 EMA20 後站回」時才進場，多數時間是空手的。' +
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
    var me = markedEquity();
    var tail = me !== null && openSyms().length ? me : null;
    c.forEach(function (p) { lo = Math.min(lo, p.equity); hi = Math.max(hi, p.equity); });
    if (tail !== null) { lo = Math.min(lo, tail); hi = Math.max(hi, tail); }
    lo = Math.min(lo, start); hi = Math.max(hi, start);
    // 縱軸至少涵蓋起始本金的 ±2%（= 每筆 1% 風險的 ±2R）。
    // 不夾的話，$0.09 的手續費會被放大成滿版的「暴跌」。
    var minSpan = start * 0.04;
    if (hi - lo < minSpan) { var mid = (hi + lo) / 2; lo = mid - minSpan / 2; hi = mid + minSpan / 2; }
    var pad = (hi - lo) * 0.1;
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

    // 含浮動損益的「現在」：從最後一點拉一段虛線到右緣的圓點
    if (tail !== null) {
      var xe = padL + pw, ye = yOf(tail);
      ctx.save(); ctx.setLineDash([4, 3]);
      ctx.strokeStyle = tail >= start ? C('--long') : C('--short'); ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(xOf(c.length - 1), yOf(c[c.length - 1].equity)); ctx.lineTo(xe, ye); ctx.stroke();
      ctx.restore();
      ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath(); ctx.arc(xe, ye, 3, 0, Math.PI * 2); ctx.fill();
    }

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
      (tail !== null ? '<span>虛線圓點 = 現在（含浮動）</span>' : '') +
      '<span>' + when(c[0].t) + ' ~ ' + when(c[c.length - 1].t) + '</span>';
  }

  function short(sym) { return String(sym || '').replace(/USDT$/, ''); }
  function px(v) { return isNum(v) ? String(+v.toPrecision(6)) : '—'; }

  /* ---------- 目前持倉 ---------- */
  function renderPositions() {
    var pos = state && state.positions ? state.positions : {};
    var keys = Object.keys(pos);
    if (!keys.length) {
      $('positions').innerHTML = '<div class="empty">空手。等日線多頭、4H 回檔到 EMA20 再站回才進場。</div>';
      return;
    }
    var fee = state.config.feeRate;
    var lastAt = 0;
    keys.forEach(function (k) { if (live[k] && live[k].at > lastAt) lastAt = live[k].at; });
    $('positions').innerHTML =
      '<div class="hint" style="margin:0 0 6px">' +
        (lastAt ? '現價更新於 <b style="font-variant-numeric:tabular-nums">' + clock(lastAt) + '</b> · ' +
                  (window.DATA ? DATA.activeName() : '') + ' 公開行情'
                : liveErr ? '抓不到現價（' + liveErr + '）' : '抓現價中…') +
      '</div>' +
      '<table class="tbl"><thead><tr><th>幣</th><th>方向</th><th>進場</th><th>現價</th><th>浮動損益</th><th>R</th>' +
      '<th>止損</th><th>距止損</th><th>名目</th><th>風險</th><th>設定槓桿</th><th>開倉時間</th></tr></thead><tbody>' +
      keys.map(function (k) {
        var p = pos[k], lv = live[k];
        var u = BOT.unrealized(p, lv && lv.price, fee);
        var uc = !u ? 'inherit' : u.pnl >= 0 ? 'var(--long)' : 'var(--short)';
        // 止損已經被移上來鎖住獲利時，標成「保本以上」
        var locked = p.side === 'long' ? p.stop >= p.entry : p.stop <= p.entry;
        return '<tr class="' + p.side + '-row"><td>' + short(k) + '</td>' +
          '<td>' + (p.side === 'long' ? '多' : '空') + '</td>' +
          '<td>' + px(p.entry) + '</td>' +
          '<td' + (lv ? ' title="' + hm(lv.at) + ' 更新"' : '') + '>' + (u ? px(u.price) : '…') + '</td>' +
          '<td style="color:' + uc + '">' + (u ? (u.pnl >= 0 ? '+' : '−') + '$' + f(Math.abs(u.pnl)) : '—') + '</td>' +
          '<td style="color:' + uc + '">' + (u && isNum(u.r) ? sgn(u.r, 2) : '—') + '</td>' +
          '<td style="color:var(--stop)">' + px(p.stop) + (locked ? ' <span style="color:var(--long)">保本↑</span>' : '') + '</td>' +
          '<td>' + (u && isNum(u.toStopPct) ? pct(u.toStopPct, 2) : '—') + '</td>' +
          '<td>$' + f(p.notional) + '</td>' +
          '<td style="color:var(--short)">−$' + f(p.riskUsd) + '</td>' +
          '<td>' + (p.exchangeLeverage || 1) + 'x</td>' +
          '<td>' + when(p.openedAt) + '</td></tr>';
      }).join('') + '</tbody></table>';
  }

  /* ---------- 各幣狀態 ---------- */
  var STATUS_TXT = { open: '開倉', closed: '剛平倉', hold: '持倉中', wait: '觀望',
                     blocked: '不做', skip: '跳過', error: '錯誤' };
  var STATUS_COLOR = { open: 'var(--accent)', hold: 'var(--accent)', closed: 'var(--text)',
                       wait: 'var(--text-dim)', blocked: 'var(--warn)', skip: 'var(--text-dim)',
                       error: 'var(--short)' };
  function renderStatus() {
    var st = state && state.status ? state.status : {};
    var syms = state ? BOT.symbolsOf(state.config) : [];
    Object.keys(st).forEach(function (k) { if (syms.indexOf(k) < 0) syms.push(k); });
    if (!syms.length) { $('status').innerHTML = '<div class="empty">還沒有資料</div>'; return; }
    var by = BOT.stats(state).bySymbol;
    $('status').innerHTML =
      '<table class="tbl"><thead><tr><th>幣</th><th>狀態</th><th>成交</th><th>合計 R</th>' +
      '<th style="text-align:left">說明</th></tr></thead><tbody>' +
      syms.map(function (k) {
        var x = st[k] || {}, b = by[k];
        var type = state.positions && state.positions[k] ? 'hold' : x.type;
        return '<tr><td>' + short(k) + '</td>' +
          '<td style="color:' + (STATUS_COLOR[type] || 'inherit') + '">' + (STATUS_TXT[type] || '—') + '</td>' +
          '<td>' + (b ? b.n : 0) + '</td>' +
          '<td style="color:' + (b && b.totalR > 0 ? 'var(--long)' : b && b.totalR < 0 ? 'var(--short)' : 'inherit') + '">' +
            (b ? (b.totalR >= 0 ? '+' : '') + b.totalR.toFixed(2) : '—') + '</td>' +
          '<td style="text-align:left;white-space:normal;font-family:inherit;min-width:180px">' +
            (x.reason || '') + '</td></tr>';
      }).join('') + '</tbody></table>';
  }

  /* ---------- 動作紀錄 ---------- */
  function renderNotes() {
    var n = state && state.notes ? state.notes : [];
    if (!n.length) { $('notes').innerHTML = '<div class="empty">還沒有開平倉事件</div>'; return; }
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
      '<table class="tbl"><thead><tr><th>幣</th><th>開倉</th><th>方向</th><th>進場</th><th>出場</th>' +
      '<th>損益</th><th>R</th><th>原因</th><th>權益</th></tr></thead><tbody>' +
      t.slice().reverse().slice(0, 50).map(function (x) {
        var c = x.pnl > 0 ? 'var(--long)' : 'var(--short)';
        return '<tr class="' + x.side + '-row">' +
          '<td>' + short(x.symbol) + '</td>' +
          '<td>' + when(x.openedAt) + '</td>' +
          '<td>' + (x.side === 'long' ? '多' : '空') + '</td>' +
          '<td>' + px(x.entry) + '</td>' +
          '<td>' + px(x.exit) + '</td>' +
          '<td style="color:' + c + '">' + (x.pnl >= 0 ? '+' : '') + f(x.pnl) + '</td>' +
          '<td style="color:' + c + '">' + (isNum(x.r) ? (x.r >= 0 ? '+' : '') + x.r.toFixed(2) : '—') + '</td>' +
          '<td>' + ({ tp: '止盈', stop: '止損', trail: '移動止損' }[x.why] || '平倉') + '</td>' +
          '<td>$' + f(x.equityAfter) + '</td></tr>';
      }).join('') + '</tbody></table>';
  }

  function renderAll() {
    renderStats(); drawCurve(); renderPositions(); renderStatus(); renderNotes(); renderTrades();
    var dot = $('conn-dot');
    if (state) {
      var fresh = isNum(state.lastTick) && (Date.now() - state.lastTick) < 3 * 3600 * 1000;
      dot.className = 'dot ' + (fresh ? 'live' : 'poll');
      dot.title = fresh ? '最近一輪在三小時內' : '超過三小時沒有更新';
      $('src-name').textContent = '上一輪 ' + hm(state.lastTick) + ' · 下一輪約 ' + hm(nextRun(state.lastTick));
    } else {
      dot.className = 'dot dead';
      $('src-name').textContent = '未載入';
    }
  }

  /* ---------- 歷史回測 ---------- */
  var backtest = null;
  function sgn(v, d) { return isNum(v) ? (v >= 0 ? '+' : '') + v.toFixed(d == null ? 2 : d) : '—'; }
  function rColor(v) { return !isNum(v) ? 'inherit' : v > 0 ? 'var(--long)' : v < 0 ? 'var(--short)' : 'inherit'; }

  /** 新舊規則並排 */
  function renderCompare() {
    var rules = backtest && backtest.rules;
    if (!rules) { $('bt-compare').innerHTML = ''; $('bt-rule').textContent = ''; return; }
    var keys = Object.keys(rules);
    var rows = [
      ['規則', function (r) { return r.name; }],
      ['成交', function (r) { return String(r.pooled.n || 0); }],
      ['勝率', function (r) { return r.pooled.n ? pct(r.pooled.winRate) : '—'; }],
      ['平均每筆', function (r) { return '<span style="color:' + rColor(r.pooled.avgR) + '">' + sgn(r.pooled.avgR, 3) + ' R</span>'; }],
      ['總計', function (r) { return '<span style="color:' + rColor(r.pooled.totalR) + '">' + sgn(r.pooled.totalR, 1) + ' R</span>'; }],
      ['獲利因子', function (r) { var p = r.pooled; return p.profitFactor == null ? (p.n ? '∞' : '—') : f(p.profitFactor); }],
      ['最長連敗', function (r) { return r.pooled.n ? r.pooled.maxLossStreak + ' 筆' : '—'; }],
      ['R 曲線回撤', function (r) { return r.pooled.n ? r.pooled.maxDDR.toFixed(1) + ' R' : '—'; }],
      ['多單', function (r) { return sideCell(r.pooled.long); }],
      ['空單', function (r) { return sideCell(r.pooled.short); }]
    ];
    $('bt-compare').innerHTML =
      '<table class="tbl"><thead><tr><th></th>' +
      keys.map(function (k) { return '<th>' + k + '</th>'; }).join('') + '</tr></thead><tbody>' +
      rows.map(function (row) {
        return '<tr><td>' + row[0] + '</td>' + keys.map(function (k) {
          return '<td style="white-space:normal">' + row[1](rules[k]) + '</td>';
        }).join('') + '</tr>';
      }).join('') + '</tbody></table>';
    var v2 = rules.v2;
    $('bt-rule').textContent = v2 ? 'v2 規則：' + v2.desc + '。' +
      (backtest.years ? '資料期間約 ' + backtest.years + ' 年，' : '') + '來源 ' + (backtest.source || '—') + '。' : '';
  }

  function renderQuarters() {
    var qs = backtest && backtest.quarters;
    if (!qs || !qs.length) { $('bt-quarters').innerHTML = '<div class="empty">沒有按季資料</div>'; return; }
    $('bt-quarters').innerHTML =
      '<table class="tbl"><thead><tr><th>季</th><th>買進持有</th><th>v1 筆數</th><th>v1 總 R</th>' +
      '<th>v2 筆數</th><th>v2 總 R</th></tr></thead><tbody>' +
      qs.map(function (q) {
        return '<tr><td>' + q.q + '</td>' +
          '<td style="color:' + rColor(q.buyHold) + '">' + sgn(q.buyHold, 1) + '%</td>' +
          '<td>' + q.v1.n + '</td><td style="color:' + rColor(q.v1.totalR) + '">' + sgn(q.v1.totalR, 1) + '</td>' +
          '<td>' + q.v2.n + '</td><td style="color:' + rColor(q.v2.totalR) + '">' + sgn(q.v2.totalR, 1) + '</td></tr>';
      }).join('') + '</tbody></table>';
  }

  function renderBacktest() {
    renderCompare();
    renderQuarters();
    if (!backtest) {
      $('bt-pool').innerHTML = '';
      $('bt-table').innerHTML = '<div class="empty">還沒有回測結果。在 GitHub 的 Actions 分頁手動觸發「歷史回測」，幾分鐘就會跑完。</div>';
      $('bt-warn').innerHTML = '';
      return;
    }
    var p = backtest.pooled || {};
    $('bt-pool').innerHTML =
      kv('合計成交', String(p.n || 0), p.n >= 30 ? 'safe' : 'warn', p.n >= 30 ? '樣本足夠' : '未滿 30 筆') +
      kv('勝率', p.n ? pct(p.winRate) : '—', p.winRate >= 50 ? 'safe' : '') +
      kv('平均每筆', p.n ? (p.avgR >= 0 ? '+' : '') + p.avgR.toFixed(3) + ' R' : '—',
         p.avgR > 0 ? 'safe' : p.n ? 'danger' : '', '已扣手續費與資金費') +
      kv('總計', p.n ? (p.totalR >= 0 ? '+' : '') + p.totalR.toFixed(1) + ' R' : '—',
         p.totalR > 0 ? 'safe' : p.n ? 'danger' : '') +
      kv('獲利因子', p.profitFactor === null || p.profitFactor === undefined ? (p.n ? '∞' : '—') : f(p.profitFactor),
         p.profitFactor > 1 ? 'safe' : p.n ? 'danger' : '') +
      kv('最長連敗', p.n ? p.maxLossStreak + ' 筆' : '—', p.maxLossStreak >= 8 ? 'danger' : '') +
      kv('R 曲線回撤', p.n ? p.maxDDR.toFixed(1) + ' R' : '—', '') +
      (p.long ? kv('多單', p.long.n ? (p.long.avgR >= 0 ? '+' : '') + p.long.avgR.toFixed(3) + ' R' : '—',
                   p.long.avgR > 0 ? 'safe' : p.long.n ? 'danger' : '', p.long.n + ' 筆平均') : '') +
      (p.short ? kv('空單', p.short.n ? (p.short.avgR >= 0 ? '+' : '') + p.short.avgR.toFixed(3) + ' R' : '—',
                    p.short.avgR > 0 ? 'safe' : p.short.n ? 'danger' : '', p.short.n + ' 筆平均') : '') +
      (isNum(p.avgBuyHoldPct) ? kv('同期買進持有', (p.avgBuyHoldPct >= 0 ? '+' : '') + pct(p.avgBuyHoldPct),
                                   p.avgBuyHoldPct >= 0 ? 'safe' : 'danger', '各幣平均，什麼都不做的基準') : '') +
      kv('產生時間', when(backtest.generatedAt), '', backtest.source || '');

    var w = [];
    if (!p.n) {
      w.push(alertBox('info', '這段期間一筆訊號都沒有', '規則太嚴或資料不夠長。'));
    } else if (p.n < 30) {
      w.push(alertBox('warn', '樣本還不夠', '只有 ' + p.n + ' 筆，勝率的誤差很大，別急著下結論。'));
    }
    // 只有多單在賺、又剛好是上漲行情 → 賺的是行情，不是規則
    if (p.long && p.short && p.long.n >= 10 && p.short.n >= 10 && p.long.avgR > 0 && p.short.avgR < 0 &&
        isNum(p.avgBuyHoldPct) && p.avgBuyHoldPct > 0) {
      w.push(alertBox('warn', '多單賺、空單賠，而且這段期間整體在漲',
        '這很可能是行情在幫忙，不是規則有優勢。在下跌或盤整的行情裡，同一套多單規則未必還能賺。' +
        '要確認得用涵蓋多頭、空頭、盤整的更長歷史再測一次。'));
    }
    if (p.n && p.winRate >= 90) {
      w.push(alertBox('danger', '勝率高得不合理', '真實市場不會這樣，先懷疑程式或資料，不要照著下真錢。'));
    }
    if (p.n >= 30 && p.avgR <= 0) {
      w.push(alertBox('danger', '這套規則在這段歷史上沒有優勢',
        p.n + ' 筆平均 ' + p.avgR.toFixed(3) + ' R。結論是改規則或不做，不是把部位開大。'));
    } else if (p.n >= 30 && p.avgR > 0) {
      w.push(alertBox('safe', '這段歷史上是正期望值',
        p.n + ' 筆平均 +' + p.avgR.toFixed(3) + ' R。但過去不等於未來，而且回測沒有滑點 —— 真實會比這差。'));
    }
    $('bt-warn').innerHTML = w.join('');

    var rows = backtest.symbols || [];
    $('bt-table').innerHTML =
      '<table class="tbl"><thead><tr><th>幣</th><th>筆數</th><th>勝率</th><th>平均 R</th>' +
      '<th>報酬</th><th>買進持有</th><th>多單 R</th><th>空單 R</th><th>最大回撤</th><th>獲利因子</th><th>期間</th></tr></thead><tbody>' +
      rows.map(function (r) {
        if (r.error) {
          return '<tr><td>' + short(r.symbol) + '</td><td colspan="10" style="text-align:left;color:var(--short);' +
                 'white-space:normal;font-family:inherit">' + r.error + '</td></tr>';
        }
        var c = r.avgR > 0 ? 'var(--long)' : r.avgR < 0 ? 'var(--short)' : 'inherit';
        return '<tr><td>' + short(r.symbol) + '</td>' +
          '<td>' + r.n + '</td>' +
          '<td>' + (r.n ? pct(r.winRate) : '—') + '</td>' +
          '<td style="color:' + c + '">' + (r.n ? (r.avgR >= 0 ? '+' : '') + r.avgR.toFixed(3) : '—') + '</td>' +
          '<td style="color:' + (r.returnPct >= 0 ? 'var(--long)' : 'var(--short)') + '">' +
            (r.returnPct >= 0 ? '+' : '') + pct(r.returnPct) + '</td>' +
          '<td>' + (isNum(r.buyHoldPct) ? (r.buyHoldPct >= 0 ? '+' : '') + pct(r.buyHoldPct) : '—') + '</td>' +
          '<td>' + sideCell(r.long) + '</td>' +
          '<td>' + sideCell(r.short) + '</td>' +
          '<td>' + pct(r.maxDD) + '</td>' +
          '<td>' + (r.profitFactor === null ? (r.n ? '∞' : '—') : f(r.profitFactor)) + '</td>' +
          '<td>' + when(r.from).slice(0, 10) + '~' + when(r.to).slice(5, 10) + '</td></tr>';
      }).join('') + '</tbody></table>';
  }

  function sideCell(x) {
    if (!x || !x.n) return '—';
    var c = x.avgR > 0 ? 'var(--long)' : 'var(--short)';
    return '<span style="color:' + c + '">' + (x.avgR >= 0 ? '+' : '') + x.avgR.toFixed(2) + '</span>' +
           '<span style="color:var(--text-dim)">×' + x.n + '</span>';
  }

  function loadBacktest() {
    fetch('bot/backtest.json?t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) { backtest = j; renderBacktest(); })
      .catch(function () { backtest = null; renderBacktest(); });
  }

  /* ---------- 載入 ---------- */
  function adopt(raw, from) {
    if (!raw || typeof raw !== 'object' || !raw.config) throw new Error('不是有效的狀態檔');
    state = BOT.migrate(raw);      // 舊版單一部位的狀態檔也能讀
    $('load-status').textContent = '已載入（' + from + '）';
    renderAll();
    pollLive();
    syncStreams();
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

  $('reload').addEventListener('click', function () { load(); loadBacktest(); });
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
  loadBacktest();
  setInterval(pollLive, LIVE_MS);
  // 狀態檔每 5 分鐘重抓一次：機器人跑完一輪，不用手動重新整理就看得到
  setInterval(function () { if (!document.hidden) load(); }, 5 * 60e3);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) pollLive(); });
})();
