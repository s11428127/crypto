/*
 * bot.js —— 模擬單機器人（多幣種，規則 v2）
 *
 * **不會**下真實訂單，也不碰任何 API 金鑰。用真實行情、真實手續費、真實資金費，
 * 記錄「照這套規則做，帳戶會變怎樣」，累積一份可以檢驗的成績單。
 *
 * 規則在 assets/strategy.js，和回測共用同一份程式 —— 回測到什麼，這裡就跑什麼：
 *   - 只在「一根 4H 剛收盤」後的第一輪判斷進場；同一根 K 棒晚了幾小時不追進去
 *   - 止損只在 4H 收盤時往有利方向移（保本、移動止損），永遠不後退
 *   - 用已收盤的 15 分 K 檢查有沒有碰到止損；跳空越過止損以開盤價出場
 *   - 虧損出場後，同一個幣 6 根 4H（24 小時）內不再進場
 *
 * 帳戶層級（多幣共用一個帳戶）：同時持倉上限、總名目不超過 maxLeverage 倍、
 * 最小下單量把風險頂超過 maxRiskPct 就不做。
 */
(function (root) {
  'use strict';

  var R = root.RISK, S = root.STRATEGY;
  function isNum(x) { return typeof x === 'number' && isFinite(x); }

  var H4 = 4 * 3600 * 1000, M15 = 15 * 60 * 1000, DAY = 86400000, EIGHT_HOURS = 8 * 3600 * 1000;
  function floorTo(t, step) { return Math.floor(t / step) * step; }

  function defaultConfig() {
    return {
      rules: 'v2',
      allowShort: false,       // 3 年回測：v2 空單沒有優勢，先只驗證多單
      symbols: ['BTCUSDT'],
      startEquity: 100,
      riskPct: 1,
      maxRiskPct: 5,
      maxPositions: 3,
      maxLeverage: 5,
      feeRate: 0.00055,
      fundingPer8h: 0.0001,
      filters: { '*': { minQty: 0, stepSize: 0, minNotional: 5 } }
    };
  }

  function symbolsOf(c) {
    if (c.symbols && c.symbols.length) return c.symbols.slice();
    return [c.symbol || 'BTCUSDT'];
  }

  function filtersFor(c, sym) {
    var f = c.filters || {};
    if (isNum(f.minNotional)) return f;
    return f[sym] || f['*'] || R.DEFAULT_FILTERS;
  }

  function newState(config) {
    var c = Object.assign(defaultConfig(), config || {});
    return {
      version: 2, config: c, equity: c.startEquity,
      positions: {}, status: {}, trades: [], curve: [],
      feesPaid: 0, fundingPaid: 0, ticks: 0, lastTick: null,
      createdAt: Date.now(), notes: []
    };
  }

  /** 補齊部位欄位（舊版開的部位沒有移動止損需要的資料） */
  function normalizePosition(p) {
    if (!isNum(p.initStop)) p.initStop = p.stop;
    if (!isNum(p.initRisk)) p.initRisk = Math.abs(p.entry - p.initStop);
    if (!isNum(p.best)) p.best = p.entry;
    if (!isNum(p.lastTrailBarT)) p.lastTrailBarT = floorTo(p.openedAt, H4) - H4;
    if (!isNum(p.lastCheckT)) p.lastCheckT = p.openedAt;
    if (!isNum(p.funding)) p.funding = 0;
    return p;
  }

  /** v1（單一部位）→ v2（多幣種）；已經是 v2 也會補齊部位欄位。回傳深拷貝。 */
  function migrate(state) {
    var s = JSON.parse(JSON.stringify(state));
    if (!(s.version >= 2 && s.positions)) {
      var sym = (s.config && s.config.symbol) || 'BTCUSDT';
      s.positions = {};
      if (s.position) s.positions[sym] = Object.assign({ symbol: sym }, s.position);
      delete s.position;
      s.status = s.status || {};
      (s.trades || []).forEach(function (t) { if (!t.symbol) t.symbol = sym; });
      (s.curve || []).forEach(function (p) { if (p.open === undefined) p.open = p.hasPosition ? 1 : 0; });
      s.notes = (s.notes || []).filter(function (n) { return n.kind !== 'idle'; });
      if (s.config && !s.config.symbols) s.config.symbols = [sym];
      s.version = 2;
    }
    s.status = s.status || {};
    for (var k in s.positions) normalizePosition(s.positions[k]);
    return s;
  }

  function openCount(state) { return Object.keys(state.positions || {}).length; }
  function totalNotional(state) {
    var sum = 0;
    for (var k in state.positions) sum += state.positions[k].notional || 0;
    return sum;
  }
  function shortName(sym) { return String(sym).replace(/USDT$/, ''); }
  function px(v) { return isNum(v) ? String(+v.toPrecision(6)) : '—'; }

  /** 只留已經收盤的 K 棒 */
  function closedOnly(bars, step, now) {
    return (bars || []).filter(function (b) { return b.t + step <= now; });
  }

  /** 15 分 K 有沒有碰到止損；跳空越過以開盤價出場 */
  function stopHit(pos, b) {
    return S.hitStop(pos, b);
  }

  /**
   * 持倉中的一輪：依時間順序處理 ——
   * 每根新收盤的 4H：先用它裡面的 15 分 K 檢查止損，沒出場就用這根 4H 更新止損；
   * 最後再檢查還在形成中那根 4H 裡已收盤的 15 分 K。
   * 和回測一樣：止損在 4H 收盤時才更新，下一根開始生效。
   */
  function manage(pos, market, ctx, k4c) {
    var p = normalizePosition(JSON.parse(JSON.stringify(pos)));
    var k15 = closedOnly(market.k15, M15, market.now)
      .filter(function (b) { return b.t >= p.openedAt && b.t > p.lastCheckT; })
      .sort(function (a, b) { return a.t - b.t; });
    var entryBarT = floorTo(p.openedAt, H4);

    function scan(from, to) {
      for (var n = 0; n < k15.length; n++) {
        var b = k15[n];
        if (b.t < from || b.t >= to) continue;
        var hit = stopHit(p, b);
        p.lastCheckT = b.t;
        if (hit !== null) return { price: hit, at: b.t + M15 };
      }
      return null;
    }

    for (var j = 0; j < k4c.length; j++) {
      var bar = k4c[j];
      if (bar.t < entryBarT || bar.t <= p.lastTrailBarT) continue;
      var ex = scan(bar.t, bar.t + H4);
      if (ex) return { exit: ex, pos: p };
      var tr = S.trail(p, ctx, j);
      p.stop = tr.stop; p.best = tr.best; p.lastTrailBarT = bar.t;
    }
    var ex2 = scan(k4c.length ? k4c[k4c.length - 1].t + H4 : 0, Infinity);
    if (ex2) return { exit: ex2, pos: p };
    return { exit: null, pos: p };
  }

  /**
   * 決定某個幣這一輪要做什麼。不改動 state。
   * market = { symbol, now, price, k4, d1, k15, fundingRate, filters }
   * （k4 / d1 / k15 可以含還沒收盤的最後一根，這裡會自己過濾）
   */
  function decide(state, market, config) {
    var c = config || state.config;
    var sym = market.symbol || symbolsOf(c)[0];
    var now = market.now;
    if (!isNum(market.price) || market.price <= 0) return { type: 'skip', reason: '沒有有效報價' };

    var k4c = closedOnly(market.k4, H4, now);
    var d1c = closedOnly(market.d1, DAY, now);
    if (k4c.length < 60 || d1c.length < 210) return { type: 'skip', reason: 'K 線資料不足（4H 至少 60 根、日線 210 根）' };
    var ctx = S.prepare(k4c, d1c);

    var held = state.positions && state.positions[sym];
    if (held) {
      var m = manage(held, market, ctx, k4c);
      if (m.exit) {
        return { type: 'close', price: m.exit.price, at: m.exit.at,
                 why: m.pos.stop === m.pos.initStop ? 'stop' : 'trail', pos: m.pos };
      }
      return { type: 'hold', pos: m.pos,
               reason: '續抱，止損 ' + px(m.pos.stop) + (m.pos.stop !== m.pos.initStop ? '（已上移）' : '') };
    }

    var i = k4c.length - 1, barT = k4c[i].t;
    var st = (state.status && state.status[sym]) || {};
    if (st.lastBarT === barT) {
      return { type: 'wait', barT: barT, reason: st.reason || '這根 4H 已經判斷過，等下一根收盤' };
    }
    if (isNum(st.cooldownUntil) && barT < st.cooldownUntil) {
      return { type: 'wait', barT: barT, reason: '止損後冷卻中，' + new Date(st.cooldownUntil).toISOString().slice(5, 16).replace('T', ' ') + ' UTC 之後才會再進' };
    }

    var sig = S.signal(ctx, i);
    if (!sig) return { type: 'wait', barT: barT, reason: S.explain(ctx, i) || '沒有訊號' };
    if (sig.side === 'short' && c.allowShort === false) {
      return { type: 'wait', barT: barT, reason: '出現空單訊號，但目前只驗證多單（回測顯示空單沒有優勢）' };
    }

    var entry = market.price;
    if (sig.side === 'long' ? entry <= sig.stop : entry >= sig.stop) {
      return { type: 'blocked', barT: barT, reason: '價格已經越過止損位置，不進' };
    }
    var maxPos = isNum(c.maxPositions) ? c.maxPositions : 3;
    if (openCount(state) >= maxPos) {
      return { type: 'wait', barT: barT, reason: '已達同時持倉上限 ' + maxPos + ' 筆，訊號到了也不加' };
    }
    var sz = S.size(state.equity, entry, sig.stop, {
      riskPct: c.riskPct, maxRiskPct: c.maxRiskPct, maxLeverage: c.maxLeverage,
      filters: market.filters || filtersFor(c, sym)
    });
    if (!sz) return { type: 'skip', barT: barT, reason: '算不出部位' };
    if (sz.blocked === 'leverage') return { type: 'blocked', barT: barT, reason: '最小部位超過槓桿上限，開不起來' };
    if (sz.blocked === 'risk') return { type: 'blocked', barT: barT, reason: '最小下單量把風險頂超過上限 ' + c.maxRiskPct + '%' };
    if (totalNotional(state) + sz.notional > state.equity * c.maxLeverage + 1e-9) {
      return { type: 'blocked', barT: barT, reason: '加上這筆，帳戶總名目會超過 ' + c.maxLeverage + ' 倍權益' };
    }
    return { type: 'open', barT: barT, why: sig.why,
             plan: { side: sig.side, entry: entry, stop: sig.stop, qty: sz.qty,
                     notional: sz.notional, riskUsd: sz.riskUsd } };
  }

  /** 把某個幣的動作套用到狀態上，回傳新的狀態（不改動傳入的物件） */
  function apply(state, action, market) {
    var s = JSON.parse(JSON.stringify(state));
    var c = s.config;
    var sym = market.symbol || symbolsOf(c)[0];
    var now = market.now;
    s.positions = s.positions || {};
    s.status = s.status || {};
    var st = s.status[sym] = Object.assign({}, s.status[sym] || {});

    // 持倉期間每 8 小時收一次資金費（記在這一筆頭上）
    var held = s.positions[sym];
    if (held && held.nextFundingAt) {
      var rate = isNum(market.fundingRate) ? Math.abs(market.fundingRate) : c.fundingPer8h;
      var due = held.nextFundingAt;
      var until = action.type === 'close' && isNum(action.at) ? Math.min(now, action.at) : now;
      while (until >= due) {
        var cost = held.notional * rate;
        s.fundingPaid += cost; s.equity -= cost;
        held.funding = (held.funding || 0) + cost;
        due += EIGHT_HOURS;
      }
      held.nextFundingAt = due;
    }

    if (action.type === 'open') {
      var p = action.plan;
      var fee = p.notional * c.feeRate;
      s.feesPaid += fee; s.equity -= fee;
      var exLev = Math.max(1, Math.ceil(p.notional / s.equity - 1e-9));
      s.positions[sym] = {
        symbol: sym, side: p.side, entry: p.entry,
        stop: p.stop, initStop: p.stop, initRisk: Math.abs(p.entry - p.stop), best: p.entry,
        qty: p.qty, notional: p.notional, riskUsd: p.riskUsd, entryFee: fee, funding: 0,
        exchangeLeverage: exLev,
        liqPrice: R.liqPrice({ entry: p.entry, leverage: exLev, side: p.side }),
        // 開倉當下那一根（t >= openedAt）也要檢查，所以從 now − 1 開始算
        openedAt: now, lastCheckT: now - 1,
        lastTrailBarT: floorTo(now, H4) - H4,
        nextFundingAt: now + EIGHT_HOURS, why: action.why
      };
      s.notes.unshift({ t: now, kind: 'open', symbol: sym,
        text: shortName(sym) + ' ' + (p.side === 'long' ? '開多' : '開空') + ' ' + p.qty + ' @ ' + px(p.entry) +
              '，止損 ' + px(p.stop) + '（風險 $' + p.riskUsd.toFixed(2) + '）' });
      Object.assign(st, { t: now, type: 'open', reason: action.why, lastBarT: action.barT });
    } else if (action.type === 'close' && held) {
      var pos = Object.assign(held, action.pos || {}, { funding: held.funding, nextFundingAt: held.nextFundingAt });
      var gross = pos.side === 'long' ? (action.price - pos.entry) * pos.qty : (pos.entry - action.price) * pos.qty;
      var exitFee = pos.qty * action.price * c.feeRate;
      s.feesPaid += exitFee;
      s.equity += gross - exitFee;
      var pnl = gross - exitFee - pos.entryFee - (pos.funding || 0);
      s.trades.push({
        symbol: sym, openedAt: pos.openedAt, closedAt: action.at || now,
        side: pos.side, entry: pos.entry, stop: pos.initStop, exit: action.price,
        qty: pos.qty, notional: pos.notional,
        pnl: pnl, r: pos.riskUsd > 0 ? pnl / pos.riskUsd : null, funding: pos.funding || 0,
        why: action.why, equityAfter: s.equity
      });
      var label = action.why === 'trail' ? '移動止損出場' : '止損出場';
      s.notes.unshift({ t: now, kind: pnl > 0 ? 'win' : 'loss', symbol: sym,
        text: shortName(sym) + ' ' + label + ' @ ' + px(action.price) + '，' + (pnl >= 0 ? '+' : '') + pnl.toFixed(2) + ' U' });
      delete s.positions[sym];
      Object.assign(st, { t: now, type: 'closed', reason: label });
      // 虧損出場 → 冷卻 6 根 4H（和回測一樣：從出場那根 4H 起算）
      if (pnl <= 0) st.cooldownUntil = floorTo(action.at || now, H4) + S.PARAMS.cooldownBars * H4;
    } else if (action.type === 'hold' && held) {
      var upd = action.pos || {};
      ['stop', 'best', 'lastTrailBarT', 'lastCheckT', 'initStop', 'initRisk'].forEach(function (k) {
        if (upd[k] !== undefined) held[k] = upd[k];
      });
      Object.assign(st, { t: now, type: 'hold', reason: action.reason || '' });
    } else {
      Object.assign(st, { t: now, type: action.type, reason: action.reason || '' });
      if (action.barT !== undefined) st.lastBarT = action.barT;
    }

    if (s.notes.length > 300) s.notes = s.notes.slice(0, 300);
    return s;
  }

  function setStatus(state, sym, now, type, reason) {
    var s = JSON.parse(JSON.stringify(state));
    s.status = s.status || {};
    s.status[sym] = Object.assign({}, s.status[sym] || {}, { t: now, type: type, reason: reason });
    return s;
  }

  function mark(state, now) {
    var s = JSON.parse(JSON.stringify(state));
    s.ticks++;
    s.lastTick = now;
    s.curve.push({ t: now, equity: s.equity, open: openCount(s) });
    if (s.curve.length > 5000) s.curve = s.curve.slice(-5000);
    return s;
  }

  /**
   * 單一幣：決定 + 套用。平倉之後同一輪再判斷一次進場 ——
   * 回測在出場的那根 K 棒收盤時就會判斷下一筆，這裡要一致，不然會少做單。
   */
  function tick(state, market, config) {
    var action = decide(state, market, config);
    var next = apply(state, action, market);
    if (action.type === 'close') {
      var again = decide(next, market, config);
      if (again.type === 'open') return { state: apply(next, again, market), action: action, then: again };
      next = apply(next, again, market);
      return { state: next, action: action, then: again };
    }
    return { state: next, action: action };
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
      if (x.pnl <= 0) { streak++; maxStreak = Math.max(maxStreak, streak); } else streak = 0;
    });
    var bySymbol = {};
    t.forEach(function (x) {
      var k = x.symbol || '?';
      var b = bySymbol[k] || (bySymbol[k] = { n: 0, wins: 0, totalR: 0, pnl: 0 });
      b.n++; if (x.pnl > 0) b.wins++;
      b.totalR += isNum(x.r) ? x.r : 0; b.pnl += x.pnl;
    });
    return {
      n: t.length, equity: state.equity, startEquity: state.config.startEquity,
      returnPct: (state.equity / state.config.startEquity - 1) * 100,
      winRate: t.length ? wins.length / t.length * 100 : null,
      avgR: t.length ? sumR / t.length : null, totalR: sumR,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
      maxDD: maxDD * 100, maxLossStreak: maxStreak,
      feesPaid: state.feesPaid, fundingPaid: state.fundingPaid,
      ticks: state.ticks, openCount: openCount(state), bySymbol: bySymbol,
      runningDays: state.createdAt ? (Date.now() - state.createdAt) / 86400000 : 0,
      enough: t.length >= 30
    };
  }

  root.BOT = {
    defaultConfig: defaultConfig, newState: newState, migrate: migrate,
    symbolsOf: symbolsOf, filtersFor: filtersFor,
    decide: decide, apply: apply, tick: tick, mark: mark, setStatus: setStatus,
    stats: stats, openCount: openCount, totalNotional: totalNotional, manage: manage
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
