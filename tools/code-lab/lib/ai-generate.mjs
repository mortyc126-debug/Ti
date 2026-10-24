// ИИ-создание новых кусков: «дополни Python работой со строками» → список предложений.
//
// propose() ТОЛЬКО предлагает: ничего не сохраняет и никакой код не запускает.
// Сохранение делает сервер отдельным шагом (/api/ai-create), после того как человек
// отметил нужные куски и поправил текст.

import { extFor } from './lang.mjs';

// языки, которые библиотека умеет хранить (см. lang.mjs); значение — как назвать язык в промпте
// единый набор языков — зеркало public/langs.js (CODELAB_LANGS), без txt. Держать синхронно.
export const LANGS = {
  html: 'HTML', css: 'CSS', js: 'JavaScript', ts: 'TypeScript', python: 'Python', sql: 'SQL', json: 'JSON', svg: 'SVG',
  bash: 'Bash', powershell: 'PowerShell', go: 'Go', ruby: 'Ruby', php: 'PHP', lua: 'Lua', r: 'R', perl: 'Perl',
  c: 'C', cpp: 'C++', java: 'Java', rust: 'Rust', kotlin: 'Kotlin', csharp: 'C#', swift: 'Swift',
};

const clean = (v, max) => String(v ?? '').replace(/\u0000/g, '').trim().slice(0, max);
const cleanList = (v, max = 8) => [...new Set((Array.isArray(v) ? v : []).map(x => clean(x, 60)).filter(Boolean))].slice(0, max);
const norm = s => String(s || '').replace(/\r\n?/g, '\n').trim();

// Проверка БЕЗ запуска: js — только компиляция (new Function не выполняет тело), json — JSON.parse.
// Для остальных языков честно говорим «не проверено», а не «всё хорошо».
export function checkSyntax(lang, code) {
  try {
    if (lang === 'json') { JSON.parse(code); return { status: 'ok', note: 'JSON разбирается' }; }
    if (lang === 'js') {
      try { new Function(code); }
      catch (e) { new Function('return (async()=>{\n' + code + '\n})'); }   // код с await на верхнем уровне
      return { status: 'ok', note: 'синтаксис JS разбирается (код не запускался)' };
    }
  } catch (e) { return { status: 'error', note: 'ошибка синтаксиса: ' + String(e.message).slice(0, 160) }; }
  return { status: 'unchecked', note: 'синтаксис для этого языка не проверялся' };
}

// Приводим ответ модели к безопасной форме и помечаем дубли.
export function normalizePieces(raw, lang, existing = []) {
  const arr = Array.isArray(raw?.pieces) ? raw.pieces : (Array.isArray(raw) ? raw : []);
  const byTitle = new Map(existing.map(e => [String(e.title || '').trim().toLowerCase(), e.id]));
  const byCode = new Map(existing.map(e => [norm(e.code), e.id]));
  const seen = new Set();
  const out = [];
  for (const p of arr) {
    const code = clean(p && p.code, 8000);
    const title = clean(p && p.title, 80);
    if (!title || !code.trim()) continue;
    const key = title.toLowerCase();
    if (seen.has(key)) continue;            // два одинаковых названия в одном ответе
    seen.add(key);
    const chk = checkSyntax(lang, code);
    out.push({
      title, lang,
      group: clean(p.group, 60) || 'Мои шаблоны',
      desc: clean(p.desc, 400),
      output: clean(p.output, 300),
      tags: cleanList(p.tags), aliases: cleanList(p.aliases),
      code,
      check: chk,
      dupOf: byCode.get(norm(code)) || byTitle.get(key) || null,
    });
    if (out.length >= 10) break;
  }
  return out;
}

export function normalizeTopics(raw) {
  const arr = Array.isArray(raw?.topics) ? raw.topics : (Array.isArray(raw) ? raw : []);
  const seen = new Set(), out = [];
  for (const t of arr) {
    const topic = clean(typeof t === 'string' ? t : t && t.topic, 100);
    if (!topic || seen.has(topic.toLowerCase())) continue;
    seen.add(topic.toLowerCase());
    out.push({ topic, why: clean(t && t.why, 220) });
    if (out.length >= 8) break;
  }
  return out;
}

function buildGapsPrompt({ lang, titles, groups }) {
  return [
    `Есть личная библиотека маленьких кусков кода на языке ${LANGS[lang]} для того, кто учится программировать.`,
    titles.length ? 'Названия кусков, которые уже есть: ' + titles.join('; ') : 'На этом языке пока нет ни одного куска.',
    groups.length ? 'Разделы: ' + groups.join('; ') : '',
    '',
    'Ты видишь только названия, а не код: не утверждай, что чего-то «нет», если это может скрываться под другим названием.',
    `Назови 5–8 тем, которых на этом языке, судя по названиям, не хватает до уверенной базы (с учётом того, что ${LANGS[lang]} обычно нужен для таких задач: частые приёмы, ошибки новичков, работа с данными, файлами, текстом).`,
    'Каждая тема — короткая формулировка, которую можно прямо подставить как запрос «дополни это» (например «чтение и запись файлов»). В why — одна фраза, почему это стоит добавить.',
    '',
    'Верни только JSON: {"topics":[{"topic": "...", "why": "..."}]}',
  ].filter(x => x !== '').join('\n');
}

function buildPrompt({ lang, topic, count, instruction, titles, groups }) {
  const L = LANGS[lang];
  return [
    `Ты наполняешь личную библиотеку маленьких готовых кусков кода на языке ${L}. Читатель учится программировать.`,
    `Тема/что дополнить: ${clean(topic, 600) || 'базовые приёмы, которых ещё не хватает'}`,
    instruction ? `Пожелание: ${clean(instruction, 400)}` : '',
    '',
    `Сделай ровно ${count} НОВЫХ кусков (или меньше, если честно нечего добавить). Правила:`,
    '- один кусок — одна идея, 3–25 строк, работает сам по себе, без выдуманных библиотек;',
    '- в коде пиши короткие комментарии на русском там, где это помогает новичку;',
    '- не повторяй то, что уже есть в библиотеке (список ниже), и не повторяй друг друга;',
    '- code — только код этого языка, без обрамляющих ``` и без пояснений снаружи;',
    '- group — «Раздел / Подраздел» в том же стиле, что уже есть; можно использовать существующие разделы или завести новый.',
    '',
    titles.length ? 'Уже есть в библиотеке на этом языке (названия): ' + titles.join('; ') : 'На этом языке в библиотеке пока ничего нет.',
    groups.length ? 'Существующие разделы: ' + groups.join('; ') : '',
    '',
    'Верни только JSON: {"pieces":[{"title": короткое название на русском, "group": "Раздел / Подраздел", "desc": 1–2 предложения что делает, "output": что получится, "tags": [до 5 слов], "aliases": [2–4 других названия, как это могут искать], "code": "..."}]}',
  ].filter(x => x !== '').join('\n');
}

export function createAiGenerate({ store, apiKey = process.env.MISTRAL_API_KEY, model = process.env.MISTRAL_MODEL || 'mistral-small-latest', fetchImpl = fetch }) {
  async function chat(k, system, user, temperature) {
    let response;
    try {
      response = await fetchImpl('https://api.mistral.ai/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, temperature, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
      });
    } catch (e) { throw new Error('Не удалось связаться с Mistral (проверьте интернет): ' + (e?.message || e)); }
    if (!response.ok) throw new Error(`Mistral HTTP ${response.status}: ${(await response.text()).slice(0, 400)}`);
    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    const text = Array.isArray(content) ? content.map(x => x.text || '').join('') : content;
    try { return JSON.parse(text); } catch { throw new Error('Mistral вернул невалидный JSON'); }
  }
  const needKey = key => {
    const k = String(key || apiKey || '').trim();
    if (!k) throw new Error('Не задан ключ Mistral. Откройте Настройки в каталоге и сохраните API-ключ.');
    return k;
  };
  return {
    langs: () => LANGS,
    // Поиск пробелов: ИИ видит только названия и разделы (не код) и предлагает темы, которых не хватает.
    async gaps({ lang, key }) {
      lang = String(lang || '').toLowerCase();
      if (!LANGS[lang]) throw new Error('Неизвестный язык: ' + lang);
      const k = needKey(key);
      const existing = (await store.entries()).filter(e => e.lang === lang);
      const titles = existing.map(e => e.title).slice(0, 200);
      const groups = [...new Set(existing.map(e => e.meta && e.meta.group).filter(Boolean))].slice(0, 50);
      const raw = await chat(k, 'Ты опытный преподаватель программирования. Отвечай валидным JSON без Markdown.', buildGapsPrompt({ lang, titles, groups }), 0.4);
      return { lang, existingCount: existing.length, topics: normalizeTopics(raw) };
    },
    async propose({ lang, topic = '', count = 4, instruction = '', key }) {
      lang = String(lang || '').toLowerCase();
      if (!LANGS[lang]) throw new Error('Неизвестный язык: ' + lang);
      const k = needKey(key);
      count = Math.max(1, Math.min(8, Number(count) || 4));

      const existing = (await store.entries()).filter(e => e.lang === lang);
      const titles = existing.map(e => e.title).slice(0, 150);
      const groups = [...new Set(existing.map(e => e.meta && e.meta.group).filter(Boolean))].slice(0, 40);

      const parsed = await chat(k, 'Ты аккуратный преподаватель программирования. Отвечай валидным JSON без Markdown.',
        buildPrompt({ lang, topic, count, instruction, titles, groups }), 0.5);
      const pieces = normalizePieces(parsed, lang, existing);
      return { lang, ext: extFor(lang), existingCount: existing.length, pieces, model };
    },
  };
}
