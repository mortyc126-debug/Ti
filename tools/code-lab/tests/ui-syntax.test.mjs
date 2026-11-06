import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(HERE, '..', 'public');

test('публичные JS-файлы и встроенные скрипты страниц синтаксически корректны', async()=>{
  const files=(await fs.readdir(PUBLIC,{withFileTypes:true})).filter(x=>x.isFile()&&x.name.endsWith('.js'));
  for(const file of files){
    const source=await fs.readFile(path.join(PUBLIC,file.name),'utf8');
    assert.doesNotThrow(()=>new vm.Script(source,{filename:file.name}),file.name);
  }
  const html=await fs.readFile(path.join(PUBLIC,'schema-json.html'),'utf8');
  const scripts=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(x=>x[1]).filter(x=>x.trim());
  assert.ok(scripts.length>0,'в schema-json.html должны быть встроенные скрипты');
  scripts.forEach((source,i)=>assert.doesNotThrow(()=>new vm.Script(source,{filename:'schema-json.html#script-'+i}),'schema-json.html inline script '+i));
  console.log('ui-syntax:',JSON.stringify({publicJs:files.length,inlineScripts:scripts.length}));
});
