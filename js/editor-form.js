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

  // ── IPA symbol section ─────────────────────────────────────────────────────
  const ipaSection = document.createElement('div'); ipaSection.className = 'ipa-section';
  const ipaLeft    = document.createElement('div'); ipaLeft.className    = 'ipa-left';
  ipaLeft.innerHTML = `
    <div class="ipa-preview" id="ipaPreview" style="color:${c}">${sym || '?'}</div>
    <div class="ipa-field-wrap">
      <label>Symbol</label>
      <input class="ipa-text" type="text" id="ipaInput" value="${sym}">
    </div>`;

  // Alternative notations
  const altWrap = document.createElement('div'); altWrap.className = 'ipa-field-wrap'; altWrap.style.marginTop = '4px';
  altWrap.innerHTML = `<label>Alt. notations <span style="font-weight:400;opacity:.5;font-size:.55rem">comma-separated</span></label>`;
  const altIn = document.createElement('input'); altIn.className = 'ipa-text'; altIn.type = 'text'; altIn.id = 'ipaAltInput';
  altIn.placeholder = 'e.g. iː, i̞'; altIn.value = (v.symbols?.slice(1) || []).join(', ');
  altWrap.appendChild(altIn); ipaLeft.appendChild(altWrap);

  const ipaBox = document.createElement('div'); ipaBox.className = 'ipa-picker-box';
  ipaBox.innerHTML = `<div class="ipa-picker-title">Click to insert</div><div class="ipa-grid" id="ipaGrid"></div><div class="ipa-mods-row" id="ipaMods"></div>`;
  ipaSection.appendChild(ipaLeft); ipaSection.appendChild(ipaBox);
  sec.appendChild(ipaSection);

  const ipaInput = sec.querySelector('#ipaInput');

  // Track focus: IPA picker inserts into whichever input is active
  let activeIpaInput = ipaInput;
  ipaInput.addEventListener('focus', () => { activeIpaInput = ipaInput; });
  altIn.addEventListener('focus',   () => { activeIpaInput = altIn; });

  ipaInput.addEventListener('input', () => {
    v.symbols = [ipaInput.value, ...(v.symbols?.slice(1) || [])];
    document.getElementById('ipaPreview').textContent = v.symbols[0] || '?';
    document.getElementById('veTitle').textContent = (state.vowelIdx < 0 ? 'New Vowel' : 'Edit: ') + v.symbols[0];
    refreshCharts(); renderVowelCards();
  });
  altIn.addEventListener('input', () => {
    const alts = altIn.value.split(',').map(s => s.trim()).filter(Boolean);
    v.symbols = [v.symbols?.[0] || '', ...alts];
  });

  buildIpaPicker(
      ipaBox.querySelector('#ipaGrid'),
      ipaBox.querySelector('#ipaMods'),
      () => activeIpaInput,
      v, c
  );

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

// ─── IPA picker grid ──────────────────────────────────────────────────────────
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