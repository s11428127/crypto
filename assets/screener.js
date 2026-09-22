/*
 * screener.js —— 幣種篩選評分（純函式）
 *
 * 目的是排出「現在偏多」和「現在偏空」兩張清單，不是預測誰會漲。
 * 評分邏輯全部攤在這裡，每一項都說得出為什麼。
 *
 * ⚠️ 山寨幣合約流動性薄、針多。這張表初期只該當觀察用。
 */
(function (root) {
  'use strict';

  var P = root.PLAN;
  function isNum(x) { return typeof x === 'number' && isFinite(x); }

  /**
   * 單一幣種評分。分數為正偏多、為負偏空，絕對值越大訊號越強。
   *
   * a1d / a4h：IND.analyze 的結果
   * ctx：{ changePct, btcChangePct, quoteVolume, fundingRate }
   */
  function score(a1d, a4h, ctx) {
    var reasons = [];
    var s = 0;

    // ① 趨勢一致性（權重最大）—— 方向本來就是由 1D + 4H 決定的
    var b = P.bias(a1d.trend.dir, a4h.trend.dir);
    if (b.side === 'long')  { s += b.strength * 2; reasons.push({ k: '趨勢', v: '+' + b.strength * 2, why: b.why }); }
    if (b.side === 'short') { s -= b.strength * 2; reasons.push({ k: '趨勢', v: '-' + b.strength * 2, why: b.why }); }
    if (b.side === 'wait')  { reasons.push({ k: '趨勢', v: '0', why: b.why }); }

    // ② 相對 BTC 的強弱 —— BTC 漲它不漲就是弱，適合當空方標的
    if (isNum(ctx.changePct) && isNum(ctx.btcChangePct)) {
      var rel = ctx.changePct - ctx.btcChangePct;
      var relPts = Math.max(-2, Math.min(2, rel / 3));   // 每差 3% 給 1 分，上限 ±2
      s += relPts;
      reasons.push({ k: '相對強度', v: (relPts >= 0 ? '+' : '') + relPts.toFixed(1),
                     why: '24h 相對 BTC ' + (rel >= 0 ? '+' : '') + rel.toFixed(2) + '%' });
    }

    // ③ 動能位置 —— RSI 在極端區時，順著做是追高殺低，扣分
    var rsi = a4h.last.rsi;
    if (isNum(rsi)) {
      var rsiPts = 0;
      if (rsi > 75) { rsiPts = -1; reasons.push({ k: 'RSI', v: '-1', why: '4H RSI ' + rsi.toFixed(0) + '，超買，這裡追多風險高' }); }
      else if (rsi < 25) { rsiPts = 1; reasons.push({ k: 'RSI', v: '+1', why: '4H RSI ' + rsi.toFixed(0) + '，超賣，這裡追空風險高' }); }
      else reasons.push({ k: 'RSI', v: '0', why: '4H RSI ' + rsi.toFixed(0) + '，在常態區間' });
      s += rsiPts;
    }

    // ④ 資金費率 —— 極端值是反指標，代表那一邊已經太擁擠
    var f = P.fundingRead(ctx.fundingRate);
    if (f) {
      var fPts = 0;
      if (f.level === 'hot') fPts = f.pct > 0 ? -1.5 : 1.5;   // 多單擁擠 → 扣多方分
      else if (f.level === 'warm') fPts = f.pct > 0 ? -0.5 : 0.5;
      s += fPts;
      reasons.push({ k: '資金費率', v: (fPts >= 0 ? '+' : '') + fPts,
                     why: f.pct.toFixed(4) + '%（年化 ' + f.annualPct.toFixed(0) + '%）' + f.note });
    }

    var side = s >= 2 ? 'long' : s <= -2 ? 'short' : 'neutral';
    return {
      score: s, side: side, reasons: reasons,
      trend1d: a1d.trend.dir, trend4h: a4h.trend.dir,
      rsi: rsi,
      atrPct: isNum(a4h.last.atr) && a4h.last.close ? a4h.last.atr / a4h.last.close * 100 : null,
      changePct: ctx.changePct,
      relStrength: isNum(ctx.changePct) && isNum(ctx.btcChangePct) ? ctx.changePct - ctx.btcChangePct : null,
      fundingPct: f ? f.pct : null,
      quoteVolume: ctx.quoteVolume
    };
  }

  /** 把一批評分結果排成偏多／偏空兩張清單 */
  function rank(rows, opts) {
    opts = opts || {};
    var minVol = isNum(opts.minQuoteVolume) ? opts.minQuoteVolume : 5e7;  // 流動性門檻
    var ok = rows.filter(function (r) {
      return isNum(r.quoteVolume) && r.quoteVolume >= minVol;
    });
    var longs = ok.filter(function (r) { return r.side === 'long'; })
                  .sort(function (a, b) { return b.score - a.score; });
    var shorts = ok.filter(function (r) { return r.side === 'short'; })
                   .sort(function (a, b) { return a.score - b.score; });
    return {
      longs: longs, shorts: shorts,
      neutral: ok.length - longs.length - shorts.length,
      filteredOut: rows.length - ok.length
    };
  }

  root.SCREENER = { score: score, rank: rank };
})(typeof globalThis !== 'undefined' ? globalThis : this);
