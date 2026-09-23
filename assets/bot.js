/*
 * bot.js —— 模擬單機器人的決策引擎（純函式）
 *
 * 這支**不會**下真實訂單，也不碰任何 API 金鑰。它用真實行情、真實手續費、
 * 真實資金費去記錄「如果照這套規則做，帳戶會變怎樣」，累積一份可以檢驗的成績單。
 *
 * v2：多幣種。一個帳戶（共用權益）同時盯多個幣，每個幣最多一個部位。
 * 規則很嚴（三個時間框架要對齊），只盯一個幣的話一個禮拜可能才一兩次機會；
 * 盯十個幣，同樣的規則機會多將近十倍，成績單累積得快，但規則本身沒有放寬。
 *
 * 設計上刻意保守，寧可低估績效：
 *   - 進出場都算吃單手續費（taker），不假設掛單成交
 *   - 同一根 K 棒同時觸及止損與止盈 → 算止損
 *   - 止損／止盈用「這段期間的最高最低價」判斷，不是只看當下報價
 *   - 最小下單量把風險頂得太高的單不做（maxRiskPct）
 *   - 帳戶總名目不超過 maxLeverage 倍，同時持倉數有上限
 */
(function (root) {
  'use strict';

  var R = root.RISK, P = root.PLAN;
  function isNum(x) { return typeof x === 'number' && isFinite(x); }

  var EIGHT_HOURS = 8 * 3600 * 1000;

  function defaultConfig() {
    return {
      symbols: ['BTCUSDT'],
      startEquity: 100,
      riskPct: 1,
      maxRiskPct: 5,           // 被最小下單量頂上去的風險超過這個就不做
      maxPositions: 3,         // 同時最多幾個部位
      maxLeverage: 5,          // 帳戶「總名目 ÷ 權益」的上限
      feeRate: 0.00045,        // Binance U 本位吃單
      fundingPer8h: 0.0001,    // 抓不到即時費率時的估計值
      rMultiples: [1.5, 3],
      // 下單限制以「實際會下單的交易所」為準，不是行情來源的。
      // "*" 是沒列出來的幣的預設值（估計值，實際以交易所顯示為準）。
      filters: { '*': { minQty: 0, stepSize: 0, minNotional: 5 } }
    };
  }

  function symbolsOf(c) {
    if (c.symbols && c.symbols.length) return c.symbols.slice();
    return [c.symbol || 'BTCUSDT'];
  }

  /** 某個幣的下單限制。相容舊格式（整個 filters 就是一組） */
  function filtersFor(c, sym) {
    var f = c.filters || {};
    if (isNum(f.minNotional)) return f;
    return f[sym] || f['*'] || R.DEFAULT_FILTERS;
  }

  function newState(config) {
    var c = Object.assign(defaultConfig(), config || {});
    return {
      version: 2,
      config: c,
      equity: c.startEquity,
      positions: {},
      status: {},              // 每個幣最近一輪的狀態（等待／被擋／錯誤…）
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

  /** v1（單一部位）→ v2（多幣種）。已經是 v2 就原樣回傳（深拷貝）。 */
  function migrate(state) {
    var s = JSON.parse(JSON.stringify(state));
    if (s.version >= 2 && s.positions) return s;
    var sym = (s.config && s.config.symbol) || 'BTCUSDT';
    s.positions = {};
    if (s.position) s.positions[sym] = Object.assign({ symbol: sym }, s.position);
    delete s.position;
    s.status = s.status || {};
    (s.trades || []).forEach(function (t) { if (!t.symbol) t.symbol = sym; });
    (s.curve || []).forEach(function (p) {
      if (p.open === undefined) p.open = p.hasPosition ? 1 : 0;
    });
    // 舊的閒置紀錄（每輪一筆「等待」）不留，notes 只放開平倉事件
    s.notes = (s.notes || []).filter(function (n) { return n.kind !== 'idle'; });
    if (s.config && !s.config.symbols) s.config.symbols = [sym];
    s.version = 2;
    return s;
  }

  function openCount(state) { return Object.keys(state.positions || {}).length; }
  function totalNotional(state) {
    var sum = 0;
    for (var k in state.positions) sum += state.positions[k].notional || 0;
    return sum;
  }
  function shortName(sym) { return String(sym).replace(/USDT$/, ''); }

  /** 掃描一段 K 棒，看部位有沒有被觸發出場。 */
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
      if (hitStop) return { price: pos.stop, why: 'stop', at: b.t };
      if (hitTp) return { price: pos.tp, why: 'tp', at: b.t };
    }
    return null;
  }

  /**
   * 決定某個幣這一輪要做什麼。不改動 state，只回傳一個動作。
   *
   * market = { symbol, now, price, k15, analyses:{d1,h4,m15}, fundingRate, filters }
   */
  function decide(state, market, config) {
    var c = config || state.config;
    var sym = market.symbol || symbolsOf(c)[0];
    if (!isNum(market.price) || market.price <= 0) {
      return { type: 'skip', reason: '沒有有效報價' };
    }

    var pos = state.positions && state.positions[sym];
    if (pos) {
      var exit = scanExit(pos, market.k15 || []);
      if (exit) return { type: 'close', price: exit.price, why: exit.why, at: exit.at };
      return { type: 'hold', reason: '續抱，未觸及止損或止盈' };
    }

    var a = market.analyses || {};
    if (!a.d1 || !a.h4 || !a.m15) return { type: 'skip', reason: 'K 線資料不足' };

    var b = P.bias(a.d1.trend.dir, a.h4.trend.dir);
    if (b.side === 'wait') return { type: 'wait', reason: b.why };

    var tm = P.timing(b.side, a.m15.trend.dir);
    if (!tm.ready) return { type: 'wait', reason: tm.why };

    var maxPos = isNum(c.maxPositions) ? c.maxPositions : 3;
    if (openCount(state) >= maxPos) {
      return { type: 'wait', reason: '已達同時持倉上限 ' + maxPos + ' 筆，訊號到了也不加' };
    }

    var plan = P.sizedPlan({
      side: b.side, price: market.price,
      atr: a.h4.last.atr, swing: a.h4.swing,
      equity: state.equity, riskPct: c.riskPct, maxLeverage: c.maxLeverage,
      filters: market.filters || filtersFor(c, sym),
      rMultiples: c.rMultiples
    });
    if (!plan) return { type: 'skip', reason: '算不出部位（ATR 或結構缺資料）' };
    if (!plan.feasible) {
      return { type: 'blocked', plan: plan, reason: plan.blockedBy === 'leverageCap'
        ? '最小部位超過槓桿上限，開不起來' : '單筆風險過大，不做' };
    }
    if (plan.liqBeforeStop) {
      return { type: 'blocked', plan: plan, reason: '爆倉會發生在止損之前，不做' };
    }
    var maxRisk = isNum(c.maxRiskPct) ? c.maxRiskPct : 5;
    if (plan.riskPctActual > maxRisk + 1e-9) {
      return { type: 'blocked', plan: plan,
        reason: '最小下單量把風險頂到 ' + plan.riskPctActual.toFixed(1) + '%，超過上限 ' + maxRisk + '%' };
    }
    if (totalNotional(state) + plan.notional > state.equity * c.maxLeverage + 1e-9) {
      return { type: 'blocked', plan: plan,
        reason: '加上這筆，帳戶總名目會超過 ' + c.maxLeverage + ' 倍權益' };
    }
    return { type: 'open', plan: plan, why: b.why + '；' + tm.why };
  }

  /** 把某個幣的動作套用到狀態上，回傳新的狀態（不改動傳入的物件） */
  function apply(state, action, market) {
    var s = JSON.parse(JSON.stringify(state));
    var c = s.config;
    var sym = market.symbol || symbolsOf(c)[0];
    var now = market.now;
    s.positions = s.positions || {};
    s.status = s.status || {};

    // 持倉期間每 8 小時收一次資金費（每個幣各自算）
    var held = s.positions[sym];
    if (held && held.nextFundingAt) {
      var rate = isNum(market.fundingRate) ? Math.abs(market.fundingRate) : c.fundingPer8h;
      var due = held.nextFundingAt;
      while (now >= due) {
        var cost = held.notional * rate;
        s.fundingPaid += cost;
        s.equity -= cost;
        held.funding = (held.funding || 0) + cost;   // 記在這一筆頭上，平倉時算進損益與 R
        due += EIGHT_HOURS;
      }
      held.nextFundingAt = due;
    }

    if (action.type === 'open') {
      var p = action.plan;
      var fee = p.notional * c.feeRate;
      s.feesPaid += fee;
      s.equity -= fee;
      s.positions[sym] = {
        symbol: sym,
        side: p.side, entry: p.entry, stop: p.stop, tp: p.targets[0].price,
        tp2: p.targets[1] ? p.targets[1].price : null,
        qty: p.qty, notional: p.notional,
        exchangeLeverage: p.exchangeLeverage, liqPrice: p.liqPrice,
        riskUsd: p.riskUsd, entryFee: fee,
        openedAt: now, nextFundingAt: now + EIGHT_HOURS,
        why: action.why
      };
      s.notes.unshift({ t: now, kind: 'open', symbol: sym,
        text: shortName(sym) + ' ' + (p.side === 'long' ? '開多' : '開空') + ' ' + p.qty +
              ' @ ' + p.entry + '，止損 ' + +p.stop.toPrecision(6) + '，止盈 ' + +p.targets[0].price.toPrecision(6) });
      s.status[sym] = { t: now, type: 'open', reason: action.why };
    } else if (action.type === 'close' && s.positions[sym]) {
      var pos = s.positions[sym];
      var gross = pos.side === 'long'
        ? (action.price - pos.entry) * pos.qty
        : (pos.entry - action.price) * pos.qty;
      var exitFee = pos.qty * action.price * c.feeRate;
      s.feesPaid += exitFee;
      s.equity += gross - exitFee;
      // 損益要含持倉期間付的資金費，不然 R 會高估（抱越久高估越多）
      var pnl = gross - exitFee - pos.entryFee - (pos.funding || 0);
      s.trades.push({
        symbol: sym,
        openedAt: pos.openedAt, closedAt: action.at || now,
        side: pos.side, entry: pos.entry, stop: pos.stop, tp: pos.tp,
        exit: action.price, qty: pos.qty, notional: pos.notional,
        pnl: pnl, r: pos.riskUsd > 0 ? pnl / pos.riskUsd : null, funding: pos.funding || 0,
        why: action.why, equityAfter: s.equity
      });
      s.notes.unshift({ t: now, kind: action.why === 'tp' ? 'win' : 'loss', symbol: sym,
        text: shortName(sym) + ' ' + (action.why === 'tp' ? '止盈出場' : '止損出場') +
              ' @ ' + +action.price.toPrecision(6) + '，' + (pnl >= 0 ? '+' : '') + pnl.toFixed(2) + ' U' });
      delete s.positions[sym];
      s.status[sym] = { t: now, type: 'closed', reason: action.why === 'tp' ? '止盈出場' : '止損出場' };
    } else {
      // hold / wait / blocked / skip：只更新這個幣的狀態，不寫進事件紀錄（避免灌爆）
      s.status[sym] = { t: now, type: action.type, reason: action.reason || '' };
    }

    if (s.notes.length > 300) s.notes = s.notes.slice(0, 300);
    return s;
  }

  /** 行情抓不到時，記下這個幣的錯誤狀態 */
  function setStatus(state, sym, now, type, reason) {
    var s = JSON.parse(JSON.stringify(state));
    s.status = s.status || {};
    s.status[sym] = { t: now, type: type, reason: reason };
    return s;
  }

  /** 一整輪（所有幣都跑完）結束時呼叫：記錄輪數與權益曲線 */
  function mark(state, now) {
    var s = JSON.parse(JSON.stringify(state));
    s.ticks++;
    s.lastTick = now;
    s.curve.push({ t: now, equity: s.equity, open: openCount(s) });
    if (s.curve.length > 5000) s.curve = s.curve.slice(-5000);
    return s;
  }

  /** 單一幣：決定 + 套用 */
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

    var bySymbol = {};
    t.forEach(function (x) {
      var k = x.symbol || '?';
      var b = bySymbol[k] || (bySymbol[k] = { n: 0, wins: 0, totalR: 0, pnl: 0 });
      b.n++; if (x.pnl > 0) b.wins++;
      b.totalR += isNum(x.r) ? x.r : 0; b.pnl += x.pnl;
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
      openCount: openCount(state),
      bySymbol: bySymbol,
      runningDays: state.createdAt ? (Date.now() - state.createdAt) / 86400000 : 0,
      enough: t.length >= 30
    };
  }

  root.BOT = {
    defaultConfig: defaultConfig, newState: newState, migrate: migrate,
    symbolsOf: symbolsOf, filtersFor: filtersFor,
    decide: decide, apply: apply, tick: tick, mark: mark, setStatus: setStatus,
    stats: stats, scanExit: scanExit, openCount: openCount, totalNotional: totalNotional
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
