// ─── Language list, selection, main panel, vowel editor — 100% DB-backed ──────
// (File System Access/local lang.json editing retired; see js/editor-tokens.js's
// header comment for the same migration on the token/sample side.)

// ─── Load languages ───────────────────────────────────────────────────────────
async function loadLanguages(){
  try{
    const langs = await fetch('/api/v1/languages').then(r=>r.json());
    state.langs = {}; state.langOrder = [];
    for(const l of langs){
      state.langs[l.key] = l;   // metadata only — {id,key,label,color,sortOrder,enabled}; vowels fetched on select
      state.langOrder.push(l.key);
    }
  }catch(e){console.error('Failed to load languages',e); toast('Could not load languages: '+e.message);}
  renderLangList();
}

// ─── Language tabs ─────────────────────────────────────────────────────────────
function renderLangList(){
  const el=document.getElementById('langTabs'); if(!el)return;
  el.innerHTML='';

  for(const key of state.langOrder){
    const lang=state.langs[key]; if(!lang) continue;
    const isActive=state.selKey===key;
    const isDisabled=!lang.enabled;

    const wrap=document.createElement('div');
    wrap.className='lang-tab-wrap'+(isDisabled?' tab-disabled':'');

    const btn=document.createElement('button');
    btn.type='button'; btn.className='lang-tab'+(isActive?' active':'')+(isDisabled?' disabled':'');
    btn.style.borderColor=isActive&&!isDisabled?lang.color:'';
    btn.style.color=isActive&&!isDisabled?lang.color:'';
    btn.textContent=(lang.label||key)+(isDisabled?' (off)':'');
    btn.addEventListener('click',()=>selectLang(key));

    const disBtn=document.createElement('button');
    disBtn.type='button'; disBtn.className='lang-tab-del'; disBtn.textContent=isDisabled?'↩':'×';
    disBtn.title=isDisabled?'Re-enable':'Disable (hide from the public chart)';
    disBtn.addEventListener('click',async e=>{
      e.stopPropagation();
      const resp=await fetch(`/api/v1/languages/${lang.id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:isDisabled})});
      if(resp.ok){ state.langs[key]=await resp.json(); renderLangList(); }
    });

    const delBtn=document.createElement('button');
    delBtn.type='button'; delBtn.className='lang-tab-del'; delBtn.textContent='🗑';
    delBtn.title='Delete permanently — destroys every sample/token/audio under this language';
    delBtn.addEventListener('click',async e=>{
      e.stopPropagation();
      const typed=prompt(`This permanently deletes "${lang.label}" (${key}) and ALL its samples, tokens, analyses, and audio files. This cannot be undone.\n\nType the language key to confirm:`);
      if(typed!==key) return;
      const resp=await fetch(`/api/v1/languages/${lang.id}`,{method:'DELETE'});
      if(!resp.ok){ toast('Delete failed'); return; }
      delete state.langs[key];
      const oi=state.langOrder.indexOf(key); if(oi!==-1)state.langOrder.splice(oi,1);
      if(state.selKey===key){state.selKey=null;state.langDraft=null;state.vowelIdx=null;state.vowelDraft=null;closeVowelEditor();}
      renderLangList(); renderEditorAll();
      toast(`Deleted "${lang.label}"`);
    });

    wrap.appendChild(btn); wrap.appendChild(disBtn); wrap.appendChild(delBtn);
    el.appendChild(wrap);
  }
}

async function selectLang(key){
  if(state.vowelIdx!==null && state.vowelDirty && !confirm('Discard unsaved vowel edits?'))return;
  const meta=state.langs[key];
  state.selKey=key;
  state.vowelIdx=null; state.vowelDraft=null; state.pickingMode=null;
  const vowels = await fetch(`/api/v1/vowels?languageId=${meta.id}`).then(r=>r.ok?r.json():[]).catch(()=>[]);
  state.langDraft = {...meta, vowels};
  renderLangList();
  showLangPanel();
  if (typeof ensureDbLanguageData === 'function') ensureDbLanguageData();
}

// ─── Show/populate the lang panel (runs once per language selection) ──────────
function showLangPanel(){
  if(!state.langDraft) return;

  const metaForm=document.getElementById('langMetaForm');
  if(metaForm){
    metaForm.style.display='block';
    const fKey=document.getElementById('fKey');
    const fLabel=document.getElementById('fLabel');
    const fColor=document.getElementById('fColor');
    if(fKey) fKey.value=state.langDraft.key||'';
    if(fLabel) fLabel.value=state.langDraft.label||'';
    if(fColor) fColor.value=state.langDraft.color||'#7eb8f7';
  }

  const cs=document.getElementById('contentSection');
  if(cs) cs.style.display='block';

  refreshCharts();
  renderVowelCards();
  if(state.vowelIdx!==null) buildInlineForm();
  updateSectionTitle();
}

function renderMain(){ showLangPanel(); }

// ─── Debounced PATCH for language meta fields (label/color) ───────────────────
let _langPatchTimer=null;
function patchLanguageDebounced(fields){
  if(!state.langDraft) return;
  Object.assign(state.langDraft, fields);
  clearTimeout(_langPatchTimer);
  _langPatchTimer=setTimeout(async ()=>{
    const resp=await fetch(`/api/v1/languages/${state.langDraft.id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(fields)});
    if(resp.ok){ const updated=await resp.json(); state.langs[state.langDraft.key]=updated; Object.assign(state.langDraft, updated); renderLangList(); }
  }, 400);
}

// ─── One-time UI wiring (called from init) ────────────────────────────────────
function initEditorUI(){
  const fLabel=document.getElementById('fLabel');
  const fColor=document.getElementById('fColor');
  if(fLabel) fLabel.addEventListener('input',e=>{ patchLanguageDebounced({label:e.target.value}); refreshCharts(); });
  if(fColor) fColor.addEventListener('input',e=>{ patchLanguageDebounced({color:e.target.value}); refreshCharts(); });

  const newBtn=document.getElementById('newLangBtn');
  if(newBtn) newBtn.addEventListener('click', async ()=>{
    const key=(prompt('Language key (lowercase letters/numbers/hyphens, e.g. "fr"):')||'').trim().toLowerCase();
    if(!key) return;
    const label=(prompt('Display label:', key)||key).trim();
    const resp=await fetch('/api/v1/languages',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key,label})});
    if(!resp.ok){ const err=await resp.json().catch(()=>({})); toast('Could not create language: '+(err.error||resp.status)); return; }
    const lang=await resp.json();
    state.langs[lang.key]=lang; state.langOrder.push(lang.key);
    renderLangList();
    await selectLang(lang.key);
  });

  const addBtn=document.getElementById('addVowelBtn');
  if(addBtn) addBtn.addEventListener('click',()=>openVowelEditor(-1));

  const averagesToggle=document.getElementById('averagesToggle');
  if(averagesToggle){
    averagesToggle.classList.toggle('active', filters.showAverages);
    averagesToggle.addEventListener('click',()=>{
      filters.showAverages=!filters.showAverages;
      averagesToggle.classList.toggle('active',filters.showAverages);
      averagesToggle.title=filters.showAverages?'Hide average vowel dots':'Show average F1/F2 vowel dots';
      refreshCharts();
    });
  }
  const tokensToggle=document.getElementById('tokensToggle');
  if(tokensToggle){
    tokensToggle.addEventListener('click',()=>{
      filters.showTokens=!filters.showTokens;
      tokensToggle.classList.toggle('active',filters.showTokens);
      tokensToggle.title=filters.showTokens?'Hide token measurements':'Show token measurements on formant chart';
      refreshCharts();
    });
  }
  const cardinalToggle=document.getElementById('cardinalToggle');
  if(cardinalToggle){
    cardinalToggle.addEventListener('click',async ()=>{
      state.showCardinals=!state.showCardinals;
      cardinalToggle.classList.toggle('active',state.showCardinals);
      cardinalToggle.title=state.showCardinals?'Hide cardinal vowels':'Show cardinal vowels';
      if(state.showCardinals && !state.cardinalLangData) await ensureCardinalLoaded();
      if(state.langDraft)refreshCharts();
    });
  }
  const soloToggle=document.getElementById('soloToggle');
  if(soloToggle){
    soloToggle.addEventListener('click',()=>{
      state.showOtherVowels=!state.showOtherVowels;
      soloToggle.classList.toggle('active',!state.showOtherVowels);
      soloToggle.title=state.showOtherVowels?'Show only current vowel':'Show all vowels';
      if(state.langDraft)refreshCharts();
    });
  }

  document.getElementById('tabIpa')?.addEventListener('click',()=>{
    state.chartTab='ipa';
    document.getElementById('tabIpa').classList.add('active');
    document.getElementById('tabFormant').classList.remove('active');
    document.getElementById('panelIpa').classList.add('active');
    document.getElementById('panelFormant').classList.remove('active');
  });
  document.getElementById('tabFormant')?.addEventListener('click',()=>{
    state.chartTab='formant';
    document.getElementById('tabFormant').classList.add('active');
    document.getElementById('tabIpa').classList.remove('active');
    document.getElementById('panelFormant').classList.add('active');
    document.getElementById('panelIpa').classList.remove('active');
  });

  const rh=document.getElementById('resizeHandle');
  const ep=document.getElementById('editorPane');
  if(rh&&ep){
    let dragging=false,startX,startW;
    rh.addEventListener('mousedown',e=>{
      dragging=true; startX=e.clientX; startW=ep.offsetWidth;
      rh.classList.add('dragging'); document.body.style.userSelect='none'; document.body.style.cursor='col-resize';
    });
    document.addEventListener('mousemove',e=>{
      if(!dragging)return;
      const w=Math.max(180,Math.min(600,startW+(startX-e.clientX)));
      ep.style.width=w+'px';
    });
    document.addEventListener('mouseup',()=>{
      if(!dragging)return; dragging=false;
      rh.classList.remove('dragging'); document.body.style.userSelect=''; document.body.style.cursor='';
    });
  }
}

// ─── Refresh charts ───────────────────────────────────────────────────────────
function refreshCharts(){
  renderEditorAll();
}

async function ensureCardinalLoaded(){
  const meta=state.langs.cardinal;
  if(!meta) return;
  const vowels = await fetch(`/api/v1/vowels?languageId=${meta.id}`).then(r=>r.ok?r.json():[]).catch(()=>[]);
  state.cardinalLangData = {...meta, vowels};
}

// ─── Sync coordinate form inputs from draft ───────────────────────────────────
function syncCoordsToForm(){
  if(!state.vowelDraft)return;
  const v=state.vowelDraft, g=id=>document.getElementById(id);
  if(g('veH'))  g('veH').value  = v.heightBackness?.[0]??'';
  if(g('veB'))  g('veB').value  = v.heightBackness?.[1]??'';
  if(g('veF1')) g('veF1').value = v.f1??'';
  if(g('veF2')) g('veF2').value = v.f2??'';
  if(g('veH2')) g('veH2').value = v.target?.heightBackness?.[0]??'';
  if(g('veB2'))  g('veB2').value  = v.target?.heightBackness?.[1]??'';
  if(g('veTF1')) g('veTF1').value = v.target?.f1??'';
  if(g('veTF2')) g('veTF2').value = v.target?.f2??'';
}

// ─── Open vowel editor ────────────────────────────────────────────────────────
function openVowelEditor(idx){
  state.vowelIdx=idx;
  state.pickingMode=null;
  state.vowelDirty=false;
  const existing=(idx>=0&&state.langDraft?.vowels)?state.langDraft.vowels[idx]:null;
  state.vowelDraft=existing?clone(existing):{symbols:[''],heightBackness:[0.5,0.5],rounded:false,desc:'',type:'short',f1:null,f2:null,wikiUrl:'',target:null};
  const ve=document.getElementById('veInline');
  if(ve){ve.style.display='block';buildInlineForm();}
  const st=document.getElementById('soloToggle'); if(st) st.style.display='';
  renderVowelCards();
  refreshCharts();
}

function closeVowelEditor(){
  state.vowelIdx=null; state.vowelDraft=null; state.pickingMode=null; state.vowelDirty=false;
  state.showOtherVowels=true;
  const st=document.getElementById('soloToggle');
  if(st){st.style.display='none';st.classList.remove('active');st.title='Show only current vowel';}
  const ve=document.getElementById('veInline');
  if(ve) ve.style.display='none';
  if(typeof updatePaneHint==='function') updatePaneHint();
  renderVowelCards(); refreshCharts();
}

// ─── Vowel-draft dirty indicator (unsaved edits in the OPEN vowel editor —
// not a whole-language save, since every Apply persists straight to the DB) ──
function markUnsaved(){
  state.vowelDirty=true;
  const n=document.getElementById('unsavedNote'); if(n) n.style.display='inline';
}
function markSaved(){
  state.vowelDirty=false;
  const n=document.getElementById('unsavedNote'); if(n) n.style.display='none';
}
