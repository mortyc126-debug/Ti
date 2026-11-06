// Read-only инвентаризация библиотеки Code Lab.
// Запуск: node tools/code-lab/scripts/audit-library.mjs [путь-к-библиотеке]
// Ничего не изменяет. Отчёт: audit-library-report.json в текущей рабочей папке.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const root = path.resolve(process.argv[2] || 'tools/code-lab/library');
const output = path.resolve('audit-library-report.json');
const codeExt = new Set(['js','mjs','cjs','jsx','ts','tsx','py','html','htm','css','scss','sql','svg','json','xml','txt']);
const tokenKinds = new Set(['kw','fn','name','num','str','com','op','sp']);
const norm = s => String(s ?? '').replace(/\r\n?/g,'\n').trim();
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
const base = p => path.basename(p).replace(/\.[^.]+$/,'');
const files = [];
async function walk(dir){
  for(const e of await fs.readdir(dir,{withFileTypes:true})){
    if(e.name.startsWith('.') || e.name.startsWith('_')) continue;
    const p=path.join(dir,e.name);
    if(e.isDirectory()) await walk(p); else files.push(p);
  }
}
await walk(root);
const set=new Set(files);
const records=[], missingMeta=[], invalidMeta=[], duplicateIds=new Map(), rawHashes=new Map(), normalizedHashes=new Map();
const noteStats={total:0,orphanTotal:0,swapped:0,invalid:0,uniqueToken:0,multipleTokens:0,composite:0,absent:0,empty:0};
const noteCases=[];
const extLang={js:'js',mjs:'js',cjs:'js',jsx:'js',ts:'ts',tsx:'ts',py:'python',html:'html',htm:'html',css:'css',scss:'css',sql:'sql',svg:'svg',json:'json'};
function countToken(code, token){
  if(!token) return 0;
  const escaped=token.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const re=new RegExp('(^|[^\\p{L}\\p{N}_$])'+escaped+'(?=$|[^\\p{L}\\p{N}_$])','gu');
  return [...code.matchAll(re)].length;
}
for(const file of files){
  if(file.endsWith('.meta.json') || file.endsWith('.bak') || file.endsWith('.tmp')) continue;
  const ext=path.extname(file).slice(1).toLowerCase();
  if(!codeExt.has(ext)) continue;
  const rel=path.relative(root,file).split(path.sep);
  const code=await fs.readFile(file,'utf8');
  const metaPath=file+'.meta.json';
  if(!set.has(metaPath)) missingMeta.push(path.relative(root,file));
  let meta={};
  if(set.has(metaPath)){
    try{
      meta=JSON.parse(await fs.readFile(metaPath,'utf8'));
      if(!meta || typeof meta!=='object' || Array.isArray(meta)) throw new Error('not object');
    }catch(e){invalidMeta.push({file:path.relative(root,metaPath),error:String(e)});meta={};}
  }
  const id=String(meta.id||base(file));
  if(!duplicateIds.has(id)) duplicateIds.set(id,[]);
  duplicateIds.get(id).push(path.relative(root,file));
  const exact=hash(norm(code));
  const formatted=hash(norm(code).replace(/[ \t]+/g,' ').replace(/\n+/g,'\n'));
  for(const [map,key] of [[rawHashes,exact],[normalizedHashes,formatted]]){
    if(!map.has(key)) map.set(key,[]);
    map.get(key).push(path.relative(root,file));
  }
  const lang=String(meta.lang||extLang[ext]||'').toLowerCase();
  const expected=extLang[ext];
  const notes=Array.isArray(meta.wordNotes)?meta.wordNotes:[];
  const orphans=Array.isArray(meta.orphanNotes)?meta.orphanNotes:[];
  noteStats.total+=notes.length; noteStats.orphanTotal+=orphans.length;
  function inspect(note,isOrphan){
    if(!note || typeof note!=='object' || typeof note.text!=='string'){noteStats.invalid++;return;}
    const swapped=tokenKinds.has(note.note) && typeof note.kind==='string' && !tokenKinds.has(note.kind);
    if(swapped) noteStats.swapped++;
    const text=swapped?note.kind:note.note;
    if(typeof text!=='string' || !text.trim()){noteStats.empty++;return;}
    const hits=countToken(code,note.text);
    let cls;
    if(hits===1){noteStats.uniqueToken++;cls='unique-token';}
    else if(hits>1){noteStats.multipleTokens++;cls='multiple-token-occurrences';}
    else if(code.includes(note.text)){noteStats.composite++;cls='composite-or-substring';}
    else {noteStats.absent++;cls='not-in-current-code';}
    if(isOrphan || hits!==1 || swapped) noteCases.push({
      file:path.relative(root,file),id,text:note.text,explanation:text,
      source:note.source||'',line:note.line??null,col:note.col??null,
      classification:cls,occurrences:hits,swapped,isOrphan
    });
  }
  for(const n of notes) inspect(n,false);
  for(const n of orphans) inspect(n,true);
  records.push({
    file:path.relative(root,file),id,lang,expectedLang:expected||null,langMismatch:!!(expected&&lang!==expected),
    group:meta.group||'',title:meta.title||'',emptyDesc:!String(meta.desc||'').trim(),
    status:meta.status||'',hasMeta:set.has(metaPath),metaError:invalidMeta.some(x=>x.file===path.relative(root,metaPath)),
    notes:notes.length,orphans:orphans.length,rawHash:exact,normalizedHash:formatted
  });
}
const groups=map=>[...map.values()].filter(v=>v.length>1).map(files=>({count:files.length,files}));
const report={
  generatedAt:new Date().toISOString(),root,
  totals:{codeFiles:records.length,passportFiles:files.filter(f=>f.endsWith('.meta.json')).length,
    missingMeta:missingMeta.length,invalidMeta:invalidMeta.length,duplicateIdGroups:[...duplicateIds.values()].filter(v=>v.length>1).length,
    emptyDesc:records.filter(x=>x.emptyDesc).length,langMismatch:records.filter(x=>x.langMismatch).length},
  duplicateIds:groups(duplicateIds),exactCodeDuplicates:groups(rawHashes),formatNormalizedCandidates:groups(normalizedHashes),
  missingMeta,invalidMeta,records,notes:noteStats,noteCases
};
await fs.writeFile(output,JSON.stringify(report,null,2)+'\n','utf8');
console.log(JSON.stringify({
  report:output,totals:report.totals,
  exactDuplicateGroups:report.exactCodeDuplicates.length,
  formatNormalizedCandidateGroups:report.formatNormalizedCandidates.length,
  noteStats:report.notes,
  sampleAmbiguousNotes:report.noteCases.slice(0,30)
},null,2));
