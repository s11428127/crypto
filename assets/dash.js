/* dash.js —— 主控台接線。計算全部委派給 IND / PLAN / RISK，這裡只負責顯示。 */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };

  var SYMBOL = 'BTCUSDT';
  var TFS = ['15m', '1h', '4h', '1d'];
  var KLINE_LIMIT = 300;
  var REFRESH_MS = 60000;

  var state = {
    tf: '4h',
    snap: null,     // DATA.snapshot 的結果
    an: {},         // 各週期的 IND.analyze 結果
    plan: null,
    live: null,     // WebSocket 即時價
    stopLive: null,
    loading: false,
    error: null
  };

  // isNum(null) === true，會讓三元判斷在 null 時選中 null 而不是走備援。一律用嚴格版本。
  function isNum(x) { return typeof x === 'number' && isFinite(x); }

  /* ---------- 格式 ---------- */
  function f(v, d) {
    if (v === null || v === undefined || !isNum(v)) return '—';
    return v.toLocaleString('en-US', { minimumFractionDigits: d == null ? 2 : d,
                                       maximumFractionDigits: d == null ? 2 : d });
  }
  function fp(v, d) { return isNum(v) ? v.toFixed(d == null ? 2 : d) + '%' : '—'; }
  function compact(v) {
    if (!isNum(v)) return '—';
    if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
    if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
    if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
    return v.toFixed(2);
  }
  function dirText(d) { return d === 'up' ? '多頭' : d === 'down' ? '空頭' : '盤整'; }
  function dirCls(d) { return d === 'up' ? 'up-c' : d === 'down' ? 'down-c' : 'range-c'; }

  function params() {
    return {
      equity: parseFloat($('p-equity').value),
      riskPct: parseFloat($('p-risk').value),
      leverage: parseFloat($('p-lev').value)
    };
  }

  /* ---------- 價格列 ---------- */
  var lastShown = null;
  function renderPrice() {
    var t = state.snap && state.snap.ticker;
    var px = currentPrice();
    if (!isNum(px)) {                       // 連 ticker 都沒有時，退到目前週期的最後收盤
      var kk = state.snap && state.snap.klines[state.tf];
      px = kk && kk.length ? kk[kk.length - 1].c : null;
    }
    var el = $('px-last');

    if (isNum(px)) {
      el.textContent = f(px, px < 100 ? 4 : 1);
      if (lastShown !== null && px !== lastShown) {
        el.classList.remove('up', 'down');
        el.classList.add(px > lastShown ? 'up' : 'down');
      }
      lastShown = px;
    } else {
      el.textContent = '—';
    }

    var chg = $('px-chg');
    if (t && isNum(t.changePct)) {
      chg.textContent = (t.changePct >= 0 ? '+' : '') + t.changePct.toFixed(2) + '%';
      chg.className = 'px-chg ' + (t.changePct >= 0 ? 'up' : 'down');
    } else { chg.textContent = '—'; chg.className = 'px-chg'; }

    var fd = state.snap && state.snap.funding;
    var oi = state.snap && state.snap.openInterest;
    var rows = [
      ['24h 高', t ? f(t.high, 1) : '—'],
      ['24h 低', t ? f(t.low, 1) : '—'],
      ['24h 量', t ? compact(t.quoteVolume) + ' U' : '—'],
      ['標記價', fd ? f(fd.markPrice, 1) : '—'],
      ['資金費率', fd && isNum(fd.rate) ? (fd.rate * 100).toFixed(4) + '%' : '—'],
      ['下次結算', fd && fd.nextTime ? countdown(fd.nextTime) : '—'],
      ['未平倉量', oi ? compact(oi.oi) + ' BTC' : '—']
    ];
    $('px-meta').innerHTML = rows.map(function (r) {
      return '<div><div class="k">' + r[0] + '</div><div class="v">' + r[1] + '</div></div>';
    }).join('');
  }

  function countdown(ts) {
    var ms = ts - Date.now();
    if (!isNum(ms) || ms < 0) return '—';
    var m = Math.floor(ms / 60000), h = Math.floor(m / 60);
    return h + 'h ' + (m % 60) + 'm';
  }

  /* ---------- 圖 ---------- */
  function renderChart() {
    var k = state.snap && state.snap.klines[state.tf];
    var a = state.an[state.tf];
    CHART.draw($('chart'), {
      klines: k || [],
      ema: a ? { e20: a.ema20, e50: a.ema50, e200: a.ema200 } : null,
      tf: state.tf,
      // 所有週期都畫「現在的價格」，不是該週期的收盤價，否則會和上方報價對不起來
      live: currentPrice()
    });
    if (a) {
      $('ma-legend').innerHTML =
        '<span style="color:var(--accent)">EMA20 <b>' + f(a.last.ema20, 1) + '</b></span>' +
        '<span style="color:var(--stop)">EMA50 <b>' + f(a.last.ema50, 1) + '</b></span>' +
        '<span>EMA200 <b>' + f(a.last.ema200, 1) + '</b></span>';
    }
  }

  /* ---------- 指標列 ---------- */
  function renderIndicators() {
    var a = state.an[state.tf];
    if (!a) { $('ind-row').innerHTML = ''; return; }
    var L = a.last;
    var rsiCls = !isNum(L.rsi) ? '' : L.rsi > 70 ? 'down-c' : L.rsi < 30 ? 'up-c' : '';
    var mh = L.macdHist;
    var cells = [
      ['RSI 14', isNum(L.rsi) ? L.rsi.toFixed(1) : '—', rsiCls],
      ['MACD 柱', isNum(mh) ? (mh > 0 ? '+' : '') + mh.toFixed(1) : '—',
        isNum(mh) ? (mh > 0 ? 'up-c' : 'down-c') : ''],
      ['ATR 14', isNum(L.atr) ? f(L.atr, 1) : '—', ''],
      ['ATR %', isNum(L.atr) && L.close ? fp(L.atr / L.close * 100) : '—', ''],
      ['趨勢', dirText(a.trend.dir), dirCls(a.trend.dir)],
      ['結構高', f(a.swing.high, 1), ''],
      ['結構低', f(a.swing.low, 1), '']
    ];
    $('ind-row').innerHTML = cells.map(function (c) {
      return '<div><div class="k">' + c[0] + '</div><div class="v ' + c[2] + '">' + c[1] + '</div></div>';
    }).join('');
  }

  /* ---------- 多框架 ---------- */
  function renderMTF() {
    var order = [['1d', '1D 方向'], ['4h', '4H 結構'], ['15m', '15m 時機']];
    $('mtf').innerHTML = order.map(function (o) {
      var a = state.an[o[0]];
      var d = a ? a.trend.dir : 'range';
      var w = a ? a.trend.reason : '載入中';
      return '<div class="tf"><div class="k">' + o[1] + '</div>' +
             '<div class="v ' + dirCls(d) + '">' + dirText(d) + '</div>' +
             '<div class="w">' + w + '</div></div>';
    }).join('');
  }

  /* ---------- 計畫卡 ---------- */
  function renderPlan() {
    var p = state.plan, el = $('plan');
    if (!p) { el.innerHTML = ''; return; }

    var sideTxt = p.side === 'long' ? '做多 LONG' : p.side === 'short' ? '做空 SHORT' : '觀望 WAIT';
    var tag = p.side === 'wait'
      ? '<span class="plan-tag">不進場</span>'
      : (p.ready ? '<span class="plan-tag go">時機到位</span>'
                 : '<span class="plan-tag hold">等時機</span>');
    var strength = p.side === 'wait' ? '' :
      '<span class="plan-tag">' + (p.strength === 2 ? '強訊號' : '弱訊號') + '</span>';

    var head = '<div class="plan-head">' +
      '<span class="plan-side ' + p.side + '">' + sideTxt + '</span>' + tag + strength +
      '<span class="plan-why">' + p.biasWhy + '。' + p.timingWhy + '</span></div>';

    var body = '';
    if (p.side === 'wait') {
      body = '<div class="prow"><span class="k">現在該做什麼</span>' +
             '<span class="v">空手等待</span></div>' +
             '<div class="prow"><span class="k">4H ATR</span><span class="v">' +
             f(p.atr, 1) + '<small>' + fp(p.atrPct) + '</small></span></div>';
    } else {
      var pr = params();
      var rows = [
        ['進場區間', f(p.entryZone[0], 1) + ' ~ ' + f(p.entryZone[1], 1), 'hl'],
        ['止損', f(p.stop, 1) + '<small>−' + fp(p.stopDistPct) + '</small>', 'stop hl'],
        ['TP1 (1.5R)', f(p.targets[0].price, 1), 'tp'],
        ['TP2 (3R)', f(p.targets[1].price, 1), 'tp']
      ];
      if (p.size) {
        rows.push(['建議數量', p.size.qty.toFixed(6) + ' BTC', '']);
        rows.push(['部位名目', '$' + f(p.size.notional), '']);
        rows.push(['算出的槓桿', p.size.impliedLev.toFixed(2) + 'x<small>風險÷止損距離</small>', 'hl']);
      }
      if (p.feasibility) {
        rows.push(['交易所最小倉', p.feasibility.minQty.toFixed(3) + ' BTC ($' +
                   f(p.feasibility.minNotional, 0) + ')', '']);
        if (isNum(p.feasibility.minRiskPct)) {
          rows.push(['最小可行風險', fp(p.feasibility.minRiskPct), '']);
        }
      }
      if (isNum(p.liqPrice)) {
        rows.push(['爆倉價 @' + pr.leverage + 'x', f(p.liqPrice, 1), 'liq hl']);
      }
      if (p.fee) {
        rows.push(['來回手續費', '$' + p.fee.feeUsd.toFixed(2) + '<small>' + p.fee.feeR.toFixed(2) + ' R</small>', '']);
      }
      body = rows.map(function (r) {
        return '<div class="prow ' + r[2] + '"><span class="k">' + r[0] +
               '</span><span class="v">' + r[1] + '</span></div>';
      }).join('');
    }
    el.innerHTML = head + '<div class="plan-body">' + body + '</div>';
  }

  /* ---------- 警告 ---------- */
  function renderWarnings() {
    var out = '';
    if (state.error) {
      out += '<div class="alert danger"><b>抓不到行情</b>' + state.error +
             '<br>可能是網路、交易所地區封鎖，或瀏覽器擋掉了請求。按「重新整理」再試一次。</div>';
    }
    if (state.plan && state.plan.warnings.length) {
      out += state.plan.warnings.map(function (w) {
        var kind = w.level === 'danger' ? 'danger' : w.level === 'warn' ? 'warn' : 'info';
        return '<div class="alert ' + kind + '">' + w.text + '</div>';
      }).join('');
    }
    $('warnings').innerHTML = out;
  }

  /* ---------- 重算 ---------- */
  /**
   * 計畫該用哪個價格：即時 > 24h ticker > 4H 收盤。
   * 4H 收盤最多可能是 4 小時前的價格，拿它算進場區間會整段偏掉。
   */
  function currentPrice() {
    if (isNum(state.live)) return state.live;
    if (state.snap && state.snap.ticker && isNum(state.snap.ticker.last)) return state.snap.ticker.last;
    var k = state.snap && state.snap.klines && state.snap.klines['15m'];
    if (k && k.length) return k[k.length - 1].c;   // 最後手段：最短週期的收盤價
    return undefined;
  }

  function recompute() {
    if (!state.snap) return;
    state.an = {};
    TFS.forEach(function (tf) {
      var k = state.snap.klines[tf];
      if (k && k.length) state.an[tf] = IND.analyze(k);
    });
    if (state.an['1d'] && state.an['4h'] && state.an['15m']) {
      var pr = params();
      state.plan = PLAN.build(
        { d1: state.an['1d'], h4: state.an['4h'], m15: state.an['15m'] },
        {
          price: currentPrice(),
          equity: pr.equity, riskPct: pr.riskPct, leverage: pr.leverage,
          fundingRate: state.snap.funding ? state.snap.funding.rate : undefined,
          filters: state.snap.filters || undefined
        }
      );
    }
  }

  function renderAll() {
    renderPrice(); renderChart(); renderIndicators();
    renderMTF(); renderPlan(); renderWarnings();
    $('src-name').textContent = state.snap ? state.snap.source : '—';
    $('updated').textContent = state.snap
      ? '更新於 ' + new Date(state.snap.at).toLocaleTimeString('en-GB')
      : (state.loading ? '載入中…' : '');
  }

  /* ---------- 載入 ---------- */
  function load() {
    if (state.loading) return;
    state.loading = true;
    state.error = null;
    $('updated').textContent = '載入中…';
    return DATA.snapshot(SYMBOL, TFS, KLINE_LIMIT)
      .then(function (s) {
        state.snap = s;
        state.error = null;
        // WebSocket 還沒吐價之前，先用 ticker 讓圖和報價一致
        if (!isNum(state.live) && s.ticker && isNum(s.ticker.last)) state.live = s.ticker.last;
        recompute();
      })
      .catch(function (e) {
        state.error = e && e.message ? e.message : String(e);
      })
      .finally(function () {
        state.loading = false;
        renderAll();
        startLive();
      });
  }

  /* ---------- 即時價 ---------- */
  var livePending = false;
  function startLive() {
    if (state.stopLive || !state.snap) return;
    state.stopLive = DATA.livePrice(SYMBOL, function (p) {
      state.live = p;
      if (livePending) return;
      livePending = true;             // 節流：最多每 200ms 重畫一次
      setTimeout(function () {
        livePending = false;
        renderPrice();
        recompute();
        renderPlan();
        renderChart();
      }, 200);
    }, function (st) {
      var d = $('conn-dot');
      d.className = 'dot ' + (st.mode === 'ws' ? 'live' : 'poll');
      d.title = st.mode === 'ws' ? 'WebSocket 即時' : ('輪詢中：' + (st.reason || ''));
    });
  }

  /* ---------- 事件 ---------- */
  $('tfbar').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-tf]');
    if (!b) return;
    state.tf = b.dataset.tf;
    Array.prototype.forEach.call(this.querySelectorAll('button'), function (x) {
      x.setAttribute('aria-pressed', String(x === b));
    });
    renderChart(); renderIndicators();
  });

  ['p-equity', 'p-risk', 'p-lev'].forEach(function (id) {
    $(id).addEventListener('input', function () {
      savePrefs();
      recompute(); renderPlan(); renderWarnings();
    });
  });

  $('refresh').addEventListener('click', load);

  function savePrefs() {
    try {
      localStorage.setItem('btc-params', JSON.stringify(params()));
    } catch (e) {}
  }
  function loadPrefs() {
    try {
      var p = JSON.parse(localStorage.getItem('btc-params') || 'null');
      if (!p) return;
      if (isNum(p.equity)) $('p-equity').value = p.equity;
      if (isNum(p.riskPct)) $('p-risk').value = p.riskPct;
      if (isNum(p.leverage)) $('p-lev').value = p.leverage;
    } catch (e) {}
  }

  THEME.init(function () { renderChart(); });

  var rT;
  window.addEventListener('resize', function () {
    clearTimeout(rT); rT = setTimeout(renderChart, 120);
  });

  // 分頁回到前景時補一次，避免看到過期的價格
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) load();
  });

  loadPrefs();
  renderAll();
  load();
  setInterval(load, REFRESH_MS);
})();
