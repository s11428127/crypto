/*
 * chart.js —— K 線圖（canvas，無外部相依）
 * 顏色一律從 CSS 變數取，切主題才不會壞。
 */
(function (root) {
  'use strict';

  // isNum(null) === true（Number(null) 是 0），會讓「有值就用、沒值就備援」的三元判斷
  // 在 null 時選中 null。一律用這個嚴格版本。
  function isNum(x) { return typeof x === 'number' && isFinite(x); }

  function cssVar(name, fallback) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback || '#888';
  }

  function fmtTime(ms, tf) {
    var d = new Date(ms);
    var p = function (n) { return n < 10 ? '0' + n : '' + n; };
    // 4H 以上的刻度間隔常常跨天，只印時分會出現一模一樣的標籤
    if (tf === '1d' || tf === '4h') return (d.getMonth() + 1) + '/' + d.getDate();
    return p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function niceStep(range, target) {
    var raw = range / Math.max(1, target);
    var mag = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-9))));
    var n = raw / mag;
    var s = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
    return s * mag;
  }

  /**
   * 畫一張 K 線圖。
   * opts: { klines, ema:{e20,e50,e200}, tf, live (即時價), bars (顯示幾根) }
   */
  function draw(canvas, opts) {
    var ctx = canvas.getContext('2d');
    var cssW = Math.max(1, canvas.clientWidth || 320);
    var cssH = Math.max(180, Math.min(420, Math.round(cssW * 0.55)));
    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(cssW * dpr));
    canvas.height = Math.max(1, Math.round(cssH * dpr));
    canvas.style.height = cssH + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    var k = opts.klines || [];
    if (!k.length) {
      ctx.fillStyle = cssVar('--text-dim');
      ctx.font = '13px ' + cssVar('--sans', 'sans-serif');
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('沒有資料', cssW / 2, cssH / 2);
      return;
    }

    var C = {
      up: cssVar('--long'), down: cssVar('--short'),
      grid: cssVar('--line'), dim: cssVar('--text-dim'), text: cssVar('--text'),
      e20: cssVar('--accent'), e50: cssVar('--stop'), e200: cssVar('--text-dim'),
      live: cssVar('--accent')
    };

    // 版面：右側留價格軸、底部留時間軸與成交量
    var axisW = 58, padT = 8, timeH = 16, volH = Math.max(24, Math.round(cssH * 0.16));
    var plotL = 4, plotR = Math.max(plotL + 10, cssW - axisW);
    var plotT = padT, plotB = Math.max(plotT + 20, cssH - timeH - volH - 6);
    var volT = plotB + 6, volB = cssH - timeH;
    var plotH = Math.max(10, plotB - plotT);
    var plotW = Math.max(10, plotR - plotL);

    // 顯示最後 N 根
    var maxBars = opts.bars || Math.max(30, Math.floor(plotW / 6));
    var start = Math.max(0, k.length - maxBars);
    var view = k.slice(start);
    var n = view.length;

    // 價格範圍：含均線與即時價
    var lo = Infinity, hi = -Infinity;
    view.forEach(function (x) { if (x.l < lo) lo = x.l; if (x.h > hi) hi = x.h; });
    var series = [];
    ['e20', 'e50', 'e200'].forEach(function (key) {
      var arr = opts.ema && opts.ema[key];
      if (!arr) return;
      var slice = arr.slice(start);
      series.push({ key: key, vals: slice, color: C[key] });
      slice.forEach(function (v) {
        if (v === null || !isNum(v)) return;
        if (v < lo) lo = v; if (v > hi) hi = v;
      });
    });
    if (isNum(opts.live)) { if (opts.live < lo) lo = opts.live; if (opts.live > hi) hi = opts.live; }
    if (!isNum(lo) || !isNum(hi) || hi <= lo) { hi = lo + 1; }
    var padP = (hi - lo) * 0.06;
    lo -= padP; hi += padP;
    var span = Math.max(hi - lo, 1e-9);
    var yOf = function (p) { return plotT + (hi - p) / span * plotH; };

    var bw = plotW / Math.max(1, n);
    var body = Math.max(1, Math.min(14, bw * 0.68));
    var xOf = function (i) { return plotL + bw * (i + 0.5); };

    // 即時價標籤會佔住價格軸的一段，先算出來，稍後跳過被蓋住的刻度
    var livePx = isNum(opts.live) ? opts.live : view[n - 1].c;
    var liveY = yOf(livePx);

    // ── 網格與價格軸 ──
    ctx.font = '10px ' + cssVar('--mono', 'monospace');
    ctx.textBaseline = 'middle';
    var step = niceStep(span, 5);
    var first = Math.ceil(lo / step) * step;
    ctx.strokeStyle = C.grid; ctx.lineWidth = 1;
    for (var g = first; g <= hi; g += step) {
      var gy = Math.round(yOf(g)) + 0.5;
      if (gy < plotT || gy > plotB) continue;
      ctx.globalAlpha = 0.5;
      ctx.beginPath(); ctx.moveTo(plotL, gy); ctx.lineTo(plotR, gy); ctx.stroke();
      ctx.globalAlpha = 1;
      if (Math.abs(gy - liveY) < 11) continue;   // 會被即時價標籤蓋住，不印
      ctx.fillStyle = C.dim; ctx.textAlign = 'left';
      ctx.fillText(g.toLocaleString('en-US', { maximumFractionDigits: g < 100 ? 2 : 0 }), plotR + 5, gy);
    }

    // ── 成交量 ──
    var vMax = 0;
    view.forEach(function (x) { if (x.v > vMax) vMax = x.v; });
    if (vMax > 0) {
      view.forEach(function (x, i) {
        var h = Math.max(0, (x.v / vMax) * Math.max(0, volB - volT));
        ctx.fillStyle = x.c >= x.o ? C.up : C.down;
        ctx.globalAlpha = 0.35;
        ctx.fillRect(xOf(i) - body / 2, volB - h, body, h);
        ctx.globalAlpha = 1;
      });
    }

    // ── K 棒 ──
    view.forEach(function (x, i) {
      var col = x.c >= x.o ? C.up : C.down;
      var cx = xOf(i);
      ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1;
      // 影線
      ctx.beginPath();
      ctx.moveTo(Math.round(cx) + 0.5, yOf(x.h));
      ctx.lineTo(Math.round(cx) + 0.5, yOf(x.l));
      ctx.stroke();
      // 實體
      var yo = yOf(x.o), yc = yOf(x.c);
      var top = Math.min(yo, yc);
      var h = Math.max(1, Math.abs(yc - yo));
      ctx.fillRect(cx - body / 2, top, body, h);
    });

    // ── 均線 ──
    series.forEach(function (s) {
      ctx.strokeStyle = s.color; ctx.lineWidth = 1.3;
      ctx.globalAlpha = s.key === 'e200' ? 0.7 : 1;
      ctx.beginPath();
      var started = false;
      s.vals.forEach(function (v, i) {
        if (v === null || !isNum(v)) { started = false; return; }
        var x = xOf(i), y = yOf(v);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.globalAlpha = 1;
    });

    // ── 即時價格線 ──
    var lp = livePx;
    var ly = Math.round(liveY) + 0.5;
    if (ly >= plotT && ly <= plotB) {
      ctx.save();
      ctx.strokeStyle = C.live; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(plotL, ly); ctx.lineTo(plotR, ly); ctx.stroke();
      ctx.restore();
      var label = lp.toLocaleString('en-US', { maximumFractionDigits: lp < 100 ? 2 : 1 });
      ctx.font = '10px ' + cssVar('--mono', 'monospace');
      var tw = ctx.measureText(label).width + 8;
      ctx.fillStyle = C.live;
      ctx.fillRect(plotR + 2, ly - 8, Math.min(tw, Math.max(0, axisW - 4)), 16);
      ctx.fillStyle = cssVar('--bg');
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(label, plotR + 6, ly);
    }

    // ── 時間軸 ──
    ctx.fillStyle = C.dim; ctx.font = '10px ' + cssVar('--mono', 'monospace');
    ctx.textBaseline = 'top'; ctx.textAlign = 'center';
    var tickEvery = Math.max(1, Math.round(n / Math.max(2, Math.floor(plotW / 64))));
    view.forEach(function (x, i) {
      if (i % tickEvery !== 0) return;
      var tx = xOf(i);
      if (tx < plotL + 12 || tx > plotR - 12) return;
      ctx.fillText(fmtTime(x.t, opts.tf), tx, volB + 3);
    });
  }

  root.CHART = { draw: draw };
})(typeof globalThis !== 'undefined' ? globalThis : this);
