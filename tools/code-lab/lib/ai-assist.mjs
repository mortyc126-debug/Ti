// ИИ-дополнение разделов куска: описание, пояснения к строкам/словам, требования,
// «можно/нельзя», типичные ошибки.
//
// Два шага, чтобы ИИ ничего не портил молча:
//   suggest() — спрашивает Mistral и ВОЗВРАЩАЕТ предложение, ничего не сохраняя;
//   apply()   — после того как человек посмотрел/поправил текст, записывает его в кусок.
// Код куска не меняется никогда.

const clean = (v, max = 1200) => String(v ?? '').trim().slice(0, max);
const cleanList = (v, max = 12, len = 300) => (Array.isArray(v) ? v : []).map(x => clean(x, len)).filter(Boolean).slice(0, max);

export const SECTIONS = {
  desc: {
    label: 'Что делает',
    ask: 'Поле desc — 1–3 простых предложения: что делает кусок и зачем он нужен. Поле output — одна короткая фраза: что получится на выходе.',
    shape: '{"desc": string, "output": string}',
  },
  notes: {
    label: 'Пояснения к коду',
    ask: 'Поле lineNotes — объект: ключ это ТОЧНЫЙ текст строки кода (без пробелов по краям), значение — одно короткое пояснение, что делает строка. ' +
         'Поле words — объект: ключ это отдельное слово/имя из кода, значение — что оно значит. Пропускай очевидное; не больше 15 строк и 15 слов.',
    shape: '{"lineNotes": {"<строка кода>": string}, "words": {"<слово>": string}}',
  },
  requirements: {
    label: 'Имена и требования',
    ask: 'Поле input — что нужно подать на вход (одна фраза). Поле requirements — список коротких пунктов: какие переменные, элементы страницы, библиотеки или формат данных нужны, чтобы кусок заработал.',
    shape: '{"input": string, "requirements": [string]}',
  },
  limits: {
    label: 'Можно / нельзя',
    ask: 'Поле errors — связный текст (3–6 предложений): что можно менять, чего менять нельзя, что сломается на пустом входе, неправильных типах и краевых значениях.',
    shape: '{"errors": string}',
  },
  errors: {
    label: 'Типичные ошибки',
    ask: 'Поле common_errors — список из 2–5 объектов: symptom (что видит человек), cause (почему), solution (что сделать).',
    shape: '{"common_errors": [{"symptom": string, "cause": string, "solution": string}]}',
  },
};

// Что сейчас лежит в разделе — чтобы ИИ именно ДОПОЛНЯЛ, а не писал с нуля.
export function currentOf(section, t) {
  const c = t.component || {};
  const sum = c.summary || {};
  const chk = (c.views && c.views.check) || {};
  switch (section) {
    case 'desc': return { desc: t.desc || '', output: t.output || sum.output || '' };
    case 'notes': return { lineNotes: c.lineNotes || {}, words: c.notes || {} };
    case 'requirements': return { input: sum.input || '', requirements: Array.isArray(sum.requirements) ? sum.requirements : (sum.requirements ? [String(sum.requirements)] : []) };
    case 'limits': return { errors: chk.errors || '' };
    case 'errors': return { common_errors: Array.isArray(chk.common_errors) ? chk.common_errors : [] };
    default: return {};
  }
}

export function codeOf(t) {
  if (typeof t.code === 'string') return t.code;
  return (t.lines || []).map(l => (l || []).map(k => (k && k.v != null ? k.v : '')).join('')).join('\n');
}

function buildPrompt(section, t, current, instruction) {
  const spec = SECTIONS[section];
  const code = codeOf(t).slice(0, 12000);
  return [
    'Ты помогаешь вести личную библиотеку кода. Читатель — человек, который учится программировать: пиши простым русским языком, без воды.',
    `Кусок: «${clean(t.title || t.id, 120)}», язык: ${clean(t.lang || 'js', 20)}.`,
    t.desc ? `Описание куска сейчас: ${clean(t.desc, 600)}` : '',
    '',
    'Код:',
    '```',
    code,
    '```',
    '',
    `Раздел: «${spec.label}».`,
    spec.ask,
    '',
    'Что в разделе уже есть (JSON):',
    JSON.stringify(current),
    '',
    'Правила: сохрани всё верное из того, что уже написано человеком, и ДОПОЛНИ недостающее; не выдумывай то, чего нет в коде; не меняй код.',
    instruction ? `Пожелание человека: ${clean(instruction, 600)}` : '',
    '',
    `Верни только JSON-объект такого вида: ${spec.shape}`,
  ].filter(x => x !== '').join('\n');
}

// Приводим ответ модели к безопасной форме. Всё лишнее отбрасываем.
export function normalize(section, raw, code = '') {
  const o = raw && typeof raw === 'object' ? raw : {};
  switch (section) {
    case 'desc': return { desc: clean(o.desc, 1200), output: clean(o.output, 300) };
    case 'notes': {
      const present = new Set(String(code).split(/\r?\n/).map(s => s.trim()).filter(Boolean));
      const lineNotes = {}, words = {};
      for (const [k, v] of Object.entries(o.lineNotes && typeof o.lineNotes === 'object' ? o.lineNotes : {})) {
        const key = String(k).trim(), val = clean(v, 400);
        if (key && val && present.has(key)) lineNotes[key] = val;      // пояснение к несуществующей строке выбрасываем
      }
      for (const [k, v] of Object.entries(o.words && typeof o.words === 'object' ? o.words : {})) {
        const key = String(k).trim(), val = clean(v, 400);
        if (key && val && key.length <= 60 && String(code).includes(key)) words[key] = val;
      }
      return { lineNotes, words };
    }
    case 'requirements': return { input: clean(o.input, 300), requirements: cleanList(o.requirements) };
    case 'limits': return { errors: clean(o.errors, 1500) };
    case 'errors': return {
      common_errors: (Array.isArray(o.common_errors) ? o.common_errors : []).map(e => ({
        symptom: clean(e && e.symptom, 200), cause: clean(e && e.cause, 300), solution: clean(e && e.solution, 300),
      })).filter(e => e.symptom && (e.cause || e.solution)).slice(0, 8),
    };
    default: return {};
  }
}

export function createAiAssist({ store, apiKey = process.env.MISTRAL_API_KEY, model = process.env.MISTRAL_MODEL || 'mistral-small-latest', fetchImpl = fetch }) {
  async function callMistral(key, prompt) {
    let response;
    try { response = await fetchImpl('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model, temperature: 0.3, response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'Ты аккуратный технический редактор. Отвечай валидным JSON без Markdown.' },
          { role: 'user', content: prompt },
        ],
      }),
    });
    } catch (e) { throw new Error('Не удалось связаться с Mistral (проверьте интернет): ' + (e?.message || e)); }
    if (!response.ok) throw new Error(`Mistral HTTP ${response.status}: ${(await response.text()).slice(0, 400)}`);
    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    const text = Array.isArray(content) ? content.map(x => x.text || '').join('') : content;
    try { return JSON.parse(text); } catch { throw new Error('Mistral вернул невалидный JSON'); }
  }

  return {
    // t — кусок целиком (из store.get) или временный {title, lang, code, desc} из конструктора
    async suggest({ id, piece, section, instruction = '', key }) {
      if (!SECTIONS[section]) throw new Error('Неизвестный раздел: ' + section);
      const k = String(key || apiKey || '').trim();
      if (!k) throw new Error('Не задан ключ Mistral. Откройте Настройки в каталоге и сохраните API-ключ.');
      let t = piece || null;
      if (id) { t = await store.get(String(id)); if (!t) throw new Error('Кусок не найден: ' + id); }
      if (!t || !codeOf(t).trim()) throw new Error('У куска нет кода — нечего объяснять.');
      const current = currentOf(section, t);
      const raw = await callMistral(k, buildPrompt(section, t, current, instruction));
      return { section, current, suggestion: normalize(section, raw, codeOf(t)) };
    },

    // Записывает принятый человеком текст. Ничего не стирает: заметки сливаются, а не заменяются целиком.
    async apply({ id, section, value }) {
      if (!SECTIONS[section]) throw new Error('Неизвестный раздел: ' + section);
      const j = await store.get(String(id));
      if (!j) throw new Error('Кусок не найден: ' + id);
      const v = normalize(section, value, codeOf(j));
      j.component = j.component || {};
      const c = j.component;
      c.summary = c.summary || {};
      c.views = c.views || {};
      c.views.check = c.views.check || {};
      let origin = 'manual';
      if (section === 'desc') {
        if (v.desc) { j.desc = v.desc; j.descAt = Date.now(); origin = 'ai'; }
        if (v.output) { j.output = v.output; c.summary.output = v.output; }
      } else if (section === 'notes') {
        c.lineNotes = { ...(c.lineNotes || {}), ...v.lineNotes };
        c.notes = { ...(c.notes || {}), ...v.words };
      } else if (section === 'requirements') {
        if (v.input) c.summary.input = v.input;
        if (v.requirements.length) c.summary.requirements = v.requirements;
      } else if (section === 'limits') {
        if (v.errors) c.views.check.errors = v.errors;
      } else if (section === 'errors') {
        if (v.common_errors.length) c.views.check.common_errors = v.common_errors;
      }
      await store.save(j, { origin });
      return { ok: true, id: j.id || id, applied: v };
    },
  };
}
