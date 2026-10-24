// Провайдеры ИИ: Mistral, GigaChat (Сбер) и любой OpenAI-совместимый.
//
// Как это встроено: очередь описаний, ИИ-дополнение и ИИ-создание кусков уже принимают
// `fetchImpl` и ходят на адрес Mistral в формате OpenAI. Мы подставляем им свой fetch:
// он смотрит на выбранного провайдера и, если это не Mistral, отправляет запрос туда,
// куда нужно (с обменом ключа на токен для GigaChat), а ответ возвращает в том же формате.
// Остальные модули менять не нужно.
//
// Что где хранится:
//   ключи          — только в браузере (localStorage); сервер получает ключ в заголовке запроса
//   настройки      — code-lab/ai-config.json (провайдер, модель, адрес, scope, путь к сертификату);
//                    ключей в этом файле нет
//   токен GigaChat — только в памяти сервера, живёт ~30 минут, обновляется сам

import { promises as fs } from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import tls from 'node:tls';
import crypto from 'node:crypto';

export const TYPES = {
  mistral:  { label: 'Mistral',  baseUrl: 'https://api.mistral.ai/v1', model: 'mistral-small-latest' },
  gigachat: { label: 'GigaChat', baseUrl: 'https://api.giga.chat/v1',  model: 'GigaChat',
              authUrl: 'https://ngw.devices.sberbank.ru:9443/api/v2/oauth', scope: 'GIGACHAT_API_PERS' },
  openai:   { label: 'OpenAI-совместимый', baseUrl: '', model: '' },
};
const MISTRAL_CHAT_URL = 'https://api.mistral.ai/v1/chat/completions';

const str = (v, max = 500) => String(v ?? '').trim().slice(0, max);
const DEFAULT_CONFIG = { type: 'mistral', model: '', baseUrl: '', scope: '', authUrl: '', caPath: '', insecureTls: false };

export function normalizeConfig(c = {}) {
  const type = TYPES[c.type] ? c.type : 'mistral';
  return {
    type,
    model: str(c.model, 120),
    baseUrl: str(c.baseUrl, 300).replace(/\/+$/, ''),
    scope: str(c.scope, 60),
    authUrl: str(c.authUrl, 300),
    caPath: str(c.caPath, 500),
    insecureTls: !!c.insecureTls,
  };
}

// Ключ авторизации GigaChat — это base64 от «Client ID:Client Secret». Принимаем и с приставкой Basic,
// и «сырой» вид client_id:secret (тогда кодируем сами).
export function gigaAuthKey(raw) {
  let k = str(raw, 2000).replace(/^Basic\s+/i, '');
  if (k.includes(':')) k = Buffer.from(k, 'utf8').toString('base64');
  return k;
}

// Ответ модели иногда приходит в ```json … ``` или с лишним текстом. Достаём сам JSON.
export function extractJson(text) {
  const s = String(text ?? '').trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  const body = fenced ? fenced[1].trim() : s;
  try { JSON.parse(body); return body; } catch {}
  const a = body.indexOf('{'), b = body.lastIndexOf('}');
  if (a >= 0 && b > a) { const cut = body.slice(a, b + 1); try { JSON.parse(cut); return cut; } catch {} }
  return s;
}

export function createProviderRuntime({ configPath, fetchImpl = fetch, httpsRequest = defaultHttpsRequest }) {
  let config = { ...DEFAULT_CONFIG };
  const tokens = new Map();          // sha1(ключ) → { token, exp }
  let caCache = { path: '', pem: null };

  async function load() {
    try { config = { ...DEFAULT_CONFIG, ...normalizeConfig(JSON.parse(await fs.readFile(configPath, 'utf8'))) }; } catch {}
    return config;
  }
  async function save(next) {
    config = normalizeConfig({ ...config, ...next });
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    const tmp = configPath + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(config, null, 2) + '\n');
    await fs.rename(tmp, configPath);
    return config;
  }

  const withDefaults = (c) => {
    const t = TYPES[c.type] || TYPES.mistral;
    return { ...c,
      baseUrl: c.baseUrl || t.baseUrl,
      model: c.model || t.model,
      scope: c.scope || t.scope || '',
      authUrl: c.authUrl || t.authUrl || '' };
  };

  async function tlsOptions(c) {
    const opts = {};
    if (c.insecureTls) opts.rejectUnauthorized = false;
    if (c.caPath) {
      if (caCache.path !== c.caPath) {
        const pem = await fs.readFile(c.caPath, 'utf8').catch(() => { throw new Error('Не удалось прочитать файл сертификата: ' + c.caPath); });
        caCache = { path: c.caPath, pem };
      }
      opts.ca = [...tls.rootCertificates, caCache.pem];   // системные корни + сертификат Минцифры
    }
    return opts;
  }

  // Запрос через node:https, чтобы можно было подложить свой сертификат (глобальный fetch этого не умеет без зависимостей).
  async function viaHttps(url, { method = 'GET', headers = {}, body = null }, c) {
    const extra = await tlsOptions(c);
    return httpsRequest(url, { method, headers, body, ...extra });
  }

  async function gigaToken(c, rawKey) {
    const id = crypto.createHash('sha1').update(String(rawKey)).digest('hex');
    const hit = tokens.get(id);
    if (hit && hit.exp - Date.now() > 60_000) return hit.token;
    const body = 'scope=' + encodeURIComponent(c.scope);
    const r = await viaHttps(c.authUrl, { method: 'POST', body, headers: {
      'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json',
      RqUID: crypto.randomUUID(), Authorization: 'Basic ' + gigaAuthKey(rawKey),
      'Content-Length': Buffer.byteLength(body) } }, c);
    if (r.status < 200 || r.status >= 300) throw new Error(`GigaChat: вход не удался (HTTP ${r.status}): ${r.text.slice(0, 300)}`);
    let j; try { j = JSON.parse(r.text); } catch { throw new Error('GigaChat: непонятный ответ при входе'); }
    if (!j.access_token) throw new Error('GigaChat: в ответе нет токена доступа');
    let exp = Number(j.expires_at) || 0;
    if (exp && exp < 1e12) exp *= 1000;               // иногда секунды, иногда миллисекунды
    if (!exp) exp = Date.now() + 25 * 60_000;
    tokens.set(id, { token: j.access_token, exp });
    return j.access_token;
  }

  const wrap = (status, text, headers = {}) => new Response(text, { status, headers: { 'Content-Type': 'application/json', ...headers } });

  // Запрос к GigaChat: обмен ключа на токен, при 401 один повтор с новым токеном.
  async function gigaCall(c, rawKey, pathPart, { method = 'GET', body = null } = {}) {
    for (let attempt = 0; ; attempt++) {
      const token = await gigaToken(c, rawKey);
      const payload = body == null ? null : JSON.stringify(body);
      const r = await viaHttps(c.baseUrl + pathPart, { method, body: payload, headers: {
        Authorization: 'Bearer ' + token, Accept: 'application/json',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) } }, c);
      if (r.status === 401 && attempt === 0) { tokens.clear(); continue; }
      return r;
    }
  }

  // Приводим тело запроса «в стиле Mistral» к тому, что принимает выбранный провайдер.
  function adaptBody(b, c) {
    const out = { ...b };
    if (c.model) out.model = c.model;
    if (c.type === 'gigachat') delete out.response_format;   // свой JSON-режим у GigaChat другой; просим JSON в промпте и чистим ответ
    return out;
  }
  function cleanReply(text, c) {
    if (c.type === 'mistral') return text;
    try {
      const j = JSON.parse(text);
      const m = j?.choices?.[0]?.message;
      if (m && typeof m.content === 'string') m.content = extractJson(m.content);
      return JSON.stringify(j);
    } catch { return text; }
  }

  async function chat(c0, rawKey, body) {
    const c = withDefaults(c0);
    if (c.type === 'gigachat') {
      const r = await gigaCall(c, rawKey, '/chat/completions', { method: 'POST', body: adaptBody(body, c) });
      return wrap(r.status, cleanReply(r.text, c), r.headers['retry-after'] ? { 'retry-after': String(r.headers['retry-after']) } : {});
    }
    const url = c.type === 'mistral' ? MISTRAL_CHAT_URL : c.baseUrl + '/chat/completions';
    if (c.type === 'openai' && !c.baseUrl) throw new Error('Для OpenAI-совместимого провайдера нужен адрес API (например https://api.openai.com/v1).');
    const resp = await fetchImpl(url, { method: 'POST',
      headers: { Authorization: `Bearer ${rawKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(adaptBody(body, c)) });
    if (c.type === 'mistral') return resp;
    const text = await resp.text();
    return wrap(resp.status, cleanReply(text, c), resp.headers.get('retry-after') ? { 'retry-after': resp.headers.get('retry-after') } : {});
  }

  // fetch для модулей: перехватывает запросы на адрес Mistral, остальное пропускает как есть.
  async function providerFetch(url, init = {}) {
    if (String(url) !== MISTRAL_CHAT_URL) return fetchImpl(url, init);
    const key = String((init.headers && (init.headers.Authorization || init.headers.authorization)) || '').replace(/^Bearer\s+/i, '');
    const body = JSON.parse(init.body || '{}');
    try { return await chat(config, key, body); }
    catch (e) { return wrap(502, JSON.stringify({ error: { message: String(e?.message || e) } })); }
  }

  // Список моделей — заодно честная проверка ключа (тратит ноль токенов).
  async function listModels(cfg, rawKey) {
    const c = withDefaults(normalizeConfig(cfg));
    if (!rawKey) throw new Error('Не указан ключ.');
    let r;
    if (c.type === 'gigachat') r = await gigaCall(c, rawKey, '/models');
    else {
      if (c.type === 'openai' && !c.baseUrl) throw new Error('Не указан адрес API.');
      const resp = await fetchImpl(c.baseUrl + '/models', { headers: { Authorization: `Bearer ${rawKey}` } });
      r = { status: resp.status, text: await resp.text() };
    }
    if (r.status < 200 || r.status >= 300) throw new Error(`${TYPES[c.type].label}: HTTP ${r.status} ${r.text.slice(0, 300)}`);
    let j; try { j = JSON.parse(r.text); } catch { throw new Error('Непонятный ответ сервиса.'); }
    const arr = Array.isArray(j) ? j : (j.data || j.models || []);
    return arr.map(m => (typeof m === 'string' ? m : m.id || m.name)).filter(Boolean).sort();
  }

  return { load, save, getConfig: () => ({ ...config }), fetch: providerFetch, listModels, chat };
}

function defaultHttpsRequest(url, { method, headers, body, ...tlsOpts }) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers, timeout: 60_000, ...tlsOpts }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('Нет ответа от сервиса за 60 секунд.')));
    req.on('error', e => {
      const m = String(e?.code || e?.message || e);
      reject(new Error(/CERT|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(m)
        ? 'Ошибка сертификата (' + m + '). Для GigaChat укажите путь к корневому сертификату Минцифры в настройках.'
        : 'Не удалось связаться с сервисом: ' + (e?.message || m)));
    });
    if (body) req.write(body);
    req.end();
  });
}
