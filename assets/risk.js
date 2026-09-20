/*
 * risk.js —— 合約風險計算核心（純數學，不碰 DOM、不連網路）
 *
 * 所有公式都寫了推導，因為使用者要看得懂為什麼，不是背結論。
 * 這個檔案同時被瀏覽器（<script>）和 Node 測試（import）載入，
 * 所以不用 export 語法，直接掛到 globalThis。
 */
(function (root) {
  'use strict';

  // Binance USDⓈ-M BTCUSDT 第一檔（名目 < 50,000 USDT）的維持保證金率。
  // 實際值工具會去 exchangeInfo / leverageBracket 抓，這只是離線時的保守預設。
  var DEFAULT_MMR = 0.004;

  // BTCUSDT 的下單限制。同樣以線上抓到的為準，這是 fallback。
  var DEFAULT_FILTERS = { minQty: 0.001, stepSize: 0.001, minNotional: 100 };

  var EPS = 1e-9;

  function isNum(x) { return typeof x === 'number' && isFinite(x); }

  /** 把數量無條件進位到交易所允許的最小跳動單位 */
  function ceilToStep(qty, step) {
    if (!isNum(step) || step <= 0) return qty;
    var n = Math.ceil(qty / step - EPS);
    // 用 step 的小數位數收尾，避免 0.1+0.2 那種浮點殘渣
    var dec = decimalsOf(step);
    return Number((n * step).toFixed(dec));
  }

  function decimalsOf(step) {
    var s = String(step);
    if (s.indexOf('e-') >= 0) return parseInt(s.split('e-')[1], 10);
    var dot = s.indexOf('.');
    return dot < 0 ? 0 : s.length - dot - 1;
  }

  /*
   * 爆倉價（逐倉 isolated）
   *
   * 推導（以做多為例）：
   *   權益 equity = 保證金 M + 數量 q × (現價 P − 進場價 E)
   *   維持保證金 = MMR × q × P
   *   爆倉發生在：equity = 維持保證金
   *     M + qP − qE = MMR·q·P
   *     qP(1 − MMR) = qE − M
   *     P = (qE − M) / (q(1 − MMR))
   *   代入 名目 N = qE = M×L（L 為槓桿）得：
   *     P_liq = E × (1 − 1/L) / (1 − MMR)
   *
   * 做空同理，符號相反：
   *     P_liq = E × (1 + 1/L) / (1 + MMR)
   *
   * 注意：這是逐倉的算法。全倉（cross）會吃到整個錢包餘額，爆倉價會更遠，
   * 但代價是爆的時候連其他倉位一起賠進去。實際數字請以交易所顯示為準。
   */
  function liqPrice(opts) {
    var entry = opts.entry, lev = opts.leverage;
    var side = opts.side === 'short' ? 'short' : 'long';
    var mmr = isNum(opts.mmr) ? opts.mmr : DEFAULT_MMR;
    if (!isNum(entry) || entry <= 0 || !isNum(lev) || lev <= 0) return null;
    var imr = 1 / lev; // 起始保證金率
    if (side === 'long') {
      return Math.max(0, entry * (1 - imr) / (1 - mmr));
    }
    return entry * (1 + imr) / (1 + mmr);
  }

  /**
   * 一個現有部位的體檢。
   * equity：這個倉投入的保證金（逐倉就是這筆倉的保證金）
   */
  function inspectPosition(opts) {
    var entry = opts.entry, lev = opts.leverage, equity = opts.equity;
    var side = opts.side === 'short' ? 'short' : 'long';
    var mmr = isNum(opts.mmr) ? opts.mmr : DEFAULT_MMR;
    if (!isNum(entry) || entry <= 0 || !isNum(lev) || lev <= 0 || !isNum(equity) || equity <= 0) return null;

    var notional = equity * lev;
    var qty = notional / entry;
    var liq = liqPrice({ entry: entry, leverage: lev, side: side, mmr: mmr });
    // 距離爆倉還有幾 %（相對進場價）
    var liqDistPct = Math.abs(entry - liq) / entry * 100;
    // 價格每變動 1%，帳戶權益變動幾 % —— 這就是槓桿的定義
    var accountMovePerPct = lev;

    return {
      side: side,
      notional: notional,
      qty: qty,
      liqPrice: liq,
      liqDistPct: liqDistPct,
      accountMovePerPct: accountMovePerPct,
      // 帳戶腰斬所需的價格變動
      halveAtPct: 50 / lev
    };
  }

  /*
   * 從止損反推部位大小 —— 這是唯一正確的順序。
   *
   *   願意虧的錢 R = 權益 × 風險%
   *   每一單位（1 BTC）從進場走到止損會虧 d = |E − S|
   *   所以數量 q = R / d
   *   名目 N = q × E
   *   而「隱含槓桿」= N / 權益 = 風險% / 止損距離%
   *
   * 最後那行是整個工具最重要的一句話：
   *   槓桿不是你選的，是「風險% ÷ 止損距離%」算出來的。
   *   1% 風險配 2% 止損 → 隱含槓桿 0.5 倍。連 1 倍都不到。
   */
  function sizeFromRisk(opts) {
    var equity = opts.equity, riskPct = opts.riskPct, entry = opts.entry, stop = opts.stop;
    if (!isNum(equity) || equity <= 0 || !isNum(riskPct) || riskPct <= 0) return null;
    if (!isNum(entry) || entry <= 0 || !isNum(stop) || stop <= 0) return null;
    var dist = Math.abs(entry - stop);
    if (dist <= 0) return null;

    var riskAmt = equity * riskPct / 100;
    var qty = riskAmt / dist;
    var notional = qty * entry;

    return {
      riskAmt: riskAmt,
      stopDist: dist,
      stopDistPct: dist / entry * 100,
      qty: qty,
      notional: notional,
      impliedLev: notional / equity
    };
  }

  /**
   * 可行性檢查：在交易所的最小下單限制下，這筆交易最少要冒多少風險？
   * 對小資金帳戶來說這比任何指標都重要 —— 它會告訴你「這筆根本不該做」。
   */
  function feasibility(opts) {
    var equity = opts.equity, entry = opts.entry, stop = opts.stop;
    var f = opts.filters || DEFAULT_FILTERS;
    if (!isNum(equity) || equity <= 0 || !isNum(entry) || entry <= 0) return null;

    // 最小可下單數量：同時要滿足 minQty 和 minNotional 兩個限制
    var q = f.minQty;
    if (q * entry < f.minNotional) {
      q = f.minNotional / entry;
    }
    q = ceilToStep(q, f.stepSize);

    var notional = q * entry;
    var minLev = notional / equity;
    var out = {
      minQty: q,
      minNotional: notional,
      minLeverage: minLev,
      // 保證金不足以開最小倉（即使開到交易所允許的最高槓桿）
      affordable: true
    };

    if (isNum(stop) && stop > 0 && Math.abs(entry - stop) > 0) {
      var loss = q * Math.abs(entry - stop);
      out.minRiskUsd = loss;
      out.minRiskPct = loss / equity * 100;
    }
    return out;
  }

  /**
   * 爆倉會不會發生在止損之前？
   * 做多：爆倉價高於止損價 → 你還沒停損就先被平掉了。這是最致命的設定錯誤。
   */
  function liqBeforeStop(opts) {
    var side = opts.side === 'short' ? 'short' : 'long';
    var liq = liqPrice(opts);
    var stop = opts.stop;
    if (liq === null || !isNum(stop) || stop <= 0) return null;
    var bad = side === 'long' ? liq > stop : liq < stop;
    return { liqPrice: liq, stop: stop, liquidatedFirst: bad };
  }

  /**
   * 給定進場、止損和 R 倍數，算出止盈價位。
   * 用 R 倍數而不是「賺幾 %」，因為 R 才能跨不同倉位比較。
   */
  function targets(opts) {
    var entry = opts.entry, stop = opts.stop;
    var rs = opts.rMultiples || [1, 2, 3];
    if (!isNum(entry) || !isNum(stop)) return [];
    var dist = entry - stop; // 做多為正、做空為負，方向自然帶進去
    return rs.map(function (r) {
      return { r: r, price: entry + dist * r };
    });
  }

  /**
   * 期望值：勝率 p、盈虧比 R，每筆平均賺幾 R。
   * 加上手續費（以 R 為單位）後才是真實期望值。
   */
  function expectancy(opts) {
    var p = opts.winRate, R = opts.rr;
    var feeR = isNum(opts.feeR) ? opts.feeR : 0;
    if (!isNum(p) || !isNum(R)) return null;
    var raw = p * R - (1 - p) * 1;
    return { rawR: raw, netR: raw - feeR };
  }

  /** 每筆來回手續費佔風險金額的比例（換算成 R） */
  function feeInR(opts) {
    var notional = opts.notional, riskAmt = opts.riskAmt;
    var rate = isNum(opts.takerRate) ? opts.takerRate : 0.00045; // Binance U 本位吃單 0.045%
    if (!isNum(notional) || !isNum(riskAmt) || riskAmt <= 0) return null;
    var feeUsd = notional * rate * 2; // 開倉 + 平倉
    return { feeUsd: feeUsd, feeR: feeUsd / riskAmt };
  }

  root.RISK = {
    DEFAULT_MMR: DEFAULT_MMR,
    DEFAULT_FILTERS: DEFAULT_FILTERS,
    ceilToStep: ceilToStep,
    liqPrice: liqPrice,
    inspectPosition: inspectPosition,
    sizeFromRisk: sizeFromRisk,
    feasibility: feasibility,
    liqBeforeStop: liqBeforeStop,
    targets: targets,
    expectancy: expectancy,
    feeInR: feeInR
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
