// Read-only инвентаризация библиотеки Code Lab.
// Запуск: node tools/code-lab/scripts/audit-library.mjs [путь-к-библиотеке]
// Ничего не изменяет. Отчёт: audit-library-report.json в текущей рабочей папке.
import fs from 'node:fs/promises';
import path from 'node:path';
import { makeLook } from '../lib/annotate.mjs';
import crypto from 'node:crypto';

const root=path.resolve(process.argv[2]||'tools/code-lab/library');
const output=path.resolve('audit-library-report.json');
const codeExt=new Set(['js','mjs','cjs','jsx','ts','tsx','py','html','htm','css','sql','svg','json','rb','php','go','lua','sh','bash','ps1','r','pl','txt']);
const tokenKinds=new Set(['kw','fn','name','num','str','com','op','sp']);
const norm=s=>String(s??'').replace(/\r\n?/g,'\n').trim();
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const base=p=>path.basename(p).replace(/\.[^.]+$/,'');
const files=[];
async function walk(dir){
  for(const e of await fs.readdir(dir,{withFileTypes:true})){
    if(e.name.startsWith('.')||e.name.startsWith('_')) continue;
    const p=path.join(dir,e.name);
    if(e.isDirectory()) await walk(p); else files.push(p);
  }
}
const isIdentifierToken=token=>/^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(String(token||''));
function positions(code,token){
  if(!token) return [];
  const out=[];
  const identifier=isIdentifierToken(token);
  code.replace(/\r\n?/g,'\n').split('\n').forEach((line,lineNo)=>{
    let at=0;
    while((at=line.indexOf(token,at))!==-1){
      const before=at>0?line[at-1]:'';
      const after=line[at+token.length]||'';
      const leftBoundary=!/[\p{L}\p{N}_$]/u.test(before);
      const rightBoundary=!/[\p{L}\p{N}_$]/u.test(after);
      if(!identifier||(leftBoundary&&rightBoundary)) out.push({line:lineNo,col:at});
      at+=Math.max(1,token.length);
    }
  });
  return out;
}
await walk(root);
const set=new Set(files);
const records=[],missingMeta=[],invalidMeta=[],duplicateIds=new Map(),rawHashes=new Map(),normalizedHashes=new Map();
const noteStats={total:0,orphanTotal:0,concept:0,orphanAlreadyInWordNotes:0,swapped:0,invalid:0,anchored:0,uniqueToken:0,multipleTokens:0,composite:0,absent:0,empty:0};
const noteCases=[],conceptNotes=[];
const dictionaryNoteStats={available:false,total:0,matched:0,stale:0,missing:0};
const dictionaryNoteCases=[];
let keywordDict=null;
try{
  keywordDict=JSON.parse(await fs.readFile(new URL('../public/keyword-dict.json',import.meta.url),'utf8'));
  keywordDict.langs=keywordDict.langs&&typeof keywordDict.langs==='object'?keywordDict.langs:{};
  const langDir=new URL('../public/dict/langs/',import.meta.url);
  for(const file of (await fs.readdir(langDir)).filter(n=>n.endsWith('.json'))){
    const lang=file.replace(/\.json$/,'').toLowerCase();
    const rawEntries=JSON.parse(await fs.readFile(new URL(file,langDir),'utf8'));
    const entries=Object.fromEntries(Object.entries(rawEntries).map(([key,value])=>[String(key).toLowerCase(),value]));
    keywordDict.langs[lang]=Object.assign({},keywordDict.langs[lang]||{},entries);
  }
  dictionaryNoteStats.available=true;
}catch{}
const viewCodeStats={eligible:0,exact:0,formatOnly:0,mismatch:0,missing:0};
const viewCodeCases=[];
const extLang={js:'js',mjs:'js',cjs:'js',jsx:'js',ts:'ts',tsx:'ts',py:'python',html:'html',htm:'html',css:'css',svg:'svg',json:'json',sql:'sql',rb:'ruby',php:'php',go:'go',lua:'lua',sh:'sh',bash:'bash',ps1:'powershell',r:'r',pl:'perl',txt:'txt'};
for(const file of files){
  if(file.endsWith('.meta.json')||file.endsWith('.bak')||file.endsWith('.tmp')) continue;
  const ext=path.extname(file).slice(1).toLowerCase();
  if(!codeExt.has(ext)) continue;
  const code=await fs.readFile(file,'utf8');
  const rel=path.relative(root,file);
  const metaPath=file+'.meta.json';
  if(!set.has(metaPath)) missingMeta.push(rel);
  let meta={};
  if(set.has(metaPath)){
    try{
      meta=JSON.parse(await fs.readFile(metaPath,'utf8'));
      if(!meta||typeof meta!=='object'||Array.isArray(meta)) throw new Error('not object');
    }catch(e){invalidMeta.push({file:path.relative(root,metaPath),error:String(e)});meta={};}
  }
  const hasOwnId=Object.prototype.hasOwnProperty.call(meta,'id')&&String(meta.id||'').trim()!=='';
  const id=String(meta.id||base(file));
  if(!duplicateIds.has(id)) duplicateIds.set(id,[]);
  duplicateIds.get(id).push(rel);
  const exact=hash(norm(code));
  const formatted=hash(norm(code).replace(/[ \t]+/g,' ').replace(/\n+/g,'\n'));
  for(const [map,key] of [[rawHashes,exact],[normalizedHashes,formatted]]){
    if(!map.has(key)) map.set(key,[]);
    map.get(key).push(rel);
  }
  const useView=meta?.component?.views?.use;
  if(useView){
    viewCodeStats.eligible++;
    const viewCode=useView?.code?.content;
    if(typeof viewCode!=='string'||!viewCode.trim()){
      viewCodeStats.missing++;
      viewCodeCases.push({file:rel,id,title:meta.title||'',classification:'missing-view-code'});
    }else{
      const sourceNorm=norm(code),viewNorm=norm(viewCode);
      const same=sourceNorm===viewNorm;
      const formatOnly=!same&&sourceNorm.replace(/[ \t]+/g,' ').replace(/\n+/g,'\n')===viewNorm.replace(/[ \t]+/g,' ').replace(/\n+/g,'\n');
      if(same)viewCodeStats.exact++;
      else if(formatOnly)viewCodeStats.formatOnly++;
      else{
        viewCodeStats.mismatch++;
        viewCodeCases.push({file:rel,id,title:meta.title||'',classification:'source-view-mismatch',sourceLines:code.split('\n').length,viewLines:viewCode.split('\n').length,sourceLength:code.length,viewLength:viewCode.length,sourceHash:hash(sourceNorm),viewHash:hash(viewNorm),sourcePreview:code.split('\n').slice(0,5),viewPreview:viewCode.split('\n').slice(0,5)});
      }
    }
  }
  const lang=String(meta.lang||extLang[ext]||'').toLowerCase();
  const look=dictionaryNoteStats.available?makeLook(lang,keywordDict):()=>null;
  const expected=extLang[ext];
  const notes=Array.isArray(meta.wordNotes)?meta.wordNotes:[];
  const codeLines=code.split('\n');
  const orphans=Array.isArray(meta.orphanNotes)?meta.orphanNotes:[];
  noteStats.total+=notes.length;noteStats.orphanTotal+=orphans.length;
  const noteKey=n=>JSON.stringify([n?.text,n?.line,n?.col,n?.note,n?.kind,n?.source]);
  const wordNoteKeys=new Set(notes.map(noteKey));
  function inspect(note,isOrphan){
    if(!note||typeof note!=='object'){noteStats.invalid++;noteCases.push({
      file:rel,id,text:'',explanation:'',source:'',line:null,col:null,
      classification:'invalid-note-record',occurrences:0,anchored:false,swapped:false,isOrphan
    });return;}
    const swapped=tokenKinds.has(note.note)&&typeof note.kind==='string'&&!tokenKinds.has(note.kind);
    if(swapped) noteStats.swapped++;
    const explanation=swapped?note.kind:note.note;
    if(note.source==='dict'&&dictionaryNoteStats.available){
      dictionaryNoteStats.total++;
      const current=look(note.text);
      if(!current){dictionaryNoteStats.missing++;dictionaryNoteCases.push({file:rel,id,text:note.text,lang,classification:'dictionary-entry-missing',storedExplanation:explanation});}
      else if(current!==explanation){dictionaryNoteStats.stale++;dictionaryNoteCases.push({file:rel,id,text:note.text,lang,classification:'dictionary-explanation-stale',storedExplanation:explanation,currentExplanation:current});}
      else dictionaryNoteStats.matched++;
    }
    if(typeof note.text!=='string'||!note.text.trim()){
      noteStats.invalid++;
      noteCases.push({
        file:rel,id,text:typeof note.text==='string'?note.text:'',explanation:typeof explanation==='string'?explanation:'',
        source:note.source||'',line:note.line??null,col:note.col??null,
        classification:typeof note.text==='string'?'empty-token-text':'invalid-token-text',
        occurrences:0,anchored:false,swapped,isOrphan
      });
      return;
    }
    if(note.kind==='concept'){noteStats.concept++;conceptNotes.push({file:rel,id,text:note.text,explanation:note.note||'',source:note.source||''});return;}
    if(isOrphan&&wordNoteKeys.has(noteKey(note))) noteStats.orphanAlreadyInWordNotes++;
    if(typeof explanation!=='string'||!explanation.trim()){noteStats.empty++;return;}
    const hits=positions(code,note.text);
    const anchored=hits.some(p=>p.line===note.line&&p.col===note.col);
    let cls;
    if(anchored){noteStats.anchored++;cls='exact-position';}
    else if(hits.length===1){noteStats.uniqueToken++;cls='unique-token-elsewhere';}
    else if(hits.length>1){noteStats.multipleTokens++;cls='multiple-token-occurrences';}
    else if(!isIdentifierToken(note.text)&&code.includes(note.text)){noteStats.composite++;cls='composite-or-substring';}
    else{noteStats.absent++;cls='not-in-current-code';}
    if(isOrphan||!anchored||swapped) noteCases.push({
      file:rel,id,text:note.text,explanation,source:note.source||'',
      line:note.line??null,col:note.col??null,classification:cls,
      occurrences:hits.length,anchored,swapped,isOrphan,
      savedLineText:codeLines[note.line]??null,
      candidatePositions:!anchored&&hits.length>1?hits.slice(0,30).map(p=>({line:p.line,col:p.col,lineText:(codeLines[p.line]||'').slice(0,240)})):[]
    });
  }
  for(const n of notes) inspect(n,false);
  for(const n of orphans) inspect(n,true);
  records.push({
    file:rel,id,hasOwnId,lang,expectedLang:expected||null,langMismatch:!!(expected&&lang!==expected),
    group:meta.group||'',title:meta.title||'',emptyDesc:!String(meta.desc||'').trim(),
    status:meta.status||'',hasMeta:set.has(metaPath),metaError:invalidMeta.some(x=>x.file===path.relative(root,metaPath)),
    notes:notes.length,orphans:orphans.length,rawHash:exact,normalizedHash:formatted,
    metaSummary:{
      title:meta.title||'',group:meta.group||'',desc:meta.desc||'',tags:meta.tags||[],
      aliases:meta.aliases||[],status:meta.status||'',component:meta.component||null,
      source:meta.source||null,externalLinks:meta.externalLinks||meta.links||meta.references||meta.reference||null,
      wordNotes:notes,orphanNotes:orphans
    },
    codeUrls:[...new Set(code.match(/https?:\/\/[^\s"'<>)}\]]+/g)||[])],
    metaUrls:[...new Set(JSON.stringify(meta).match(/https?:\/\/[^\s"'<>)}\]]+/g)||[])]
  });
}
const groups=map=>[...map.values()].filter(v=>v.length>1).map(files=>({count:files.length,files}));
const recordByFile=new Map(records.map(x=>[x.file,x]));
const duplicateReview=groups(rawHashes).map(g=>({count:g.count,files:g.files.map(f=>recordByFile.get(f))}));
const report={
  generatedAt:new Date().toISOString(),root,
  totals:{codeFiles:records.length,passportFiles:files.filter(f=>f.endsWith('.meta.json')).length,
    missingMeta:missingMeta.length,invalidMeta:invalidMeta.length,missingId:records.filter(x=>!x.hasOwnId).length,
    duplicateIdGroups:[...duplicateIds.values()].filter(v=>v.length>1).length,
    emptyDesc:records.filter(x=>x.emptyDesc).length,langMismatch:records.filter(x=>x.langMismatch).length},
  duplicateIds:groups(duplicateIds),exactCodeDuplicates:groups(rawHashes),
  formatNormalizedCandidates:groups(normalizedHashes),duplicateReview,missingMeta,invalidMeta,records,notes:noteStats,noteCases,conceptNotes,
  viewCodeAudit:viewCodeStats,viewCodeCases,
  dictionaryNoteAudit:dictionaryNoteStats,dictionaryNoteCases
};
await fs.writeFile(output,JSON.stringify(report,null,2)+'\n','utf8');
console.log(JSON.stringify({
  report:output,totals:report.totals,
  exactDuplicateGroups:report.exactCodeDuplicates.length,
  formatNormalizedCandidateGroups:report.formatNormalizedCandidates.length,
  noteStats:report.notes,viewCodeAudit:report.viewCodeAudit,
  sampleViewCodeMismatches:report.viewCodeCases.slice(0,30),
  dictionaryNoteAudit:report.dictionaryNoteAudit,sampleDictionaryNoteMismatches:report.dictionaryNoteCases.slice(0,30),
  sampleAmbiguousNotes:report.noteCases.slice(0,30),conceptSamples:report.conceptNotes.slice(0,20)
},null,2));
