/*
 * plan.js —— 多時間框架對齊與進場計畫（純函式）
 *
 * 分工固定：1D 定方向、4H 定結構、15m 定時機。
 * 三個框架不同調時輸出「觀望」—— 不做也是一種結論，而且是最常出現的那一種。
 */
(function (root) {
  'use strict';

  var R = root.RISK;

  function isN(x) { return typeof x === 'number' && isFinite(x); }

  /**
   * 方向偏好：只看 1D 與 4H。15m 不參與定方向，只決定時機。
   */
  function bias(d1, h4) {
    if (d1 === 'up' && h4 === 'up')     return { side: 'long',  strength: 2, why: '日線與 4H 同為多頭' };
    if (d1 === 'down' && h4 === 'down') return { side: 'short', strength: 2, why: '日線與 4H 同為空頭' };
    if (d1 === 'range' && h4 === 'up')   return { side: 'long',  strength: 1, why: '日線盤整、4H 偏多（只能小做）' };
    if (d1 === 'range' && h4 === 'down') return { side: 'short', strength: 1, why: '日線盤整、4H 偏空（只能小做）' };
    if (d1 === 'up' && h4 === 'down')   return { side: 'wait', strength: 0, why: '日線多頭但 4H 轉弱，可能只是回調，等 4H 重新站回' };
    if (d1 === 'down' && h4 === 'up')   return { side: 'wait', strength: 0, why: '日線空頭但 4H 反彈，逆勢反彈最容易被收掉' };
    if (h4 === 'range')                  return { side: 'wait', strength: 0, why: '4H 在整理，沒有可依附的結構' };
    return { side: 'wait', strength: 0, why: '方向不明' };
  }

  /**
   * 時機：15m 是否同向。不同向不代表不能做，代表「現在不是進場點」。
   */
  function timing(side, m15) {
    if (side === 'wait') return { ready: false, why: '方向未定，不談時機' };
    if (side === 'long') {
      if (m15 === 'up')    return { ready: true,  why: '15m 同步轉強，動能到位' };
      if (m15 === 'down')  return { ready: false, why: '15m 仍在回落，等止跌再進，不要接刀' };
      return { ready: false, why: '15m 橫盤，等突破確認' };
    }
    if (m15 === 'down')  return { ready: true,  why: '15m 同步轉弱，動能到位' };
    if (m15 === 'up')    return { ready: false, why: '15m 仍在反彈，等反彈結束再進' };
    return { ready: false, why: '15m 橫盤，等跌破確認' };
  }

  /**
   * 止損位置：放在 4H 的結構外面，再用 ATR 留緩衝。
   * 兩個夾限：太近會被雜訊掃掉，太遠會讓盈虧比失去意義。
   */
  function stopLevel(side, entry, swing, atr, cfg) {
    cfg = cfg || {};
    var buf = (cfg.atrBuffer == null ? 0.25 : cfg.atrBuffer) * atr;
    var minD = (cfg.minAtr == null ? 0.8 : cfg.minAtr) * atr;
    var maxD = (cfg.maxAtr == null ? 2.5 : cfg.maxAtr) * atr;
    var raw, d;

    if (side === 'long') {
      raw = swing.low - buf;
      d = entry - raw;
      if (!isN(d) || d <= 0) d = minD;
      d = Math.min(Math.max(d, minD), maxD);
      return { price: entry - d, dist: d, clamped: Math.abs((entry - raw) - d) > 1e-9 };
    }
    raw = swing.high + buf;
    d = raw - entry;
    if (!isN(d) || d <= 0) d = minD;
    d = Math.min(Math.max(d, minD), maxD);
    return { price: entry + d, dist: d, clamped: Math.abs((raw - entry) - d) > 1e-9 };
  }

  /**
   * 資金費率解讀。極端正值代表多單過度擁擠 —— 是反指標，不是順向訊號。
   * Binance 每 8 小時結算一次，所以年化 = rate × 3 × 365。
   */
  function fundingRead(rate) {
    if (!isN(rate)) return null;
    var pct = rate * 100;
    var annual = rate * 3 * 365 * 100;
    var level = 'normal', note = '費率正常，無明顯擁擠';
    if (rate > 0.0005)       { level = 'hot';  note = '多單明顯擁擠，做多要提高警覺（反指標）'; }
    else if (rate > 0.0002)  { level = 'warm'; note = '多方稍微偏多，還在常態範圍'; }
    else if (rate < -0.0005) { level = 'hot';  note = '空單明顯擁擠，做空要提高警覺（反指標）'; }
    else if (rate < -0.0002) { level = 'warm'; note = '空方稍微偏多，還在常態範圍'; }
    return { pct: pct, annualPct: annual, level: level, note: note };
  }

  /**
   * 組出完整計畫。
   * tf: { d1:analyze結果, h4:analyze結果, m15:analyze結果 }
   */
  function build(tf, opts) {
    opts = opts || {};
    var price = isN(opts.price) ? opts.price : tf.h4.last.close;
    var atr = tf.h4.last.atr;
    var b = bias(tf.d1.trend.dir, tf.h4.trend.dir);
    var tm = timing(b.side, tf.m15.trend.dir);

    var out = {
      side: b.side,
      strength: b.strength,
      biasWhy: b.why,
      ready: tm.ready,
      timingWhy: tm.why,
      price: price,
      atr: atr,
      atrPct: isN(atr) && price ? atr / price * 100 : null,
      trends: { d1: tf.d1.trend, h4: tf.h4.trend, m15: tf.m15.trend },
      rsi: tf.h4.last.rsi,
      macdHist: tf.h4.last.macdHist,
      funding: fundingRead(opts.fundingRate),
      warnings: []
    };

    if (!isN(atr) || atr <= 0) {
      out.warnings.push({ level: 'warn', text: 'ATR 無法計算，K 線資料可能不足，計畫僅供參考。' });
      return out;
    }

    // RSI 極端：不推翻方向，但要提醒追高／殺低的風險
    if (isN(out.rsi)) {
      if (b.side === 'long' && out.rsi > 70) {
        out.warnings.push({ level: 'warn', text: '4H RSI ' + out.rsi.toFixed(1) + '，已在超買區，這裡進多是追高。' });
      }
      if (b.side === 'short' && out.rsi < 30) {
        out.warnings.push({ level: 'warn', text: '4H RSI ' + out.rsi.toFixed(1) + '，已在超賣區，這裡進空是殺低。' });
      }
    }
    if (out.funding && out.funding.level === 'hot') {
      var crowdedSame = (out.funding.pct > 0 && b.side === 'long') || (out.funding.pct < 0 && b.side === 'short');
      if (crowdedSame) {
        out.warnings.push({ level: 'warn', text: '資金費率 ' + out.funding.pct.toFixed(4) + '%（年化 ' +
          out.funding.annualPct.toFixed(0) + '%），和你的方向同邊且已經擁擠。' + out.funding.note });
      }
    }

    if (b.side === 'wait') return out;

    // ── 價位 ──
    var st = stopLevel(b.side, price, tf.h4.swing, atr, opts.stopCfg);
    out.entry = price;
    out.entryZone = [price - atr * 0.15, price + atr * 0.15];
    out.stop = st.price;
    out.stopDist = st.dist;
    out.stopDistPct = st.dist / price * 100;
    out.stopClamped = st.clamped;
    out.targets = R.targets({ entry: price, stop: st.price, rMultiples: opts.rMultiples || [1.5, 3] });

    // ── 部位 ──
    var equity = isN(opts.equity) ? opts.equity : 0;
    var riskPct = isN(opts.riskPct) ? opts.riskPct : 1;
    if (equity > 0) {
      out.size = R.sizeFromRisk({ equity: equity, riskPct: riskPct, entry: price, stop: st.price });
      out.feasibility = R.feasibility({
        equity: equity, entry: price, stop: st.price,
        filters: opts.filters || R.DEFAULT_FILTERS
      });

      if (out.size && out.feasibility && isN(out.feasibility.minRiskPct)) {
        if (out.feasibility.minRiskPct > riskPct * 1.05) {
          out.warnings.push({
            level: 'danger',
            text: '做不到 ' + riskPct + '% 風險：交易所最小下單量讓你至少要冒 ' +
                  out.feasibility.minRiskPct.toFixed(1) + '%（' +
                  (out.feasibility.minRiskPct / riskPct).toFixed(1) + ' 倍）。'
          });
        }
      }

      // 使用者設定的槓桿會不會讓爆倉發生在止損之前
      if (isN(opts.leverage) && opts.leverage > 0) {
        var lq = R.liqBeforeStop({ entry: price, leverage: opts.leverage, side: b.side, stop: st.price });
        if (lq) {
          out.liqPrice = lq.liqPrice;
          out.liqBeforeStop = lq.liquidatedFirst;
          if (lq.liquidatedFirst) {
            out.warnings.push({
              level: 'danger',
              text: opts.leverage + ' 倍下爆倉價 ' + lq.liqPrice.toFixed(0) +
                    ' 在止損 ' + st.price.toFixed(0) + ' 之前，止損等於沒設。降槓桿或拉近止損。'
            });
          }
        }
      }

      // 手續費佔風險預算的比例
      if (out.size) {
        var fee = R.feeInR({ notional: out.size.notional, riskAmt: out.size.riskAmt });
        if (fee) {
          out.fee = fee;
          if (fee.feeR > 0.3) {
            out.warnings.push({
              level: fee.feeR > 1 ? 'danger' : 'warn',
              text: '來回手續費約 $' + fee.feeUsd.toFixed(2) + '，等於 ' + fee.feeR.toFixed(2) +
                    ' R。你得先賺這麼多才回到原點。'
            });
          }
        }
      }
    }

    if (st.clamped) {
      out.warnings.push({
        level: 'info',
        text: '結構止損距離被夾到合理範圍內（0.8~2.5 ATR）。原始結構位置太' +
              (st.dist <= atr * 0.81 ? '近，容易被雜訊掃掉' : '遠，盈虧比會不划算') + '。'
      });
    }
    return out;
  }

  /**
   * 給定方向與結構，算出一整組可執行的數字：
   * 進場、止損、止盈、部位大小、槓桿、爆倉價，以及**賺賠各是幾 U**。
   *
   * 和 build() 的差別：build() 自己判斷方向（要三個時間框架），
   * 這支只負責「方向已經決定了，那部位該怎麼開」，篩選器每一列都用它。
   *
   * 部位大小的決定順序（順序很重要）：
   *   1. 依風險% 算出理想數量
   *   2. **捨去**到交易所的最小跳動單位（進位會讓實際風險超出預算）
   *   3. 不足最小下單量 → 頂上去（風險會被迫變大，標記 forcedUp）
   *   4. 名目超過槓桿上限 → 這筆做不起來，標記 blockedBy
   */
  function sizedPlan(opts) {
    var side = opts.side === 'short' ? 'short' : 'long';
    var entry = opts.price, atr = opts.atr, swing = opts.swing;
    var equity = opts.equity, riskPct = opts.riskPct;
    var maxLev = isN(opts.maxLeverage) ? opts.maxLeverage : 20;
    var filters = opts.filters || R.DEFAULT_FILTERS;
    var rMultiples = opts.rMultiples || [1.5, 3];

    if (!isN(entry) || entry <= 0 || !isN(atr) || atr <= 0 ||
        !isN(equity) || equity <= 0 || !isN(riskPct) || riskPct <= 0) return null;

    var st = stopLevel(side, entry, swing, atr, opts.stopCfg);
    var stopDist = st.dist;
    // 價格和 ATR 尺度對不上（例如指標跟報價來自不同的幣）時，做多的止損會被算成負數。
    // 這種計畫不能拿去下單，直接作廢。
    if (!(st.price > 0)) return null;

    // 理想數量 → 捨去 → 不足最小可下單才頂上去
    var wantQty = (equity * riskPct / 100) / stopDist;
    var qty = R.floorToStep(wantQty, filters.stepSize);
    var feas = R.feasibility({ equity: equity, entry: entry, stop: st.price, filters: filters });
    var forcedUp = false;
    if (qty < feas.minQty) { qty = feas.minQty; forcedUp = true; }

    var notional = qty * entry;
    var leverage = notional / equity;
    // 交易所的槓桿最低只能設 1 倍。名目小於本金時設 1 倍就好，
    // 保證金會自動只佔掉名目那麼多，剩下的本金閒置。
    var exchangeLeverage = Math.max(1, Math.ceil(leverage - 1e-9));
    var blockedBy = null;
    if (notional > equity * maxLev + 1e-9) blockedBy = 'leverageCap';

    var riskUsd = qty * stopDist;
    if (riskUsd >= equity) blockedBy = blockedBy || 'riskTooBig';

    var tps = R.targets({ entry: entry, stop: st.price, rMultiples: rMultiples });
    var out = {
      side: side, entry: entry,
      stop: st.price, stopDist: stopDist, stopDistPct: stopDist / entry * 100,
      stopClamped: st.clamped,
      qty: qty, notional: notional,
      leverage: leverage,                    // 名目 ÷ 本金，可能小於 1
      exchangeLeverage: exchangeLeverage,    // 實際要在交易所設定的整數倍率
      marginUsed: notional / exchangeLeverage,
      riskUsd: riskUsd, riskPctActual: riskUsd / equity * 100,
      forcedUp: forcedUp, blockedBy: blockedBy, feasible: blockedBy === null,
      minQty: feas.minQty, minNotional: feas.minNotional,
      targets: tps.map(function (t) {
        return {
          r: t.r, price: t.price,
          // 賺幾 U：數量 × 價差（方向已經含在 targets 的算法裡）
          usd: qty * Math.abs(t.price - entry)
        };
      })
    };

    // 爆倉價要用「實際會在交易所設定的倍率」算。
    // 用 notional/equity 這個比例算是錯的：交易所最低只能設 1x，
    // 比例小於 1 的空單會算出離譜的遠（例如 6.5 倍距離，實際只有 2 倍）。
    out.liqPrice = R.liqPrice({ entry: entry, leverage: exchangeLeverage,
                                side: side, mmr: opts.mmr });
    var lq = R.liqBeforeStop({ entry: entry, leverage: exchangeLeverage, side: side,
                               stop: st.price, mmr: opts.mmr });
    out.liqBeforeStop = lq ? lq.liquidatedFirst : null;
    // 做多在 1x 下價格要歸零才會爆倉，實務上等於不會爆
    out.liqFree = side === 'long' && exchangeLeverage <= 1;

    var fee = R.feeInR({ notional: notional, riskAmt: riskUsd });
    if (fee) { out.feeUsd = fee.feeUsd; out.feeR = fee.feeR; }

    return out;
  }

  root.PLAN = {
    bias: bias, timing: timing, stopLevel: stopLevel,
    fundingRead: fundingRead, build: build, sizedPlan: sizedPlan
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
