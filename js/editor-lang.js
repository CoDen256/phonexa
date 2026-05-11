// ─── Language list, selection, main panel render, vowel editor open/close ─────
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

// ─── Language list ────────────────────────────────────────────────────────────
function renderLangList(){
  const el=document.getElementById('langList');
  el.innerHTML='';
  for(const[key,lang]of Object.entries(state.langs)){
    const item=document.createElement('div');
    item.className='lang-item'+(state.selKey===key?' active':'');
    item.innerHTML=`<span class="lang-dot" style="background:${lang.color}"></span><span class="lang-item-name">${lang.label||key}</span><span class="lang-item-key">${key}</span>`;
    item.addEventListener('click',()=>selectLang(key));
    el.appendChild(item);
  }
}

function selectLang(key){
  if(state.unsaved&&!confirm('Discard unsaved changes?'))return;
  state.selKey=key; state.langDraft=clone(state.langs[key]);
  state.unsaved=false; state.vowelIdx=null; state.vowelDraft=null;
  renderLangList(); renderMain();
}

// ─── Render main panel ────────────────────────────────────────────────────────
function renderMain(){
  const panel=document.getElementById('mainPanel');
  const ph=document.getElementById('placeholder');
  if(!state.langDraft){ph.style.display='flex';return;}
  ph.style.display='none';
  [...panel.children].forEach(c=>{if(c!==ph)c.remove();});

  // ── Language metadata form ──
  const form=document.createElement('div');
  form.className='lang-form';
  form.innerHTML=`
    <div class="form-row">
      <div class="field"><label>Key</label><input type="text" id="fKey" value="${state.langDraft.key||''}" style="width:80px"></div>
      <div class="field"><label>Label</label><input type="text" id="fLabel" value="${state.langDraft.label||''}" style="width:140px"></div>
      <div class="field"><label>Color</label><input type="color" id="fColor" value="${state.langDraft.color||'#7eb8f7'}"></div>
    </div>
    <div class="lang-form-actions">
      <button class="btn btn-primary" id="saveLangBtn" type="button">💾 Save</button>
      <span class="unsaved-note" id="unsavedNote" style="display:none">● unsaved</span>
    </div>`;
  panel.appendChild(form);
  ['fKey','fLabel','fColor'].forEach(id=>{
    document.getElementById(id).addEventListener('input',e=>{
      const map={fKey:'key',fLabel:'label',fColor:'color'};
      state.langDraft[map[id]]=e.target.value; markUnsaved();
    });
  });
  document.getElementById('saveLangBtn').addEventListener('click',saveLang);

  // ── Chart section with tabs ──
  const cs=document.createElement('div');
  cs.className='chart-section';
  cs.innerHTML=`
    <div class="chart-top-bar">
      <div class="chart-tabs">
        <button class="chart-tab${state.chartTab==='ipa'?' active':''}" id="tabIpa" type="button">IPA Chart</button>
        <button class="chart-tab${state.chartTab==='form'?' active':''}" id="tabForm" type="button">Formant Plot</button>
      </div>
    </div>
    <div class="chart-tab-panel${state.chartTab==='ipa'?' active':''}" id="panelIpa">
      <div class="chart-wrap"><svg class="chart-svg" id="langIpaSvg" viewBox="0 0 700 420"></svg></div>
    </div>
    <div class="chart-tab-panel${state.chartTab==='form'?' active':''}" id="panelForm">
      <div class="chart-wrap"><svg class="chart-svg" id="langFormSvg" viewBox="0 0 700 420"></svg></div>
    </div>
    <p class="chart-hint" id="chartHint">${state.vowelIdx!==null?'Click chart to reposition vowel':'Click a vowel to edit it'}</p>`;
  panel.appendChild(cs);

  document.getElementById('tabIpa').addEventListener('click',()=>{state.chartTab='ipa';document.getElementById('tabIpa').classList.add('active');document.getElementById('tabForm').classList.remove('active');document.getElementById('panelIpa').classList.add('active');document.getElementById('panelForm').classList.remove('active');});
  document.getElementById('tabForm').addEventListener('click',()=>{state.chartTab='form';document.getElementById('tabForm').classList.add('active');document.getElementById('tabIpa').classList.remove('active');document.getElementById('panelForm').classList.add('active');document.getElementById('panelIpa').classList.remove('active');});

  // Chart click handlers — position a vowel being edited
  function onIpaClick(clientX,clientY){
    if(state.vowelIdx===null)return;
    const svg=document.getElementById('langIpaSvg');
    const pt=svgPt(svg,clientX,clientY);
    const {h,b}=ltHB(pt.x,pt.y);
    const diph=state.vowelDraft.type==='diphthong';
    if(diph && state.clickTarget==='target'){
      state.vowelDraft.h2=h; state.vowelDraft.b2=b;
      state.clickTarget='start';
    } else {
      state.vowelDraft.h=h; state.vowelDraft.b=b;
      if(diph) state.clickTarget='target';
    }
    syncCoordsToForm(); refreshCharts();
    // Update the toggle label if visible
    const lbl=document.getElementById('clickTargetLabel');
    if(lbl) lbl.textContent=state.clickTarget==='target'?'Target':'Start';
  }
  function onFormClick(clientX,clientY){
    if(state.vowelIdx===null)return;
    const svg=document.getElementById('langFormSvg');
    const pt=svgPt(svg,clientX,clientY);
    const {f1,f2}=lfF1F2(pt.x,pt.y);
    state.vowelDraft.f1=f1; state.vowelDraft.f2=f2;
    syncCoordsToForm(); refreshCharts();
  }
  ['langIpaSvg'].forEach(id=>{
    const s=document.getElementById(id);
    let drag=false;
    s.addEventListener('mousedown',e=>{drag=true;onIpaClick(e.clientX,e.clientY);});
    s.addEventListener('mouseup',()=>drag=false);
    s.addEventListener('mousemove',e=>{if(drag)onIpaClick(e.clientX,e.clientY);});
    s.addEventListener('click',e=>onIpaClick(e.clientX,e.clientY));
  });
  ['langFormSvg'].forEach(id=>{
    const s=document.getElementById(id);
    let drag=false;
    s.addEventListener('mousedown',e=>{drag=true;onFormClick(e.clientX,e.clientY);});
    s.addEventListener('mouseup',()=>drag=false);
    s.addEventListener('mousemove',e=>{if(drag)onFormClick(e.clientX,e.clientY);});
    s.addEventListener('click',e=>onFormClick(e.clientX,e.clientY));
  });

  // ── Inline vowel editor (always in DOM, shown/hidden) ──
  const veSection=document.createElement('div');
  veSection.id='veInline';
  veSection.className='ve-inline';
  veSection.style.display=state.vowelIdx!==null?'block':'none';
  panel.appendChild(veSection);

  // ── Vowel cards ──
  const vs=document.createElement('div');
  vs.className='vowel-section';
  vs.innerHTML=`<div class="section-head"><span class="section-title" id="sectionTitle">Vowels (${(state.langDraft.vowels||[]).length})</span><button class="btn btn-secondary btn-sm" id="addVowelBtn" type="button">+ Add Vowel</button></div><div class="vowel-cards" id="vowelCards"></div>`;
  panel.appendChild(vs);
  document.getElementById('addVowelBtn').addEventListener('click',()=>openVowelEditor(-1));

  refreshCharts();
  renderVowelCards();
  if(state.vowelIdx!==null) buildInlineForm();
}

// ─── Refresh charts (called on any draft change) ───────────────────────────────
function refreshCharts(){
  renderLangIpa();
  renderLangFormant();
  const hint=document.getElementById('chartHint');
  if(hint){
    if(state.vowelIdx!==null && state.vowelDraft?.type==='diphthong'){
      hint.textContent=`Click chart to set ${state.clickTarget==='target'?'TARGET (end)':'START (begin)'} position`;
    } else {
      hint.textContent=state.vowelIdx!==null?'Click chart to reposition vowel':'Click a vowel to edit it';
    }
  }
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
  const existing=(idx>=0&&state.langDraft.vowels)?state.langDraft.vowels[idx]:null;
  state.vowelDraft=existing?clone(existing):{ipa:'',h:0.5,b:0.5,h2:null,b2:null,rounded:false,desc:'',type:'short',f1:null,f2:null,ipaAudio:'',wikiUrl:'',words:[]};
  const veSection=document.getElementById('veInline');
  if(veSection){veSection.style.display='block';buildInlineForm();}
  renderVowelCards();
  refreshCharts();
}

function closeVowelEditor(){
  state.vowelIdx=null; state.vowelDraft=null;
  const veSection=document.getElementById('veInline');
  if(veSection)veSection.style.display='none';
  renderVowelCards(); refreshCharts();
}