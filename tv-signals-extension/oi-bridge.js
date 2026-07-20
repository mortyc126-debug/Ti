/* oi-bridge.js — isolated-world мост MAIN ↔ background service worker.
 * MAIN-мир не видит chrome.runtime, а в MV3 фетч из content-script режется
 * CORS (host_permissions не освобождает — только фетч из SW). Поэтому:
 * content.js (MAIN) → DOM-событие → этот мост (ISOLATED) → chrome.runtime →
 * background.js (SW, CORS-exempt) → ответ обратно тем же путём. */
(function () {
  'use strict';
  window.addEventListener('tvsig:oi:req', (e) => {
    let d; try { d = JSON.parse(e.detail); } catch (_) { return; }
    const reply = (res) => {
      res.id = d.id;
      try { window.dispatchEvent(new CustomEvent('tvsig:oi:res', { detail: JSON.stringify(res) })); } catch (_) {}
    };
    try {
      chrome.runtime.sendMessage({ type: 'tvsig:fetch', url: d.url, headers: d.headers || null, method: d.method || null, body: d.body || null }, (res) => {
        if (chrome.runtime.lastError) return reply({ ok: false, error: chrome.runtime.lastError.message || 'sw-unreachable' });
        reply(res || { ok: false, error: 'no-response' });
      });
    } catch (err) { reply({ ok: false, error: String(err && err.message || err) }); }
  });
})();
