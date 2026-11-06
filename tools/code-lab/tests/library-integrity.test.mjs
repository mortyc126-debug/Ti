import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIBRARY = path.resolve(HERE, '..', 'library');
const CODE_EXT = new Set(['.js','.mjs','.cjs','.jsx','.ts','.tsx','.py','.rb','.php','.go','.rs','.java','.c','.h','.cpp','.cs','.lua','.sh','.bash','.ps1','.r','.sql','.css','.html','.htm','.svg','.json','.txt']);
const ALIASES = { javascript:'js', typescript:'ts', py:'python', python3:'python', shell:'bash', sh:'bash', zsh:'bash', 'c++':'cpp', cplusplus:'cpp', cxx:'cpp', 'c#':'csharp', 'c-sharp':'csharp', cs:'csharp', golang:'go', rb:'ruby', kt:'kotlin', rs:'rust', jsx:'js', tsx:'ts', htm:'html', yml:'yaml' };
const canon = value => { const v=String(value||'').trim().toLowerCase(); return ALIASES[v] || v.replace(/[^a-z0-9_+-]/g,'') || 'other'; };

async function walk(dir){
  const out=[];
  for(const ent of await fs.readdir(dir,{withFileTypes:true})){
    const abs=path.join(dir,ent.name);
    if(ent.isDirectory()) out.push(...await walk(abs));
    else if(ent.isFile()) out.push(abs);
  }
  return out;
}

test('библиотека: пары кода и паспортов, JSON и ID целостны', async()=>{
  const langs=(await fs.readdir(LIBRARY,{withFileTypes:true})).filter(x=>x.isDirectory()).map(x=>x.name);
  const ids=new Map(), problems=[], duplicateCodes=new Map(), missingIds=[], languageMismatches=[], rows=[];
  let codeCount=0, metaCount=0;
  for(const langDir of langs){
    const files=await walk(path.join(LIBRARY,langDir));
    const set=new Set(files);
    for(const file of files){
      if(file.endsWith('.meta.json')){
        metaCount++;
        const code=file.slice(0,-10);
        if(!set.has(code)) problems.push('нет кода для паспорта: '+path.relative(LIBRARY,file));
        let meta;
        try{meta=JSON.parse(await fs.readFile(file,'utf8'));}catch(e){problems.push('битый JSON '+path.relative(LIBRARY,file)+': '+e.message);continue;}
        if(!meta||typeof meta!=='object'||Array.isArray(meta)) {problems.push('паспорт не объект: '+path.relative(LIBRARY,file));continue;}
        const codeBase=path.basename(code,path.extname(code));
        const effectiveId=String(meta.id || codeBase);
        if(!meta.id) missingIds.push(path.relative(LIBRARY,file));
        rows.push({ id:effectiveId, lang:canon(meta.lang || langDir), file:path.relative(LIBRARY,code) });
        if(meta.lang && canon(meta.lang)!==canon(langDir)) languageMismatches.push(path.relative(LIBRARY,file)+' ('+meta.lang+')');
      } else if(CODE_EXT.has(path.extname(file).toLowerCase())){
        codeCount++;
        if(!set.has(file+'.meta.json')) problems.push('нет паспорта для кода: '+path.relative(LIBRARY,file));
        const code=(await fs.readFile(file,'utf8')).replace(/\r\n/g,'\n').trim();
        const key=canon(langDir)+'\0'+code;
        if(code){if(!duplicateCodes.has(key))duplicateCodes.set(key,[]);duplicateCodes.get(key).push(path.relative(LIBRARY,file));}
      }
    }
  }
  const dupGroups=[...duplicateCodes.values()].filter(x=>x.length>1);
  for(const row of rows.sort((a,b)=>a.file.localeCompare(b.file))){
    let id=row.id;
    if(ids.has(id)){ id=id+'~'+row.lang; let k=2; while(ids.has(id)) id=row.id+'~'+row.lang+k++; }
    ids.set(id,row.file);
  }
  console.log('library-integrity:',JSON.stringify({languages:langs,codeCount,metaCount,effectiveIds:ids.size,missingIds:missingIds.length,folderLanguageMismatches:languageMismatches.length,duplicateCodeGroups:dupGroups.length,problems:problems.length,languageMismatchSamples:languageMismatches.slice(0,8),missingIdSamples:missingIds.slice(0,5)}));
  assert.deepEqual(problems,[]);
  assert.equal(codeCount,metaCount,'число файлов кода и паспортов должно совпадать');
  assert.equal(ids.size,codeCount,'все элементы должны получать уникальный ID после разрешения совпадений');
});
