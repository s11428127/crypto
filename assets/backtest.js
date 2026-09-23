/*
 * backtest.js —— 歷史回測引擎（純函式）
 *
 * 唯一的重點：**不能偷看未來**。
 * 回測最容易犯的錯是在第 i 根就用到第 i+1 根以後的資料，
 * 這會讓績效看起來好得離譜。這支檔案的每個決策點都只用 ≤ i 的資料，
 * 而且樞紐高低點（需要右側確認）還要再往回退 lb 根。
 */
(function (root) {
  'use strict';

  var I = root.IND, R = root.RISK, P = root.PLAN;

  function isNum(x) { return typeof x === 'number' && isFinite(x); }

  /** 把 4H K 線併成日線（以 UTC 日界切） */
  function resampleToDaily(k4) {
    var out = [], cur = null, curDay = null;
    for (var i = 0; i < k4.length; i++) {
      var b = k4[i];
      var day = Math.floor(b.t / 86400000);
      if (day !== curDay) {
        if (cur) out.push(cur);
        curDay = day;
        cur = { t: day * 86400000, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v };
      } else {
        cur.h = Math.max(cur.h, b.h);
        cur.l = Math.min(cur.l, b.l);
        cur.c = b.c;
        cur.v += b.v;
      }
    }
    if (cur) out.push(cur);
    return out;
  }

  /** 找出時間 ts 之前最後一根「已經收盤」的日線索引（二分搜尋） */
  function lastClosedDaily(d1, ts) {
    var lo = 0, hi = d1.length - 1, ans = -1;
    var dayStart = Math.floor(ts / 86400000) * 86400000;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (d1[mid].t < dayStart) { ans = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return ans;
  }

  /** 第 i 根（含）之前最後一個「已確認」的樞紐高低點 */
  function swingUpTo(highs, lows, i, lb) {
    lb = lb || 3;
    var lo = null, hi = null;
    // 樞紐要左右各 lb 根確認，所以最新可用的樞紐最多在 i-lb
    for (var j = i - lb; j >= lb; j--) {
      var isHi = hi === null, isLo = lo === null;
      if (!isHi && !isLo) break;
      for (var m = j - lb; m <= j + lb; m++) {
        if (m === j) continue;
        if (highs[m] >= highs[j]) isHi = false;
        if (lows[m] <= lows[j]) isLo = false;
      }
      if (isHi && hi === null) hi = highs[j];
      if (isLo && lo === null) lo = lows[j];
    }
    // 找不到樞紐就退回近期極值
    var from = Math.max(0, i - 40);
    if (lo === null) { lo = Infinity; for (var a = from; a <= i; a++) lo = Math.min(lo, lows[a]); }
    if (hi === null) { hi = -Infinity; for (var b2 = from; b2 <= i; b2++) hi = Math.max(hi, highs[b2]); }
    return { low: lo, high: hi };
  }

  /**
   * 跑一次回測。
   *
   * k4：4H K 線（由舊到新）。日線由它併出來，所以兩個框架天生對齊。
   * opts：
   *   equity      起始本金 USDT
   *   riskPct     單筆風險 %
   *   feeRate     單邊吃單費率（預設 0.045%）
   *   fundingPer8h 平均資金費率（預設 0.01%，持倉才收）
   *   filters     交易所下單限制
   *   maxLeverage 槓桿上限（超過就縮小部位）
   *   daily       日線 K 線。交易所可以直接給，比用 4H 併出來的長得多
   *               （1500 根日線 ≈ 4 年，1500 根 4H 併出來只有 250 天，
   *                連日線 EMA200 都湊不齊）。沒給才退回用 4H 併。
   */
  function run(k4, opts) {
    opts = opts || {};
    var equity0 = isNum(opts.equity) ? opts.equity : 100;
    var riskPct = isNum(opts.riskPct) ? opts.riskPct : 1;
    var feeRate = isNum(opts.feeRate) ? opts.feeRate : 0.00045;
    var fund8h = isNum(opts.fundingPer8h) ? opts.fundingPer8h : 0.0001;
    var filters = opts.filters || R.DEFAULT_FILTERS;
    var maxLev = isNum(opts.maxLeverage) ? opts.maxLeverage : 20;
    var rMultiples = opts.rMultiples || [1.5, 3];

    if (!k4 || k4.length < 250) {
      return { error: 'K 線不足（需要至少 250 根 4H），實際 ' + (k4 ? k4.length : 0) + ' 根' };
    }

    // 日線優先用交易所直接給的；沒有才用 4H 併（歷史會短很多）
    var d1 = (opts.daily && opts.daily.length >= 60) ? opts.daily : resampleToDaily(k4);
    var MIN_DAILY = 60;   // EMA50 需要 50 根；EMA200 湊不齊時 trend() 會退回 EMA20/50
    // 每根 4H 對應到「當下已收盤」的日線索引
    var dayIndex = {};
    d1.forEach(function (b, idx) { dayIndex[Math.floor(b.t / 86400000)] = idx; });

    var c4 = k4.map(function (x) { return x.c; });
    var h4 = k4.map(function (x) { return x.h; });
    var l4 = k4.map(function (x) { return x.l; });
    var e20 = I.ema(c4, 20), e50 = I.ema(c4, 50), e200 = I.ema(c4, 200);
    var atr4 = I.atr(h4, l4, c4, 14);
    var rsi4 = I.rsi(c4, 14);

    var cd = d1.map(function (x) { return x.c; });
    var hd = d1.map(function (x) { return x.h; });
    var ld = d1.map(function (x) { return x.l; });
    var de20 = I.ema(cd, 20), de50 = I.ema(cd, 50), de200 = I.ema(cd, 200);
    var atrD = I.atr(hd, ld, cd, 14);

    var equity = equity0;
    var peak = equity0;
    var maxDD = 0;
    var trades = [];
    var curve = [];
    var pos = null;
    var feesPaid = 0, fundingPaid = 0;
    var skipped = { infeasible: 0, wait: 0, notReady: 0 };

    for (var i = 200; i < k4.length - 1; i++) {
      var bar = k4[i];
      var day = Math.floor(bar.t / 86400000);

      // ── 持倉中：先看這一根有沒有出場 ──
      if (pos) {
        var nb = k4[i];
        // 資金費：每 8 小時一次 = 每兩根 4H
        if (i % 2 === 0) {
          var fcost = pos.notional * fund8h;
          fundingPaid += fcost;
          equity -= fcost;
          pos.funding += fcost;       // 記在這一筆頭上，不然 R 會高估（抱越久高估越多）
        }
        var hitStop, hitTp;
        if (pos.side === 'long') {
          hitStop = nb.l <= pos.stop;
          hitTp = nb.h >= pos.tp;
        } else {
          hitStop = nb.h >= pos.stop;
          hitTp = nb.l <= pos.tp;
        }
        // 同一根同時觸及時假設先打到止損 —— 保守，避免高估績效
        var exitPx = null, why = null;
        if (hitStop) { exitPx = pos.stop; why = 'stop'; }
        else if (hitTp) { exitPx = pos.tp; why = 'tp'; }

        if (exitPx !== null) {
          var gross = pos.side === 'long'
            ? (exitPx - pos.entry) * pos.qty
            : (pos.entry - exitPx) * pos.qty;
          var exitFee = pos.qty * exitPx * feeRate;
          feesPaid += exitFee;
          equity += gross - exitFee;
          trades.push({
            t: pos.t, exitT: bar.t, side: pos.side,
            entry: pos.entry, stop: pos.stop, tp: pos.tp, exit: exitPx,
            qty: pos.qty, notional: pos.notional,
            pnl: gross - exitFee - pos.entryFee - pos.funding,
            r: (gross - exitFee - pos.entryFee - pos.funding) / pos.riskAmt,
            funding: pos.funding,
            why: why, equityAfter: equity
          });
          pos = null;
        }
      }

      peak = Math.max(peak, equity);
      maxDD = Math.max(maxDD, (peak - equity) / peak);
      curve.push({ t: bar.t, equity: equity });

      if (equity <= equity0 * 0.05) break;   // 實質歸零，停止

      // ── 空手：判斷要不要進場 ──
      if (!pos) {
        var di = dayIndex[day];
        // 當天的日線還在形成，只能用前一根「已收盤」的
        if (di === undefined) {
          // 這根 4H 的日期不在日線序列裡（日線比較短）→ 找最後一根比它早的
          di = lastClosedDaily(d1, bar.t);
          if (di < 0) continue;
          var dUse = di;
        } else {
          var dUse = di - 1;
        }
        if (dUse < MIN_DAILY) continue;

        var atr = atr4[i];
        if (!isNum(atr) || atr <= 0) continue;

        var dTrend = I.trend(cd.slice(0, dUse + 1), de20.slice(0, dUse + 1),
                             de50.slice(0, dUse + 1), de200.slice(0, dUse + 1), atrD[dUse]);
        var hTrend = I.trend(c4.slice(0, i + 1), e20.slice(0, i + 1),
                             e50.slice(0, i + 1), e200.slice(0, i + 1), atr);
        var b = P.bias(dTrend.dir, hTrend.dir);
        if (b.side === 'wait') { skipped.wait++; continue; }

        // 進場價用下一根的開盤 —— 不能用這一根的收盤價成交
        var next = k4[i + 1];
        var entry = next.o;
        var sw = swingUpTo(h4, l4, i, 3);
        var st = P.stopLevel(b.side, entry, sw, atr);

        var size = R.sizeFromRisk({ equity: equity, riskPct: riskPct, entry: entry, stop: st.price });
        if (!size) continue;

        // 交易所最小下單量：$100 的帳戶常常會卡在這裡
        var feas = R.feasibility({ equity: equity, entry: entry, stop: st.price, filters: filters });
        var qty = R.floorToStep(size.qty, filters.stepSize);
        if (qty < feas.minQty) qty = feas.minQty;
        var notional = qty * entry;

        // 槓桿上限
        if (notional / equity > maxLev) { skipped.infeasible++; continue; }
        // 保證金不夠
        if (notional / maxLev > equity) { skipped.infeasible++; continue; }

        var realRisk = qty * Math.abs(entry - st.price);
        if (realRisk > equity * 0.5) { skipped.infeasible++; continue; }  // 單筆超過半個帳戶，不做

        var tps = R.targets({ entry: entry, stop: st.price, rMultiples: rMultiples });
        var entryFee = notional * feeRate;
        feesPaid += entryFee;
        equity -= entryFee;

        pos = {
          t: next.t, side: b.side, entry: entry, stop: st.price,
          tp: tps[0].price,          // 單一目標：TP1，簡化成「全出」
          qty: qty, notional: notional,
          riskAmt: realRisk, entryFee: entryFee, funding: 0
        };
      }
    }

    // 收盤時仍持倉 → 以最後收盤價平掉
    if (pos) {
      var lastPx = k4[k4.length - 1].c;
      var g = pos.side === 'long'
        ? (lastPx - pos.entry) * pos.qty
        : (pos.entry - lastPx) * pos.qty;
      var ef = pos.qty * lastPx * feeRate;
      feesPaid += ef;
      equity += g - ef;
      trades.push({
        t: pos.t, exitT: k4[k4.length - 1].t, side: pos.side,
        entry: pos.entry, stop: pos.stop, tp: pos.tp, exit: lastPx,
        qty: pos.qty, notional: pos.notional,
        pnl: g - ef - pos.entryFee - pos.funding, r: (g - ef - pos.entryFee - pos.funding) / pos.riskAmt,
        funding: pos.funding,
        why: 'close', equityAfter: equity
      });
    }

    return stats(trades, curve, {
      equity0: equity0, equity: equity, maxDD: maxDD,
      feesPaid: feesPaid, fundingPaid: fundingPaid, skipped: skipped,
      from: k4[200].t, to: k4[k4.length - 1].t
    });
  }

  function stats(trades, curve, meta) {
    var wins = trades.filter(function (t) { return t.pnl > 0; });
    var losses = trades.filter(function (t) { return t.pnl <= 0; });
    var sumR = trades.reduce(function (a, t) { return a + t.r; }, 0);
    var grossWin = wins.reduce(function (a, t) { return a + t.pnl; }, 0);
    var grossLoss = Math.abs(losses.reduce(function (a, t) { return a + t.pnl; }, 0));

    // 最長連敗
    var streak = 0, maxStreak = 0;
    trades.forEach(function (t) {
      if (t.pnl <= 0) { streak++; maxStreak = Math.max(maxStreak, streak); }
      else streak = 0;
    });

    return {
      trades: trades, curve: curve,
      equity0: meta.equity0, equity: meta.equity,
      returnPct: (meta.equity / meta.equity0 - 1) * 100,
      n: trades.length,
      winRate: trades.length ? wins.length / trades.length * 100 : null,
      avgR: trades.length ? sumR / trades.length : null,
      totalR: sumR,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
      maxDD: meta.maxDD * 100,
      maxLossStreak: maxStreak,
      feesPaid: meta.feesPaid,
      fundingPaid: meta.fundingPaid,
      costPct: meta.equity0 ? (meta.feesPaid + meta.fundingPaid) / meta.equity0 * 100 : null,
      skipped: meta.skipped,
      from: meta.from, to: meta.to
    };
  }

  root.BACKTEST = { run: run, resampleToDaily: resampleToDaily, swingUpTo: swingUpTo,
                    lastClosedDaily: lastClosedDaily };
})(typeof globalThis !== 'undefined' ? globalThis : this);
