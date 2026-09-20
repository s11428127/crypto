/*
 * indicators.js —— 技術指標運算（純函式，不碰 DOM、不連網路）
 *
 * 所有函式吃「由舊到新」排序的陣列，回傳等長陣列，
 * 暖身期不足的位置填 null —— 這樣索引永遠和 K 線對得上，畫圖不用再對位。
 */
(function (root) {
  'use strict';

  function isN(x) { return typeof x === 'number' && isFinite(x); }
  function nulls(n) { return new Array(n).fill(null); }

  /** 簡單移動平均 */
  function sma(vals, n) {
    var out = nulls(vals.length), sum = 0;
    for (var i = 0; i < vals.length; i++) {
      if (!isN(vals[i])) { sum = 0; continue; }
      sum += vals[i];
      if (i >= n) sum -= vals[i - n];
      if (i >= n - 1) out[i] = sum / n;
    }
    return out;
  }

  /** 指數移動平均。用前 n 根的 SMA 當種子，之後遞推 */
  function ema(vals, n) {
    var out = nulls(vals.length);
    if (vals.length < n) return out;
    var k = 2 / (n + 1), seed = 0;
    for (var i = 0; i < n; i++) seed += vals[i];
    out[n - 1] = seed / n;
    for (var j = n; j < vals.length; j++) out[j] = vals[j] * k + out[j - 1] * (1 - k);
    return out;
  }

  /** Wilder 平滑（RSI 與 ATR 用的，不是一般的 EMA） */
  function wilder(vals, n) {
    var out = nulls(vals.length);
    if (vals.length < n) return out;
    var seed = 0;
    for (var i = 0; i < n; i++) seed += vals[i];
    out[n - 1] = seed / n;
    for (var j = n; j < vals.length; j++) out[j] = (out[j - 1] * (n - 1) + vals[j]) / n;
    return out;
  }

  /** RSI（Wilder 原版） */
  function rsi(closes, n) {
    n = n || 14;
    var gains = [0], losses = [0];
    for (var i = 1; i < closes.length; i++) {
      var d = closes[i] - closes[i - 1];
      gains.push(d > 0 ? d : 0);
      losses.push(d < 0 ? -d : 0);
    }
    // 第一根沒有前一根可比，從 index 1 開始算
    var ag = wilder(gains.slice(1), n), al = wilder(losses.slice(1), n);
    var out = nulls(closes.length);
    for (var j = 0; j < ag.length; j++) {
      if (ag[j] === null || al[j] === null) continue;
      if (al[j] === 0) { out[j + 1] = 100; continue; }
      var rs = ag[j] / al[j];
      out[j + 1] = 100 - 100 / (1 + rs);
    }
    return out;
  }

  /** MACD：快線 − 慢線、訊號線、柱狀體 */
  function macd(closes, fast, slow, signal) {
    fast = fast || 12; slow = slow || 26; signal = signal || 9;
    var ef = ema(closes, fast), es = ema(closes, slow);
    var line = closes.map(function (_, i) {
      return (ef[i] === null || es[i] === null) ? null : ef[i] - es[i];
    });
    // 訊號線只對有值的部分做 EMA，再塞回原索引
    var firstIdx = line.findIndex(function (v) { return v !== null; });
    var sig = nulls(closes.length), hist = nulls(closes.length);
    if (firstIdx >= 0) {
      var compact = line.slice(firstIdx);
      var se = ema(compact, signal);
      for (var i = 0; i < se.length; i++) {
        if (se[i] === null) continue;
        sig[firstIdx + i] = se[i];
        hist[firstIdx + i] = line[firstIdx + i] - se[i];
      }
    }
    return { line: line, signal: sig, hist: hist };
  }

  /** 真實區間 True Range */
  function trueRange(highs, lows, closes) {
    var out = nulls(highs.length);
    for (var i = 0; i < highs.length; i++) {
      if (i === 0) { out[0] = highs[0] - lows[0]; continue; }
      out[i] = Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1])
      );
    }
    return out;
  }

  /** ATR（Wilder 平滑的 TR） */
  function atr(highs, lows, closes, n) {
    return wilder(trueRange(highs, lows, closes), n || 14);
  }

  /** 布林通道 */
  function bollinger(closes, n, mult) {
    n = n || 20; mult = mult || 2;
    var mid = sma(closes, n);
    var up = nulls(closes.length), lo = nulls(closes.length);
    for (var i = n - 1; i < closes.length; i++) {
      if (mid[i] === null) continue;
      var v = 0;
      for (var j = i - n + 1; j <= i; j++) v += Math.pow(closes[j] - mid[i], 2);
      var sd = Math.sqrt(v / n);
      up[i] = mid[i] + mult * sd;
      lo[i] = mid[i] - mult * sd;
    }
    return { mid: mid, upper: up, lower: lo };
  }

  /**
   * 擺盪高低點（樞紐 pivot）：左右各 lb 根都比它低（高）才算數。
   * 用來決定止損該放哪 —— 止損要放在結構外面，不是憑感覺抓個數字。
   */
  function pivots(highs, lows, lb) {
    lb = lb || 3;
    var hi = [], lo = [];
    for (var i = lb; i < highs.length - lb; i++) {
      var isHi = true, isLo = true;
      for (var j = i - lb; j <= i + lb; j++) {
        if (j === i) continue;
        if (highs[j] >= highs[i]) isHi = false;
        if (lows[j] <= lows[i]) isLo = false;
      }
      if (isHi) hi.push({ i: i, p: highs[i] });
      if (isLo) lo.push({ i: i, p: lows[i] });
    }
    return { highs: hi, lows: lo };
  }

  /** 最近一個擺盪低點／高點（找不到就退回區間極值） */
  function lastSwing(highs, lows, lb) {
    var p = pivots(highs, lows, lb);
    return {
      low:  p.lows.length  ? p.lows[p.lows.length - 1].p   : Math.min.apply(null, lows),
      high: p.highs.length ? p.highs[p.highs.length - 1].p : Math.max.apply(null, highs)
    };
  }

  /**
   * 單一時間框架的趨勢判讀。
   *
   * 只看「收盤在均線上方」會把橫盤誤判成趨勢 —— 均線幾乎貼在一起時，
   * 收盤在哪一邊純粹是雜訊。所以要求均線之間拉開足夠的距離才算數，
   * 門檻用 ATR（市場自己的波動尺度），沒有 ATR 時退回價格的 0.2%。
   */
  function trend(closes, e20, e50, e200, atrVal) {
    var i = closes.length - 1;
    var c = closes[i], a = e20[i], b = e50[i], d = e200[i];
    if (!isN(c) || !isN(b)) return { dir: 'range', reason: '資料不足' };

    var sep = isN(atrVal) && atrVal > 0 ? atrVal * 0.3 : Math.abs(c) * 0.002;

    if (isN(d)) {
      if (c > b && b - d > sep) return { dir: 'up',   reason: '收盤 > EMA50 > EMA200，均線發散' };
      if (c < b && d - b > sep) return { dir: 'down', reason: '收盤 < EMA50 < EMA200，均線發散' };
      if (Math.abs(b - d) <= sep) return { dir: 'range', reason: 'EMA50 與 EMA200 糾結' };
    }
    if (isN(a)) {
      if (c > a && a - b > sep) return { dir: 'up',   reason: '收盤站上發散的 EMA20/50' };
      if (c < a && b - a > sep) return { dir: 'down', reason: '收盤跌破發散的 EMA20/50' };
    }
    return { dir: 'range', reason: '均線糾結，無明確方向' };
  }

  /** 把一整串 K 線算成一組指標，給上層直接用 */
  function analyze(k, cfg) {
    cfg = cfg || {};
    var closes = k.map(function (x) { return x.c; });
    var highs  = k.map(function (x) { return x.h; });
    var lows   = k.map(function (x) { return x.l; });
    var e20 = ema(closes, 20), e50 = ema(closes, 50), e200 = ema(closes, 200);
    var a = atr(highs, lows, closes, cfg.atrLen || 14);
    var r = rsi(closes, cfg.rsiLen || 14);
    var m = macd(closes);
    var last = closes.length - 1;
    return {
      closes: closes, highs: highs, lows: lows,
      ema20: e20, ema50: e50, ema200: e200,
      atr: a, rsi: r, macd: m,
      bb: bollinger(closes),
      swing: lastSwing(highs, lows, cfg.pivotLb || 3),
      trend: trend(closes, e20, e50, e200, a[closes.length - 1]),
      last: {
        close: closes[last], ema20: e20[last], ema50: e50[last], ema200: e200[last],
        atr: a[last], rsi: r[last],
        macd: m.line[last], macdSignal: m.signal[last], macdHist: m.hist[last]
      }
    };
  }

  root.IND = {
    sma: sma, ema: ema, wilder: wilder, rsi: rsi, macd: macd,
    trueRange: trueRange, atr: atr, bollinger: bollinger,
    pivots: pivots, lastSwing: lastSwing, trend: trend, analyze: analyze
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
