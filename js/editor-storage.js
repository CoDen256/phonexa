// ─── File system persistence: IndexedDB + FileSystemDirectoryHandle + save ────
// ─── IndexedDB persistence for dirHandle ──────────────────────────────────────
function idbOpen(){return new Promise((res,rej)=>{const rq=indexedDB.open('ipa-editor',1);rq.onupgradeneeded=e=>e.target.result.createObjectStore('kv');rq.onsuccess=e=>res(e.target.result);rq.onerror=rej;});}
async function idbPut(key,val){try{const db=await idbOpen();const tx=db.transaction('kv','readwrite');tx.objectStore('kv').put(val,key);}catch(e){}}
async function idbGet(key){try{const db=await idbOpen();return new Promise((res)=>{const tx=db.transaction('kv','readonly');const rq=tx.objectStore('kv').get(key);rq.onsuccess=()=>res(rq.result??null);rq.onerror=()=>res(null);});}catch(e){return null;}}

async function tryRestoreHandle(){
  const h=await idbGet('dirHandle');
  if(!h) return;
  try{
    const perm=await h.queryPermission({mode:'readwrite'});
    if(perm==='granted'){applyHandle(h);return;}
    // Permission was not persisted — can't request without user gesture, skip silently
  }catch(e){}
}
function applyHandle(h){
  state.dirHandle=h;
  const btn=document.getElementById('folderBtn');
  btn.textContent='✓ '+h.name+' connected';
  btn.classList.add('connected');
}

// ─── Save language ────────────────────────────────────────────────────────────
async function saveLang(){
  if(!state.langDraft)return;
  const data=clone(state.langDraft);
  const key=data.key;
  if(!key){toast('Language key is required');return;}
  const json=JSON.stringify(data,null,2);

  if(state.dirHandle){
    try{
      const subDir=await state.dirHandle.getDirectoryHandle(key,{create:true});
      const fh=await subDir.getFileHandle('lang.json',{create:true});
      const w=await fh.createWritable(); await w.write(json); await w.close();
      // Update index.json
      const allKeys=Object.keys(state.langs);
      if(!allKeys.includes(key))allKeys.push(key);
      const origKey=state.selKey;
      if(origKey&&origKey!==key){const p=allKeys.indexOf(origKey);if(p>=0)allKeys.splice(p,1);}
      const idxFh=await state.dirHandle.getFileHandle('index.json',{create:true});
      const iw=await idxFh.createWritable(); await iw.write(JSON.stringify({languages:allKeys},null,2)); await iw.close();
      if(origKey&&origKey!==key)delete state.langs[origKey];
      state.langs[key]=data; state.selKey=key; state.unsaved=false;
      const n=document.getElementById('unsavedNote'); if(n)n.style.display='none';
      renderLangList(); toast('✓ Saved to lang/'+key+'/lang.json');
      return;
    }catch(e){console.error('FS write failed:',e); toast('Write failed — downloading instead');}
  }
  // Fallback: download
  const a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob([json],{type:'application/json'}));
  a.download='lang.json'; a.click();
  toast(`Downloaded — put in lang/${key}/`);
  state.langs[key]=data; state.selKey=key; state.unsaved=false;
  const n=document.getElementById('unsavedNote'); if(n)n.style.display='none';
  renderLangList();
}

// ─── Folder connect ───────────────────────────────────────────────────────────
document.getElementById('folderBtn').addEventListener('click',async()=>{
  if(!window.showDirectoryPicker){toast('File System API not supported — use Chrome/Edge');return;}
  try{
    const h=await window.showDirectoryPicker({mode:'readwrite',startIn:'documents'});
    applyHandle(h);
    await idbPut('dirHandle',h);
    toast('Folder connected — saves go directly to files');
  }catch(e){if(e.name!=='AbortError')toast('Could not connect: '+e.message);}
});

// ─── New language ─────────────────────────────────────────────────────────────
document.getElementById('newLangBtn').addEventListener('click',()=>{
  if(state.unsaved&&!confirm('Discard unsaved changes?'))return;
  const key='lang-'+Date.now().toString(36);
  const fresh={key,label:'New Language',color:'#a78bfa',vowels:[]};
  state.langs[key]=fresh; state.selKey=key; state.langDraft=clone(fresh);
  state.unsaved=true; state.vowelIdx=null; state.vowelDraft=null;
  renderLangList(); renderMain();
});