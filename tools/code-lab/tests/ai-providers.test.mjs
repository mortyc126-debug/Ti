import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createProviderRuntime, extractJson, gigaAuthKey, normalizeConfig } from '../lib/ai-providers.mjs';

const MISTRAL = 'https://api.mistral.ai/v1/chat/completions';
const tmp = async () => path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'aip-')), 'ai-config.json');
const okReply = content => JSON.stringify({ choices: [{ message: { content } }] });

test('extractJson: достаёт JSON из ```-блока и из текста вокруг', () => {
  assert.equal(extractJson('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(extractJson('Вот ответ: {"a":1} готово'), '{"a":1}');
  assert.equal(extractJson('{"a":1}'), '{"a":1}');
});

test('gigaAuthKey: приставка Basic срезается, client_id:secret кодируется', () => {
  assert.equal(gigaAuthKey('Basic QUJD'), 'QUJD');
  assert.equal(gigaAuthKey('abc:def'), Buffer.from('abc:def').toString('base64'));
  assert.equal(gigaAuthKey('QUJDREVG'), 'QUJDREVG');
});

test('Mistral по умолчанию проходит как раньше, ключ и тело не меняются', async () => {
  const calls = [];
  const rt = createProviderRuntime({ configPath: await tmp(), fetchImpl: async (u, i) => { calls.push([u, i]); return new Response(okReply('{"x":1}')); } });
  await rt.load();
  const r = await rt.fetch(MISTRAL, { method: 'POST', headers: { Authorization: 'Bearer K1' }, body: JSON.stringify({ model: 'm', response_format: { type: 'json_object' }, messages: [] }) });
  assert.equal(r.status, 200);
  assert.equal(calls[0][0], MISTRAL);
  assert.equal(calls[0][1].headers.Authorization, 'Bearer K1');
  assert.deepEqual(JSON.parse(calls[0][1].body).response_format, { type: 'json_object' });
});

test('чужие адреса пропускаются без изменений', async () => {
  let seen;
  const rt = createProviderRuntime({ configPath: await tmp(), fetchImpl: async (u) => { seen = u; return new Response('{}'); } });
  await rt.fetch('https://example.com/x', {});
  assert.equal(seen, 'https://example.com/x');
});

test('GigaChat: обмен ключа на токен, токен кэшируется, response_format убран, ответ очищен', async () => {
  const calls = [];
  const httpsRequest = async (url, o) => {
    calls.push({ url, ...o });
    if (url.includes('/oauth')) return { status: 200, headers: {}, text: JSON.stringify({ access_token: 'TOK', expires_at: Date.now() + 1800_000 }) };
    return { status: 200, headers: {}, text: okReply('```json\n{"title":"Привет"}\n```') };
  };
  const rt = createProviderRuntime({ configPath: await tmp(), httpsRequest });
  await rt.save({ type: 'gigachat' });
  const send = () => rt.fetch(MISTRAL, { method: 'POST', headers: { Authorization: 'Bearer QUJD' },
    body: JSON.stringify({ model: 'mistral-small-latest', response_format: { type: 'json_object' }, messages: [{ role: 'user', content: 'hi' }] }) });
  const r1 = await send(); await send();
  const j = await r1.json();
  assert.equal(JSON.parse(j.choices[0].message.content).title, 'Привет');
  const oauth = calls.filter(c => c.url.includes('/oauth'));
  assert.equal(oauth.length, 1, 'токен должен браться один раз');
  assert.equal(oauth[0].headers.Authorization, 'Basic QUJD');
  assert.match(oauth[0].headers.RqUID, /^[0-9a-f-]{36}$/);
  assert.equal(oauth[0].body, 'scope=GIGACHAT_API_PERS');
  const chat = calls.find(c => c.url.endsWith('/chat/completions'));
  assert.equal(chat.url, 'https://api.giga.chat/v1/chat/completions');
  assert.equal(chat.headers.Authorization, 'Bearer TOK');
  const sent = JSON.parse(chat.body);
  assert.equal(sent.model, 'GigaChat');
  assert.equal('response_format' in sent, false);
});

test('GigaChat: при 401 токен берётся заново и запрос повторяется один раз', async () => {
  let chatCalls = 0, oauthCalls = 0;
  const httpsRequest = async (url) => {
    if (url.includes('/oauth')) { oauthCalls++; return { status: 200, headers: {}, text: JSON.stringify({ access_token: 'T' + oauthCalls, expires_at: Date.now() + 1800_000 }) }; }
    chatCalls++;
    return chatCalls === 1 ? { status: 401, headers: {}, text: 'expired' } : { status: 200, headers: {}, text: okReply('{"ok":true}') };
  };
  const rt = createProviderRuntime({ configPath: await tmp(), httpsRequest });
  await rt.save({ type: 'gigachat' });
  const r = await rt.fetch(MISTRAL, { method: 'POST', headers: { Authorization: 'Bearer KEY' }, body: JSON.stringify({ messages: [] }) });
  assert.equal(r.status, 200);
  assert.equal(oauthCalls, 2);
  assert.equal(chatCalls, 2);
});

test('GigaChat: ошибка входа превращается в понятный ответ 502, а не в падение', async () => {
  const httpsRequest = async () => ({ status: 401, headers: {}, text: 'bad key' });
  const rt = createProviderRuntime({ configPath: await tmp(), httpsRequest });
  await rt.save({ type: 'gigachat' });
  const r = await rt.fetch(MISTRAL, { method: 'POST', headers: { Authorization: 'Bearer BAD' }, body: '{}' });
  assert.equal(r.status, 502);
  assert.match((await r.json()).error.message, /вход не удался/);
});

test('expires_at в секундах тоже понимается (токен не считается просроченным)', async () => {
  let oauth = 0;
  const httpsRequest = async (url) => url.includes('/oauth')
    ? (oauth++, { status: 200, headers: {}, text: JSON.stringify({ access_token: 'T', expires_at: Math.floor(Date.now() / 1000) + 1800 }) })
    : { status: 200, headers: {}, text: okReply('{}') };
  const rt = createProviderRuntime({ configPath: await tmp(), httpsRequest });
  await rt.save({ type: 'gigachat' });
  for (let i = 0; i < 2; i++) await rt.fetch(MISTRAL, { method: 'POST', headers: { Authorization: 'Bearer K' }, body: '{}' });
  assert.equal(oauth, 1);
});

test('OpenAI-совместимый: свой адрес, своя модель, JSON-режим сохраняется', async () => {
  const calls = [];
  const rt = createProviderRuntime({ configPath: await tmp(), fetchImpl: async (u, i) => { calls.push([u, i]); return new Response(okReply('```json\n{"a":2}\n```')); } });
  await rt.save({ type: 'openai', baseUrl: 'http://localhost:1234/v1/', model: 'qwen' });
  const r = await rt.fetch(MISTRAL, { method: 'POST', headers: { Authorization: 'Bearer Z' }, body: JSON.stringify({ model: 'x', response_format: { type: 'json_object' } }) });
  assert.equal(calls[0][0], 'http://localhost:1234/v1/chat/completions');
  assert.equal(JSON.parse(calls[0][1].body).model, 'qwen');
  assert.equal(JSON.parse((await r.json()).choices[0].message.content).a, 2);
});

test('OpenAI-совместимый без адреса: понятная ошибка', async () => {
  const rt = createProviderRuntime({ configPath: await tmp(), fetchImpl: async () => new Response('{}') });
  await rt.save({ type: 'openai' });
  const r = await rt.fetch(MISTRAL, { method: 'POST', headers: { Authorization: 'Bearer Z' }, body: '{}' });
  assert.equal(r.status, 502);
  assert.match((await r.json()).error.message, /нужен адрес/);
});

test('настройки сохраняются в файл без ключей и читаются обратно', async () => {
  const p = await tmp();
  const a = createProviderRuntime({ configPath: p });
  await a.save({ type: 'gigachat', model: 'GigaChat-2-Pro', caPath: 'C:\\certs\\ru.pem', key: 'SECRET', apiKey: 'SECRET' });
  const raw = await fs.readFile(p, 'utf8');
  assert.equal(/SECRET/.test(raw), false);
  const b = createProviderRuntime({ configPath: p }); await b.load();
  assert.equal(b.getConfig().type, 'gigachat');
  assert.equal(b.getConfig().model, 'GigaChat-2-Pro');
  assert.equal(b.getConfig().caPath, 'C:\\certs\\ru.pem');
});

test('listModels для GigaChat и Mistral', async () => {
  const httpsRequest = async (url) => url.includes('/oauth')
    ? { status: 200, headers: {}, text: JSON.stringify({ access_token: 'T', expires_at: Date.now() + 1800_000 }) }
    : { status: 200, headers: {}, text: JSON.stringify({ data: [{ id: 'GigaChat-2-Pro' }, { id: 'GigaChat' }] }) };
  const rt = createProviderRuntime({ configPath: await tmp(), httpsRequest,
    fetchImpl: async () => new Response(JSON.stringify({ data: [{ id: 'ministral-14b-latest' }] })) });
  assert.deepEqual(await rt.listModels({ type: 'gigachat' }, 'K'), ['GigaChat', 'GigaChat-2-Pro']);
  assert.deepEqual(await rt.listModels({ type: 'mistral' }, 'K'), ['ministral-14b-latest']);
  await assert.rejects(() => rt.listModels({ type: 'mistral' }, ''), /ключ/);
});

test('normalizeConfig: неизвестный тип → mistral, слэши в адресе срезаются', () => {
  assert.equal(normalizeConfig({ type: 'zzz' }).type, 'mistral');
  assert.equal(normalizeConfig({ baseUrl: 'http://x/v1///' }).baseUrl, 'http://x/v1');
});
