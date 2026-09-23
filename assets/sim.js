/*
 * sim.js —— 小資金帳戶的蒙地卡羅模擬（純函式，不需要行情資料）
 *
 * 回答的問題是：「用 X 美金、每筆冒 Y% 風險、勝率 Z%、盈虧比 1:N，
 * 做 M 筆之後會變怎樣？」
 *
 * 這不是預測市場，是把「已知的勝率與盈虧比」丟進骰子裡看結果分布。
 * 重點在於它會把兩個小資金特有的摩擦算進去：
 *   1. 交易所最小下單量 —— 部位切不細，被迫冒比你想要的更高的風險
 *   2. 手續費是按名目算的 —— 高槓桿把名目放大，費用跟著放大
 */
(function (root) {
  'use strict';

  var R = root.RISK;
  function isNum(x) { return typeof x === 'number' && isFinite(x); }

  /** 可重現的亂數（同樣的 seed give 同樣的結果，方便驗算） */
  function rng(seed) {
    var s = seed >>> 0 || 1;
    return function () {
      s ^= s << 13; s >>>= 0;
      s ^= s >> 17;
      s ^= s << 5;  s >>>= 0;
      return s / 4294967296;
    };
  }

  /**
   * 單筆交易在目前權益下實際能冒多少風險。
   * 想冒的 riskPct 常常做不到 —— 最小下單量會把它頂上去。
   */
  function tradeSizing(equity, opts) {
    var wantRisk = equity * opts.riskPct / 100;
    var stopDist = opts.price * opts.stopPct / 100;
    var wantQty = wantRisk / stopDist;

    var feas = R.feasibility({
      equity: equity, entry: opts.price,
      stop: opts.price * (1 - opts.stopPct / 100),
      filters: opts.filters
    });

    var qty = R.floorToStep(wantQty, opts.filters.stepSize);
    var forced = false;
    if (qty < feas.minQty) { qty = feas.minQty; forced = true; }

    var notional = qty * opts.price;
    var riskAmt = qty * stopDist;
    var lev = notional / equity;

    return {
      qty: qty, notional: notional, riskAmt: riskAmt,
      riskPctActual: riskAmt / equity * 100,
      leverage: lev, forcedUp: forced,
      // 槓桿超過上限，或單筆風險大於半個帳戶 → 這筆做不了
      tradeable: lev <= opts.maxLeverage && riskAmt < equity * 0.5
    };
  }

  /**
   * 跑一次序列，回傳最終權益與過程。
   */
  function oneRun(opts, rand) {
    var equity = opts.equity;
    var peak = equity, maxDD = 0;
    var done = 0, blocked = 0, wins = 0;
    var feeTotal = 0;
    var curve = [equity];

    for (var i = 0; i < opts.nTrades; i++) {
      var s = tradeSizing(equity, opts);
      if (!s.tradeable) { blocked++; break; }   // 帳戶小到開不了最小倉 = 出局

      var fee = s.notional * opts.feeRate * 2;  // 開 + 平
      feeTotal += fee;
      equity -= fee;

      if (rand() < opts.winRate) { equity += s.riskAmt * opts.rr; wins++; }
      else { equity -= s.riskAmt; }

      done++;
      peak = Math.max(peak, equity);
      maxDD = Math.max(maxDD, (peak - equity) / peak);
      curve.push(equity);

      if (equity <= opts.equity * 0.05) break;  // 實質歸零
    }

    return {
      equity: equity, trades: done, wins: wins, blocked: blocked > 0,
      maxDD: maxDD * 100, fees: feeTotal, curve: curve
    };
  }

  function pct(sorted, p) {
    if (!sorted.length) return null;
    var idx = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
    return sorted[idx];
  }

  /**
   * 跑 runs 次，回傳結果分布。
   */
  function monteCarlo(opts) {
    var o = {
      equity: isNum(opts.equity) ? opts.equity : 100,
      riskPct: isNum(opts.riskPct) ? opts.riskPct : 1,
      winRate: isNum(opts.winRate) ? opts.winRate : 0.5,
      rr: isNum(opts.rr) ? opts.rr : 1.5,
      nTrades: isNum(opts.nTrades) ? opts.nTrades : 100,
      price: isNum(opts.price) ? opts.price : 80000,
      stopPct: isNum(opts.stopPct) ? opts.stopPct : 2,
      feeRate: isNum(opts.feeRate) ? opts.feeRate : 0.00045,
      maxLeverage: isNum(opts.maxLeverage) ? opts.maxLeverage : 20,
      filters: opts.filters || R.DEFAULT_FILTERS
    };
    var runs = isNum(opts.runs) ? opts.runs : 2000;
    var rand = rng(opts.seed || 12345);

    var finals = [], ruins = 0, doubles = 0, blocked = 0;
    var tradeSum = 0, ddSum = 0, feeSum = 0;
    var sample = null;

    for (var i = 0; i < runs; i++) {
      var r = oneRun(o, rand);
      finals.push(r.equity);
      if (r.equity <= o.equity * 0.5) ruins++;
      if (r.equity >= o.equity * 2) doubles++;
      if (r.blocked) blocked++;
      tradeSum += r.trades; ddSum += r.maxDD; feeSum += r.fees;
      if (i === 0) sample = r.curve;
    }

    finals.sort(function (a, b) { return a - b; });
    var mean = finals.reduce(function (a, b) { return a + b; }, 0) / finals.length;

    // 第一筆交易的部位資訊 —— 用來說明「想冒的風險做不做得到」
    var first = tradeSizing(o.equity, o);

    return {
      input: o, runs: runs,
      median: pct(finals, 0.5), mean: mean,
      p5: pct(finals, 0.05), p25: pct(finals, 0.25),
      p75: pct(finals, 0.75), p95: pct(finals, 0.95),
      worst: finals[0], best: finals[finals.length - 1],
      ruinPct: ruins / runs * 100,          // 剩不到一半
      doublePct: doubles / runs * 100,
      blockedPct: blocked / runs * 100,     // 小到開不了倉
      avgTrades: tradeSum / runs,
      avgMaxDD: ddSum / runs,
      avgFees: feeSum / runs,
      sizing: first,
      sampleCurve: sample,
      // 需要畫分布圖時才帶回完整樣本（已排序），否則省記憶體
      finals: opts.keepFinals ? finals : null,
      // 理論每筆期望值（以 R 為單位，扣掉手續費）
      expectancyR: o.winRate * o.rr - (1 - o.winRate),
      feeR: first.riskAmt > 0 ? (first.notional * o.feeRate * 2) / first.riskAmt : null
    };
  }

  root.SIM = { monteCarlo: monteCarlo, tradeSizing: tradeSizing, oneRun: oneRun, rng: rng };
})(typeof globalThis !== 'undefined' ? globalThis : this);
