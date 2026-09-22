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
    var tickers, funding, symbols;

    Promise.all([DATA.allTickers(), DATA.allFunding().catch(function () { return {}; })])
      .then(function (r) {
        tickers = r[0]; funding = r[1];
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
      return '<tr class="' + kind + '-row" data-sym="' + r.symbol + '" style="cursor:pointer">' +
        '<td>' + r.symbol.replace('USDT', '') + '</td>' +
        '<td style="color:' + (r.score > 0 ? 'var(--long)' : 'var(--short)') + '">' +
          (r.score >= 0 ? '+' : '') + r.score.toFixed(1) + '</td>' +
        '<td class="' + dirCls(r.trend1d) + '">' + dirText(r.trend1d) + '</td>' +
        '<td class="' + dirCls(r.trend4h) + '">' + dirText(r.trend4h) + '</td>' +
        '<td>' + (isNum(r.changePct) ? pct(r.changePct) : '—') + '</td>' +
        '<td>' + (isNum(r.relStrength) ? pct(r.relStrength) : '—') + '</td>' +
        '<td>' + (isNum(r.rsi) ? r.rsi.toFixed(0) : '—') + '</td>' +
        '<td>' + (isNum(r.atrPct) ? r.atrPct.toFixed(2) + '%' : '—') + '</td>' +
        '<td>' + (isNum(r.fundingPct) ? r.fundingPct.toFixed(3) + '%' : '—') + '</td>' +
        '<td>' + compact(r.quoteVolume) + '</td></tr>';
    }).join('');
    return '<table class="tbl"><thead><tr>' +
      '<th>幣</th><th>分數</th><th>1D</th><th>4H</th><th>24h</th><th>對BTC</th>' +
      '<th>RSI</th><th>ATR%</th><th>費率</th><th>量</th>' +
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
    $('detail').innerHTML =
      '<div class="sec"><h2>' + r.symbol + ' 的評分細項</h2>' +
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

  $('run-scan').addEventListener('click', scan);
  THEME.init();
})();
