// ─── Inline vowel editor form + IPA glyph picker ─────────────────────────────
// Updated: new section layout, target formant section, alt symbols, fixed bugs.
// Words/samples removed (now in samples.json).

// ─── Section divider helper ───────────────────────────────────────────────────
function makeDividerLabel(text) {
  const d = document.createElement('div');
  d.className = 'divider-label';
  d.style.cssText = 'margin-top:10px;margin-bottom:4px';
  d.textContent = text;
  return d;
}

// ─── Build inline form ────────────────────────────────────────────────────────
function buildInlineForm() {
  const sec = document.getElementById('veInline');
  if (!sec || !state.vowelDraft) return;
  sec.innerHTML = '';
  const v = state.vowelDraft;
  const c = state.langDraft?.color || '#7eb8f7';
  const sym = v.symbols?.[0] || '';
  const diph = v.type === 'diphthong';

  // ── Header ─────────────────────────────────────────────────────────────────
  const hdr = document.createElement('div'); hdr.className = 've-inline-header';
  hdr.innerHTML = `<span class="ve-inline-title" id="veTitle">${state.vowelIdx < 0 ? 'New Vowel' : 'Edit: ' + (sym || '?')}</span>`;
  const cancelBtn = document.createElement('button'); cancelBtn.className = 'btn btn-secondary btn-sm'; cancelBtn.textContent = 'Cancel'; cancelBtn.type = 'button';
  const applyBtn  = document.createElement('button'); applyBtn.className  = 'btn btn-primary btn-sm';   applyBtn.textContent = 'Apply';  applyBtn.type = 'button';
  hdr.appendChild(cancelBtn); hdr.appendChild(applyBtn);
  cancelBtn.addEventListener('click', closeVowelEditor);
  applyBtn.addEventListener('click', applyVowel);
  sec.appendChild(hdr);

  // ── IPA symbol section: big preview left-top, alt chips below ──────────────
  const ipaSection = document.createElement('div'); ipaSection.className = 'ipa-section';
  const ipaLeft    = document.createElement('div'); ipaLeft.className    = 'ipa-left';

  // Big clickable preview — main symbol
  const ipaPreview = document.createElement('div');
  ipaPreview.className = 'ipa-preview'; ipaPreview.id = 'ipaPreview'; ipaPreview.style.color = c;
  ipaPreview.style.cursor = 'pointer'; ipaPreview.title = 'Click to edit symbol';
  ipaPreview.textContent = sym || '?';
  const editHint = document.createElement('div');
  editHint.style.cssText = 'font-size:.58rem;color:var(--muted);text-align:center;cursor:pointer;margin-top:1px';
  editHint.textContent = '✎ click to edit';
  ipaLeft.appendChild(ipaPreview);
  ipaLeft.appendChild(editHint);

  // Alt notations below the preview
  const altLabel = document.createElement('div');
  altLabel.style.cssText = 'font-size:.6rem;color:var(--muted);margin-top:6px;margin-bottom:3px;text-transform:uppercase;letter-spacing:.04em';
  altLabel.textContent = 'Alt. notations';
  ipaLeft.appendChild(altLabel);
  const altChipsWrap = document.createElement('div'); altChipsWrap.id = 'altChipsWrap';
  altChipsWrap.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;align-items:center';
  ipaLeft.appendChild(altChipsWrap);

  const renderAltChips = () => {
    altChipsWrap.innerHTML = '';
    (v.symbols?.slice(1)||[]).forEach((altSym, ai) => {
      const chip = document.createElement('span');
      chip.style.cssText = `font-family:Georgia,serif;font-size:1rem;padding:3px 10px;background:var(--input);border:1px solid var(--border);border-radius:5px;cursor:pointer;color:${c};transition:border-color .12s`;
      chip.textContent = altSym; chip.title = 'Click to edit · leave empty to remove';
      chip.addEventListener('mouseenter', ()=>chip.style.borderColor=c);
      chip.addEventListener('mouseleave', ()=>chip.style.borderColor='');
      chip.addEventListener('click', () => openIPAPickerPopup(altSym, newSym => {
        if (newSym) v.symbols[ai+1] = newSym; else v.symbols.splice(ai+1,1);
        renderAltChips(); refreshCharts(); renderVowelCards();
      }));
      altChipsWrap.appendChild(chip);
    });
    const addAlt = document.createElement('button');
    addAlt.type = 'button'; addAlt.className = 'btn btn-secondary btn-sm';
    addAlt.textContent = '+ Alt'; addAlt.style.cssText = 'font-size:.65rem;padding:3px 8px';
    addAlt.addEventListener('click', () => openIPAPickerPopup('', newSym => {
      if (!newSym) return;
      v.symbols = [...(v.symbols||[sym]), newSym];
      renderAltChips(); refreshCharts(); renderVowelCards();
    }));
    altChipsWrap.appendChild(addAlt);
  };
  renderAltChips();

  ipaSection.appendChild(ipaLeft);
  sec.appendChild(ipaSection);

  // Wire — click preview or hint opens IPA picker popup
  const openMainEdit = () => openIPAPickerPopup(v.symbols?.[0]||'', newSym => {
    if (!newSym) return;
    v.symbols = [newSym, ...(v.symbols?.slice(1)||[])];
    ipaPreview.textContent = newSym;
    document.getElementById('veTitle').textContent = (state.vowelIdx<0?'New Vowel':'Edit: ')+newSym;
    refreshCharts(); renderVowelCards();
  });
  ipaPreview.addEventListener('click', openMainEdit);
  editHint.addEventListener('click', openMainEdit);

  // ── Description · Type · Rounded ───────────────────────────────────────────
  const metaRow = document.createElement('div'); metaRow.className = 've-meta';
  metaRow.innerHTML = `
    <div class="field"><label>Description</label><input type="text" class="wide" id="fDesc" value="${v.desc || ''}" placeholder="Close front unrounded"></div>
    <div class="field" style="flex:0;min-width:120px">
      <label>Type</label>
      <select id="fType" style="background:var(--input);border:1px solid var(--border);border-radius:6px;color:#d8e8f4;padding:6px 8px;font-size:.82rem;outline:none;cursor:pointer">
        <option value="short"    ${v.type === 'short'     ? 'selected' : ''}>Short</option>
        <option value="long"     ${v.type === 'long'      ? 'selected' : ''}>Long</option>
        <option value="diphthong"${v.type === 'diphthong' ? 'selected' : ''}>Diphthong</option>
        <option value="variable" ${v.type === 'variable'  ? 'selected' : ''}>Variable</option>
      </select>
    </div>
    <div class="field" style="flex:0;min-width:100px">
      <label>Rounded</label>
      <div class="rounded-row">
        <input type="checkbox" id="fRounded" ${v.rounded ? 'checked' : ''}>
        <span style="font-size:.8rem;white-space:nowrap">Lip rounded</span>
      </div>
    </div>`;
  sec.appendChild(metaRow);
  metaRow.querySelector('#fDesc').addEventListener('input', e => { v.desc = e.target.value; renderVowelCards(); });
  metaRow.querySelector('#fType').addEventListener('change', e => {
    v.type = e.target.value;
    if (v.type !== 'diphthong') { v.target = null; }
    else if (!v.target) { v.target = {heightBackness: [...(v.heightBackness || [0.5, 0.5])], rounded: v.rounded, f1: null, f2: null}; }
    buildInlineForm(); renderVowelCards(); refreshCharts();
  });
  metaRow.querySelector('#fRounded').addEventListener('change', e => { v.rounded = e.target.checked; refreshCharts(); renderVowelCards(); });

  // ── Source vowel section ────────────────────────────────────────────────────
  const hb = v.heightBackness || [0.5, 0.5];
  sec.appendChild(makeDividerLabel(diph ? 'Source vowel' : 'Position'));

  const srcRow = document.createElement('div');
  srcRow.innerHTML = `
    <div style="display:flex;gap:6px;align-items:flex-end;margin-bottom:6px">
      <div class="field" style="flex:1;min-width:0"><label>Height <span style="font-size:.55rem;opacity:.45">0=Close · 1=Open</span></label><input type="number" id="veH" min="0" max="1" step="0.001" value="${hb[0]}"></div>
      <button class="btn btn-secondary btn-sm" id="pickIpa" type="button" style="flex:1;min-width:0;align-self:flex-end">📍 IPA</button>
      <div class="field" style="flex:1;min-width:0"><label>Backness <span style="font-size:.55rem;opacity:.45">0=Front · 1=Back</span></label><input type="number" id="veB" min="0" max="1" step="0.001" value="${hb[1]}"></div>
    </div>
    <div style="display:flex;gap:6px;align-items:flex-end">
      <div class="field" style="flex:1;min-width:0"><label>F1 (Hz)</label><input type="number" id="veF1" min="${F1MIN}" max="${F1MAX}" step="1" value="${v.f1 || ''}"></div>
      <button class="btn btn-secondary btn-sm" id="pickFormant" type="button" style="flex:1;min-width:0;align-self:flex-end">📍 Formant</button>
      <div class="field" style="flex:1;min-width:0"><label>F2 (Hz)</label><input type="number" id="veF2" min="${F2MIN}" max="${F2MAX}" step="1" value="${v.f2 || ''}"></div>
    </div>`;
  sec.appendChild(srcRow);

  srcRow.querySelector('#veH').addEventListener('input', e => { v.heightBackness = [+e.target.value, v.heightBackness?.[1] ?? 0.5]; refreshCharts(); });
  srcRow.querySelector('#veB').addEventListener('input', e => { v.heightBackness = [v.heightBackness?.[0] ?? 0.5, +e.target.value]; refreshCharts(); });
  srcRow.querySelector('#veF1').addEventListener('input', e => { v.f1 = +e.target.value || null; refreshCharts(); renderVowelCards(); });
  srcRow.querySelector('#veF2').addEventListener('input', e => { v.f2 = +e.target.value || null; refreshCharts(); renderVowelCards(); });
  srcRow.querySelector('#pickIpa').addEventListener('click', () => { state.pickingMode = 'ipa'; document.getElementById('tabIpa').click(); refreshCharts(); });
  srcRow.querySelector('#pickFormant').addEventListener('click', () => { state.pickingMode = 'formant'; document.getElementById('tabFormant').click(); refreshCharts(); });

  // ── Target vowel section (diphthongs only) ──────────────────────────────────
  if (diph) {
    const thb = v.target?.heightBackness || [hb[0], hb[1]];
    sec.appendChild(makeDividerLabel('Target vowel'));

    const tgtRow = document.createElement('div');
    tgtRow.innerHTML = `
      <div style="display:flex;gap:6px;align-items:flex-end;margin-bottom:6px">
        <div class="field" style="flex:1;min-width:0"><label>Height</label><input type="number" id="veH2" min="0" max="1" step="0.001" value="${thb[0]}"></div>
        <button class="btn btn-secondary btn-sm" id="pickIpaTarget" type="button" style="flex:1;min-width:0;align-self:flex-end">📍 IPA</button>
        <div class="field" style="flex:1;min-width:0"><label>Backness</label><input type="number" id="veB2" min="0" max="1" step="0.001" value="${thb[1]}"></div>
      </div>
      <div style="display:flex;gap:6px;align-items:flex-end">
        <div class="field" style="flex:1;min-width:0"><label>F1 (Hz)</label><input type="number" id="veTF1" min="${F1MIN}" max="${F1MAX}" step="1" value="${v.target?.f1 || ''}"></div>
        <button class="btn btn-secondary btn-sm" id="pickTargetFormant" type="button" style="flex:1;min-width:0;align-self:flex-end">📍 Formant</button>
        <div class="field" style="flex:1;min-width:0"><label>F2 (Hz)</label><input type="number" id="veTF2" min="${F2MIN}" max="${F2MAX}" step="1" value="${v.target?.f2 || ''}"></div>
      </div>
      <div style="display:flex;justify-content:flex-end;margin-top:6px">
        <div class="rounded-row" style="gap:6px">
          <input type="checkbox" id="fTargetRounded" ${v.target?.rounded ? 'checked' : ''}>
          <span style="font-size:.8rem;color:var(--muted)">Target lip rounded</span>
        </div>
      </div>`;
    sec.appendChild(tgtRow);

    tgtRow.querySelector('#veH2').addEventListener('input', e => {
      if (!v.target) v.target = {heightBackness:[0.5,0.5],rounded:false,f1:null,f2:null};
      v.target.heightBackness = [+e.target.value, v.target.heightBackness?.[1] ?? 0.5]; refreshCharts();
    });
    tgtRow.querySelector('#veB2').addEventListener('input', e => {
      if (!v.target) v.target = {heightBackness:[0.5,0.5],rounded:false,f1:null,f2:null};
      v.target.heightBackness = [v.target.heightBackness?.[0] ?? 0.5, +e.target.value]; refreshCharts();
    });
    tgtRow.querySelector('#veTF1').addEventListener('input', e => {
      if (!v.target) v.target = {heightBackness:[...(v.heightBackness||[0.5,0.5])],rounded:false,f1:null,f2:null};
      v.target.f1 = +e.target.value || null; renderVowelCards();
    });
    tgtRow.querySelector('#veTF2').addEventListener('input', e => {
      if (!v.target) v.target = {heightBackness:[...(v.heightBackness||[0.5,0.5])],rounded:false,f1:null,f2:null};
      v.target.f2 = +e.target.value || null; renderVowelCards();
    });
    tgtRow.querySelector('#fTargetRounded').addEventListener('change', e => {
      if (!v.target) v.target = {heightBackness:[...(v.heightBackness||[0.5,0.5])],rounded:false,f1:null,f2:null};
      v.target.rounded = e.target.checked; renderVowelCards(); refreshCharts();
    });
    tgtRow.querySelector('#pickIpaTarget').addEventListener('click', () => { state.pickingMode = 'ipa-target'; document.getElementById('tabIpa').click(); refreshCharts(); });
    tgtRow.querySelector('#pickTargetFormant').addEventListener('click', () => { state.pickingMode = 'formant-target'; document.getElementById('tabFormant').click(); refreshCharts(); });
  }

  // ── Audio + wiki ────────────────────────────────────────────────────────────
  const urlRow = document.createElement('div'); urlRow.className = 've-meta';
  urlRow.innerHTML = `
    <div class="field"><label>Audio URL <span style="font-weight:400;opacity:.55;font-size:.55rem">(average sound · synthesized from F1/F2 if absent)</span></label><input type="url" id="fAudio" value="${v.audio || ''}" placeholder="https://… or lang/…/audio/…"></div>
    <div class="field"><label>Wikipedia URL</label><input type="url" id="fWiki" value="${v.wikiUrl || ''}" placeholder="https://en.wikipedia.org/…"></div>`;
  sec.appendChild(urlRow);
  urlRow.querySelector('#fAudio').addEventListener('input', e => { v.audio = e.target.value || null; });
  urlRow.querySelector('#fWiki').addEventListener('input',  e => { v.wikiUrl = e.target.value; });

  // ── Linked samples strip ──────────────────────────────────────────────────
  const linked = (state.samplesDraft || []).filter(s =>
      s.tokens?.some(t => v.symbols?.includes(t.symbol))
  );
  const c2 = state.langDraft?.color || '#7eb8f7';
  sec.appendChild(makeDividerLabel(`Samples (${linked.length})`));
  const strip = document.createElement('div'); strip.style.cssText = 'display:flex;flex-direction:column;gap:3px';
  if (linked.length === 0) {
    const hint = document.createElement('div'); hint.style.cssText = 'font-size:.65rem;color:#3a5878';
    hint.textContent = 'No samples linked to this vowel yet.'; strip.appendChild(hint);
  } else {
    linked.slice(0, 6).forEach(smp => {
      const row = document.createElement('div'); row.style.cssText = 'font-size:.72rem;color:#8fa8c0;cursor:pointer;padding:2px 4px;border-radius:4px;display:flex;justify-content:space-between;transition:background .1s';
      const myToks = smp.tokens.filter(t => v.symbols?.includes(t.symbol));
      const okToks = myToks.filter(t => t.analysis?.f1).length;
      row.innerHTML = `<span><span style='font-family:Georgia,serif'>${smp.text||'?'}</span>${smp.phonemic?` <span style='opacity:.5;font-style:italic'>${smp.phonemic}</span>`:''}</span><span style='font-size:.6rem;color:#4a6888'>${okToks}/${myToks.length} ⚡</span>`;
      row.addEventListener('mouseenter', () => row.style.background='#1a2e44');
      row.addEventListener('mouseleave', () => row.style.background='');
      row.addEventListener('click', () => {
        const idx = state.samplesDraft.indexOf(smp);
        if (idx >= 0) openSampleInVowelEditor(idx);
      });
      strip.appendChild(row);
    });
    if (linked.length > 6) { const more = document.createElement('div'); more.style.cssText = 'font-size:.6rem;color:#3a5878'; more.textContent = `+${linked.length-6} more`; strip.appendChild(more); }
  }
  // Add sample for this vowel
  const addSmpBtn = document.createElement('button'); addSmpBtn.className='btn btn-secondary btn-sm'; addSmpBtn.type='button'; addSmpBtn.style.marginTop='4px';
  addSmpBtn.textContent = '+ Add sample for /' + (v.symbols?.[0]||'?') + '/';
  addSmpBtn.addEventListener('click', () => {
    state.samplesDraft = state.samplesDraft || [];
    openSampleInVowelEditor(-1);
    if (state.sampleDraft) { state.sampleDraft.tokens = [{symbol:v.symbols?.[0]||'', position:[0,0], analysis:null}]; buildSampleForm(document.getElementById('seVowelInline'), true); }
  });
  strip.appendChild(addSmpBtn);
  sec.appendChild(strip);

  // Container for inline sample editing (within vowel form)
  let sv = document.getElementById('seVowelInline');
  if (!sv) {
    sv = document.createElement('div'); sv.id = 'seVowelInline';
    sv.style.cssText = 'display:none;border-top:1px solid var(--border);margin-top:8px;padding-top:8px';
    sec.appendChild(sv);
  }
}

// ─── Apply vowel to draft ─────────────────────────────────────────────────────
function applyVowel() {
  if (!state.vowelDraft) return;
  if (!state.vowelDraft.symbols?.[0]?.trim()) { toast('IPA symbol is required'); return; }
  if (!state.langDraft.vowels) state.langDraft.vowels = [];
  if (state.vowelIdx < 0) state.langDraft.vowels.push(state.vowelDraft);
  else state.langDraft.vowels[state.vowelIdx] = state.vowelDraft;
  markUnsaved();
  const applied = state.vowelDraft.symbols[0];
  closeVowelEditor();
  updateSectionTitle();
  toast(`Vowel "${applied}" applied`);
}


// ─── IPA symbol picker popup ──────────────────────────────────────────────────
// onApply(selectedText): called when user clicks Apply
function openIPAPickerPopup(initialVal, onApply) {
  document.getElementById('ipaPickerBackdrop')?.remove();
  let current = initialVal || '';
  const c = state.langDraft?.color || '#7eb8f7';

  const backdrop = document.createElement('div'); backdrop.id = 'ipaPickerBackdrop';
  backdrop.style.cssText = 'position:fixed;inset:0;background:#000000bb;z-index:9500;display:flex;align-items:center;justify-content:center';

  const modal = document.createElement('div');
  modal.style.cssText = 'background:#0d1a28;border:1px solid var(--border);border-radius:12px;padding:18px;width:min(440px,95vw);max-height:90vh;overflow-y:auto';

  const update = val => {
    current = val;
    const pr = modal.querySelector('#ippPreview');
    const inp = modal.querySelector('#ippInput');
    if (pr) pr.textContent = val || '?';
    if (inp && document.activeElement !== inp) inp.value = val;
  };

  modal.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
      <div style="display:flex;gap:8px;align-items:center">
        <div id="ippPreview" style="font-family:Georgia,serif;font-size:2rem;min-width:48px;text-align:center;color:${c}">${current||'?'}</div>
        <input id="ippInput" type="text" value="${current}"
          style="background:var(--input);border:1px solid var(--border);border-radius:5px;color:#d8e8f4;padding:6px 8px;font-size:1rem;font-family:Georgia,serif;width:90px;outline:none">
        <button type="button" id="ippBackspace" class="btn btn-secondary btn-sm" title="Backspace">⌫</button>
        <button type="button" id="ippClear" class="btn btn-secondary btn-sm" title="Clear">✕</button>
      </div>
      <button type="button" id="ippClose" class="btn btn-secondary btn-sm">✕</button>
    </div>
    <div id="ippGrid" style="font-size:.82rem"></div>
    <div id="ippMods" class="ipa-mods-row" style="margin-top:5px"></div>
    <div style="display:flex;gap:6px;margin-top:12px;border-top:1px solid var(--border);padding-top:10px">
      <button type="button" id="ippApply" class="btn btn-primary btn-sm">Apply</button>
      <button type="button" id="ippCancel" class="btn btn-secondary btn-sm">Cancel</button>
    </div>`;

  backdrop.appendChild(modal); document.body.appendChild(backdrop);

  const inp = modal.querySelector('#ippInput');
  inp.addEventListener('input', e => update(e.target.value));
  modal.querySelector('#ippBackspace').addEventListener('click', () => update(current.slice(0,-1)));
  modal.querySelector('#ippClear').addEventListener('click', () => update(''));
  modal.querySelector('#ippClose').addEventListener('click', () => backdrop.remove());
  modal.querySelector('#ippCancel').addEventListener('click', () => backdrop.remove());
  modal.querySelector('#ippApply').addEventListener('click', () => { onApply(current); backdrop.remove(); });
  backdrop.addEventListener('click', e => { if(e.target===backdrop) backdrop.remove(); });

  // IPA table
  const grid = modal.querySelector('#ippGrid');
  const hdr = document.createElement('div'); hdr.className='ipa-row';
  hdr.innerHTML='<span class="ipa-row-lbl"></span><span style="font-size:.5rem;color:#3a5878;flex:1;text-align:center">Front</span><span class="ipa-sep"></span><span style="font-size:.5rem;color:#3a5878;flex:1;text-align:center">Central</span><span class="ipa-sep"></span><span style="font-size:.5rem;color:#3a5878;flex:1;text-align:center">Back</span>';
  grid.appendChild(hdr);
  IPA_ROWS.forEach(row => {
    const rowEl=document.createElement('div'); rowEl.className='ipa-row';
    const lbl=document.createElement('span'); lbl.className='ipa-row-lbl'; lbl.textContent=row.label;
    rowEl.appendChild(lbl);
    row.pairs.forEach((pair,pi)=>{
      if(pi>0){const sep=document.createElement('span');sep.className='ipa-sep';rowEl.appendChild(sep);}
      const cell=document.createElement('span'); cell.style.cssText='display:flex;flex:1;justify-content:space-around';
      pair.forEach(ch=>{
        if(!ch){const sp=document.createElement('span');sp.className='ipa-ch';sp.style.cursor='default';cell.appendChild(sp);return;}
        const btn=document.createElement('span'); btn.className='ipa-ch'; btn.textContent=ch; btn.title=ch;
        btn.addEventListener('click',()=>update(current+ch));
        cell.appendChild(btn);
      });
      rowEl.appendChild(cell);
    });
    grid.appendChild(rowEl);
  });

  const modsRow = modal.querySelector('#ippMods');
  IPA_MODS.forEach(mod=>{
    const btn=document.createElement('button'); btn.type='button'; btn.className='ipa-mod';
    btn.innerHTML=`${mod.ch}<small>${mod.lbl}</small>`;
    btn.addEventListener('click',()=>{
      const pos=inp.selectionStart??current.length;
      update(current.slice(0,pos)+mod.ch+current.slice(pos));
    });
    modsRow.appendChild(btn);
  });

  setTimeout(()=>inp.focus(),50);
}

// ─── IPA picker grid (legacy) ────────────────────────────────────────────────
// getInputEl: function returning the currently active input element (main or alt)
function buildIpaPicker(grid, modsRow, getInputEl, v, color) {
  const hdr = document.createElement('div'); hdr.className = 'ipa-row';
  hdr.innerHTML = `<span class="ipa-row-lbl"></span><span style="font-size:.5rem;color:#3a5878;flex:1;text-align:center">Front</span><span class="ipa-sep"></span><span style="font-size:.5rem;color:#3a5878;flex:1;text-align:center">Central</span><span class="ipa-sep"></span><span style="font-size:.5rem;color:#3a5878;flex:1;text-align:center">Back</span>`;
  grid.appendChild(hdr);

  IPA_ROWS.forEach(row => {
    const rowEl = document.createElement('div'); rowEl.className = 'ipa-row';
    const lbl = document.createElement('span'); lbl.className = 'ipa-row-lbl'; lbl.textContent = row.label;
    rowEl.appendChild(lbl);
    row.pairs.forEach((pair, pi) => {
      if (pi > 0) { const sep = document.createElement('span'); sep.className = 'ipa-sep'; rowEl.appendChild(sep); }
      const cell = document.createElement('span'); cell.style.cssText = 'display:flex;flex:1;justify-content:space-around';
      pair.forEach(ch => {
        if (!ch) { const sp = document.createElement('span'); sp.className = 'ipa-ch'; sp.style.cursor = 'default'; cell.appendChild(sp); return; }
        const btn = document.createElement('span'); btn.className = 'ipa-ch'; btn.textContent = ch; btn.title = ch;
        btn.addEventListener('click', () => {
          const inputEl = typeof getInputEl === 'function' ? getInputEl() : getInputEl;
          inputEl.value += ch;
          if (inputEl.id === 'ipaAltInput') {
            const alts = inputEl.value.split(',').map(s => s.trim()).filter(Boolean);
            v.symbols = [v.symbols?.[0] || '', ...alts];
          } else {
            v.symbols = [inputEl.value, ...(v.symbols?.slice(1) || [])];
            document.getElementById('ipaPreview').textContent = v.symbols[0] || '?';
            document.getElementById('veTitle').textContent = (state.vowelIdx < 0 ? 'New Vowel' : 'Edit: ') + v.symbols[0];
          }
          refreshCharts(); renderVowelCards();
        });
        cell.appendChild(btn);
      });
      rowEl.appendChild(cell);
    });
    grid.appendChild(rowEl);
  });

  IPA_MODS.forEach(mod => {
    const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'ipa-mod';
    btn.innerHTML = `${mod.ch}<small>${mod.lbl}</small>`;
    btn.addEventListener('click', () => {
      const inputEl = typeof getInputEl === 'function' ? getInputEl() : getInputEl;
      const pos = inputEl.selectionStart ?? inputEl.value.length;
      inputEl.value = inputEl.value.slice(0, pos) + mod.ch + inputEl.value.slice(pos);
      if (inputEl.id === 'ipaAltInput') {
        const alts = inputEl.value.split(',').map(s => s.trim()).filter(Boolean);
        v.symbols = [v.symbols?.[0] || '', ...alts];
      } else {
        v.symbols = [inputEl.value, ...(v.symbols?.slice(1) || [])];
        document.getElementById('ipaPreview').textContent = v.symbols[0] || '?';
      }
      refreshCharts(); renderVowelCards();
    });
    modsRow.appendChild(btn);
  });
}