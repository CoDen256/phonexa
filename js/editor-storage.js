// ─── File system persistence: IndexedDB + FileSystemDirectoryHandle + save ────

// ─── IndexedDB helpers ────────────────────────────────────────────────────────
function idbOpen(){return new Promise((res,rej)=>{const rq=indexedDB.open('ipa-editor',1);rq.onupgradeneeded=e=>e.target.result.createObjectStore('kv');rq.onsuccess=e=>res(e.target.result);rq.onerror=rej;});}
async function idbPut(key,val){try{const db=await idbOpen();const tx=db.transaction('kv','readwrite');tx.objectStore('kv').put(val,key);}catch(e){}}
async function idbGet(key){try{const db=await idbOpen();return new Promise((res)=>{const tx=db.transaction('kv','readonly');const rq=tx.objectStore('kv').get(key);rq.onsuccess=()=>res(rq.result??null);rq.onerror=()=>res(null);});}catch(e){return null;}}

// ─── Restore persisted folder handle on page load ────────────────────────────
async function tryRestoreHandle(){
  const h=await idbGet('dirHandle');
  if(!h)return;
  try{
    const perm=await h.queryPermission({mode:'readwrite'});
    if(perm==='granted'){applyHandle(h); await loadFromFolder(h);}
  }catch(e){}
}
function applyHandle(h){
  state.dirHandle=h;
  const btn=document.getElementById('folderBtn');
  if(btn){btn.textContent='📂 Loaded: '+h.name; btn.classList.add('connected');}
}

// ─── Load all languages from a folder into state.langs ───────────────────────
async function loadFromFolder(h){
  // Read index.json to know which are enabled (in active set)
  let enabledKeys=[];
  try{
    const idxFile=await h.getFileHandle('index.json');
    const idx=JSON.parse(await(await idxFile.getFile()).text());
    enabledKeys=(idx.languages||[]).filter(n=>!n.startsWith('_'));
  }catch(e){/* No index.json yet */}

  // Scan ALL subdirectories for lang.json (finds disabled langs too)
  let loaded=0;
  try{
    for await(const[name,entry]of h.entries()){
      if(entry.kind!=='directory'||name.startsWith('_')||name==='cardinal')continue;
      try{
        const langFile=await entry.getFileHandle('lang.json');
        const data=JSON.parse(await(await langFile.getFile()).text());
        if(data&&data.key){
          state.langs[data.key]=data;
          state.langSources[data.key]='folder';
          if(!state.langOrder.includes(data.key))state.langOrder.push(data.key);
          // Mark disabled if not listed in index.json
          if(!enabledKeys.includes(data.key))state.langDisabled.add(data.key);
          else state.langDisabled.delete(data.key);
          loaded++;
        }
      }catch(e){/* no lang.json in this subdir */}
    }
  }catch(e){console.warn('Folder scan:',e);}

  renderLangList(); updateSaveButtons();
  return loaded;
}
// ─── Write one language to a folder ──────────────────────────────────────────
async function writeToFolder(handle,data){
  const key=data.key; if(!key)throw new Error('Language key required');
  const json=JSON.stringify(data,null,2);
  const subDir=await handle.getDirectoryHandle(key,{create:true});
  const fh=await subDir.getFileHandle('lang.json',{create:true});
  const w=await fh.createWritable(); await w.write(json); await w.close();
  return key;
}

// ─── Update index.json in a folder to list all saved language keys ────────────
async function writeIndex(handle,keys){
  // Respect state.langOrder for the save order
  const ordered=(state.langOrder||[]).filter(k=>keys.includes(k));
  const rest=keys.filter(k=>!ordered.includes(k));
  const finalKeys=[...ordered,...rest];
  const fh=await handle.getFileHandle('index.json',{create:true});
  const w=await fh.createWritable();
  await w.write(JSON.stringify({languages:finalKeys},null,2));
  await w.close();
}

// ─── Flush the current vowel/language draft into state.langs ─────────────────
function flushCurrentDraft(){
  if(!state.langDraft)return;
  // Flush open vowel editor into the lang draft
  if(state.vowelIdx!==null&&state.vowelDraft&&state.vowelDraft.ipa){
    if(state.vowelIdx<0)(state.langDraft.vowels=state.langDraft.vowels||[]).push(state.vowelDraft);
    else state.langDraft.vowels[state.vowelIdx]=state.vowelDraft;
  }
  state.langs[state.langDraft.key]=clone(state.langDraft);
}

// ─── Save all languages to the connected folder ───────────────────────────────
async function saveLang(){
  if(!state.dirHandle){return saveAsLang();}
  flushCurrentDraft();
  // Write all non-cardinal langs to disk; only include enabled in index.json
  const allLangs=Object.entries(state.langs).filter(([k])=>k!=='cardinal');
  const enabledKeys=allLangs.filter(([k])=>!state.langDisabled.has(k)).map(([k])=>k);
  let saved=0,errors=0;
  for(const[,lang]of allLangs){
    try{await writeToFolder(state.dirHandle,lang);saved++;}
    catch(e){console.error('Failed:',e);errors++;}
  }
  try{await writeIndex(state.dirHandle,enabledKeys);}catch(e){}
  markSaved(); renderLangList();
  toast(errors?`Saved ${saved}, ${errors} failed`:`Saved — ${enabledKeys.length} active, ${allLangs.length-enabledKeys.length} disabled`);
}

// ─── Save As: pick a new folder, save everything there, switch connection ─────
async function saveAsLang(){
  if(!window.showDirectoryPicker){
    if(!state.langDraft){toast('No language selected');return;}
    flushCurrentDraft();
    const a=document.createElement('a');
    a.href=URL.createObjectURL(new Blob([JSON.stringify(clone(state.langDraft),null,2)],{type:'application/json'}));
    a.download='lang.json'; a.click();
    toast('Downloaded (File System API not available in this browser)');
    return;
  }
  try{
    const h=await window.showDirectoryPicker({mode:'readwrite',startIn:'documents'});
    flushCurrentDraft();
    const allLangs=Object.entries(state.langs).filter(([k])=>k!=='cardinal');
    const enabledKeys=allLangs.filter(([k])=>!state.langDisabled.has(k)).map(([k])=>k);
    let saved=0,errors=0;
    for(const[,lang]of allLangs){
      try{await writeToFolder(h,lang);saved++;}
      catch(e){console.error('Failed:',e);errors++;}
    }
    try{await writeIndex(h,enabledKeys);}catch(e){}
    for(const[k]of allLangs) state.langSources[k]='folder';
    applyHandle(h);
    await idbPut('dirHandle',h);
    markSaved(); renderLangList(); updateSaveButtons();
    toast(errors?`Saved ${saved}, ${errors} failed`:`Saved to ${h.name} — ${enabledKeys.length} active`);
  }catch(e){if(e.name!=='AbortError')toast('Save failed: '+e.message);}
}

// ─── Mark saved state ─────────────────────────────────────────────────────────
function markSaved(){
  state.unsaved=false;
  const n=document.getElementById('unsavedNote'); if(n)n.style.display='none';
}

// ─── Load lang folder button ──────────────────────────────────────────────────
document.getElementById('folderBtn').addEventListener('click',async()=>{
  if(!window.showDirectoryPicker){toast('File System API not supported — use Chrome/Edge');return;}
  try{
    const h=await window.showDirectoryPicker({mode:'readwrite',startIn:'documents'});
    applyHandle(h);
    await idbPut('dirHandle',h);
    const n=await loadFromFolder(h);
    toast(n>0?`Loaded ${n} language${n!==1?'s':''} from ${h.name}`:`Connected ${h.name} — folder is empty`);
  }catch(e){if(e.name!=='AbortError')toast('Could not open: '+e.message);}
});

// ─── New language button ──────────────────────────────────────────────────────
document.getElementById('newLangBtn').addEventListener('click',()=>{
  if(state.unsaved&&!confirm('Discard unsaved changes?'))return;
  const key='lang-'+Date.now().toString(36);
  const fresh={key,label:'New Language',color:'#a78bfa',vowels:[]};
  state.langs[key]=fresh; state.langSources[key]='new'; state.langOrder.push(key);
  state.selKey=key; state.langDraft=clone(fresh);
  state.unsaved=true; state.vowelIdx=null; state.vowelDraft=null;
  renderLangList(); renderMain();
});