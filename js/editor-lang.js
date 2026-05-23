// ─── Language list, selection, main panel, vowel editor ──────────────────────

// ─── Load languages ───────────────────────────────────────────────────────────
async function loadLanguages(){
  try{
    const idx=await fetch(`lang/index.json?t=${Date.now()}`).then(r=>r.json());
    const names=(idx.languages||[]).filter(n=>!n.startsWith('_'));
    await Promise.all(names.map(name=>
        fetch(`lang/${name}/lang.json?t=${Date.now()}`)
            .then(r=>{if(!r.ok)throw new Error(r.status);return r.json();})
            .then(async d=>{
              if(d&&d.key&&!state.langSources[d.key]){
                state.langs[d.key]=d;
                state.langSources[d.key]='builtin';
                if(!state.langOrder.includes(d.key)) state.langOrder.push(d.key);
                // Try loading samples.json for this language
                try{
                  const sData=await fetch(`lang/${name}/samples.json?t=${Date.now()}`).then(r=>r.ok?r.json():[]);
                  state.langSamples[d.key]=sData;
                }catch(e){ state.langSamples[d.key]=[]; }
              }
            })
            .catch(e=>console.warn(`Skip ${name}:`,e.message))
    ));
  }catch(e){console.error('Failed to load index',e);}
  renderLangList();
  updateSaveButtons();
}

// ─── Language tabs with drag-to-reorder, disable/enable ─────────────────────
function renderLangList(){
  const el=document.getElementById('langTabs'); if(!el)return;
  el.innerHTML='';
  for(const key of Object.keys(state.langs)) if(!state.langOrder.includes(key)) state.langOrder.push(key);
  let dragSrcKey=null;

  for(const key of state.langOrder){
    const lang=state.langs[key]; if(!lang) continue;
    const src=state.langSources[key]||'builtin';
    const isActive=state.selKey===key;
    const isDisabled=state.langDisabled.has(key);

    const wrap=document.createElement('div');
    wrap.className='lang-tab-wrap'+(isDisabled?' tab-disabled':''); wrap.draggable=true;

    const btn=document.createElement('button');
    btn.type='button'; btn.className='lang-tab'+(isActive?' active':'')+(isDisabled?' disabled':'');
    if(src==='builtin') btn.classList.add('builtin');
    btn.style.borderColor=isActive&&!isDisabled?lang.color:'';
    btn.style.color=isActive&&!isDisabled?lang.color:'';
    btn.textContent=(lang.label||key)+(isDisabled?' (off)':'');
    btn.title=isDisabled?'Disabled — excluded from index.json. Use ↩ to re-enable.'
        :src==='builtin'?'Built-in — editable, use Save As to export':'';
    btn.addEventListener('click',()=>selectLang(key));

    if(isDisabled){
      // ↩ Re-enable button — always visible when disabled
      const enBtn=document.createElement('button');
      enBtn.type='button'; enBtn.className='lang-tab-enable'; enBtn.textContent='↩'; enBtn.title='Re-enable (add back to index.json)';
      enBtn.addEventListener('click',e=>{e.stopPropagation();enableLang(key);});
      // 🗑 Delete button — always visible when disabled
      const delBtn=document.createElement('button');
      const canDeleteFromDisk=src==='folder'&&!!state.dirHandle;
      delBtn.type='button'; delBtn.className='lang-tab-del'; delBtn.textContent='🗑';
      delBtn.title=canDeleteFromDisk?'Delete from folder permanently':'Remove from editor (not on disk)';
      delBtn.addEventListener('click',async e=>{
        e.stopPropagation();
        const label=lang.label||key;
        const msg=canDeleteFromDisk
            ?`Permanently delete "${label}" from folder? This cannot be undone.`
            :`Remove "${label}" from editor? (No folder connected — nothing deleted from disk.)`;
        if(!confirm(msg))return;
        if(canDeleteFromDisk) await deleteLangFromFolder(key);
        delete state.langs[key]; delete state.langSources[key];
        const oi=state.langOrder.indexOf(key); if(oi!==-1)state.langOrder.splice(oi,1);
        state.langDisabled.delete(key);
        if(state.selKey===key){state.selKey=null;state.langDraft=null;state.vowelIdx=null;state.vowelDraft=null;}
        renderLangList(); renderEditorAll(); markUnsaved();
      });
      wrap.appendChild(btn); wrap.appendChild(enBtn); wrap.appendChild(delBtn);
    }else{
      const disBtn=document.createElement('button');
      disBtn.type='button'; disBtn.className='lang-tab-del'; disBtn.textContent='×'; disBtn.title='Disable (exclude from index.json)';
      disBtn.addEventListener('click',e=>{e.stopPropagation();disableLang(key);});
      const delBtn2=document.createElement('button');
      const canDel=src==='folder'&&!!state.dirHandle;
      delBtn2.type='button'; delBtn2.className='lang-tab-del'; delBtn2.textContent='🗑';
      delBtn2.title=canDel?'Delete from folder permanently':'Remove from editor';
      delBtn2.addEventListener('click',async e=>{
        e.stopPropagation();
        const label=lang.label||key;
        if(!confirm(canDel?`Permanently delete "${label}" from folder?`:`Remove "${label}" from editor?`))return;
        if(canDel) await deleteLangFromFolder(key);
        delete state.langs[key]; delete state.langSources[key];
        const oi=state.langOrder.indexOf(key); if(oi!==-1)state.langOrder.splice(oi,1);
        state.langDisabled.delete(key);
        if(state.selKey===key){state.selKey=null;state.langDraft=null;state.vowelIdx=null;state.vowelDraft=null;}
        renderLangList(); renderEditorAll(); markUnsaved();
      });
      wrap.appendChild(btn); wrap.appendChild(disBtn); wrap.appendChild(delBtn2);
    }

    wrap.addEventListener('dragstart',e=>{dragSrcKey=key;wrap.classList.add('dragging');e.dataTransfer.effectAllowed='move';});
    wrap.addEventListener('dragend',()=>{wrap.classList.remove('dragging');el.querySelectorAll('.lang-tab-wrap').forEach(t=>t.classList.remove('drag-over'));});
    wrap.addEventListener('dragover',e=>{e.preventDefault();e.dataTransfer.dropEffect='move';el.querySelectorAll('.lang-tab-wrap').forEach(t=>t.classList.remove('drag-over'));if(key!==dragSrcKey)wrap.classList.add('drag-over');});
    wrap.addEventListener('drop',e=>{
      e.preventDefault(); if(!dragSrcKey||dragSrcKey===key)return;
      const from=state.langOrder.indexOf(dragSrcKey),to=state.langOrder.indexOf(key);
      if(from!==-1&&to!==-1){state.langOrder.splice(from,1);state.langOrder.splice(to,0,dragSrcKey);}
      renderLangList();
    });
    el.appendChild(wrap);
  }
}

// ─── Disable / enable language ────────────────────────────────────────────────
function disableLang(key){
  state.langDisabled.add(key);
  markUnsaved(); renderLangList(); renderEditorAll();
}
function enableLang(key){
  state.langDisabled.delete(key);
  markUnsaved(); renderLangList(); renderEditorAll();
}

function selectLang(key){
  if(state.unsaved&&!confirm('Discard unsaved changes?'))return;
  state.selKey=key; state.langDraft=clone(state.langs[key]);
  state.unsaved=false;
  state.vowelIdx=null; state.vowelDraft=null; state.pickingMode=null;
  state.sampleIdx=null; state.sampleDraft=null; state.samplesTab=false;
  state.samplesDraft=clone(state.langSamples[key]||[]);
  if(typeof setLangSamples==='function') setLangSamples(key, state.samplesDraft);
  renderLangList();
  showLangPanel();
  updateSaveButtons();
}

// ─── Show/populate the lang panel (runs once per language selection) ──────────
function showLangPanel(){
  if(!state.langDraft) return;

  // Lang meta form
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

  updateSaveButtons();

  // Content section (vowels + samples tabs)
  const cs=document.getElementById('contentSection');
  if(cs) cs.style.display='block';
  // Restore correct tab
  if(state.samplesTab) switchToSamplesTab(); else switchToVowelsTab();

  refreshCharts();
  renderVowelCards();
  if(state.vowelIdx!==null) buildInlineForm();
  updateSectionTitle();
}

// renderMain kept for compatibility — just calls showLangPanel
function renderMain(){ showLangPanel(); }

// ─── Save button visibility ───────────────────────────────────────────────────
function updateSaveButtons(){
  const folderConnected=!!state.dirHandle;
  const hasLangs=Object.keys(state.langs).length > 0;
  // Save: only when a folder is connected (saves everything to it)
  const saveBtn=document.getElementById('saveLangBtn');
  if(saveBtn) saveBtn.style.display=folderConnected?'inline-flex':'none';
  // Save As: whenever there's anything to save (no folder needed)
  const saveAsBtn=document.getElementById('saveAsLangBtn');
  if(saveAsBtn) saveAsBtn.style.display=hasLangs?'inline-flex':'none';
}

// ─── One-time UI wiring (called from init) ────────────────────────────────────
function initEditorUI(){
  // Lang meta inputs
  const fKey=document.getElementById('fKey');
  const fLabel=document.getElementById('fLabel');
  const fColor=document.getElementById('fColor');
  if(fKey) fKey.addEventListener('input',e=>{
    if(!state.langDraft)return;
    const raw=e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g,'-');
    e.target.value=raw;
    const oldKey=state.selKey; const newKey=raw;
    if(!newKey||newKey===oldKey){state.langDraft.key=newKey||oldKey;return;}
    // Rename in all state maps
    state.langDraft.key=newKey;
    state.langs[newKey]={...clone(state.langDraft),key:newKey};
    delete state.langs[oldKey];
    state.langSources[newKey]=state.langSources[oldKey]||'new'; delete state.langSources[oldKey];
    const oi=state.langOrder.indexOf(oldKey); if(oi!==-1)state.langOrder[oi]=newKey;
    if(state.langDisabled.has(oldKey)){state.langDisabled.delete(oldKey);state.langDisabled.add(newKey);}
    state.selKey=newKey;
    markUnsaved(); renderLangList();
  });
  if(fLabel) fLabel.addEventListener('input',e=>{if(state.langDraft){state.langDraft.label=e.target.value;markUnsaved();renderLangList();}});
  if(fColor) fColor.addEventListener('input',e=>{if(state.langDraft){state.langDraft.color=e.target.value;markUnsaved();renderLangList();}});

  // Save / Save As buttons
  const saveBtn=document.getElementById('saveLangBtn');
  if(saveBtn) saveBtn.addEventListener('click',saveLang);
  const saveAsBtn=document.getElementById('saveAsLangBtn');
  if(saveAsBtn) saveAsBtn.addEventListener('click',saveAsLang);

  // Vowels / Samples tabs
  document.getElementById('tabVowelsList')?.addEventListener('click',()=>switchToVowelsTab());
  document.getElementById('tabSamplesList')?.addEventListener('click',()=>switchToSamplesTab());

  // Add vowel button
  const addBtn=document.getElementById('addVowelBtn');
  if(addBtn) addBtn.addEventListener('click',()=>openVowelEditor(-1));

  // Add sample button
  document.getElementById('addSampleBtn')?.addEventListener('click',()=>{
    switchToSamplesTab(); openSampleEditor(-1);
  });

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
  if(typeof closeSampleEditor==='function') closeSampleEditor();
  state.vowelIdx=idx;
  state.pickingMode=null;
  const existing=(idx>=0&&state.langDraft?.vowels)?state.langDraft.vowels[idx]:null;
  state.vowelDraft=existing?clone(existing):{symbols:[''],heightBackness:[0.5,0.5],rounded:false,desc:'',type:'short',f1:null,f2:null,audio:null,wikiUrl:'',target:null};
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
  if(typeof updatePaneHint==='function') updatePaneHint();
  renderVowelCards(); refreshCharts();
}