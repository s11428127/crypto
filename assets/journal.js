/*
 * journal.js —— 交易日誌統計（純函式）
 *
 * 做滿 30 筆才知道自己的流程行不行。這個答案比任何指標訊號都值錢。
 * 所有統計以 R 為單位，因為只有 R 能跨不同部位大小比較。
 */
(function (root) {
  'use strict';
  function isNum(x) { return typeof x === 'number' && isFinite(x); }

  /** 單筆交易的 R 倍數：(出場 − 進場) ÷ (進場 − 止損)，方向自動處理 */
  function rOf(t) {
    if (!isNum(t.entry) || !isNum(t.stop) || !isNum(t.exit)) return null;
    var risk = Math.abs(t.entry - t.stop);
    if (risk <= 0) return null;
    var move = t.side === 'short' ? (t.entry - t.exit) : (t.exit - t.entry);
    return move / risk;
  }

  function stats(trades) {
    var rows = (trades || []).map(function (t) {
      return { t: t, r: isNum(t.r) ? t.r : rOf(t) };
    }).filter(function (x) { return isNum(x.r); });

    if (!rows.length) {
      return { n: 0, winRate: null, avgR: null, expectancy: null, totalR: 0,
               maxDD: 0, maxLossStreak: 0, maxWinStreak: 0, curve: [],
               bySide: { long: null, short: null }, enough: false };
    }

    var wins = rows.filter(function (x) { return x.r > 0; });
    var losses = rows.filter(function (x) { return x.r <= 0; });
    var totalR = rows.reduce(function (a, x) { return a + x.r; }, 0);
    var avgWin = wins.length ? wins.reduce(function (a, x) { return a + x.r; }, 0) / wins.length : 0;
    var avgLoss = losses.length ? Math.abs(losses.reduce(function (a, x) { return a + x.r; }, 0)) / losses.length : 0;
    var winRate = wins.length / rows.length;

    // R 曲線與最大回撤（以 R 計）
    var cum = 0, peak = 0, maxDD = 0, curve = [];
    rows.forEach(function (x) {
      cum += x.r;
      peak = Math.max(peak, cum);
      maxDD = Math.max(maxDD, peak - cum);
      curve.push(cum);
    });

    // 連勝／連敗
    var ls = 0, ws = 0, maxLs = 0, maxWs = 0;
    rows.forEach(function (x) {
      if (x.r > 0) { ws++; ls = 0; maxWs = Math.max(maxWs, ws); }
      else { ls++; ws = 0; maxLs = Math.max(maxLs, ls); }
    });

    function sideStats(side) {
      var sub = rows.filter(function (x) { return x.t.side === side; });
      if (!sub.length) return null;
      var w = sub.filter(function (x) { return x.r > 0; }).length;
      return {
        n: sub.length, winRate: w / sub.length * 100,
        totalR: sub.reduce(function (a, x) { return a + x.r; }, 0)
      };
    }

    return {
      n: rows.length,
      winRate: winRate * 100,
      avgR: totalR / rows.length,
      totalR: totalR,
      avgWinR: avgWin, avgLossR: avgLoss,
      // 期望值：用實際的平均賺賠算，不是用假設的盈虧比
      expectancy: winRate * avgWin - (1 - winRate) * avgLoss,
      payoff: avgLoss > 0 ? avgWin / avgLoss : null,
      maxDD: maxDD,
      maxLossStreak: maxLs, maxWinStreak: maxWs,
      curve: curve,
      bySide: { long: sideStats('long'), short: sideStats('short') },
      // 30 筆以下的統計沒有意義，樣本太小
      enough: rows.length >= 30
    };
  }

  /** 檢查一筆輸入是否完整 */
  function validate(t) {
    var errs = [];
    if (!isNum(t.entry) || t.entry <= 0) errs.push('進場價必填');
    if (!isNum(t.stop) || t.stop <= 0) errs.push('止損價必填');
    if (!isNum(t.exit) || t.exit <= 0) errs.push('出場價必填');
    if (t.side !== 'long' && t.side !== 'short') errs.push('方向必填');
    if (isNum(t.entry) && isNum(t.stop) && t.entry === t.stop) errs.push('止損價不能等於進場價');
    if (t.side === 'long' && isNum(t.entry) && isNum(t.stop) && t.stop > t.entry)
      errs.push('做多的止損應該低於進場價');
    if (t.side === 'short' && isNum(t.entry) && isNum(t.stop) && t.stop < t.entry)
      errs.push('做空的止損應該高於進場價');
    return errs;
  }

  root.JOURNAL = { stats: stats, rOf: rOf, validate: validate };
})(typeof globalThis !== 'undefined' ? globalThis : this);
