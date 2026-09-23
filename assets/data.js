/*
 * data.js —— 行情資料層
 *
 * 只打交易所的「公開」端點：不需要 API key、不碰帳戶、不能下單。
 * 主來源 Binance U 本位永續，連不上（地區封鎖、網路政策）時自動退到 Bybit。
 *
 * 所有來源都正規化成同一種格式：
 *   K 線 { t, o, h, l, c, v }，由舊到新
 */
(function (root) {
  'use strict';

  var TIMEOUT = 12000;

  function fetchJSON(url, signal) {
    var ctl = new AbortController();
    var timer = setTimeout(function () { ctl.abort(); }, TIMEOUT);
    if (signal) signal.addEventListener('abort', function () { ctl.abort(); });
    return fetch(url, { signal: ctl.signal, cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .finally(function () { clearTimeout(timer); });
  }

  /* ---------- Binance U 本位永續 ---------- */
  var BINANCE = {
    id: 'binance',
    name: 'Binance',
    base: 'https://fapi.binance.com',
    // Binance 的 interval 字串就是我們用的字串
    intervals: { '15m': '15m', '1h': '1h', '4h': '4h', '1d': '1d' },
    klines: function (sym, tf, limit) {
      return fetchJSON(this.base + '/fapi/v1/klines?symbol=' + sym +
                       '&interval=' + this.intervals[tf] + '&limit=' + limit)
        .then(function (rows) {
          return rows.map(function (r) {
            return { t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] };
          });
        });
    },
    ticker: function (sym) {
      return fetchJSON(this.base + '/fapi/v1/ticker/24hr?symbol=' + sym)
        .then(function (d) {
          return {
            last: +d.lastPrice, changePct: +d.priceChangePercent,
            high: +d.highPrice, low: +d.lowPrice,
            volume: +d.volume, quoteVolume: +d.quoteVolume
          };
        });
    },
    funding: function (sym) {
      return fetchJSON(this.base + '/fapi/v1/premiumIndex?symbol=' + sym)
        .then(function (d) {
          return {
            markPrice: +d.markPrice, indexPrice: +d.indexPrice,
            rate: +d.lastFundingRate, nextTime: +d.nextFundingTime
          };
        });
    },
    openInterest: function (sym) {
      return fetchJSON(this.base + '/fapi/v1/openInterest?symbol=' + sym)
        .then(function (d) { return { oi: +d.openInterest, time: +d.time }; });
    },
    // 下單限制：用交易所回的真實數值，不用寫死的預設
    filters: function (sym) {
      return fetchJSON(this.base + '/fapi/v1/exchangeInfo').then(function (d) {
        var s = (d.symbols || []).find(function (x) { return x.symbol === sym; });
        if (!s) throw new Error('找不到 ' + sym);
        var f = {};
        s.filters.forEach(function (x) { f[x.filterType] = x; });
        return {
          minQty: +(f.LOT_SIZE && f.LOT_SIZE.minQty) || 0.001,
          stepSize: +(f.LOT_SIZE && f.LOT_SIZE.stepSize) || 0.001,
          minNotional: +(f.MIN_NOTIONAL && f.MIN_NOTIONAL.notional) || 100,
          pricePrecision: s.pricePrecision
        };
      });
    },
    // 一次 exchangeInfo 拿回「所有」幣的下單限制，篩選器每一列都要用
    filtersAll: function () {
      return fetchJSON(this.base + '/fapi/v1/exchangeInfo').then(function (d) {
        var m = {};
        (d.symbols || []).forEach(function (s) {
          var f = {};
          s.filters.forEach(function (x) { f[x.filterType] = x; });
          m[s.symbol] = {
            minQty: +(f.LOT_SIZE && f.LOT_SIZE.minQty) || 0.001,
            stepSize: +(f.LOT_SIZE && f.LOT_SIZE.stepSize) || 0.001,
            minNotional: +(f.MIN_NOTIONAL && f.MIN_NOTIONAL.notional) || 5,
            pricePrecision: s.pricePrecision
          };
        });
        return m;
      });
    },
    // 全市場 24h 行情：一次呼叫拿回所有合約，篩選器用
    allTickers: function () {
      return fetchJSON(this.base + '/fapi/v1/ticker/24hr').then(function (rows) {
        return rows.filter(function (d) { return /USDT$/.test(d.symbol); })
          .map(function (d) {
            return { symbol: d.symbol, last: +d.lastPrice, changePct: +d.priceChangePercent,
                     quoteVolume: +d.quoteVolume };
          });
      });
    },
    allFunding: function () {
      return fetchJSON(this.base + '/fapi/v1/premiumIndex').then(function (rows) {
        var m = {};
        (Array.isArray(rows) ? rows : [rows]).forEach(function (d) {
          m[d.symbol] = +d.lastFundingRate;
        });
        return m;
      });
    },
    wsUrl: function (sym) {
      return 'wss://fstream.binance.com/ws/' + sym.toLowerCase() + '@aggTrade';
    },
    wsPrice: function (msg) { return msg && msg.p ? +msg.p : null; }
  };

  /* ---------- Bybit（備援） ---------- */
  var BYBIT = {
    id: 'bybit',
    name: 'Bybit',
    base: 'https://api.bybit.com',
    intervals: { '15m': '15', '1h': '60', '4h': '240', '1d': 'D' },
    klines: function (sym, tf, limit) {
      return fetchJSON(this.base + '/v5/market/kline?category=linear&symbol=' + sym +
                       '&interval=' + this.intervals[tf] + '&limit=' + limit)
        .then(function (d) {
          // Bybit 回傳由新到舊，要反轉
          var rows = (d.result && d.result.list) || [];
          return rows.map(function (r) {
            return { t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] };
          }).reverse();
        });
    },
    ticker: function (sym) {
      return fetchJSON(this.base + '/v5/market/tickers?category=linear&symbol=' + sym)
        .then(function (d) {
          var t = (d.result && d.result.list && d.result.list[0]) || {};
          return {
            last: +t.lastPrice, changePct: +t.price24hPcnt * 100,
            high: +t.highPrice24h, low: +t.lowPrice24h,
            volume: +t.volume24h, quoteVolume: +t.turnover24h
          };
        });
    },
    funding: function (sym) {
      return fetchJSON(this.base + '/v5/market/tickers?category=linear&symbol=' + sym)
        .then(function (d) {
          var t = (d.result && d.result.list && d.result.list[0]) || {};
          return {
            markPrice: +t.markPrice, indexPrice: +t.indexPrice,
            rate: +t.fundingRate, nextTime: +t.nextFundingTime
          };
        });
    },
    openInterest: function (sym) {
      return fetchJSON(this.base + '/v5/market/tickers?category=linear&symbol=' + sym)
        .then(function (d) {
          var t = (d.result && d.result.list && d.result.list[0]) || {};
          return { oi: +t.openInterest, time: Date.now() };
        });
    },
    filters: function (sym) {
      return fetchJSON(this.base + '/v5/market/instruments-info?category=linear&symbol=' + sym)
        .then(function (d) {
          var s = (d.result && d.result.list && d.result.list[0]) || {};
          var lot = s.lotSizeFilter || {};
          return {
            minQty: +lot.minOrderQty || 0.001,
            stepSize: +lot.qtyStep || 0.001,
            minNotional: +lot.minNotionalValue || 5,
            pricePrecision: 2
          };
        });
    },
    filtersAll: function () {
      return fetchJSON(this.base + '/v5/market/instruments-info?category=linear').then(function (d) {
        var m = {};
        ((d.result && d.result.list) || []).forEach(function (s) {
          var lot = s.lotSizeFilter || {};
          m[s.symbol] = {
            minQty: +lot.minOrderQty || 0.001,
            stepSize: +lot.qtyStep || 0.001,
            minNotional: +lot.minNotionalValue || 5,
            pricePrecision: 2
          };
        });
        return m;
      });
    },
    allTickers: function () {
      return fetchJSON(this.base + '/v5/market/tickers?category=linear').then(function (d) {
        var list = (d.result && d.result.list) || [];
        return list.filter(function (x) { return /USDT$/.test(x.symbol); })
          .map(function (x) {
            return { symbol: x.symbol, last: +x.lastPrice,
                     changePct: +x.price24hPcnt * 100, quoteVolume: +x.turnover24h };
          });
      });
    },
    allFunding: function () {
      return fetchJSON(this.base + '/v5/market/tickers?category=linear').then(function (d) {
        var m = {};
        ((d.result && d.result.list) || []).forEach(function (x) { m[x.symbol] = +x.fundingRate; });
        return m;
      });
    },
    wsUrl: function (sym) { return 'wss://stream.bybit.com/v5/public/linear'; },
    wsSub: function (sym) {
      return JSON.stringify({ op: 'subscribe', args: ['publicTrade.' + sym] });
    },
    wsPrice: function (msg) {
      if (msg && msg.topic && msg.topic.indexOf('publicTrade') === 0 && msg.data && msg.data.length) {
        return +msg.data[msg.data.length - 1].p;
      }
      return null;
    }
  };

  var SOURCES = [BINANCE, BYBIT];
  var active = BINANCE;

  /** 依序嘗試各來源，第一個成功的就成為之後的主來源 */
  function withFallback(method, args) {
    var order = [active].concat(SOURCES.filter(function (s) { return s !== active; }));
    var errors = [];
    function attempt(i) {
      if (i >= order.length) {
        var e = new Error('所有資料來源都連不上：' + errors.join('；'));
        e.allFailed = true;
        throw e;
      }
      var src = order[i];
      return Promise.resolve()
        .then(function () { return src[method].apply(src, args); })
        .then(function (r) {
          if (src !== active) active = src;   // 換源成功，之後都走這裡
          return r;
        })
        .catch(function (err) {
          errors.push(src.name + ': ' + err.message);
          return attempt(i + 1);
        });
    }
    return attempt(0);
  }

  /** 一次把畫面需要的東西全抓回來。個別失敗不影響其他欄位。 */
  function snapshot(sym, timeframes, limit) {
    var tasks = timeframes.map(function (tf) {
      return withFallback('klines', [sym, tf, limit])
        .then(function (k) { return { tf: tf, k: k }; });
    });
    return Promise.all([
      Promise.all(tasks),
      withFallback('ticker', [sym]).catch(function () { return null; }),
      withFallback('funding', [sym]).catch(function () { return null; }),
      withFallback('openInterest', [sym]).catch(function () { return null; }),
      withFallback('filters', [sym]).catch(function () { return null; })
    ]).then(function (r) {
      var kl = {};
      r[0].forEach(function (x) { kl[x.tf] = x.k; });
      return {
        source: active.name,
        klines: kl,
        ticker: r[1],
        funding: r[2],
        openInterest: r[3],
        filters: r[4],
        at: Date.now()
      };
    });
  }

  /**
   * 即時價格。優先用 WebSocket；連不上就退回輪詢。
   * 回傳 stop() 讓呼叫端收拾。
   */
  function livePrice(sym, onPrice, onStatus) {
    var ws = null, poll = null, stopped = false, src = active;

    function startPolling(why) {
      if (stopped || poll) return;
      if (onStatus) onStatus({ mode: 'poll', reason: why });
      poll = setInterval(function () {
        withFallback('ticker', [sym])
          .then(function (t) { if (!stopped && t && isFinite(t.last)) onPrice(t.last); })
          .catch(function () {});
      }, 5000);
    }

    try {
      ws = new WebSocket(src.wsUrl(sym));
      ws.onopen = function () {
        if (onStatus) onStatus({ mode: 'ws' });
        if (src.wsSub) ws.send(src.wsSub(sym));
      };
      ws.onmessage = function (ev) {
        try {
          var p = src.wsPrice(JSON.parse(ev.data));
          if (p !== null && isFinite(p)) onPrice(p);
        } catch (e) {}
      };
      ws.onerror = function () { startPolling('WebSocket 錯誤'); };
      ws.onclose = function () { if (!stopped) startPolling('WebSocket 斷線'); };
    } catch (e) {
      startPolling('WebSocket 無法建立');
    }

    return function stop() {
      stopped = true;
      if (ws) { try { ws.onclose = null; ws.close(); } catch (e) {} }
      if (poll) clearInterval(poll);
    };
  }

  /**
   * 批次抓多個幣種的 K 線。限制並行數，避免觸發交易所的頻率限制。
   * 任何一個幣失敗不會中斷整批，該幣標成 null。
   */
  function klinesBatch(symbols, tf, limit, opts) {
    opts = opts || {};
    var concurrency = opts.concurrency || 4;
    var onProgress = opts.onProgress;
    var out = {}, idx = 0, done = 0;

    function worker() {
      if (idx >= symbols.length) return Promise.resolve();
      var sym = symbols[idx++];
      return withFallback('klines', [sym, tf, limit])
        .then(function (k) { out[sym] = k; })
        .catch(function () { out[sym] = null; })
        .then(function () {
          done++;
          if (onProgress) onProgress(done, symbols.length);
          return worker();
        });
    }
    var workers = [];
    for (var i = 0; i < Math.min(concurrency, symbols.length); i++) workers.push(worker());
    return Promise.all(workers).then(function () { return out; });
  }

  /** 回測要的：4H + 日線兩段歷史，日線要夠長才湊得出 EMA200 */
  function history(sym, opts) {
    opts = opts || {};
    return Promise.all([
      withFallback('klines', [sym, '4h', opts.bars4h || 1500]),
      withFallback('klines', [sym, '1d', opts.barsD || 1000]),
      withFallback('filters', [sym]).catch(function () { return null; })
    ]).then(function (r) {
      return { k4: r[0], d1: r[1], filters: r[2], source: active.name };
    });
  }

  root.DATA = {
    sources: SOURCES,
    activeName: function () { return active.name; },
    snapshot: snapshot,
    livePrice: livePrice,
    klinesBatch: klinesBatch,
    history: history,
    allTickers: function () { return withFallback('allTickers', []); },
    filtersAll: function () { return withFallback('filtersAll', []); },
    allFunding: function () { return withFallback('allFunding', []); },
    _fetchJSON: fetchJSON
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
