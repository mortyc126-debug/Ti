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
  const emptyDescriptions=[], shortDescriptions=[], missingTitles=[], missingGroups=[], missingLangs=[], fileFieldMismatches=[];
  const missingSchema=[], legacyMetadataFiles=[], legacyWordMaps=[], embeddedCodeMismatches=[];
  const unknownGroups=[], wordNoteProblems=[], malformedTagFields=[], malformedComponents=[];
  const statusCounts={}, descriptionLengthBuckets={empty:0,short:0,medium:0,long:0};
  const sectionDoc=JSON.parse(await fs.readFile(path.join(LIBRARY,'_sections.json'),'utf8'));
  const validGroups=new Set();
  for(const section of sectionDoc.tree||[]){
    validGroups.add(section.name);
    for(const sub of section.subs||[]) validGroups.add(section.name+' / '+sub);
  }
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
        const relativeFile=path.relative(LIBRARY,file), relativeCode=path.relative(LIBRARY,code);
        const desc=typeof meta.desc==='string'?meta.desc.trim():'';
        const title=typeof meta.title==='string'?meta.title.trim():'';
        const group=typeof meta.group==='string'?meta.group.trim():'';
        const status=String(meta.status||'(missing)');
        statusCounts[status]=(statusCounts[status]||0)+1;
        if(!desc){emptyDescriptions.push(relativeFile);descriptionLengthBuckets.empty++;}
        else if(desc.length<45){shortDescriptions.push({file:relativeFile,desc});descriptionLengthBuckets.short++;}
        else if(desc.length<160) descriptionLengthBuckets.medium++;
        else descriptionLengthBuckets.long++;
        if(!title) missingTitles.push(relativeFile);
        if(!group) missingGroups.push(relativeFile);
        else if(!validGroups.has(group)) unknownGroups.push({file:relativeFile,group});
        if(!meta.lang) missingLangs.push(relativeFile);
        if(meta.tags!=null && !Array.isArray(meta.tags)) malformedTagFields.push({file:relativeFile,field:'tags'});
        if(meta.aliases!=null && !Array.isArray(meta.aliases)) malformedTagFields.push({file:relativeFile,field:'aliases'});
        if(meta.component!=null && (typeof meta.component!=='object' || Array.isArray(meta.component))) malformedComponents.push(relativeFile);
        if(meta.schema!==1) missingSchema.push(relativeFile);
        if(meta.file && meta.file!==path.basename(code)) fileFieldMismatches.push({file:relativeFile,declared:meta.file,actual:path.basename(code)});
        let sourceCode=null;
        if(typeof meta.code==='string'){
          legacyMetadataFiles.push(relativeFile);
          const embedded=meta.code.replace(/\r\n/g,'\n').trim();
          sourceCode=(await fs.readFile(code,'utf8')).replace(/\r\n/g,'\n');
          if(embedded!==sourceCode.trim()) embeddedCodeMismatches.push(relativeFile);
        }
        if(Array.isArray(meta.wordNotes) && meta.wordNotes.length){
          if(sourceCode==null) sourceCode=(await fs.readFile(code,'utf8')).replace(/\r\n/g,'\n');
          const codeLines=sourceCode.split('\n');
          for(let i=0;i<meta.wordNotes.length;i++){
            const note=meta.wordNotes[i], line=Number(note?.line), col=Number(note?.col), text=String(note?.text||'');
            if(!Number.isInteger(line)||!Number.isInteger(col)||line<0||line>=codeLines.length||col<0||!text||codeLines[line].slice(col,col+text.length)!==text){
              wordNoteProblems.push({file:relativeFile,index:i,line:note?.line,col:note?.col,text:note?.text});
            }
          }
        }
        if(meta.words && typeof meta.words==='object' && !Array.isArray(meta.words) && !Array.isArray(meta.wordNotes)) legacyWordMaps.push(relativeFile);
        rows.push({ id:effectiveId, lang:canon(meta.lang || langDir), file:relativeCode });
        if(meta.lang && canon(meta.lang)!==canon(langDir)) languageMismatches.push(relativeFile+' ('+meta.lang+')');
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
  const idGroups = new Map();
  for(const row of rows){ if(!idGroups.has(row.id)) idGroups.set(row.id,[]); idGroups.get(row.id).push(row.file); }
  const duplicateIdGroups = [...idGroups.values()].filter(group => group.length > 1);
  console.log('library-integrity:',JSON.stringify({
    languages:langs,codeCount,metaCount,effectiveIds:ids.size,missingIds:missingIds.length,
    folderLanguageMismatches:languageMismatches.length,duplicateCodeGroups:dupGroups.length,
    duplicateCodeSamples:dupGroups,duplicateIdGroups,missingIdFiles:missingIds,
    emptyDescriptions,shortDescriptionSamples:shortDescriptions.slice(0,60),descriptionLengthBuckets,statusCounts,
    missingTitles,missingGroups,missingLangs,fileFieldMismatches,missingSchema,legacyMetadataFiles,legacyWordMaps,embeddedCodeMismatches,unknownGroups,wordNoteProblems:wordNoteProblems.slice(0,80),wordNoteProblemCount:wordNoteProblems.length,malformedTagFields,malformedComponents,
    problems:problems.length,languageMismatchSamples:languageMismatches.slice(0,8)
  }));
  assert.deepEqual(problems,[]);
  assert.equal(codeCount,metaCount,'число файлов кода и паспортов должно совпадать');
  assert.equal(ids.size,codeCount,'все элементы должны получать уникальный ID после разрешения совпадений');
});
