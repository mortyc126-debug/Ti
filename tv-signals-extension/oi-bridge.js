/* oi-bridge.js — isolated-world мост для загрузки OI из воркера.
 * MAIN-мир не может фетчить сторонний домен (CSP терминала), а isolated-world
 * content-script ходит по host_permissions в обход CSP страницы. Общаемся
 * через DOM-события (detail — строка JSON, чисто переносится между мирами). */
(function () {
  'use strict';
  window.addEventListener('tvsig:oi:req', async (e) => {
    let d; try { d = JSON.parse(e.detail); } catch (_) { return; }
    const res = { id: d.id };
    try {
      const opt = { credentials: 'omit' };
      if (d.headers) opt.headers = d.headers;   // напр. Authorization: Bearer <MOEX-токен>
      const r = await fetch(d.url, opt);
      if (!r.ok) { res.ok = false; res.error = 'HTTP ' + r.status; }
      else { res.ok = true; res.json = await r.text(); }
    } catch (err) { res.ok = false; res.error = String(err && err.message || err); }
    try { window.dispatchEvent(new CustomEvent('tvsig:oi:res', { detail: JSON.stringify(res) })); } catch (_) {}
  });
})();
