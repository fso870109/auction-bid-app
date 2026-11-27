/* v113: fill in browser features that older iPhones (iOS 15 / early 16) do not have.
   Without AbortSignal.timeout (iOS < 16) joining a room threw an error, so the
   iPhone never got into the room. Must load before every other script. */
(function () {
  try {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout !== 'function') {
      AbortSignal.timeout = function (ms) {
        const c = new AbortController();
        setTimeout(function () {
          try { c.abort(new DOMException('TimeoutError', 'TimeoutError')); } catch (e) { c.abort(); }
        }, ms);
        return c.signal;
      };
    }
  } catch (e) { /* ignore */ }
  try {
    if (typeof window.structuredClone !== 'function') {
      window.structuredClone = function (v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); };
    }
  } catch (e) { /* ignore */ }
  function def(proto, name, fn) {
    if (!proto[name]) {
      try { Object.defineProperty(proto, name, { value: fn, configurable: true, writable: true }); } catch (e) { /* ignore */ }
    }
  }
  def(Array.prototype, 'at', function (i) { i = Math.trunc(i) || 0; if (i < 0) i += this.length; return this[i]; });
  def(String.prototype, 'at', function (i) { i = Math.trunc(i) || 0; if (i < 0) i += this.length; return this[i]; });
  def(Array.prototype, 'findLast', function (f, t) { for (let i = this.length - 1; i >= 0; i--) if (f.call(t, this[i], i, this)) return this[i]; return undefined; });
  def(Array.prototype, 'findLastIndex', function (f, t) { for (let i = this.length - 1; i >= 0; i--) if (f.call(t, this[i], i, this)) return i; return -1; });
  if (!Object.hasOwn) Object.hasOwn = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };
  if (typeof window.requestIdleCallback !== 'function') {
    window.requestIdleCallback = function (cb) { return setTimeout(function () { cb({ didTimeout: false, timeRemaining: function () { return 8; } }); }, 1); };
    window.cancelIdleCallback = function (id) { clearTimeout(id); };
  }
})();
