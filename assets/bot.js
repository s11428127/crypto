/*
 * bot.js —— 模擬單機器人的決策引擎（純函式）
 *
 * 這支**不會**下真實訂單，也不碰任何 API 金鑰。它用真實行情、真實手續費、
 * 真實資金費去記錄「如果照這套規則做，帳戶會變怎樣」，累積一份可以檢驗的成績單。
 *
 * 設計上刻意保守，寧可低估績效：
 *   - 進出場都算吃單手續費（taker），不假設掛單成交
 *   - 同一根 K 棒同時觸及止損與止盈 → 算止損
 *   - 止損／止盈用「這段期間的最高最低價」判斷，不是只看當下報價
 *     （只看當下會漏掉掃到止損又彈回去的情況，那會讓績效虛高）
 *   - 同時只持有一個部位
 */
(function (root) {
  'use strict';

  var R = root.RISK, P = root.PLAN;
  function isNum(x) { return typeof x === 'number' && isFinite(x); }

  var EIGHT_HOURS = 8 * 3600 * 1000;

  function defaultConfig() {
    return {
      symbol: 'BTCUSDT',
      startEquity: 100,
      riskPct: 1,
      maxLeverage: 5,
      feeRate: 0.00045,        // Binance U 本位吃單
      fundingPer8h: 0.0001,    // 抓不到即時費率時的估計值
      rMultiples: [1.5, 3],
      // 下單限制以「實際會下單的交易所」為準，不是行情來源的
      filters: { minQty: 0.001, stepSize: 0.001, minNotional: 100 }
    };
  }

  function newState(config) {
    var c = Object.assign(defaultConfig(), config || {});
    return {
      version: 1,
      config: c,
      equity: c.startEquity,
      position: null,
      trades: [],
      curve: [],
      feesPaid: 0,
      fundingPaid: 0,
      ticks: 0,
      lastTick: null,
      createdAt: Date.now(),
      notes: []
    };
  }

  /**
   * 掃描一段 K 棒，看部位有沒有被觸發出場。
   * 只看收盤價會漏掉「掃到止損又彈回來」的情況，那會讓績效虛高。
   */
  function scanExit(pos, bars) {
    for (var i = 0; i < bars.length; i++) {
      var b = bars[i];
      if (!isNum(b.h) || !isNum(b.l)) continue;
      if (b.t <= pos.openedAt) continue;      // 開倉當根不算，避免用到進場前的價格
      var hitStop, hitTp;
      if (pos.side === 'long') {
        hitStop = b.l <= pos.stop;
        hitTp = b.h >= pos.tp;
      } else {
        hitStop = b.h >= pos.stop;
        hitTp = b.l <= pos.tp;
      }
      // 同一根兩邊都碰到 → 算止損。保守，不高估績效。
      if (hitStop) return { price: pos.stop, why: 'stop', at: b.t };
      if (hitTp) return { price: pos.tp, why: 'tp', at: b.t };
    }
    return null;
  }

  /**
   * 決定這一輪要做什麼。不改動 state，只回傳一個動作。
   *
   * market = {
   *   now, price,               目前時間與即時價
   *   k15,                      最近的 15m K 棒（用來判斷止損止盈有沒有被觸發）
   *   analyses: {d1, h4, m15},  各週期的 IND.analyze 結果
   *   fundingRate,              即時資金費率，沒有就用 config 的估計值
   *   filters                   下單限制，沒有就用 config 的
   * }
   */
  function decide(state, market, config) {
    var c = config || state.config;
    if (!isNum(market.price) || market.price <= 0) {
      return { type: 'skip', reason: '沒有有效報價' };
    }

    // ── 持倉中 ──
    if (state.position) {
      var exit = scanExit(state.position, market.k15 || []);
      if (exit) return { type: 'close', price: exit.price, why: exit.why, at: exit.at };
      return { type: 'hold', reason: '部位續抱，未觸及止損或止盈' };
    }

    // ── 空手 ──
    var a = market.analyses || {};
    if (!a.d1 || !a.h4 || !a.m15) return { type: 'skip', reason: 'K 線資料不足' };

    var b = P.bias(a.d1.trend.dir, a.h4.trend.dir);
    if (b.side === 'wait') return { type: 'wait', reason: b.why };

    var tm = P.timing(b.side, a.m15.trend.dir);
    if (!tm.ready) return { type: 'wait', reason: tm.why };

    var plan = P.sizedPlan({
      side: b.side, price: market.price,
      atr: a.h4.last.atr, swing: a.h4.swing,
      equity: state.equity, riskPct: c.riskPct, maxLeverage: c.maxLeverage,
      filters: market.filters || c.filters,
      rMultiples: c.rMultiples
    });
    if (!plan) return { type: 'skip', reason: '算不出部位（ATR 或結構缺資料）' };
    if (!plan.feasible) {
      return { type: 'blocked', reason: plan.blockedBy === 'leverageCap'
        ? '最小部位超過槓桿上限，這筆開不起來' : '單筆風險過大，這筆不做', plan: plan };
    }
    if (plan.liqBeforeStop) {
      return { type: 'blocked', reason: '爆倉會發生在止損之前，這筆不做', plan: plan };
    }
    return { type: 'open', plan: plan, why: b.why + '；' + tm.why };
  }

  /** 把動作套用到狀態上，回傳新的狀態（不改動傳入的物件） */
  function apply(state, action, market) {
    var s = JSON.parse(JSON.stringify(state));
    var c = s.config;
    var now = market.now;
    s.ticks++;
    s.lastTick = now;

    // 持倉期間每 8 小時收一次資金費
    if (s.position) {
      var rate = isNum(market.fundingRate) ? Math.abs(market.fundingRate) : c.fundingPer8h;
      var due = s.position.nextFundingAt;
      while (due && now >= due) {
        var cost = s.position.notional * rate;
        s.fundingPaid += cost;
        s.equity -= cost;
        due += EIGHT_HOURS;
      }
      if (s.position.nextFundingAt) s.position.nextFundingAt = due;
    }

    if (action.type === 'open') {
      var p = action.plan;
      var fee = p.notional * c.feeRate;
      s.feesPaid += fee;
      s.equity -= fee;
      s.position = {
        side: p.side, entry: p.entry, stop: p.stop, tp: p.targets[0].price,
        tp2: p.targets[1].price, qty: p.qty, notional: p.notional,
        exchangeLeverage: p.exchangeLeverage, liqPrice: p.liqPrice,
        riskUsd: p.riskUsd, entryFee: fee,
        openedAt: now, nextFundingAt: now + EIGHT_HOURS,
        why: action.why
      };
      s.notes.unshift({ t: now, kind: 'open',
        text: (p.side === 'long' ? '開多' : '開空') + ' ' + p.qty + ' @ ' + p.entry.toFixed(1) +
              '，止損 ' + p.stop.toFixed(1) + '，止盈 ' + p.targets[0].price.toFixed(1) });
    } else if (action.type === 'close' && s.position) {
      var pos = s.position;
      var gross = pos.side === 'long'
        ? (action.price - pos.entry) * pos.qty
        : (pos.entry - action.price) * pos.qty;
      var exitFee = pos.qty * action.price * c.feeRate;
      s.feesPaid += exitFee;
      s.equity += gross - exitFee;
      var pnl = gross - exitFee - pos.entryFee;
      s.trades.push({
        openedAt: pos.openedAt, closedAt: action.at || now,
        side: pos.side, entry: pos.entry, stop: pos.stop, tp: pos.tp,
        exit: action.price, qty: pos.qty, notional: pos.notional,
        pnl: pnl, r: pos.riskUsd > 0 ? pnl / pos.riskUsd : null,
        why: action.why, equityAfter: s.equity
      });
      s.notes.unshift({ t: now, kind: action.why === 'tp' ? 'win' : 'loss',
        text: (action.why === 'tp' ? '止盈出場' : '止損出場') + ' @ ' + action.price.toFixed(1) +
              '，' + (pnl >= 0 ? '+' : '') + pnl.toFixed(2) + ' U' });
      s.position = null;
    } else if (action.type !== 'hold') {
      // wait / blocked / skip 只留最近一筆理由，不要把日誌灌爆
      if (!s.notes.length || s.notes[0].kind !== 'idle' || s.notes[0].text !== action.reason) {
        s.notes.unshift({ t: now, kind: 'idle', text: action.reason });
      }
    }

    s.curve.push({ t: now, equity: s.equity, hasPosition: !!s.position });
    if (s.curve.length > 5000) s.curve = s.curve.slice(-5000);
    if (s.notes.length > 200) s.notes = s.notes.slice(0, 200);
    return s;
  }

  /** 跑一輪：決定 + 套用 */
  function tick(state, market, config) {
    var action = decide(state, market, config);
    return { state: apply(state, action, market), action: action };
  }

  function stats(state) {
    var t = state.trades || [];
    var wins = t.filter(function (x) { return x.pnl > 0; });
    var losses = t.filter(function (x) { return x.pnl <= 0; });
    var sumR = t.reduce(function (a, x) { return a + (isNum(x.r) ? x.r : 0); }, 0);
    var grossWin = wins.reduce(function (a, x) { return a + x.pnl; }, 0);
    var grossLoss = Math.abs(losses.reduce(function (a, x) { return a + x.pnl; }, 0));

    var peak = state.config.startEquity, maxDD = 0;
    (state.curve || []).forEach(function (p) {
      peak = Math.max(peak, p.equity);
      maxDD = Math.max(maxDD, (peak - p.equity) / peak);
    });

    var streak = 0, maxStreak = 0;
    t.forEach(function (x) {
      if (x.pnl <= 0) { streak++; maxStreak = Math.max(maxStreak, streak); }
      else streak = 0;
    });

    return {
      n: t.length,
      equity: state.equity,
      startEquity: state.config.startEquity,
      returnPct: (state.equity / state.config.startEquity - 1) * 100,
      winRate: t.length ? wins.length / t.length * 100 : null,
      avgR: t.length ? sumR / t.length : null,
      totalR: sumR,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
      maxDD: maxDD * 100,
      maxLossStreak: maxStreak,
      feesPaid: state.feesPaid,
      fundingPaid: state.fundingPaid,
      ticks: state.ticks,
      runningDays: state.createdAt ? (Date.now() - state.createdAt) / 86400000 : 0,
      // 30 筆以下的勝率沒有統計意義
      enough: t.length >= 30
    };
  }

  root.BOT = {
    defaultConfig: defaultConfig, newState: newState,
    decide: decide, apply: apply, tick: tick, stats: stats, scanExit: scanExit
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
