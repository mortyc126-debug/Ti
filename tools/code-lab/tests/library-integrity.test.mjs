import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tokenize } from '../lib/tokenizer.mjs';
import { tokText, codeFromLines } from '../lib/migrate.mjs';
import { mapGroup, parseRules, placeInTree } from '../lib/sections.mjs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIBRARY = path.resolve(HERE, '..', 'library');
const CODELAB_ROOT = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(HERE, '../../..');
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
async function walkReferenceFiles(dir){
  const out=[], skip=new Set(['.git','node_modules','vendor','dist','build','coverage','.cache']);
  const allowed=new Set(['.json','.md','.txt','.js','.mjs','.cjs','.html','.htm','.css','.yml','.yaml','.py','.sql','.ts','.sh','.bash']);
  for(const ent of await fs.readdir(dir,{withFileTypes:true})){
    if(ent.isDirectory()&&skip.has(ent.name)) continue;
    const abs=path.join(dir,ent.name);
    if(ent.isDirectory()) out.push(...await walkReferenceFiles(abs));
    else if(ent.isFile()&&allowed.has(path.extname(ent.name).toLowerCase())){
      const rel=path.relative(REPO_ROOT,abs).split(path.sep).join('/');
      if(rel.startsWith('tools/code-lab/library/')) continue;
      const st=await fs.stat(abs);
      if(st.size<=2*1024*1024) out.push(abs);
    }
  }
  return out;
}

test('библиотека: пары кода и паспортов, JSON и ID целостны', async()=>{
  const langs=(await fs.readdir(LIBRARY,{withFileTypes:true})).filter(x=>x.isDirectory()).map(x=>x.name);
  const ids=new Map(), problems=[], duplicateCodes=new Map(), missingIds=[], languageMismatches=[], rows=[];
  const emptyDescriptions=[], shortDescriptions=[], missingTitles=[], missingGroups=[], missingLangs=[], fileFieldMismatches=[];
  const missingSchema=[], legacyMetadataFiles=[], legacyWordMaps=[], embeddedCodeMismatches=[];
  const legacyWordMapStats={maps:0,keys:0,matchedKeys:0,matchedTokenOccurrences:0,unmatchedKeySamples:[]};
  const unknownGroups=[], wordNoteProblems=[], malformedTagFields=[], malformedComponents=[], replacementCharacterFields=[], codeReplacementFiles=[];
  let wordNoteTotal=0, orphanNoteTotal=0;
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
        const scanReplacement=(value,key='')=>{if(typeof value==='string'){if(value.includes('\uFFFD')) replacementCharacterFields.push({file:relativeFile,field:key});}else if(Array.isArray(value)){value.forEach((v,i)=>scanReplacement(v,key+'['+i+']'));}else if(value&&typeof value==='object'){for(const [k,v] of Object.entries(value)) scanReplacement(v,key?key+'.'+k:k);}};
        scanReplacement(meta);
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
        if(Array.isArray(meta.wordNotes)) wordNoteTotal+=meta.wordNotes.length;
        if(Array.isArray(meta.orphanNotes)) orphanNoteTotal+=meta.orphanNotes.length;
        if(Array.isArray(meta.wordNotes) && meta.wordNotes.length){
          if(sourceCode==null) sourceCode=(await fs.readFile(code,'utf8')).replace(/\r\n/g,'\n');
          const tokenLines=tokenize(sourceCode,meta.lang||langDir);
          for(let i=0;i<meta.wordNotes.length;i++){
            const note=meta.wordNotes[i], line=Number(note?.line), col=Number(note?.col||0), text=String(note?.text||'');
            const tokens=Number.isInteger(line)&&line>=0?tokenLines[line]:null;
            let found=!!(tokens&&text&&tokens.some(token=>tokText(token)===text));
            // Повторяем fallback placeNotes: составной старый токен может начинаться в сохранённой позиции.
            if(!found&&tokens&&Number.isInteger(col)&&col>=0){
              let currentCol=0;
              for(const token of tokens){
                const tokenText=tokText(token);
                if(currentCol===col&&tokenText&&tokenText!==text&&text.startsWith(tokenText)){found=true;break;}
                currentCol+=tokenText.length;
              }
            }
            if(!found) wordNoteProblems.push({file:relativeFile,index:i,line:note?.line,col:note?.col,text:note?.text,kind:note?.kind});
          }
        }
        if(meta.words && typeof meta.words==='object' && !Array.isArray(meta.words) && !Array.isArray(meta.wordNotes)){
          legacyWordMaps.push(relativeFile); legacyWordMapStats.maps++;
          if(sourceCode==null) sourceCode=(await fs.readFile(code,'utf8')).replace(/\r\n/g,'\n');
          const tokens=tokenize(sourceCode,meta.lang||langDir).flat().map(tokText);
          for(const [word,note] of Object.entries(meta.words)){
            legacyWordMapStats.keys++;
            const occurrences=tokens.filter(token=>token===word).length;
            if(occurrences){legacyWordMapStats.matchedKeys++;legacyWordMapStats.matchedTokenOccurrences+=occurrences;}
            else if(legacyWordMapStats.unmatchedKeySamples.length<30) legacyWordMapStats.unmatchedKeySamples.push({file:relativeFile,word,note});
          }
        }
        rows.push({ id:effectiveId, lang:canon(meta.lang || langDir), file:relativeCode, title, descLength:desc.length, tagsCount:Array.isArray(meta.tags)?meta.tags.length:0, aliasesCount:Array.isArray(meta.aliases)?meta.aliases.length:0, wordNotesCount:Array.isArray(meta.wordNotes)?meta.wordNotes.length:0, orphanNotesCount:Array.isArray(meta.orphanNotes)?meta.orphanNotes.length:0, componentProvidesCount:Array.isArray(meta.component?.provides)?meta.component.provides.length:0, componentRequiresCount:Array.isArray(meta.component?.requires)?meta.component.requires.length:0, status });
        if(meta.lang && canon(meta.lang)!==canon(langDir)) languageMismatches.push(relativeFile+' ('+meta.lang+')');
      } else if(CODE_EXT.has(path.extname(file).toLowerCase())){
        codeCount++;
        if(!set.has(file+'.meta.json')) problems.push('нет паспорта для кода: '+path.relative(LIBRARY,file));
        const code=(await fs.readFile(file,'utf8')).replace(/\r\n/g,'\n').trim();
        if(code.includes('\uFFFD')) codeReplacementFiles.push(path.relative(LIBRARY,file));
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
  const rowsByFile=new Map(rows.map(row=>[row.file,row]));
  const sectionConfig=JSON.parse(await fs.readFile(path.join(LIBRARY,'_sections.json'),'utf8'));
  const parsedSectionRules=parseRules(sectionConfig.rules||[]);
  const templateFiles=await walk(path.join(CODELAB_ROOT,'templates'));
  const templateGroupPlan={total:0,withLines:0,withoutLines:0,changed:0,outsideAfter:[],moves:{},missingFromLibrary:[],nonMigratable:[],duplicateIds:[],codeDuplicateCount:0,missingTemplateCodeDuplicates:[],sameIdCodeConflicts:[]};
  const libraryIdSet=new Set(rows.map(row=>row.id)), rowsById=new Map(rows.map(row=>[row.id,row])), seenTemplateIds=new Set();
  for(const file of templateFiles.filter(file=>file.toLowerCase().endsWith('.json'))){
    try{
      const value=JSON.parse(await fs.readFile(file,'utf8'));
      if(typeof value.group!=='string'||!value.group.trim()) continue;
      templateGroupPlan.total++;
      const templateId=String(value.id||path.basename(file,'.json'));
      if(Array.isArray(value.lines)){
        templateGroupPlan.withLines++;
        if(!libraryIdSet.has(templateId)) templateGroupPlan.missingFromLibrary.push({file:path.relative(CODELAB_ROOT,file).split(path.sep).join('/'),id:templateId});
        const lang=String(value.lang||'txt').toLowerCase(), code=codeFromLines(value.lines).replace(/\r\n/g,'\n').trim();
        const matches=duplicateCodes.get(lang+'\u0000'+code)||[];
        const sameId=rowsById.get(templateId);
        if(sameId&&!matches.includes(sameId.file)) templateGroupPlan.sameIdCodeConflicts.push({
          file:path.relative(CODELAB_ROOT,file).split(path.sep).join('/'),id:templateId,
          title:value.title||'',descLength:String(value.desc||'').trim().length,
          libraryFile:sameId.file,libraryTitle:sameId.title,libraryDescLength:sameId.descLength,
          templateCodeLength:code.length
        });
        if(matches.length){
          templateGroupPlan.codeDuplicateCount++;
          if(!libraryIdSet.has(templateId)){
            templateGroupPlan.missingTemplateCodeDuplicates.push({
              file:path.relative(CODELAB_ROOT,file).split(path.sep).join('/'),id:templateId,
              title:value.title||'',descLength:String(value.desc||'').trim().length,
              tagsCount:Array.isArray(value.tags)?value.tags.length:0,
              aliasesCount:Array.isArray(value.aliases)?value.aliases.length:0,
              component:!!value.component,
              libraryEntries:matches.map(file=>({file,...(rowsByFile.get(file)||{})}))
            });
          }
        }
      }else{
        templateGroupPlan.withoutLines++;
        templateGroupPlan.nonMigratable.push({file:path.relative(CODELAB_ROOT,file).split(path.sep).join('/'),id:templateId});
      }
      if(seenTemplateIds.has(templateId)) templateGroupPlan.duplicateIds.push(templateId); else seenTemplateIds.add(templateId);
      const mapped=mapGroup(value.group,parsedSectionRules.rules);
      if(mapped.to!==value.group) templateGroupPlan.changed++;
      const move=value.group+' => '+mapped.to;
      templateGroupPlan.moves[move]=(templateGroupPlan.moves[move]||0)+1;
      const place=placeInTree(mapped.to,sectionConfig.tree||[]);
      if(!place.top||!place.sub) templateGroupPlan.outsideAfter.push({file:path.relative(CODELAB_ROOT,file).split(path.sep).join('/'),from:value.group,to:mapped.to});
    }catch(_){}
  }
  const otherDataGroupIssues=[];
  for(const dirName of ['tasks','recipes','flows','templates']){
    const dir=path.join(CODELAB_ROOT,dirName);
    let dataFiles=[];
    try{dataFiles=await walk(dir);}catch(_){continue;}
    for(const file of dataFiles.filter(file=>file.toLowerCase().endsWith('.json'))){
      try{
        const value=JSON.parse(await fs.readFile(file,'utf8'));
        if(value&&typeof value==='object'&&!Array.isArray(value)&&typeof value.group==='string'&&value.group.trim()&&!validGroups.has(value.group.trim())){
          otherDataGroupIssues.push({file:path.relative(CODELAB_ROOT,file).split(path.sep).join('/'),group:value.group});
        }
      }catch(_){}
    }
  }
  const duplicatePairQuality={pairs:dupGroups.length,oneDescriptionEmpty:0,descriptionUnequal:0,tagsOnlyOneSide:0,aliasesOnlyOneSide:0,componentOnlyOneSide:0,wordNotesOnlyOneSide:0,orphanNotesOnlyOneSide:0,referencedPairs:[]};
  const duplicatePairSamples=[];
  for(const group of dupGroups){
    const pair=group.map(file=>rowsByFile.get(file)).filter(Boolean);
    if(pair.length!==2) continue;
    const [a,b]=pair;
    if(!a.descLength||!b.descLength) duplicatePairQuality.oneDescriptionEmpty++;
    if(a.descLength!==b.descLength) duplicatePairQuality.descriptionUnequal++;
    if((a.tagsCount>0)!==(b.tagsCount>0)) duplicatePairQuality.tagsOnlyOneSide++;
    if((a.aliasesCount>0)!==(b.aliasesCount>0)) duplicatePairQuality.aliasesOnlyOneSide++;
    if((a.componentProvidesCount+a.componentRequiresCount>0)!==(b.componentProvidesCount+b.componentRequiresCount>0)) duplicatePairQuality.componentOnlyOneSide++;
    if((a.wordNotesCount>0)!==(b.wordNotesCount>0)) duplicatePairQuality.wordNotesOnlyOneSide++;
    if((a.orphanNotesCount>0)!==(b.orphanNotesCount>0)) duplicatePairQuality.orphanNotesOnlyOneSide++;
    if(duplicatePairSamples.length<20) duplicatePairSamples.push({a,b});
  }
  const duplicateIds=new Map();
  for(const group of dupGroups) for(const file of group){
    const row=rows.find(item=>item.file===file);
    if(row) duplicateIds.set(row.id,file);
  }
  const referenceFiles=await walkReferenceFiles(REPO_ROOT), duplicateReferenceHits=[], templateReferenceHits=[];
  const missingTemplateIds=new Set(templateGroupPlan.missingFromLibrary.map(item=>item.id));
  for(const file of referenceFiles){
    const body=await fs.readFile(file,'utf8');
    const relative=path.relative(REPO_ROOT,file).split(path.sep).join('/');
    for(const id of duplicateIds.keys()) if(body.includes(id)) duplicateReferenceHits.push({id,file:relative});
    if(!relative.startsWith('tools/code-lab/templates/')) for(const id of missingTemplateIds) if(body.includes(id)) templateReferenceHits.push({id,file:relative});
  }
  const wordNoteProblemByKind={}, wordNoteProblemByLang={};
  for(const problem of wordNoteProblems){
    const kind=String(problem.kind||'(missing)'), lang=problem.file.split('/')[0];
    wordNoteProblemByKind[kind]=(wordNoteProblemByKind[kind]||0)+1;
    wordNoteProblemByLang[lang]=(wordNoteProblemByLang[lang]||0)+1;
  }
  console.log('library-integrity:',JSON.stringify({
    languages:langs,codeCount,metaCount,effectiveIds:ids.size,missingIds:missingIds.length,
    folderLanguageMismatches:languageMismatches.length,duplicateCodeGroups:dupGroups.length,
    duplicateCodeSamples:dupGroups,duplicateIdGroups,duplicatePairQuality,duplicatePairSamples,otherDataGroupIssues,templateGroupPlan,duplicateReferenceScan:{filesScanned:referenceFiles.length,idsScanned:duplicateIds.size,hitCount:duplicateReferenceHits.length,hits:duplicateReferenceHits},templateReferenceScan:{idsScanned:missingTemplateIds.size,hitCount:templateReferenceHits.length,hits:templateReferenceHits},missingIdFiles:missingIds,
    emptyDescriptions,shortDescriptionSamples:shortDescriptions.slice(0,60),descriptionLengthBuckets,statusCounts,
    missingTitles,missingGroups,missingLangs,fileFieldMismatches,missingSchema,legacyMetadataFiles,legacyWordMaps,legacyWordMapStats,embeddedCodeMismatches,unknownGroups,wordNoteProblems:wordNoteProblems.slice(0,80),wordNoteProblemCount:wordNoteProblems.length,wordNoteProblemFiles:[...new Set(wordNoteProblems.map(x=>x.file))],wordNoteProblemByKind,wordNoteProblemByLang,wordNoteTotal,orphanNoteTotal,malformedTagFields,malformedComponents,replacementCharacterFields,codeReplacementFiles,
    problems:problems.length,languageMismatchSamples:languageMismatches.slice(0,8)
  }));
  assert.deepEqual(problems,[]);
  assert.equal(codeCount,metaCount,'число файлов кода и паспортов должно совпадать');
  assert.equal(ids.size,codeCount,'все элементы должны получать уникальный ID после разрешения совпадений');
});
