/* screener-page.js —— 篩選器頁的接線 */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function pct(v, d) { return isNum(v) ? (v >= 0 ? '+' : '') + v.toFixed(d == null ? 2 : d) + '%' : '—'; }
  function compact(v) {
    if (!isNum(v)) return '—';
    if (v >= 1e9) return (v / 1e9).toFixed(1) + 'B';
    if (v >= 1e6) return (v / 1e6).toFixed(0) + 'M';
    return v.toFixed(0);
  }
  function dirText(d) { return d === 'up' ? '多' : d === 'down' ? '空' : '整'; }
  function dirCls(d) { return d === 'up' ? 'up-c' : d === 'down' ? 'down-c' : 'range-c'; }
  function alertBox(kind, title, body) {
    return '<div class="alert ' + kind + '">' + (title ? '<b>' + title + '</b>' : '') + body + '</div>';
  }

  var rows = [];   // 評分結果，供點選查看理由

  function account() {
    return {
      equity: parseFloat($('sc-equity').value) || 50,
      riskPct: parseFloat($('sc-risk').value) || 1,
      maxLev: parseFloat($('sc-lev').value) || 5
    };
  }
  function usd(v, d) {
    return isNum(v) ? '$' + v.toLocaleString('en-US', { minimumFractionDigits: d == null ? 2 : d,
                                                        maximumFractionDigits: d == null ? 2 : d }) : '—';
  }
  function px(v) {
    if (!isNum(v)) return '—';
    var d = v >= 1000 ? 1 : v >= 1 ? 3 : 6;
    return v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  }

  function scan() {
    var btn = $('run-scan');
    btn.disabled = true;
    $('sc-warn').innerHTML = '';
    $('sc-status').textContent = '抓取全市場行情…';
    $('sc-prog').hidden = false;
    var bar = $('sc-prog').querySelector('i');
    bar.style.width = '5%';

    var count = parseInt($('sc-count').value, 10) || 30;
    var minVol = (parseFloat($('sc-vol').value) || 50) * 1e6;
    var tickers, funding, filters, symbols;

    Promise.all([
      DATA.allTickers(),
      DATA.allFunding().catch(function () { return {}; }),
      DATA.filtersAll().catch(function () { return {}; })
    ])
      .then(function (r) {
        tickers = r[0]; funding = r[1]; filters = r[2];
        // 依 24h 成交額排序，取前 N 名，並確保 BTC 一定在裡面（要拿它當相對強度基準）
        var sorted = tickers.slice().sort(function (a, b) { return b.quoteVolume - a.quoteVolume; });
        symbols = sorted.slice(0, count).map(function (x) { return x.symbol; });
        if (symbols.indexOf('BTCUSDT') < 0) symbols.unshift('BTCUSDT');
        $('sc-status').textContent = '抓 K 線 0/' + symbols.length * 2;

        // 每個幣要日線與 4H 兩段
        return DATA.klinesBatch(symbols, '1d', 260, {
          concurrency: 4,
          onProgress: function (d, t) {
            bar.style.width = (10 + d / t * 40) + '%';
            $('sc-status').textContent = '抓日線 ' + d + '/' + t;
          }
        }).then(function (daily) {
          return DATA.klinesBatch(symbols, '4h', 260, {
            concurrency: 4,
            onProgress: function (d, t) {
              bar.style.width = (50 + d / t * 45) + '%';
              $('sc-status').textContent = '抓 4H ' + d + '/' + t;
            }
          }).then(function (h4) { return { daily: daily, h4: h4 }; });
        });
      })
      .then(function (k) {
        $('sc-status').textContent = '計算中…';
        var acct = account();
        var bySym = {};
        tickers.forEach(function (t) { bySym[t.symbol] = t; });
        var btcChg = bySym['BTCUSDT'] ? bySym['BTCUSDT'].changePct : 0;

        rows = [];
        symbols.forEach(function (sym) {
          var kd = k.daily[sym], k4 = k.h4[sym];
          if (!kd || !k4 || kd.length < 60 || k4.length < 60) return;
          var a1d = IND.analyze(kd), a4h = IND.analyze(k4);
          var t = bySym[sym] || {};
          var r = SCREENER.score(a1d, a4h, {
            changePct: t.changePct, btcChangePct: btcChg,
            quoteVolume: t.quoteVolume, fundingRate: funding[sym]
          });
          r.symbol = sym;
          r.price = t.last;
          r._atr = a4h.last.atr;
          r._swing = a4h.swing;
          r._filters = filters[sym] || undefined;
          // 依使用者的本金／風險／槓桿上限，算出可執行的部位計畫
          if (r.side !== 'neutral' && isNum(t.last)) {
            r.plan = PLAN.sizedPlan({
              side: r.side, price: t.last, atr: a4h.last.atr, swing: a4h.swing,
              equity: acct.equity, riskPct: acct.riskPct, maxLeverage: acct.maxLev,
              filters: filters[sym] || undefined
            });
          }
          rows.push(r);
        });

        var ranked = SCREENER.rank(rows, { minQuoteVolume: minVol });
        render(ranked);
        $('sc-status').textContent = '掃描 ' + rows.length + ' 個幣 · ' +
          new Date().toLocaleTimeString('en-GB');
        if (ranked.filteredOut > 0) {
          $('sc-warn').innerHTML = alertBox('info', '',
            '有 ' + ranked.filteredOut + ' 個幣因為 24h 成交額低於 ' +
            compact(minVol) + ' USDT 被剔除 —— 流動性太薄的合約，止損很容易被針掉。');
        }
      })
      .catch(function (e) {
        $('sc-warn').innerHTML = alertBox('danger', '掃描失敗',
          (e && e.message ? e.message : String(e)) +
          '<br>可能是網路、交易所地區封鎖，或請求太頻繁被限流。等一下再試。');
      })
      .finally(function () {
        btn.disabled = false;
        $('sc-prog').hidden = true;
        bar.style.width = '0';
      });
  }

  function table(list, kind) {
    if (!list.length) {
      return '<div class="empty">沒有符合條件的幣。' +
             (kind === 'long' ? '市場現在沒有明確偏多的標的。' : '市場現在沒有明確偏空的標的。') +
             '</div>';
    }
    var body = list.map(function (r) {
      var p = r.plan;
      var blocked = p && !p.feasible;
      var note = !p ? '—'
        : blocked ? (p.blockedBy === 'leverageCap' ? '超過槓桿上限' : '風險過大')
        : (p.forcedUp ? '風險被頂高' : '可做');
      var noteColor = !p ? '' : blocked ? 'var(--short)' : p.forcedUp ? 'var(--warn)' : 'var(--long)';

      return '<tr class="' + kind + '-row" data-sym="' + r.symbol + '" style="cursor:pointer' +
        (blocked ? ';opacity:.55' : '') + '">' +
        '<td>' + r.symbol.replace('USDT', '') + '</td>' +
        '<td style="color:' + (r.score > 0 ? 'var(--long)' : 'var(--short)') + '">' +
          (r.score >= 0 ? '+' : '') + r.score.toFixed(1) + '</td>' +
        '<td style="color:' + noteColor + '">' + note + '</td>' +
        '<td>' + (p ? px(p.entry) : '—') + '</td>' +
        '<td style="color:var(--stop)">' + (p ? px(p.stop) : '—') + '</td>' +
        '<td style="color:var(--safe)">' + (p ? px(p.targets[0].price) : '—') + '</td>' +
        '<td style="color:var(--safe)">' + (p ? px(p.targets[1].price) : '—') + '</td>' +
        '<td style="color:var(--short)">−' + (p ? usd(p.riskUsd) : '—') + '</td>' +
        '<td style="color:var(--long)">+' + (p ? usd(p.targets[0].usd) : '—') + '</td>' +
        '<td>' + (p ? usd(p.notional) : '—') + '</td>' +
        '<td>' + (p ? p.exchangeLeverage + 'x' : '—') + '</td>' +
        '<td class="' + dirCls(r.trend1d) + '">' + dirText(r.trend1d) + '</td>' +
        '<td class="' + dirCls(r.trend4h) + '">' + dirText(r.trend4h) + '</td>' +
        '<td>' + (isNum(r.relStrength) ? pct(r.relStrength) : '—') + '</td>' +
        '<td>' + (isNum(r.rsi) ? r.rsi.toFixed(0) : '—') + '</td>' +
        '<td>' + (isNum(r.fundingPct) ? r.fundingPct.toFixed(3) + '%' : '—') + '</td>' +
        '<td>' + compact(r.quoteVolume) + '</td></tr>';
    }).join('');
    return '<table class="tbl"><thead><tr>' +
      '<th>幣</th><th>分數</th><th>可行性</th><th>進場</th><th>止損</th><th>TP1</th><th>TP2</th>' +
      '<th>虧</th><th>賺(TP1)</th><th>名目</th><th>設定槓桿</th>' +
      '<th>1D</th><th>4H</th><th>對BTC</th><th>RSI</th><th>費率</th><th>量</th>' +
      '</tr></thead><tbody>' + body + '</tbody></table>';
  }

  function render(ranked) {
    $('longs').innerHTML = table(ranked.longs, 'long');
    $('shorts').innerHTML = table(ranked.shorts, 'short');
    $('detail').innerHTML = '';
  }

  // 點一列看評分理由
  document.addEventListener('click', function (e) {
    var tr = e.target.closest('tr[data-sym]');
    if (!tr) return;
    var r = rows.find(function (x) { return x.symbol === tr.dataset.sym; });
    if (!r) return;
    var p = r.plan;
    var planHtml = '';
    if (p) {
      planHtml = '<div class="kv">' +
        '<div><div class="k">方向</div><div class="v ' +
          (p.side === 'long' ? 'safe' : 'danger') + '">' +
          (p.side === 'long' ? '做多' : '做空') + '</div></div>' +
        '<div><div class="k">進場</div><div class="v">' + px(p.entry) + '</div></div>' +
        '<div><div class="k">止損</div><div class="v" style="color:var(--stop)">' + px(p.stop) +
          '</div><div class="s">' + p.stopDistPct.toFixed(2) + '%</div></div>' +
        '<div><div class="k">TP1 (1.5R)</div><div class="v" style="color:var(--safe)">' +
          px(p.targets[0].price) + '</div><div class="s">+' + usd(p.targets[0].usd) + '</div></div>' +
        '<div><div class="k">TP2 (3R)</div><div class="v" style="color:var(--safe)">' +
          px(p.targets[1].price) + '</div><div class="s">+' + usd(p.targets[1].usd) + '</div></div>' +
        '<div><div class="k">停損會虧</div><div class="v" style="color:var(--short)">−' +
          usd(p.riskUsd) + '</div><div class="s">本金的 ' + p.riskPctActual.toFixed(2) + '%</div></div>' +
        '<div><div class="k">下單數量</div><div class="v">' + p.qty + '</div>' +
          '<div class="s">這欄直接填進交易所</div></div>' +
        '<div><div class="k">部位名目</div><div class="v">' + usd(p.notional) + '</div>' +
          '<div class="s">本金的 ' + (p.leverage * 100).toFixed(0) + '%</div></div>' +
        '<div><div class="k">設定槓桿</div><div class="v">' + p.exchangeLeverage + 'x</div>' +
          '<div class="s">交易所最低只能設 1x</div></div>' +
        '<div><div class="k">佔用保證金</div><div class="v">' + usd(p.marginUsed) + '</div>' +
          '<div class="s">剩下的本金閒置</div></div>' +
        '<div><div class="k">爆倉價</div><div class="v" style="color:' +
          (p.liqFree ? 'var(--safe)' : 'var(--danger)') + '">' +
          (p.liqFree ? '不會爆倉' : px(p.liqPrice)) + '</div>' +
          '<div class="s">' + (p.liqFree ? '1x 做多，價格歸零才會爆'
                                         : '依 ' + p.exchangeLeverage + 'x 逐倉計算') + '</div></div>' +
        '<div><div class="k">來回手續費</div><div class="v">' + usd(p.feeUsd, 3) + '</div>' +
          '<div class="s">' + (isNum(p.feeR) ? p.feeR.toFixed(2) + ' R' : '—') + '</div></div>' +
        '</div>';
      if (!p.feasible) {
        planHtml += alertBox('danger', '這筆開不起來',
          p.blockedBy === 'leverageCap'
            ? '最小可下單的名目是 ' + usd(p.minNotional) + '，超過你的槓桿上限允許的 ' +
              usd(account().equity * account().maxLev) + '。要嘛提高槓桿上限，要嘛換一個最小下單金額低的幣。'
            : '單筆風險會超過本金的一半，這筆不該做。');
      } else if (p.forcedUp) {
        planHtml += alertBox('warn', '風險被最小下單量頂高了',
          '你想冒 ' + account().riskPct + '%，但最小可下單是 ' + p.minQty +
          '，實際會冒 <b>' + p.riskPctActual.toFixed(2) + '%</b>（' + usd(p.riskUsd) + '）。');
      }
      if (p.liqBeforeStop) {
        planHtml += alertBox('danger', '爆倉會發生在止損之前',
          '這個槓桿下爆倉價 ' + px(p.liqPrice) + ' 落在止損 ' + px(p.stop) +
          ' 之內，止損等於沒設。');
      }
      if (isNum(p.feeR) && p.feeR > 0.3) {
        planHtml += alertBox('warn', '手續費佔比偏高',
          '來回手續費等於 ' + p.feeR.toFixed(2) + ' R，你得先賺這麼多才回到原點。');
      }
    }

    $('detail').innerHTML =
      '<div class="sec"><h2>' + r.symbol + ' 的完整計畫</h2>' + planHtml +
      '<h2 style="margin-top:18px">評分細項</h2>' +
      '<div class="tbl-wrap"><table class="tbl"><thead><tr>' +
      '<th>項目</th><th>分數</th><th style="text-align:left">理由</th></tr></thead><tbody>' +
      r.reasons.map(function (x) {
        return '<tr><td>' + x.k + '</td><td>' + x.v + '</td>' +
               '<td style="text-align:left;white-space:normal;font-family:inherit">' + x.why + '</td></tr>';
      }).join('') +
      '<tr><td><b>合計</b></td><td><b>' + (r.score >= 0 ? '+' : '') + r.score.toFixed(1) +
      '</b></td><td style="text-align:left;font-family:inherit">' +
      (r.side === 'long' ? '偏多' : r.side === 'short' ? '偏空' : '中性（分數未達 ±2）') +
      '</td></tr></tbody></table></div></div>';
    $('detail').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });

  // 改了帳戶參數，已經掃出來的結果要跟著重算，不用重抓資料
  ['sc-equity', 'sc-risk', 'sc-lev'].forEach(function (id) {
    $(id).addEventListener('input', function () {
      if (!rows.length) return;
      var acct = account();
      rows.forEach(function (r) {
        if (r.side === 'neutral' || !isNum(r.price) || !r._atr) { r.plan = null; return; }
        r.plan = PLAN.sizedPlan({
          side: r.side, price: r.price, atr: r._atr, swing: r._swing,
          equity: acct.equity, riskPct: acct.riskPct, maxLeverage: acct.maxLev,
          filters: r._filters
        });
      });
      render(SCREENER.rank(rows, { minQuoteVolume: (parseFloat($('sc-vol').value) || 50) * 1e6 }));
    });
  });

  $('run-scan').addEventListener('click', scan);
  THEME.init();
})();
