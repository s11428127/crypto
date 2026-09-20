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

  root.PLAN = {
    bias: bias, timing: timing, stopLevel: stopLevel,
    fundingRead: fundingRead, build: build
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
