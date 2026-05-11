// ─── Inline vowel editor form + IPA glyph picker ────────────────────────────
// ─── Inline vowel form ────────────────────────────────────────────────────────
function buildInlineForm(){
  const sec=document.getElementById('veInline');
  if(!sec||!state.vowelDraft)return;
  sec.innerHTML='';
  const v=state.vowelDraft;
  const c=state.langDraft?.color||'#7eb8f7';

  // Header
  const hdr=document.createElement('div');
  hdr.className='ve-inline-header';
  hdr.innerHTML=`<span class="ve-inline-title" id="veTitle">${state.vowelIdx<0?'New Vowel':'Edit: '+v.ipa}</span>`;
  const cancelBtn=document.createElement('button'); cancelBtn.className='btn btn-secondary btn-sm'; cancelBtn.textContent='Cancel'; cancelBtn.type='button';
  const applyBtn=document.createElement('button'); applyBtn.className='btn btn-primary btn-sm'; applyBtn.textContent='Apply'; applyBtn.type='button';
  hdr.appendChild(cancelBtn); hdr.appendChild(applyBtn);
  cancelBtn.addEventListener('click',closeVowelEditor);
  applyBtn.addEventListener('click',applyVowel);
  sec.appendChild(hdr);

  // IPA picker
  const ipaSection=document.createElement('div'); ipaSection.className='ipa-section';
  const ipaLeft=document.createElement('div'); ipaLeft.className='ipa-left';
  ipaLeft.innerHTML=`<div class="ipa-preview" id="ipaPreview" style="color:${c}">${v.ipa||'?'}</div><div class="ipa-field-wrap"><label>Symbol</label><input class="ipa-text" type="text" id="ipaInput" value="${v.ipa||''}"></div>`;
  const ipaBox=document.createElement('div'); ipaBox.className='ipa-picker-box';
  ipaBox.innerHTML=`<div class="ipa-picker-title">Click to insert</div><div class="ipa-grid" id="ipaGrid"></div><div class="ipa-mods-row" id="ipaMods"></div>`;
  ipaSection.appendChild(ipaLeft); ipaSection.appendChild(ipaBox);
  sec.appendChild(ipaSection);

  const ipaInput=sec.querySelector('#ipaInput');
  ipaInput.addEventListener('input',()=>{
    v.ipa=ipaInput.value;
    document.getElementById('ipaPreview').textContent=v.ipa||'?';
    document.getElementById('veTitle').textContent=state.vowelIdx<0?'New Vowel':'Edit: '+v.ipa;
    refreshCharts(); renderVowelCards();
  });
  buildIpaPicker(ipaBox.querySelector('#ipaGrid'),ipaBox.querySelector('#ipaMods'),ipaInput,v,c);

  // Description + rounded
  const metaRow=document.createElement('div'); metaRow.className='ve-meta';
  metaRow.innerHTML=`
    <div class="field"><label>Description</label><input type="text" class="wide" id="fDesc" value="${v.desc||''}" placeholder="Close front unrounded"></div>
    <div class="field" style="flex:0;min-width:120px">
      <label>Type</label>
      <select id="fType" style="background:var(--input);border:1px solid var(--border);border-radius:6px;color:#d8e8f4;padding:6px 8px;font-size:.82rem;outline:none;cursor:pointer">
        <option value="short"      ${(v.type||'short')==='short'      ?'selected':''}>Short</option>
        <option value="long"       ${(v.type||'short')==='long'       ?'selected':''}>Long</option>
        <option value="diphthong"  ${(v.type||'short')==='diphthong'  ?'selected':''}>Diphthong</option>
        <option value="variable"   ${(v.type||'short')==='variable'   ?'selected':''}>Variable (long/short)</option>
      </select>
    </div>
    <div class="field" style="flex:0"><label>Rounded</label><div class="rounded-row"><input type="checkbox" id="fRounded" ${v.rounded?'checked':''}><span style="font-size:.8rem">Lip rounded</span></div></div>`;
  sec.appendChild(metaRow);
  metaRow.querySelector('#fDesc').addEventListener('input',e=>{v.desc=e.target.value;renderVowelCards();});
  metaRow.querySelector('#fType').addEventListener('change',e=>{
    v.type=e.target.value;
    if(v.type!=='diphthong'){delete v.h2;delete v.b2;}
    else if(v.h2==null){v.h2=v.h;v.b2=v.b;}
    state.clickTarget='start';
    buildInlineForm(); renderVowelCards(); refreshCharts();
  });
  metaRow.querySelector('#fRounded').addEventListener('change',e=>{v.rounded=e.target.checked;refreshCharts();renderVowelCards();});

  // Coordinate inputs
  const diph=v.type==='diphthong';
  const coordsRow=document.createElement('div'); coordsRow.className='ve-coords';
  coordsRow.innerHTML=`
    <div class="field"><label>h (0=Close · 1=Open)</label><input type="number" id="veH" min="0" max="1" step="0.001" value="${v.h??0.5}"></div>
    <div class="field"><label>b (0=Front · 1=Back)</label><input type="number" id="veB" min="0" max="1" step="0.001" value="${v.b??0.5}"></div>
    <button class="btn btn-secondary btn-sm" id="pickIpa" type="button" style="align-self:flex-end">📍 Pick on IPA chart</button>
    <div class="field"><label>F1 (Hz)</label><input type="number" id="veF1" min="${F1MIN}" max="${F1MAX}" step="1" value="${v.f1||''}"></div>
    <div class="field"><label>F2 (Hz)</label><input type="number" id="veF2" min="${F2MIN}" max="${F2MAX}" step="1" value="${v.f2||''}"></div>
    <button class="btn btn-secondary btn-sm" id="pickFormant" type="button" style="align-self:flex-end">📍 Pick on formant</button>
    ${diph?`<div class="field"><label>h Target</label><input type="number" id="veH2" min="0" max="1" step="0.001" value="${v.h2??v.h??0.5}"></div>
    <div class="field"><label>b Target</label><input type="number" id="veB2" min="0" max="1" step="0.001" value="${v.b2??v.b??0.5}"></div>
    <button class="btn btn-secondary btn-sm" id="pickIpaTarget" type="button" style="align-self:flex-end">📍 Pick target on IPA chart</button>`:''}
  `;
  sec.appendChild(coordsRow);
  coordsRow.querySelector('#veH').addEventListener('input',e=>{v.h=+e.target.value;refreshCharts();});
  coordsRow.querySelector('#veB').addEventListener('input',e=>{v.b=+e.target.value;refreshCharts();});
  coordsRow.querySelector('#veF1').addEventListener('input',e=>{v.f1=+e.target.value||null;refreshCharts();});
  coordsRow.querySelector('#veF2').addEventListener('input',e=>{v.f2=+e.target.value||null;refreshCharts();});
  coordsRow.querySelector('#pickIpa').addEventListener('click',()=>{
    state.pickingMode='ipa';
    document.getElementById('tabIpa').click();
    refreshCharts();
  });
  coordsRow.querySelector('#pickFormant').addEventListener('click',()=>{
    state.pickingMode='formant';
    document.getElementById('tabForm').click();
    refreshCharts();
  });
  if(diph){
    coordsRow.querySelector('#veH2').addEventListener('input',e=>{v.h2=+e.target.value;refreshCharts();});
    coordsRow.querySelector('#veB2').addEventListener('input',e=>{v.b2=+e.target.value;refreshCharts();});
    coordsRow.querySelector('#pickIpaTarget').addEventListener('click',()=>{
      state.pickingMode='ipa-target';
      document.getElementById('tabIpa').click();
      refreshCharts();
    });
  }

  // Audio + wiki
  const urlRow=document.createElement('div'); urlRow.className='ve-meta';
  urlRow.innerHTML=`<div class="field"><label>IPA Audio URL</label><input type="url" id="fIpaAudio" value="${v.ipaAudio||''}" placeholder="https://..."></div><div class="field"><label>Wikipedia URL</label><input type="url" id="fWiki" value="${v.wikiUrl||''}" placeholder="https://en.wikipedia.org/..."></div>`;
  sec.appendChild(urlRow);
  urlRow.querySelector('#fIpaAudio').addEventListener('input',e=>v.ipaAudio=e.target.value);
  urlRow.querySelector('#fWiki').addEventListener('input',e=>v.wikiUrl=e.target.value);

  // Words
  const wordsSec=document.createElement('div');
  wordsSec.innerHTML=`<div class="divider-label" style="margin-bottom:6px">Example Words</div>`;
  const wordsList=document.createElement('div'); wordsList.className='words-list'; wordsList.id='wordsList';
  wordsSec.appendChild(wordsList);
  const addWordBtn=document.createElement('button'); addWordBtn.className='add-word-btn'; addWordBtn.type='button'; addWordBtn.textContent='+ Add word';
  addWordBtn.addEventListener('click',()=>{v.words=[...(v.words||[]),{text:'',audio:null}];renderWordRows(wordsList,v);});
  wordsSec.appendChild(addWordBtn);
  sec.appendChild(wordsSec);
  renderWordRows(wordsList,v);
}

function applyVowel(){
  if(!state.vowelDraft)return;
  if(!state.vowelDraft.ipa?.trim()){toast('IPA symbol is required');return;}
  if(!state.langDraft.vowels)state.langDraft.vowels=[];
  if(state.vowelIdx<0)state.langDraft.vowels.push(state.vowelDraft);
  else state.langDraft.vowels[state.vowelIdx]=state.vowelDraft;
  markUnsaved();
  const applied=state.vowelDraft.ipa;
  closeVowelEditor();
  updateSectionTitle();
  toast(`Vowel "${applied}" applied`);
}

function renderWordRows(container,v){
  container.innerHTML='';
  (v.words||[]).forEach((w,i)=>{
    const row=document.createElement('div'); row.className='word-row';
    row.innerHTML=`<input type="text" class="word-text" placeholder="f&lt;b&gt;ee&lt;/b&gt;t" value="${(w.text||'').replace(/"/g,'&quot;')}"><input type="url" class="word-audio" placeholder="Audio URL" value="${w.audio||''}"><button class="word-del" title="Remove">✕</button>`;
    row.querySelector('.word-text').addEventListener('input',e=>w.text=e.target.value);
    row.querySelector('.word-audio').addEventListener('input',e=>w.audio=e.target.value||null);
    row.querySelector('.word-del').addEventListener('click',()=>{v.words.splice(i,1);renderWordRows(container,v);});
    container.appendChild(row);
  });
}

// ─── IPA picker grid ──────────────────────────────────────────────────────────
function buildIpaPicker(grid,modsRow,inputEl,v,color){
  const hdr=document.createElement('div'); hdr.className='ipa-row';
  hdr.innerHTML=`<span class="ipa-row-lbl"></span><span style="font-size:.5rem;color:#3a5878;flex:1;text-align:center">Front</span><span class="ipa-sep"></span><span style="font-size:.5rem;color:#3a5878;flex:1;text-align:center">Central</span><span class="ipa-sep"></span><span style="font-size:.5rem;color:#3a5878;flex:1;text-align:center">Back</span>`;
  grid.appendChild(hdr);
  IPA_ROWS.forEach(row=>{
    const rowEl=document.createElement('div'); rowEl.className='ipa-row';
    const lbl=document.createElement('span'); lbl.className='ipa-row-lbl'; lbl.textContent=row.label;
    rowEl.appendChild(lbl);
    row.pairs.forEach((pair,pi)=>{
      if(pi>0){const sep=document.createElement('span');sep.className='ipa-sep';rowEl.appendChild(sep);}
      const cell=document.createElement('span');
      cell.style.cssText='display:flex;flex:1;justify-content:space-around';
      pair.forEach(ch=>{
        if(!ch){const sp=document.createElement('span');sp.className='ipa-ch';sp.style.cursor='default';cell.appendChild(sp);return;}
        const btn=document.createElement('span'); btn.className='ipa-ch'; btn.textContent=ch; btn.title=ch;
        btn.addEventListener('click',()=>{
          inputEl.value+=ch; v.ipa=inputEl.value;
          document.getElementById('ipaPreview').textContent=v.ipa||'?';
          document.getElementById('veTitle').textContent=(state.vowelIdx<0?'New Vowel':'Edit: ')+v.ipa;
          refreshCharts(); renderVowelCards();
        });
        cell.appendChild(btn);
      });
      rowEl.appendChild(cell);
    });
    grid.appendChild(rowEl);
  });
  IPA_MODS.forEach(mod=>{
    const btn=document.createElement('button'); btn.type='button'; btn.className='ipa-mod';
    btn.innerHTML=`${mod.ch}<small>${mod.lbl}</small>`;
    btn.addEventListener('click',()=>{
      const pos=inputEl.selectionStart??inputEl.value.length;
      inputEl.value=inputEl.value.slice(0,pos)+mod.ch+inputEl.value.slice(pos);
      v.ipa=inputEl.value;
      document.getElementById('ipaPreview').textContent=v.ipa||'?';
      refreshCharts(); renderVowelCards();
    });
    modsRow.appendChild(btn);
  });
}