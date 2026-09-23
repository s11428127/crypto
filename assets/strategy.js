/*
 * strategy.js —— 規則 v2：順大勢、等回檔、移動止損（純函式）
 *
 * 回測與即時機器人共用這一份。v1 的問題之一是即時機器人用了 15m 時機，
 * 回測卻測不了 15m，兩邊跑的其實不是同一套規則。v2 只用 4H + 日線。
 *
 * 每一條規則都對應一個實際踩過的坑：
 *
 *   大方向過濾   日線收盤在 EMA200 之上只做多、之下只做空
 *                → 不在牛市裡做空、不在熊市裡接刀（v1 回測：空單在牛市平均 −0.50R）
 *   順 4H 趨勢   EMA20 在 EMA50 之上、收盤在 EMA50 之上（做空反過來）
 *   等回檔再進   最近 3 根內有碰到 EMA20 附近，且收盤重新站回 EMA20
 *   不追價       收盤離 EMA20 超過 1 個 ATR、或 RSI > 70（做空 < 30）就不進
 *                → 「剛剛暴漲沒追到，再追高」
 *   止損放結構外 最近 5 根的最低點再往外 0.25 ATR，距離夾在 1～3 ATR
 *                → 太近會被雜訊掃掉（「止損後又漲回去」）
 *   只進不退     賺到 1R 後止損移到成本；之後用「進場以來最高價 − 3 ATR」跟著往上
 *                → 止損永遠不往後退（「撐一下就回來」）
 *   冷卻期       同一個幣止損後 6 根 4H（24 小時）不再進場
 *                → 虧了想馬上扳回來
 *   部位由 ATR 算 風險固定佔本金 1%，止損遠（波動大）部位就自動變小
 *                → 不熟的幣波動大，卻開高槓桿
 *
 * 參數在跑回測之前就定下來，不會為了讓結果好看回頭調。
 */
(function (root) {
  'use strict';

  var I = root.IND, R = root.RISK;
  function isNum(x) { return typeof x === 'number' && isFinite(x); }

  var PARAMS = Object.freeze({
    regimeEma: 200,          // 日線大方向
    touchAtr: 0.5,           // 「碰到 EMA20 附近」的容忍距離
    touchLookback: 3,        // 最近幾根內有回檔
    maxExtAtr: 1.0,          // 離 EMA20 超過幾個 ATR 算追價
    rsiLong: 70, rsiShort: 30,
    swingLookback: 5,        // 止損參考最近幾根的高低點
    stopBufAtr: 0.25,
    minStopAtr: 1.0, maxStopAtr: 3.0,
    breakevenR: 1.0,         // 賺到幾 R 後止損移到成本
    trailAtr: 3.0,           // 移動止損：最高價 − 幾個 ATR
    cooldownBars: 6          // 止損後冷卻幾根 4H
  });

  var H4 = 4 * 3600 * 1000, DAY = 86400000;

  /**
   * 把 4H 與日線算成一包可以用索引查的資料。
   * dIdx[i] = 第 i 根 4H **收盤當下**已經收盤的最後一根日線（沒有就是 −1）。
   * 日線 D 在 D+1 00:00 收盤，所以 20:00–24:00 那根 4H 收盤時，日線 D 剛好可以用。
   */
  function prepare(k4, d1) {
    var c = k4.map(function (b) { return b.c; });
    var h = k4.map(function (b) { return b.h; });
    var l = k4.map(function (b) { return b.l; });
    var dc = d1.map(function (b) { return b.c; });
    var dIdx = new Array(k4.length);
    var j = -1;
    for (var i = 0; i < k4.length; i++) {
      var closeAt = k4[i].t + H4;
      while (j + 1 < d1.length && d1[j + 1].t + DAY <= closeAt) j++;
      dIdx[i] = j;
    }
    return {
      k4: k4, d1: d1, c: c, h: h, l: l,
      e20: I.ema(c, 20), e50: I.ema(c, 50),
      atr: I.atr(h, l, c, 14), rsi: I.rsi(c, 14),
      dc: dc, dEma: I.ema(dc, PARAMS.regimeEma),
      dIdx: dIdx
    };
  }

  /** 日線大方向：'bull' / 'bear' / null（資料不足） */
  function regime(ctx, i) {
    var d = ctx.dIdx[i];
    if (d < 0 || !isNum(ctx.dEma[d])) return null;
    return ctx.dc[d] > ctx.dEma[d] ? 'bull' : 'bear';
  }

  /**
   * 第 i 根 4H 收盤時，有沒有進場訊號。只用 ≤ i 的資料。
   * 回傳 null 或 { side, stop, why }；進場價由呼叫端用「下一根開盤」或即時價。
   */
  function signal(ctx, i, p) {
    p = p || PARAMS;
    var atr = ctx.atr[i], e20 = ctx.e20[i], e50 = ctx.e50[i], c = ctx.c[i], rsi = ctx.rsi[i];
    if (!isNum(atr) || atr <= 0 || !isNum(e20) || !isNum(e50) || !isNum(rsi)) return null;
    var rg = regime(ctx, i);
    if (!rg) return null;
    var from = Math.max(0, i - p.touchLookback + 1);
    var k, lo, hi;

    if (rg === 'bull') {
      if (!(e20 > e50 && c > e50)) return null;                    // 4H 也要是多頭
      var touched = false;
      for (k = from; k <= i; k++) if (ctx.l[k] <= ctx.e20[k] + p.touchAtr * atr) touched = true;
      if (!touched) return null;                                    // 沒回檔，不追
      if (!(c > e20)) return null;                                  // 還沒站回
      if (c - e20 > p.maxExtAtr * atr) return null;                 // 離均線太遠
      if (rsi > p.rsiLong) return null;                             // 過熱
      lo = Infinity;
      for (k = Math.max(0, i - p.swingLookback + 1); k <= i; k++) lo = Math.min(lo, ctx.l[k]);
      var dL = c - (lo - p.stopBufAtr * atr);
      dL = Math.min(Math.max(dL, p.minStopAtr * atr), p.maxStopAtr * atr);
      return { side: 'long', stop: c - dL, why: '日線在 EMA200 之上、4H 多頭，回檔到 EMA20 後站回' };
    }

    if (!(e20 < e50 && c < e50)) return null;
    var touchedS = false;
    for (k = from; k <= i; k++) if (ctx.h[k] >= ctx.e20[k] - p.touchAtr * atr) touchedS = true;
    if (!touchedS) return null;
    if (!(c < e20)) return null;
    if (e20 - c > p.maxExtAtr * atr) return null;
    if (rsi < p.rsiShort) return null;
    hi = -Infinity;
    for (k = Math.max(0, i - p.swingLookback + 1); k <= i; k++) hi = Math.max(hi, ctx.h[k]);
    var dS = (hi + p.stopBufAtr * atr) - c;
    dS = Math.min(Math.max(dS, p.minStopAtr * atr), p.maxStopAtr * atr);
    return { side: 'short', stop: c + dS, why: '日線在 EMA200 之下、4H 空頭，反彈到 EMA20 後跌回' };
  }

  /**
   * 沒有訊號時，說明卡在哪一條規則（給即時狀態表看）。有訊號時回傳 null。
   * 判斷順序和 signal() 完全一樣。
   */
  function explain(ctx, i, p) {
    p = p || PARAMS;
    if (signal(ctx, i, p)) return null;
    var atr = ctx.atr[i], e20 = ctx.e20[i], e50 = ctx.e50[i], c = ctx.c[i], rsi = ctx.rsi[i];
    if (!isNum(atr) || !isNum(e20) || !isNum(e50) || !isNum(rsi)) return '4H 指標資料不足';
    var rg = regime(ctx, i);
    if (!rg) return '日線 EMA200 資料不足';
    var from = Math.max(0, i - p.touchLookback + 1), k;
    if (rg === 'bull') {
      if (!(e20 > e50 && c > e50)) return '日線多頭，但 4H 不是多頭排列，等 4H 轉強';
      var t = false;
      for (k = from; k <= i; k++) if (ctx.l[k] <= ctx.e20[k] + p.touchAtr * atr) t = true;
      if (!t) return '多頭中，但沒有回檔到 EMA20，不追價';
      if (!(c > e20)) return '回檔中，等收盤重新站回 EMA20';
      if (c - e20 > p.maxExtAtr * atr) return '離 EMA20 太遠（' + ((c - e20) / atr).toFixed(1) + ' ATR），不追價';
      if (rsi > p.rsiLong) return 'RSI ' + rsi.toFixed(0) + ' 過熱，不追價';
      return '條件未滿足';
    }
    if (!(e20 < e50 && c < e50)) return '日線空頭，4H 不是空頭排列，不做';
    var ts = false;
    for (k = from; k <= i; k++) if (ctx.h[k] >= ctx.e20[k] - p.touchAtr * atr) ts = true;
    if (!ts) return '空頭中，但沒有反彈到 EMA20，不追空';
    if (!(c < e20)) return '反彈中，等收盤重新跌破 EMA20';
    if (e20 - c > p.maxExtAtr * atr) return '離 EMA20 太遠，不追空';
    if (rsi < p.rsiShort) return 'RSI ' + rsi.toFixed(0) + ' 過冷，不追空';
    return '條件未滿足';
  }

  /**
   * 第 i 根收盤後更新止損（下一根開始生效）。**只會往有利方向移，永遠不後退。**
   * pos 需要：side, entry, stop, initRisk（進場時每單位的風險距離）, best（進場以來最有利價）
   */
  function trail(pos, ctx, i, p) {
    p = p || PARAMS;
    var atr = ctx.atr[i];
    var stop = pos.stop;
    if (pos.side === 'long') {
      var best = Math.max(pos.best, ctx.h[i]);
      if (best - pos.entry >= p.breakevenR * pos.initRisk) stop = Math.max(stop, pos.entry);
      if (isNum(atr)) stop = Math.max(stop, best - p.trailAtr * atr);
      return { stop: stop, best: best };
    }
    var bestS = Math.min(pos.best, ctx.l[i]);
    if (pos.entry - bestS >= p.breakevenR * pos.initRisk) stop = Math.min(stop, pos.entry);
    if (isNum(atr)) stop = Math.min(stop, bestS + p.trailAtr * atr);
    return { stop: stop, best: bestS };
  }

  /** 這一根有沒有打到止損。跳空越過止損時，以開盤價出場（比止損價更差，照實算） */
  function hitStop(pos, bar) {
    if (pos.side === 'long') {
      if (bar.o <= pos.stop) return bar.o;
      if (bar.l <= pos.stop) return pos.stop;
      return null;
    }
    if (bar.o >= pos.stop) return bar.o;
    if (bar.h >= pos.stop) return pos.stop;
    return null;
  }

  /** 依風險算數量：捨去到跳動單位，不足最小下單量就頂上去 */
  function size(equity, entry, stop, o) {
    var f = o.filters || R.DEFAULT_FILTERS;
    var dist = Math.abs(entry - stop);
    if (!(dist > 0)) return null;
    var qty = R.floorToStep(equity * o.riskPct / 100 / dist, f.stepSize);
    var minQ = R.feasibility({ equity: equity, entry: entry, stop: stop, filters: f }).minQty;
    if (qty < minQ) qty = minQ;
    var notional = qty * entry, riskUsd = qty * dist;
    if (notional > equity * o.maxLeverage + 1e-9) return { blocked: 'leverage' };
    if (riskUsd / equity * 100 > o.maxRiskPct + 1e-9) return { blocked: 'risk' };
    return { qty: qty, notional: notional, riskUsd: riskUsd };
  }

  /**
   * 回測。輸出格式與 BACKTEST.run 相同，方便並排比較。
   * 決策在第 i 根收盤，進場在第 i+1 根開盤；出場用第 i 根的開高低判斷（跳空照實算）。
   */
  function backtest(k4, d1, opts) {
    opts = opts || {};
    var o = {
      equity: isNum(opts.equity) ? opts.equity : 100,
      riskPct: isNum(opts.riskPct) ? opts.riskPct : 1,
      maxRiskPct: isNum(opts.maxRiskPct) ? opts.maxRiskPct : 5,
      maxLeverage: isNum(opts.maxLeverage) ? opts.maxLeverage : 5,
      feeRate: isNum(opts.feeRate) ? opts.feeRate : 0.00055,
      fundingPer8h: isNum(opts.fundingPer8h) ? opts.fundingPer8h : 0.0001,
      filters: opts.filters,
      params: opts.params || PARAMS
    };
    if (!k4 || k4.length < 300) return { error: '4H K 線不足 300 根，實際 ' + (k4 ? k4.length : 0) };
    if (!d1 || d1.length < 210) return { error: '日線不足 210 根（EMA200 需要暖身），實際 ' + (d1 ? d1.length : 0) };

    var ctx = prepare(k4, d1);
    var equity = o.equity, peak = equity, maxDD = 0;
    var trades = [], curve = [], pos = null, feesPaid = 0, fundingPaid = 0;
    var cooldownUntil = -1, skipped = { infeasible: 0, cooldown: 0 };

    // 從日線 EMA200 算得出來的那一根開始（之前沒有大方向可判斷）
    var start = 60;
    while (start < k4.length && !regime(ctx, start)) start++;
    if (start >= k4.length - 1) return { error: '日線 EMA200 暖身後沒有剩下可以回測的 4H K 線' };

    for (var i = start; i < k4.length; i++) {
      var bar = k4[i];

      // ── 持倉：先用這一根判斷出場，再收資金費，最後更新止損 ──
      if (pos) {
        var exitPx = hitStop(pos, bar);
        if (exitPx === null && i % 2 === 0) {
          var fc = pos.notional * o.fundingPer8h;
          fundingPaid += fc; equity -= fc; pos.funding += fc;
        }
        if (exitPx !== null) {
          var gross = pos.side === 'long' ? (exitPx - pos.entry) * pos.qty : (pos.entry - exitPx) * pos.qty;
          var exitFee = pos.qty * exitPx * o.feeRate;
          feesPaid += exitFee;
          equity += gross - exitFee;
          var pnl = gross - exitFee - pos.entryFee - pos.funding;
          trades.push({ t: pos.t, exitT: bar.t, side: pos.side, entry: pos.entry, stop: pos.initStop,
                        exit: exitPx, qty: pos.qty, notional: pos.notional, pnl: pnl,
                        r: pnl / pos.riskUsd, funding: pos.funding,
                        // 止損從沒動過 → 原始止損；動過（保本或移動止損）→ trail
                        why: pos.stop === pos.initStop ? 'stop' : 'trail', equityAfter: equity });
          if (pnl <= 0) cooldownUntil = i + o.params.cooldownBars;
          pos = null;
        } else {
          var tr = trail(pos, ctx, i, o.params);
          pos.stop = tr.stop; pos.best = tr.best;
        }
      }

      peak = Math.max(peak, equity);
      maxDD = Math.max(maxDD, (peak - equity) / peak);
      curve.push({ t: bar.t, equity: equity });
      if (equity <= o.equity * 0.05) break;

      // ── 空手：第 i 根收盤判斷，第 i+1 根開盤進場 ──
      if (!pos && i + 1 < k4.length) {
        var sig = signal(ctx, i, o.params);
        if (!sig) continue;
        if (i < cooldownUntil) { skipped.cooldown++; continue; }
        var entry = k4[i + 1].o;
        // 跳空已經越過止損就不進
        if (sig.side === 'long' ? entry <= sig.stop : entry >= sig.stop) continue;
        var sz = size(equity, entry, sig.stop, o);
        if (!sz || sz.blocked) { skipped.infeasible++; continue; }
        var fee = sz.notional * o.feeRate;
        feesPaid += fee; equity -= fee;
        pos = { t: k4[i + 1].t, side: sig.side, entry: entry, stop: sig.stop, initStop: sig.stop,
                initRisk: Math.abs(entry - sig.stop), best: entry, qty: sz.qty,
                notional: sz.notional, riskUsd: sz.riskUsd, entryFee: fee, funding: 0 };
      }
    }

    if (pos) {
      var lastPx = k4[k4.length - 1].c;
      var g = pos.side === 'long' ? (lastPx - pos.entry) * pos.qty : (pos.entry - lastPx) * pos.qty;
      var ef = pos.qty * lastPx * o.feeRate;
      feesPaid += ef; equity += g - ef;
      var pl = g - ef - pos.entryFee - pos.funding;
      trades.push({ t: pos.t, exitT: k4[k4.length - 1].t, side: pos.side, entry: pos.entry,
                    stop: pos.initStop, exit: lastPx, qty: pos.qty, notional: pos.notional,
                    pnl: pl, r: pl / pos.riskUsd, funding: pos.funding, why: 'close', equityAfter: equity });
    }

    return root.BACKTEST.stats(trades, curve, {
      equity0: o.equity, equity: equity, maxDD: maxDD, feesPaid: feesPaid,
      fundingPaid: fundingPaid, skipped: skipped, from: k4[start].t, to: k4[k4.length - 1].t
    });
  }

  root.STRATEGY = {
    PARAMS: PARAMS, prepare: prepare, regime: regime, signal: signal, explain: explain,
    trail: trail, hitStop: hitStop, size: size, backtest: backtest
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
