/* background.js — service worker. В MV3 только фетч из SW освобождён от CORS
 * по host_permissions (content-script, даже isolated, CORS подчиняется).
 * Мост oi-bridge.js шлёт сюда запрос, SW фетчит apim.moex.com / воркер и
 * возвращает тело. */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'tvsig:fetch' || !msg.url) return;
  (async () => {
    try {
      // futoi (analyticalproducts) авторизуется сессионной кукой MOEX Passport —
      // той же, что даёт ручной доступ на сайте. Поэтому для moex.com шлём
      // credentials, иначе запрос уходит без входа и MOEX отдаёт 401.
      // Воркер (не moex.com) — по-прежнему без кук.
      let host = ''; try { host = new URL(msg.url).hostname; } catch (_) {}
      const opt = { credentials: /(^|\.)moex\.com$/.test(host) ? 'include' : 'omit' };
      if (msg.headers) opt.headers = msg.headers; // напр. Authorization: Bearer <AlgoPack APIKEY>
      const r = await fetch(msg.url, opt);
      if (!r.ok) sendResponse({ ok: false, error: 'HTTP ' + r.status });
      else sendResponse({ ok: true, json: await r.text() });
    } catch (err) { sendResponse({ ok: false, error: String(err && err.message || err) }); }
  })();
  return true; // держим канал открытым под async sendResponse
});
