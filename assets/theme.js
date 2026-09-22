/* theme.js —— 共用的主題切換（預設跟隨系統，手動選過才覆蓋並記住） */
(function (root) {
  'use strict';
  var listeners = [];
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function effective() {
    var s = document.documentElement.getAttribute('data-theme');
    return (s === 'dark' || s === 'light') ? s : (mq && mq.matches ? 'dark' : 'light');
  }
  function apply(t) {
    if (t === 'dark' || t === 'light') document.documentElement.setAttribute('data-theme', t);
    else document.documentElement.removeAttribute('data-theme');
    var btn = document.getElementById('theme-toggle');
    if (btn) btn.textContent = effective() === 'dark' ? '淺色' : '深色';
    listeners.forEach(function (f) { try { f(effective()); } catch (e) {} });
  }
  function init(onChange) {
    if (onChange) listeners.push(onChange);
    var saved = null;
    try { saved = localStorage.getItem('btcrisk-theme'); } catch (e) {}
    apply(saved);
    var btn = document.getElementById('theme-toggle');
    if (btn) btn.addEventListener('click', function () {
      var next = effective() === 'dark' ? 'light' : 'dark';
      apply(next);
      try { localStorage.setItem('btcrisk-theme', next); } catch (e) {}
    });
    if (mq && mq.addEventListener) mq.addEventListener('change', function () {
      if (!document.documentElement.getAttribute('data-theme')) apply(null);
    });
  }
  root.THEME = { init: init, effective: effective };
})(typeof globalThis !== 'undefined' ? globalThis : this);
