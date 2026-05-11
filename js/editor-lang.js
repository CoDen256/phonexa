// ─── Language list, selection, main panel, vowel editor ──────────────────────

// ─── Load languages ───────────────────────────────────────────────────────────
async function loadLanguages(){
  state.langs={};
  try{
    const idx=await fetch(`lang/index.json?t=${Date.now()}`).then(r=>r.json());
    const names=(idx.languages||[]).filter(n=>!n.startsWith('_'));
    await Promise.all(names.map(name=>
      fetch(`lang/${name}/lang.json?t=${Date.now()}`)
        .then(r=>{if(!r.ok)throw new Error(r.status);return r.json();})
        .then(d=>{if(d&&d.key)state.langs[d.key]=d;})
        .catch(e=>console.warn(`Skip ${name}:`,e.message))
    ));
  }catch(e){console.error('Failed to load index',e);}
  renderLangList();
}

// ─── Language tabs (horizontal) ───────────────────────────────────────────────
function renderLangList(){
  const el=document.getElementById('langTabs'); if(!el)return;
  el.innerHTML='';
  for(const[key,lang]of Object.entries(state.langs)){
    const btn=document.createElement('button');
    btn.type='button'; btn.className='lang-tab'+(state.selKey===key?' active':'');
    btn.style.borderColor=state.selKey===key?lang.color:'';
    btn.style.color=state.selKey===key?lang.color:'';
    btn.textContent=lang.label||key;
    btn.addEventListener('click',()=>selectLang(key));
    el.appendChild(btn);
  }
}

function selectLang(key){
  if(state.unsaved&&!confirm('Discard unsaved changes?'))return;
  state.selKey=key; state.langDraft=clone(state.langs[key]);
  state.unsaved=false; state.vowelIdx=null; state.vowelDraft=null;
  state.pickingMode=null;
  renderLangList();
  showLangPanel();
}

// ─── Show/populate the lang panel (runs once per language selection) ──────────
function showLangPanel(){
  if(!state.langDraft) return;

  // Lang meta form
  const metaForm=document.getElementById('langMetaForm');
  if(metaForm){
    metaForm.style.display='block';
    const fLabel=document.getElementById('fLabel');
    const fColor=document.getElementById('fColor');
    if(fLabel) fLabel.value=state.langDraft.label||'';
    if(fColor) fColor.value=state.langDraft.color||'#7eb8f7';
  }

  // Save button
  const saveBtn=document.getElementById('saveLangBtn');
  if(saveBtn) saveBtn.style.display='inline-flex';

  // Vowel section
  const vs=document.getElementById('vowelSection');
  if(vs) vs.style.display='block';

  refreshCharts();
  renderVowelCards();
  if(state.vowelIdx!==null) buildInlineForm();
  updateSectionTitle();
}

// renderMain kept for compatibility — just calls showLangPanel
function renderMain(){ showLangPanel(); }

// ─── One-time UI wiring (called from init) ────────────────────────────────────
function initEditorUI(){
  // Lang meta inputs
  const fLabel=document.getElementById('fLabel');
  const fColor=document.getElementById('fColor');
  if(fLabel) fLabel.addEventListener('input',e=>{if(state.langDraft){state.langDraft.label=e.target.value;markUnsaved();renderLangList();}});
  if(fColor) fColor.addEventListener('input',e=>{if(state.langDraft){state.langDraft.color=e.target.value;markUnsaved();renderLangList();}});

  // Save button
  const saveBtn=document.getElementById('saveLangBtn');
  if(saveBtn) saveBtn.addEventListener('click',saveLang);

  // Add vowel button
  const addBtn=document.getElementById('addVowelBtn');
  if(addBtn) addBtn.addEventListener('click',()=>openVowelEditor(-1));

  // Cardinal vowels toggle
  const cardinalToggle=document.getElementById('cardinalToggle');
  if(cardinalToggle){
    cardinalToggle.addEventListener('click',()=>{
      state.showCardinals=!state.showCardinals;
      cardinalToggle.classList.toggle('active',state.showCardinals);
      cardinalToggle.title=state.showCardinals?'Hide cardinal vowels':'Show cardinal vowels';
      if(state.langDraft)refreshCharts();
    });
  }
  // Solo toggle (show only current vowel)
  const soloToggle=document.getElementById('soloToggle');
  if(soloToggle){
    soloToggle.addEventListener('click',()=>{
      state.showOtherVowels=!state.showOtherVowels;
      soloToggle.classList.toggle('active',!state.showOtherVowels);
      soloToggle.title=state.showOtherVowels?'Show only current vowel':'Show all vowels';
      if(state.langDraft)refreshCharts();
    });
  }

  // Chart tabs
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

  // Resizable editor pane
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

// ─── Sync coordinate form inputs from draft ───────────────────────────────────
function syncCoordsToForm(){
  if(state.vowelDraft===null)return;
  const map={veH:'h',veB:'b',veF1:'f1',veF2:'f2',veH2:'h2',veB2:'b2'};
  for(const[id,key]of Object.entries(map)){
    const el=document.getElementById(id);
    if(el) el.value=state.vowelDraft[key]??'';
  }
}

// ─── Open vowel editor ────────────────────────────────────────────────────────
function openVowelEditor(idx){
  state.vowelIdx=idx;
  state.pickingMode=null;
  const existing=(idx>=0&&state.langDraft?.vowels)?state.langDraft.vowels[idx]:null;
  state.vowelDraft=existing?clone(existing):{ipa:'',h:0.5,b:0.5,h2:null,b2:null,rounded:false,desc:'',type:'short',f1:null,f2:null,ipaAudio:'',wikiUrl:'',words:[]};
  const ve=document.getElementById('veInline');
  if(ve){ve.style.display='block';buildInlineForm();}
  const st=document.getElementById('soloToggle'); if(st) st.style.display='';
  renderVowelCards();
  refreshCharts();
}

function closeVowelEditor(){
  state.vowelIdx=null; state.vowelDraft=null; state.pickingMode=null;
  state.showOtherVowels=true;
  const st=document.getElementById('soloToggle');
  if(st){st.style.display='none';st.classList.remove('active');st.title='Show only current vowel';}
  const ve=document.getElementById('veInline');
  if(ve) ve.style.display='none';
  renderVowelCards(); refreshCharts();
}