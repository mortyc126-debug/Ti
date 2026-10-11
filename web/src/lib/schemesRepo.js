// Клиент GitHub Contents API для «схем отраслей»: список/чтение/добавление/
// удаление HTML-файлов прямо в репозитории. Каждое add/delete — отдельный
// коммит (через браузер, по персональному токену). Ничего не грузится при
// старте: список запрашивается при открытии отрасли, содержимое — при открытии
// файла. Токен хранится в localStorage (как и прочие), наружу не логируется.

const API = 'https://api.github.com';
const BASE = 'references/schemes';
const DEFAULT_REPO = 'mortyc126-debug/ti';
const BRANCH = 'main';

export function getRepo(){ try { return localStorage.getItem('ba_repo') || DEFAULT_REPO; } catch(_){ return DEFAULT_REPO; } }
export function setRepo(v){ try { localStorage.setItem('ba_repo', String(v || '').trim() || DEFAULT_REPO); } catch(_){} }
// Отдельный ключ под репо-токен; как запасной — gist-токен (если у него есть
// право repo). Пользователь вводит PAT с доступом к Contents этого репозитория.
export function getToken(){ try { return localStorage.getItem('ba_repo_token') || localStorage.getItem('ba_gist_token') || ''; } catch(_){ return ''; } }
export function setToken(v){ try { if(v) localStorage.setItem('ba_repo_token', v.trim()); else localStorage.removeItem('ba_repo_token'); } catch(_){} }

// UTF-8 ⇄ base64 (btoa работает только с latin1). Кодируем ПОБЛОЧНО: спред
// большого массива в String.fromCharCode(...bytes) переполняет стек вызовов
// ("Maximum call stack size exceeded") на файлах в десятки КБ.
function utf8ToB64(s){
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  const CH = 0x8000;   // 32768 аргументов за раз — безопасно для apply
  for(let i = 0; i < bytes.length; i += CH){
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(bin);
}
function b64ToUtf8(b){ const bin = atob(b.replace(/\s/g, '')); const bytes = Uint8Array.from(bin, c => c.charCodeAt(0)); return new TextDecoder().decode(bytes); }

async function gh(path, { method = 'GET', body } = {}){
  const tok = getToken();
  const headers = { 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if(tok) headers['Authorization'] = 'Bearer ' + tok;
  const r = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if(r.status === 404) return { _notFound: true };
  const txt = await r.text();
  let j = null; try { j = txt ? JSON.parse(txt) : {}; } catch(_){ j = { message: txt }; }
  if(!r.ok) throw new Error((j && j.message) || ('HTTP ' + r.status));
  return j;
}

// Список HTML-файлов отрасли. 404 (папки ещё нет) → пустой список.
export async function listSchemes(industryKey){
  const repo = getRepo();
  const res = await gh(`/repos/${repo}/contents/${BASE}/${encodeURIComponent(industryKey)}?ref=${BRANCH}`);
  if(res._notFound || !Array.isArray(res)) return [];
  return res
    .filter(x => x.type === 'file' && /\.html?$/i.test(x.name))
    .map(x => ({ name: x.name, path: x.path, sha: x.sha, size: x.size }))
    .sort((a, b) => a.name < b.name ? -1 : 1);
}

// Содержимое файла (лениво, при открытии) → строка HTML.
export async function getSchemeContent(path){
  const repo = getRepo();
  const res = await gh(`/repos/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}?ref=${BRANCH}`);
  if(res._notFound) throw new Error('файл не найден');
  if(res.content) return b64ToUtf8(res.content);
  if(res.download_url){ const r = await fetch(res.download_url); return await r.text(); }
  throw new Error('пустой ответ');
}

// Добавить/заменить файл = коммит. htmlText — содержимое, filename — имя (.html).
export async function putScheme(industryKey, filename, htmlText){
  const repo = getRepo();
  let name = String(filename || '').trim().replace(/[^\wа-яё.\- ]/gi, '_');
  if(!/\.html?$/i.test(name)) name += '.html';
  const path = `${BASE}/${industryKey}/${name}`;
  // если файл уже есть — нужен его sha для замены
  let sha;
  try { const cur = await gh(`/repos/${repo}/contents/${path}?ref=${BRANCH}`); if(cur && cur.sha) sha = cur.sha; } catch(_){}
  const body = { message: `Схемы: ${sha ? 'обновлён' : 'добавлен'} ${industryKey}/${name}`, content: utf8ToB64(htmlText), branch: BRANCH };
  if(sha) body.sha = sha;
  await gh(`/repos/${repo}/contents/${path}`, { method: 'PUT', body });
  return { path, name };
}

// Удалить файл = коммит.
export async function deleteScheme(path, sha){
  const repo = getRepo();
  await gh(`/repos/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}`, {
    method: 'DELETE',
    body: { message: `Схемы: удалён ${path}`, sha, branch: BRANCH },
  });
}
