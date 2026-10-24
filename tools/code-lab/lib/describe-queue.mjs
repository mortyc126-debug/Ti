import { promises as fs } from 'node:fs';
import path from 'node:path';

const priority = { ai: 1, imported: 2, manual: 3 };
const clean = (v, max = 500) => String(v ?? '').trim().slice(0, max);
const list = (v, max = 20) => [...new Set((Array.isArray(v) ? v : []).map(x => clean(x, 80)).filter(Boolean))].slice(0, max);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MIN_DESC = 60, MIN_TAGS = 4, MIN_ALIASES = 3;
const isIncomplete = meta => {
  if (!meta) return true;
  if (meta.enriched) return false;               // уже обработано ИИ, повторно не трогаем
  const desc = String(meta.desc || '').trim();
  return !desc || meta.status === 'needs_description' || desc.length < MIN_DESC
    || (meta.tags || []).length < MIN_TAGS || (meta.aliases || []).length < MIN_ALIASES;
};

export function createDescriptionQueue({ store, statePath, apiKey = process.env.MISTRAL_API_KEY, model = process.env.MISTRAL_MODEL || 'mistral-small-latest', fetchImpl = fetch }) {
  console.log('describe-queue: model =', model);
  let state = { jobs: [], active: false, createdAt: null, updatedAt: null };
  let workerPromise = null;
  let runtimeApiKey = apiKey || '';
  const setApiKey = value => { runtimeApiKey = String(value || '').trim(); if (runtimeApiKey && state.jobs.some(j => j.status === 'queued')) void runWorker(); };
  const persist = async () => {
    state.updatedAt = new Date().toISOString();
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    const tmp = `${statePath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(state, null, 2) + '\n');
    await fs.rename(tmp, statePath);
  };
  const summary = () => ({ active: state.active, createdAt: state.createdAt, updatedAt: state.updatedAt,
    total: state.jobs.length, queued: state.jobs.filter(j => j.status === 'queued').length,
    running: state.jobs.filter(j => j.status === 'running').length, completed: state.jobs.filter(j => j.status === 'completed').length,
    failed: state.jobs.filter(j => j.status === 'failed').length,
    jobs: state.jobs.slice(-100).map(({ id, status, attempts, error, startedAt, finishedAt }) => ({ id, status, attempts, error: error || null, startedAt: startedAt || null, finishedAt: finishedAt || null })) });

  async function describe(entry) {
    if (!runtimeApiKey) throw new Error('Не задан ключ Mistral. Откройте Настройки в браузере и сохраните API-ключ.');
    const m = entry.meta || {};
    const have = (m.desc || (m.tags || []).length || (m.aliases || []).length)
      ? `\nУже есть (не противоречь этому):\nописание: ${m.desc || '—'}\nтеги: ${(m.tags || []).join(', ') || '—'}\nсинонимы: ${(m.aliases || []).join(', ') || '—'}\nЕсли описание уже хорошее, верни его без изменений. В tags и aliases верни только НОВЫЕ значения.\n`
      : '';
    const prompt = `Ты описываешь фрагменты кода для личной библиотеки. Верни ТОЛЬКО JSON-объект:
{"title": "...", "desc": "...", "tags": [...], "aliases": [...]}

Правила:
- title: 2–5 слов, что делает фрагмент (не название языка и не "пример кода").
- desc: 2–3 предложения по-русски: что делает, что принимает на вход, что получается на выходе, когда это применять. Опирайся только на то, что есть в коде.
- tags: 4–6 коротких тегов (технологии, приёмы, тема).
- aliases: 3–5 фраз, которыми человек мог бы искать этот фрагмент в поиске.

Пример ответа для кода «worker.postMessage(arr); worker.onmessage = e => console.log(e.data)»:
{"title":"Обмен данными с Web Worker","desc":"Отправляет массив в фоновый поток и выводит результат, который вернул воркер. Подходит, чтобы не блокировать интерфейс тяжёлыми вычислениями.","tags":["web worker","postMessage","многопоточность","javascript"],"aliases":["как передать данные в воркер","фоновые вычисления","worker сообщение"]}

Язык: ${entry.lang}
Текущий раздел: ${entry.meta?.group || ''}
${have}Код:
${String(entry.code).slice(0, 6000)}`;

    let response;
    for (let attempt = 0; ; attempt++) {
      response = await fetchImpl('https://api.mistral.ai/v1/chat/completions', {
        method: 'POST', headers: { Authorization: `Bearer ${runtimeApiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, temperature: 0.2, response_format: { type: 'json_object' }, messages: [
          { role: 'system', content: 'Ты аккуратный технический редактор. Отвечай валидным JSON без Markdown.' }, { role: 'user', content: prompt }
        ] })
      });
      if (response.status !== 429 || attempt >= 5) break;
      const ra = Number(response.headers.get('retry-after'));
      await sleep((ra > 0 ? ra * 1000 : 2000 * 2 ** attempt) + Math.random() * 500);
    }
    if (!response.ok) { const body = (await response.text()).slice(0, 500); throw new Error(`Mistral HTTP ${response.status}: ${body}`); }
    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    let parsed;
    try { parsed = JSON.parse(Array.isArray(content) ? content.map(x => x.text || '').join('') : content); }
    catch { throw new Error('Mistral вернул невалидный JSON'); }
    if (!parsed || typeof parsed !== 'object') throw new Error('Пустой ответ Mistral');
    return { title: clean(parsed.title, 120), desc: clean(parsed.desc, 1200), tags: list(parsed.tags), aliases: list(parsed.aliases) };
  }

  async function runWorker() {
    if (workerPromise) return workerPromise;
    workerPromise = (async () => {
      state.active = true; await persist();
      try {
        while (true) {
          const job = state.jobs.find(j => j.status === 'queued');
          if (!job) break;
          job.status = 'running'; job.startedAt = new Date().toISOString(); job.attempts = (job.attempts || 0) + 1; job.error = null; await persist();
          try {
            const entry = (await store.entries()).find(e => e.id === job.id);
            if (!entry) throw new Error('Кусок больше не существует');
            const meta = entry.meta || {};
            if (!isIncomplete(meta)) {
              job.status = 'completed'; job.skipped = true; job.finishedAt = new Date().toISOString(); await persist(); continue;
            }
            const result = await describe(entry);
            // Сохраняем только AI-поля. Store защищает поля, у которых авторитетнее manual/imported.
            await store.applyDescription(job.id, result, { origin: 'ai' });
            job.status = 'completed'; job.finishedAt = new Date().toISOString();
          } catch (e) {
            job.status = 'failed'; job.error = String(e?.message || e).slice(0, 800); job.finishedAt = new Date().toISOString();
          }
          await persist();
          await sleep(1500);
        }
      } finally { state.active = false; await persist(); workerPromise = null; }
    })();
    return workerPromise;
  }

  return {
    async init() {
      try { state = JSON.parse(await fs.readFile(statePath, 'utf8')); } catch {}
      if (!state || !Array.isArray(state.jobs)) state = { jobs: [], active: false };
      for (const j of state.jobs) if (j.status === 'running') { j.status = 'queued'; j.error = 'Повтор после перезапуска сервера'; }
      state.active = false; await persist();
      if (runtimeApiKey && state.jobs.some(j => j.status === 'queued')) void runWorker();
    },
    setApiKey,
    async start({ ids = null, apiKey: requestApiKey = null } = {}) {
      if (requestApiKey) setApiKey(requestApiKey);
      if (!runtimeApiKey) throw new Error('Не задан ключ Mistral. Откройте Настройки в браузере и сохраните API-ключ.');
      const entries = await store.entries();
      const selected = ids == null ? entries.filter(e => isIncomplete(e.meta)) : entries.filter(e => ids.includes(e.id));
      const existing = new Set(state.jobs.filter(j => ['queued', 'running'].includes(j.status)).map(j => j.id));
      let added = 0;
      for (const e of selected) {
        if (existing.has(e.id)) continue;
        if (ids == null && !isIncomplete(e.meta)) continue;
        state.jobs.push({ id: e.id, status: 'queued', attempts: 0, createdAt: new Date().toISOString() }); added++;
      }
      await persist();
      if (added || state.jobs.some(j => j.status === 'queued')) void runWorker();
      return { added, ...summary() };
    },
    async get() { return summary(); }
  };
}
