/**
 * editor-samples.js — Sample management.
 *
 * Two sample editor modes:
 *   1. Samples tab (seInline):  openSampleEditor(idx)       — no jump button
 *   2. Inline in vowel form:    openSampleInVowelEditor(idx) — shows ↗ Samples button
 *
 * Waveform slice is set via a popup modal (openWaveformPopup).
 * Token rows show saved results + play/analyze buttons; no inline waveform.
 */

const SAMPLE_SERVER = 'http://localhost:5050';


// ─── Module state ─────────────────────────────────────────────────────────────
let _wave      = null;   // { samples: Float32Array, sampleRate, duration(ms) }
let _waveUrl   = null;   // URL that _wave was decoded from
let _wavePeaks = null;   // [Float32Array mn, Float32Array mx]

// Popup waveform state
let _popLeft  = 0.15;
let _popRight = 0.85;
let _popTokIdx = null;
let _popDrag   = null;   // 'left' | 'right' | null
let _popPlay   = null;   // { actx, startTime, sliceDur, raf }

// Text-range selector drag state
let _textDrag  = null;   // { tokIdx, which:'start'|'end', container, tok }

// ─── Tab switching ─────────────────────────────────────────────────────────────
function switchToSamplesTab() {
    state.samplesTab = true;
    document.getElementById('vowelPanel')?.style.setProperty('display','none');
    document.getElementById('samplesPanel')?.style.removeProperty('display');
    document.getElementById('tabVowelsList')?.classList.remove('active');
    document.getElementById('tabSamplesList')?.classList.add('active');
    updatePaneHint(); renderSampleList();
}
function switchToVowelsTab() {
    state.samplesTab = false;
    document.getElementById('vowelPanel')?.style.removeProperty('display');
    document.getElementById('samplesPanel')?.style.setProperty('display','none');
    document.getElementById('tabVowelsList')?.classList.add('active');
    document.getElementById('tabSamplesList')?.classList.remove('active');
    updatePaneHint();
}
function updatePaneHint() {
    const ph = document.getElementById('editorPaneHint');
    if (!ph) return;
    ph.style.display = (state.vowelIdx !== null || state.sampleIdx !== null) ? 'none' : 'block';
    ph.textContent   = state.samplesTab ? 'Select a sample · or + Add Sample'
        : 'Select a vowel on the chart or card to edit';
}

// ─── Sample grid ──────────────────────────────────────────────────────────────
function renderSampleList() {
    const el = document.getElementById('sampleList');
    if (!el) return;
    el.innerHTML = '';
    const samples = state.samplesDraft || [];
    const c = state.langDraft?.color || '#7eb8f7';

    samples.forEach((s, i) => {
        const isAct = state.sampleIdx === i;
        const card  = document.createElement('div');
        card.className = 'sample-card' + (isAct ? ' active' : '');
        if (isAct) card.style.borderColor = c;

        const del = document.createElement('button');
        del.className = 'vc-del-btn'; del.textContent = '×'; del.title = 'Delete sample';
        del.addEventListener('click', e => {
            e.stopPropagation();
            if (!confirm(`Delete "${s.text || '?'}"?`)) return;
            state.samplesDraft.splice(i, 1);
            if (state.sampleIdx === i)    closeSampleEditor();
            else if (state.sampleIdx > i) state.sampleIdx--;
            markUnsaved(); renderSampleList();
        });
        card.appendChild(del);

        const body = document.createElement('div');
        const clr  = state.langDraft?.color || '#7eb8f7';

        // Rich text: all token positions highlighted, clicking slice plays it
        const textDiv = buildHighlightedText(s, null, clr, {
            textStyle: 'font-size:.9rem;color:#c8d8e8;margin-bottom:2px',
            onTokenPlay: tok => playTokenSlice(s, tok),
            // No onFullPlay here — card click handles full audio
        });
        body.appendChild(textDiv);

        if (s.phonemic) {
            const ph = document.createElement('div'); ph.className = 'sc-phonemic';
            ph.textContent = s.phonemic; body.appendChild(ph);
        }

        // Representative badge — top-right corner of card
        if (s.representative) {
            const repBadge = document.createElement('div');
            repBadge.style.cssText = `position:absolute;top:4px;right:28px;font-size:.55rem;color:${clr};background:${clr}18;border:1px solid ${clr}50;border-radius:3px;padding:1px 5px;pointer-events:none`;
            repBadge.textContent = `★ ${s.representative}`;
            card.appendChild(repBadge);
        }
        card.appendChild(body);

        // Card click: play full audio + open editor
        // (token highlight clicks stop propagation so they don't also open editor)
        card.addEventListener('click', () => {
            if (s.audio) new Audio(s.audio).play().catch(()=>{});
            openSampleEditor(i);
        });
        el.appendChild(card);
    });

    const t = document.getElementById('tabSamplesList');
    if (t) t.textContent = `Samples (${samples.length})`;
    const h = document.getElementById('samplesSectionTitle');
    if (h) h.textContent = `Samples (${samples.length})`;
}

// ─── Open / close ─────────────────────────────────────────────────────────────
function openSampleEditor(idx) {
    // Used from samples tab — opens seInline, NO jump button
    if (state.vowelIdx !== null) closeVowelEditor();
    _initSampleDraft(idx);
    document.getElementById('veInline').style.display = 'none';
    const se = document.getElementById('seInline');
    se.style.display = 'block';
    buildSampleForm(se, false);
    updatePaneHint(); renderSampleList();
}

function openSampleInVowelEditor(idx) {
    // Used from vowel form — renders inside seVowelInline, WITH jump button
    // Does NOT close the vowel editor
    _initSampleDraft(idx);
    const container = document.getElementById('seVowelInline');
    if (!container) return;
    container.style.display = 'block';
    buildSampleForm(container, true);
    renderSampleList();
    setTimeout(()=>container.scrollIntoView({behavior:'smooth',block:'nearest'}),80);
}

function _initSampleDraft(idx) {
    state.sampleIdx  = idx;
    state.sampleDraft = idx >= 0 ? clone(state.samplesDraft[idx])
        : {text:'', audio:null, phonemic:null, tokens:[], representative:null};
    // Don't reset _wave — can reuse if same audio URL loaded
}

function closeSampleEditor() {
    closeWaveformPopup();
    state.sampleIdx = null; state.sampleDraft = null;
    // Close both possible containers
    document.getElementById('seInline').style.display = 'none';
    const sv = document.getElementById('seVowelInline');
    if (sv) { sv.style.display = 'none'; sv.innerHTML = ''; }
    updatePaneHint(); renderSampleList();
}

function applySample() {
    if (!state.sampleDraft) return;
    if (!state.samplesDraft) state.samplesDraft = [];
    if (state.sampleIdx < 0) state.samplesDraft.push(state.sampleDraft);
    else                     state.samplesDraft[state.sampleIdx] = state.sampleDraft;
    markUnsaved();
    const txt = state.sampleDraft.text;
    const idx = state.sampleIdx < 0 ? state.samplesDraft.length - 1 : state.sampleIdx;
    state.sampleIdx = idx;
    state.sampleDraft = clone(state.samplesDraft[idx]);
    if (typeof setLangSamples === 'function' && state.selKey)
        setLangSamples(state.selKey, state.samplesDraft);
    renderSampleList(); renderTokenRows();
    toast(`Sample "${txt}" saved`);
}

// ─── Build sample form ────────────────────────────────────────────────────────
function buildSampleForm(container, showJumpBtn) {
    if (!container || !state.sampleDraft) return;
    container.innerHTML = '';
    const s = state.sampleDraft;

    // Header
    const hdr = document.createElement('div'); hdr.className = 've-inline-header';
    hdr.innerHTML = `<span class="ve-inline-title">${state.sampleIdx < 0 ? 'New Sample' : 'Edit sample'}</span>`;
    if (showJumpBtn) {
        const jb = document.createElement('button');
        jb.className = 'btn btn-secondary btn-sm'; jb.type = 'button'; jb.textContent = '↗ Samples';
        jb.addEventListener('click', () => {
            const saved = state.sampleIdx;
            closeSampleEditor();
            switchToSamplesTab();
            if (saved >= 0) openSampleEditor(saved);
        });
        hdr.appendChild(jb);
    }
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn btn-secondary btn-sm'; cancelBtn.type = 'button'; cancelBtn.textContent = 'Cancel';
    const applyBtn = document.createElement('button');
    applyBtn.className = 'btn btn-primary btn-sm'; applyBtn.type = 'button'; applyBtn.textContent = 'Apply';
    hdr.appendChild(cancelBtn); hdr.appendChild(applyBtn);
    cancelBtn.addEventListener('click', closeSampleEditor);
    applyBtn.addEventListener('click', applySample);
    container.appendChild(hdr);

    // Text + phonemic
    const metaRow = document.createElement('div'); metaRow.className = 've-meta';
    metaRow.innerHTML = `
    <div class="field" style="flex:2"><label>Text</label><input type="text" id="seText" value="${escAttr(s.text||'')}" placeholder="feet"></div>
    <div class="field" style="flex:1"><label>Phonemic</label><input type="text" id="sePhonemic" value="${escAttr(s.phonemic||'')}" placeholder="/fiːt/"></div>`;
    // Representative vowel selector
    const repRow = document.createElement('div'); repRow.className = 've-meta';
    const repOpts = ['<option value="">— not representative —</option>',
        ...(state.langDraft?.vowels||[]).map(v => {
            const sym = v.symbols?.[0]||'?';
            const sel = s.representative === sym ? 'selected' : '';
            return `<option value="${sym}" ${sel}>${sym}${v.desc?' — '+v.desc:''}</option>`;
        })
    ].join('');
    repRow.innerHTML = `<div class="field" style="flex:1"><label>★ Representative for vowel</label>
    <select id="seRepresentative" style="background:var(--input);border:1px solid var(--border);border-radius:5px;color:#d8e8f4;padding:5px 8px;font-size:.82rem;outline:none;cursor:pointer;width:100%">${repOpts}</select></div>`;
    container.appendChild(repRow);
    container.querySelector('#seRepresentative').addEventListener('change', e => { s.representative = e.target.value || null; renderSampleList(); });
    container.appendChild(metaRow);
    container.querySelector('#seText').addEventListener('input', e => { s.text = e.target.value; renderSampleList(); renderTokenRows(); });
    container.querySelector('#sePhonemic').addEventListener('input', e => { s.phonemic = e.target.value || null; });

    // Audio URL
    const audioRow = document.createElement('div'); audioRow.className = 've-meta';
    audioRow.innerHTML = `
    <div class="field" style="flex:1"><label>Audio URL</label>
      <div style="display:flex;gap:4px">
        <input type="url" id="seAudioUrl" value="${escAttr(s.audio||'')}" placeholder="https://… or lang/…" style="flex:1;min-width:0">
        <button class="btn btn-secondary btn-sm" id="seLoadAudio" type="button">⟳ Load</button>
        <button class="btn btn-secondary btn-sm" id="sePlayFull" type="button">▶ Full</button>
      </div>
      <div id="seAudioInfo" style="font-size:.6rem;color:var(--muted);margin-top:3px">${s.audio?'Click ⟳ Load to decode for analysis':'Add an audio URL'}</div>
    </div>`;
    container.appendChild(audioRow);
    container.querySelector('#seAudioUrl').addEventListener('input', e => { s.audio = e.target.value||null; });
    container.querySelector('#seLoadAudio').addEventListener('click', () => loadSampleAudio(s.audio));
    container.querySelector('#sePlayFull').addEventListener('click', () => { if(s.audio) new Audio(s.audio).play().catch(()=>{}); });

    // Tokens
    container.appendChild(makeDividerLabel('Tokens'));
    const tokContainer = document.createElement('div'); tokContainer.id = 'seTokens';
    container.appendChild(tokContainer);

    const addTok = document.createElement('button');
    addTok.className = 'add-word-btn'; addTok.type = 'button'; addTok.textContent = '+ Add token';
    addTok.addEventListener('click', () => {
        const fullLen = (s.text||'').length;
        s.tokens = [...(s.tokens||[]), {symbol:'', position:[0, fullLen], analysis:null}];
        renderTokenRows();
    });
    container.appendChild(addTok);

    renderTokenRows();
    attachGlobalDragHandlers();

    if (s.audio) loadSampleAudio(s.audio);
}

// ─── Token rows ───────────────────────────────────────────────────────────────
function renderTokenRows() {
    const container = document.getElementById('seTokens');
    if (!container || !state.sampleDraft) return;
    container.innerHTML = '';
    const s = state.sampleDraft;
    const allSyms = [...new Set((state.langDraft?.vowels||[]).flatMap(v=>v.symbols||[]))].filter(Boolean);

    (s.tokens||[]).forEach((tok, i) => {
        const row = document.createElement('div'); row.className = 'token-row';

        // Symbol + delete
        const symOpts = ['', ...allSyms].map(sym =>
            `<option value="${escAttr(sym)}" ${tok.symbol===sym?'selected':''}>${sym||'—'}</option>`
        ).join('');
        const top = document.createElement('div');
        top.style.cssText = 'display:flex;gap:6px;align-items:center;margin-bottom:6px';
        top.innerHTML = `<select class="tok-sym-sel">${symOpts}</select>
      <button class="btn btn-secondary btn-sm tok-del" type="button" style="margin-left:auto">✕</button>`;
        row.appendChild(top);
        top.querySelector('.tok-sym-sel').addEventListener('change', e => { tok.symbol = e.target.value; renderSampleList(); });
        top.querySelector('.tok-del').addEventListener('click', () => {
            s.tokens.splice(i, 1); renderTokenRows(); renderSampleList();
        });

        // Text range selector
        const textSel = document.createElement('div');
        textSel.className = 'tok-text-sel'; textSel.dataset.tok = i;
        row.appendChild(textSel);
        buildTokTextSel(i, textSel, tok);

        // Position inputs (secondary, stay in sync)
        const [ps, pe] = tok.position || [0, 0];
        const bot = document.createElement('div');
        bot.style.cssText = 'display:flex;gap:5px;align-items:flex-end;flex-wrap:wrap;margin-top:6px';
        const an = tok.analysis;
        const anHtml = an?.f1
            ? `<span class="tok-analysis ok">F1 ${an.f1} · F2 ${an.f2} Hz</span>`
            : `<span class="tok-analysis pending">not analyzed</span>`;
        bot.innerHTML = `
      <div class="field" style="flex:none;width:60px"><label>Start</label><input type="number" class="tok-ps" value="${ps}" style="width:100%"></div>
      <div class="field" style="flex:none;width:60px"><label>End</label><input type="number" class="tok-pe" value="${pe}" style="width:100%"></div>
      ${an?.slice ? `<button class="btn btn-secondary btn-sm tok-play" type="button">▶ Play</button>` : ''}
      <button class="btn btn-secondary btn-sm tok-analyze" type="button">⚡ Analyze</button>
      ${anHtml}`;
        row.appendChild(bot);

        bot.querySelector('.tok-ps').addEventListener('input', e => {
            tok.position = [Math.min(+e.target.value, (tok.position[1]||0)), tok.position[1]||0];
            buildTokTextSel(i, textSel, tok);
        });
        bot.querySelector('.tok-pe').addEventListener('input', e => {
            tok.position = [tok.position[0]||0, Math.max(+e.target.value, tok.position[0]||0)];
            buildTokTextSel(i, textSel, tok);
        });
        bot.querySelector('.tok-analyze')?.addEventListener('click', () => openWaveformPopup(i));
        bot.querySelector('.tok-play')?.addEventListener('click', () => playTokenResult(i));

        container.appendChild(row);
    });
}

// ─── Interactive text range selector ─────────────────────────────────────────
function buildTokTextSel(tokIdx, container, tok) {
    container.innerHTML = '';
    const text = state.sampleDraft?.text || '';
    if (!text) {
        container.innerHTML = '<span style="font-size:.65rem;color:#3a5878">Enter text to select range</span>';
        return;
    }
    const c = state.langDraft?.color || '#7eb8f7';
    const [ps, pe] = tok.position || [0, 0];

    [...text].forEach((ch, ci) => {
        const sp = document.createElement('span');
        sp.className = 'tc'; sp.dataset.i = ci;
        const inSel = ci >= ps && ci < pe;
        sp.style.cssText = `padding:0 2px;border-radius:2px;white-space:pre;${
            inSel ? `background:${c}33;color:${c};` : ''}${
            ci === ps  ? `border-left:2px solid ${c};` : ''}${
            ci === pe-1 ? `border-right:2px solid ${c};` : ''}`;
        sp.textContent = ch === ' ' ? '\u00a0' : ch;
        container.appendChild(sp);
    });
    // Sentinel for dragging past last char
    const end = document.createElement('span');
    end.className = 'tc'; end.dataset.i = text.length;
    end.style.cssText = 'display:inline-block;min-width:6px';
    end.textContent = '\u200b';
    container.appendChild(end);

    container.addEventListener('mousedown', e => {
        const ci = hitTestChar(container, e.clientX);
        const [ps, pe] = tok.position || [0, 0];
        const distS = Math.abs(ci - ps), distE = Math.abs(ci - pe);
        _textDrag = { tokIdx, which: distS <= distE ? 'start' : 'end', container, tok };
        e.preventDefault();
    });
}

function updateTokTextSel(container, tok) {
    const text = state.sampleDraft?.text || '';
    const c = state.langDraft?.color || '#7eb8f7';
    const [ps, pe] = tok.position || [0, 0];
    container.querySelectorAll('.tc[data-i]').forEach(sp => {
        const ci = +sp.dataset.i;
        const inSel = ci >= ps && ci < pe;
        sp.style.background   = inSel ? c + '33' : '';
        sp.style.color        = inSel ? c : '';
        sp.style.borderLeft   = ci === ps    ? `2px solid ${c}` : '';
        sp.style.borderRight  = ci === pe-1  ? `2px solid ${c}` : '';
    });
    // Sync number inputs
    const row = container.closest('.token-row');
    if (row) {
        const psInput = row.querySelector('.tok-ps');
        const peInput = row.querySelector('.tok-pe');
        if (psInput) psInput.value = ps;
        if (peInput) peInput.value = pe;
    }
}

function hitTestChar(container, clientX) {
    const spans = [...container.querySelectorAll('.tc[data-i]')];
    for (const sp of spans) {
        const rect = sp.getBoundingClientRect();
        if (clientX < rect.left + rect.width / 2) return +sp.dataset.i;
    }
    const text = state.sampleDraft?.text || '';
    return text.length;
}

function attachGlobalDragHandlers() {
    if (document._seGlobalDragBound) return;
    document._seGlobalDragBound = true;

    document.addEventListener('mousemove', e => {
        // Text selector drag
        if (_textDrag) {
            const { tokIdx, which, container, tok } = _textDrag;
            const ci  = hitTestChar(container, e.clientX);
            const [ps, pe] = tok.position || [0, 0];
            if (which === 'start') tok.position = [Math.min(ci, Math.max(0, pe - 1)), pe];
            else                   tok.position = [ps, Math.max(ci, ps + 1)];
            updateTokTextSel(container, tok);
        }
        // Popup waveform drag
        if (_popDrag && _wave) {
            const canvas = document.getElementById('wfCanvas');
            if (!canvas) return;
            const rect = canvas.getBoundingClientRect();
            const f = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            if (_popDrag === 'left')  _popLeft  = Math.min(f, _popRight  - 0.005);
            else                      _popRight = Math.max(f, _popLeft + 0.005);
            drawPopupWave(); updatePopupTimeDisplay();
        }
    });

    document.addEventListener('mouseup', () => { _textDrag = null; _popDrag = null; });
}

// ─── Token result playback (no progress line) ─────────────────────────────────
async function playTokenResult(tokIdx) {
    const tok = state.sampleDraft?.tokens?.[tokIdx];
    if (!tok?.analysis?.slice) { toast('Analyze token first'); return; }
    if (!_wave) {
        await loadSampleAudio(state.sampleDraft?.audio);
        if (!_wave) { toast('Load audio first'); return; }
    }
    const [startMs, endMs] = tok.analysis.slice;
    const i0 = Math.floor(startMs / _wave.duration * _wave.samples.length);
    const i1 = Math.ceil( endMs   / _wave.duration * _wave.samples.length);
    const actx = new (window.AudioContext || window.webkitAudioContext)();
    const buf  = actx.createBuffer(1, i1-i0, _wave.sampleRate);
    buf.getChannelData(0).set(_wave.samples.slice(i0, i1));
    const src  = actx.createBufferSource(); src.buffer = buf; src.connect(actx.destination); src.start();
    src.onended = () => actx.close();
}

// ─── Waveform popup ───────────────────────────────────────────────────────────
function openWaveformPopup(tokIdx) {
    closeWaveformPopup();
    const tok = state.sampleDraft?.tokens?.[tokIdx];
    if (!tok) return;
    _popTokIdx = tokIdx;

    // Init handles from saved slice or defaults
    if (tok.analysis?.slice && _wave) {
        _popLeft  = tok.analysis.slice[0] / _wave.duration;
        _popRight = tok.analysis.slice[1] / _wave.duration;
    } else {
        _popLeft = 0.15; _popRight = 0.85;
    }

    const cfg = tok.analysis || {};
    const backdrop = document.createElement('div'); backdrop.id = 'wfBackdrop';
    backdrop.style.cssText = 'position:fixed;inset:0;background:#000000bb;z-index:9000;display:flex;align-items:center;justify-content:center';

    const modal = document.createElement('div'); modal.className = 'wf-modal';
    modal.innerHTML = `
    <div class="wf-modal-head">
      <span style="font-size:.85rem;font-weight:700;color:#d8e8f4">
        Analyze token: <span style="font-family:Georgia,serif;color:${state.langDraft?.color||'#7eb8f7'}">${tok.symbol||'?'}</span>
      </span>
      <button id="wfClose" class="btn btn-secondary btn-sm">✕</button>
    </div>
    <div id="wfTextHighlight"></div>
    <div id="wfAudioInfo" style="font-size:.62rem;color:var(--muted);margin-bottom:6px">
      ${_wave ? `${(_wave.duration/1000).toFixed(2)}s · ${(_wave.sampleRate/1000).toFixed(1)} kHz` : 'Load audio in sample form first'}
    </div>
    <div class="wf-modal-wave">
      <canvas id="wfCanvas" style="display:block;width:100%;height:80px"></canvas>
    </div>
    <div style="display:flex;justify-content:space-between;font-size:.6rem;color:var(--muted);padding:2px 2px 8px;font-family:monospace">
      <span id="wfTL">—</span><span id="wfTD">—</span><span id="wfTR">—</span>
    </div>
    <div class="wf-params">
      <div class="field" style="flex:1"><label>Max formant (Hz)</label>  <input type="number" id="wfMaxF"      value="${cfg.max_f??5000}"              step="50"    min="1000" max="9000"></div>
      <div class="field" style="flex:1"><label>N formants</label>        <input type="number" id="wfNFmt"      value="${cfg.n_formants??5}"            step="1"     min="3"    max="8"></div>
      <div class="field" style="flex:1"><label>Window (ms)</label>       <input type="number" id="wfWinMs"     value="${cfg.window_ms??25}"            step="1"     min="5"    max="100"></div>
      <div class="field" style="flex:1"><label>Pre-emphasis (Hz)</label> <input type="number" id="wfPreEmph"   value="${cfg.pre_emphasis??50}"         step="10"    min="0"    max="500"></div>
    </div>
    <div class="wf-params" style="margin-top:4px">
      <div class="field" style="flex:1"><label>Back ceiling (Hz)</label> <input type="number" id="wfBackCeil"  value="${cfg.back_ceiling??1800}"       step="50"    min="500"  max="3000"></div>
      <div class="field" style="flex:1"><label>Back/ceil ratio</label>   <input type="number" id="wfBackRatio" value="${cfg.back_ceiling_ratio??0.95}" step="0.01"  min="0"    max="1"></div>
      <div class="field" style="flex:1"><label>Back/front ratio</label>  <input type="number" id="wfFrontRatio"value="${cfg.back_front_ratio??0.75}"   step="0.01"  min="0"    max="1"></div>
      <div class="field" style="flex:1"><label>RMS floor</label>         <input type="number" id="wfRmsFloor"  value="${cfg.rms_floor??0.005}"         step="0.001" min="0"    max="1"></div>
      <div class="field" style="flex:1"><label>Median smooth n</label>   <input type="number" id="wfMedianN"   value="${cfg.median_n??5}"              step="2"     min="1"    max="21"></div>
    </div>
    <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:10px">
      <button id="wfPlay"  class="btn btn-secondary btn-sm">▶ Play slice</button>
      <button id="wfAnalyze" class="btn btn-primary btn-sm">⚡ Analyze</button>
      <span id="wfResult" style="font-size:.72rem;font-family:monospace"></span>
    </div>
    <div style="display:flex;gap:6px;margin-top:10px;border-top:1px solid var(--border);padding-top:10px">
      <button id="wfApply"  class="btn btn-primary btn-sm">✓ Apply</button>
      <button id="wfCancel" class="btn btn-secondary btn-sm">Cancel</button>
    </div>`;

    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    // Fill token text highlight in popup
    {
        const wfTH = modal.querySelector('#wfTextHighlight');
        if (wfTH) {
            const t  = state.sampleDraft?.text || '';
            const [ps, pe] = tok.position || [0, 0];
            const c2 = state.langDraft?.color || '#7eb8f7';
            const esc = x => String(x).replace(/&/g,'&amp;').replace(/</g,'&lt;');
            const mid = t.slice(ps, pe);
            if (mid) {
                wfTH.style.cssText = 'font-family:Georgia,serif;font-size:.95rem;margin-bottom:6px;line-height:1.6;padding:3px 4px;background:#0a1520;border-radius:5px';
                wfTH.innerHTML = esc(t.slice(0,ps))
                    + `<mark style="background:${c2}33;color:${c2};padding:0 2px;border-radius:2px">${esc(mid)}</mark>`
                    + esc(t.slice(pe));
            }
        }
    }

    // Note: no backdrop click-to-close — drag release outside modal would trigger it
    modal.querySelector('#wfClose').addEventListener('click', closeWaveformPopup);
    modal.querySelector('#wfCancel').addEventListener('click', closeWaveformPopup);

    modal.querySelector('#wfPlay').addEventListener('click', playPopupSlice);
    modal.querySelector('#wfAnalyze').addEventListener('click', analyzeInPopup);
    modal.querySelector('#wfApply').addEventListener('click', applyPopupResult);

    // Waveform drag
    const canvas = modal.querySelector('#wfCanvas');
    canvas.addEventListener('mousedown', e => {
        if (!_wave) return;
        const rect = canvas.getBoundingClientRect();
        const f = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        _popDrag = Math.abs(f - _popLeft) < Math.abs(f - _popRight) ? 'left' : 'right';
        e.preventDefault();
    });

    // Touch
    canvas.addEventListener('touchstart', e => {
        if (!_wave) return;
        const rect = canvas.getBoundingClientRect();
        const f = Math.max(0, Math.min(1, (e.touches[0].clientX - rect.left) / rect.width));
        _popDrag = Math.abs(f - _popLeft) < Math.abs(f - _popRight) ? 'left' : 'right';
        e.preventDefault();
    }, {passive:false});
    canvas.addEventListener('touchmove', e => {
        if (!_popDrag || !_wave) return;
        const rect = canvas.getBoundingClientRect();
        const f = Math.max(0, Math.min(1, (e.touches[0].clientX - rect.left) / rect.width));
        if (_popDrag === 'left')  _popLeft  = Math.min(f, _popRight  - 0.005);
        else                      _popRight = Math.max(f, _popLeft + 0.005);
        drawPopupWave(); updatePopupTimeDisplay(); e.preventDefault();
    }, {passive:false});
    canvas.addEventListener('touchend', () => { _popDrag = null; });

    requestAnimationFrame(() => { drawPopupWave(); updatePopupTimeDisplay(); });
}

function closeWaveformPopup() {
    if (_popPlay) {
        cancelAnimationFrame(_popPlay.raf);
        try { _popPlay.actx.close(); } catch(e) {}
        _popPlay = null;
    }
    _popDrag = null; _popTokIdx = null;
    document.getElementById('wfBackdrop')?.remove();
}

let _popupAnalysisResult = null;  // stores last analyze result for Apply

function drawPopupWave(progress=null) {
    const canvas = document.getElementById('wfCanvas');
    if (!canvas) return;
    const W = canvas.width  = canvas.offsetWidth  || 500;
    const H = canvas.height = canvas.offsetHeight || 80;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#0a1520'; ctx.fillRect(0, 0, W, H);

    const c = state.langDraft?.color || '#7eb8f7';
    if (!_wavePeaks) {
        ctx.fillStyle = '#1a3050'; ctx.fillRect(0, H/2-1, W, 2);
        ctx.fillStyle = '#2a4060'; ctx.font = '12px system-ui';
        ctx.textAlign = 'center'; ctx.fillText('Load audio first', W/2, H/2+5);
        return;
    }
    const lx = Math.floor(_popLeft  * W);
    const rx = Math.ceil(_popRight * W);
    const nb = _wavePeaks[0].length;

    ctx.fillStyle = c + '18'; ctx.fillRect(lx, 0, rx-lx, H);

    for (let x = 0; x < W; x++) {
        const bi = Math.min(nb-1, Math.floor((x/W)*nb));
        const mn = _wavePeaks[0][bi], mx = _wavePeaks[1][bi];
        const yT = Math.floor((1-mx)*H/2), yB = Math.ceil((1-mn)*H/2);
        ctx.fillStyle = (x>=lx && x<=rx) ? c+'cc' : c+'44';
        ctx.fillRect(x, yT, 1, Math.max(1, yB-yT));
    }

    ctx.fillStyle = c; ctx.fillRect(lx, 0, 2, H); ctx.fillRect(rx-1, 0, 2, H);

    if (progress !== null) {
        const px = lx + Math.floor(progress * (rx - lx));
        ctx.fillStyle = '#ffffffcc'; ctx.fillRect(px, 0, 1, H);
    }
}

function updatePopupTimeDisplay() {
    if (!_wave) return;
    const sl = _popLeft  * _wave.duration;
    const sr = _popRight * _wave.duration;
    const g  = id => document.getElementById(id);
    if (g('wfTL')) g('wfTL').textContent = sl.toFixed(0) + ' ms';
    if (g('wfTR')) g('wfTR').textContent = sr.toFixed(0) + ' ms';
    if (g('wfTD')) g('wfTD').textContent = (sr-sl).toFixed(0) + ' ms';
}

async function playPopupSlice() {
    if (!_wave) { toast('Load audio first'); return; }
    if (_popPlay) {
        cancelAnimationFrame(_popPlay.raf);
        try { _popPlay.actx.close(); } catch(e) {}
        _popPlay = null;
        const btn = document.getElementById('wfPlay');
        if (btn) btn.innerHTML = '▶ Play slice';
        return;
    }
    const i0 = Math.floor(_popLeft  * _wave.samples.length);
    const i1 = Math.ceil( _popRight * _wave.samples.length);
    const slice = _wave.samples.slice(i0, i1);
    const sliceDur = (i1-i0) / _wave.sampleRate;

    const actx = new (window.AudioContext || window.webkitAudioContext)();
    const buf  = actx.createBuffer(1, slice.length, _wave.sampleRate);
    buf.getChannelData(0).set(slice);
    const src  = actx.createBufferSource(); src.buffer = buf; src.connect(actx.destination); src.start();

    const startTime = actx.currentTime;
    const btn = document.getElementById('wfPlay');
    if (btn) btn.innerHTML = '■ Stop';

    _popPlay = {actx, startTime, sliceDur};
    const tick = () => {
        const p = (actx.currentTime - startTime) / sliceDur;
        if (p >= 1 || !_popPlay) { _popPlay=null; drawPopupWave(); if(btn)btn.innerHTML='▶ Play slice'; return; }
        drawPopupWave(p);
        _popPlay.raf = requestAnimationFrame(tick);
    };
    _popPlay.raf = requestAnimationFrame(tick);
    src.onended = () => { if(_popPlay){cancelAnimationFrame(_popPlay.raf);_popPlay=null;drawPopupWave();if(btn)btn.innerHTML='▶ Play slice';} };
}

async function analyzeInPopup() {
    if (!_wave) { toast('Load audio first'); return; }
    const btn = document.getElementById('wfAnalyze');
    if (btn) { btn.disabled=true; btn.textContent='…'; }
    const res = document.getElementById('wfResult');
    if (res) res.textContent = 'Analyzing…';
    const i0 = Math.floor(_popLeft  * _wave.samples.length);
    const i1 = Math.ceil( _popRight * _wave.samples.length);
    const gv = id => +(document.getElementById(id)?.value ?? 0) || undefined;
    const max_f              = +(document.getElementById('wfMaxF')?.value)      || 5000;
    const n_formants         = +(document.getElementById('wfNFmt')?.value)      || 5;
    const window_ms          = +(document.getElementById('wfWinMs')?.value)     || 25;
    const pre_emphasis       = +(document.getElementById('wfPreEmph')?.value)   || 50;
    const back_ceiling       = +(document.getElementById('wfBackCeil')?.value)  || 1800;
    const back_ceiling_ratio = +(document.getElementById('wfBackRatio')?.value) || 0.95;
    const back_front_ratio   = +(document.getElementById('wfFrontRatio')?.value)|| 0.75;
    const rms_floor          = +(document.getElementById('wfRmsFloor')?.value)  || 0.005;
    const median_n           = +(document.getElementById('wfMedianN')?.value)   || 5;

    try {
        const form = new FormData();
        form.append('file', encodeWavBlob(_wave.samples.slice(i0,i1), _wave.sampleRate), 'slice.wav');
        form.append('config', JSON.stringify({
            single_segment: true,
            max_f, n_formants, window_ms, pre_emphasis,
            back_ceiling, back_ceiling_ratio, back_front_ratio,
            rms_floor, median_n,
        }));
        const resp  = await fetch(`${SAMPLE_SERVER}/frames`, {method:'POST', body:form});
        if (!resp.ok) throw new Error('Server ' + resp.status);
        const data  = await resp.json();
        const frame = data.frames?.[0];
        if (!frame?.voiced) { if(res) res.textContent = '⚠ No voiced speech'; return; }
        _popupAnalysisResult = {
            slice: [Math.round(_popLeft*_wave.duration), Math.round(_popRight*_wave.duration)],
            f1: frame.f1, f2: frame.f2,
            max_f, n_formants, window_ms, pre_emphasis,
            back_ceiling, back_ceiling_ratio, back_front_ratio, rms_floor, median_n,
        };
        if (res) res.innerHTML = `<span class="tok-analysis ok">F1 ${frame.f1} · F2 ${frame.f2} Hz</span>`;
    } catch(e) {
        if (res) res.textContent = '✗ ' + e.message;
    } finally {
        if (btn) { btn.disabled=false; btn.textContent='⚡ Analyze'; }
    }
}

function applyPopupResult() {
    const tok = state.sampleDraft?.tokens?.[_popTokIdx];
    if (!tok) { closeWaveformPopup(); return; }
    // Apply whatever we have — even without running analyze, save the slice
    if (_popupAnalysisResult) {
        tok.analysis = _popupAnalysisResult;
        _popupAnalysisResult = null;
    } else if (_wave) {
        // Save slice only (no F1/F2)
        const existing = tok.analysis || {};
        tok.analysis = { ...existing, slice: [Math.round(_popLeft*_wave.duration), Math.round(_popRight*_wave.duration)] };
    }
    markUnsaved();
    closeWaveformPopup();
    renderTokenRows(); renderSampleList();
}

// ─── Audio loading ────────────────────────────────────────────────────────────
async function loadSampleAudio(url) {
    const info = document.getElementById('seAudioInfo');
    if (!url) { if(info) info.textContent='Add an audio URL'; return; }
    if (_wave && _waveUrl === url) {
        if(info) info.textContent=`${(_wave.duration/1000).toFixed(2)}s · ready`;
        return;  // same audio already decoded
    }
    _waveUrl = null; _wave = null; _wavePeaks = null;  // reset before reload
    if(info) info.textContent = 'Decoding…';
    try {
        // Use XHR for audio load — works with more server configs than fetch()
        const ab = await new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('GET', url); xhr.responseType = 'arraybuffer';
            xhr.onload  = () => xhr.status < 400 ? resolve(xhr.response) : reject(new Error('HTTP '+xhr.status));
            xhr.onerror = () => reject(new Error('Network error'));
            xhr.send();
        });
        const actx = new (window.AudioContext||window.webkitAudioContext)();
        const dec  = await actx.decodeAudioData(ab);
        actx.close();
        _wave = { samples: dec.getChannelData(0), sampleRate: dec.sampleRate, duration: dec.duration*1000 };
        _waveUrl = url;
        precomputePeaks();
        if(info) info.textContent = `${(_wave.duration/1000).toFixed(2)}s · ${(_wave.sampleRate/1000).toFixed(1)} kHz · ready`;
        // Re-enable analyze buttons
        document.querySelectorAll('.tok-analyze').forEach(b => b.disabled = false);
        // If popup is open, redraw
        if (_popTokIdx !== null) { drawPopupWave(); updatePopupTimeDisplay(); }
    } catch(e) {
        if(info) info.textContent = 'Failed: '+e.message;
        console.warn('loadSampleAudio:', e);
    }
}

function precomputePeaks(numBins=800) {
    if (!_wave) return;
    const { samples } = _wave;
    const mn = new Float32Array(numBins), mx = new Float32Array(numBins);
    for (let b=0; b<numBins; b++) {
        const i0 = Math.floor((b/numBins)*samples.length);
        const i1 = Math.min(samples.length, Math.floor(((b+1)/numBins)*samples.length));
        let lo=0, hi=0;
        for (let i=i0; i<i1; i++) { if(samples[i]<lo)lo=samples[i]; if(samples[i]>hi)hi=samples[i]; }
        mn[b]=lo; mx[b]=hi;
    }
    _wavePeaks = [mn, mx];
}

// ─── WAV encoder ──────────────────────────────────────────────────────────────
function encodeWavBlob(samples, sr) {
    const buf=new ArrayBuffer(44+samples.length*2), v=new DataView(buf);
    const ws=(o,s)=>{for(let i=0;i<s.length;i++)v.setUint8(o+i,s.charCodeAt(i));};
    ws(0,'RIFF'); v.setUint32(4,36+samples.length*2,true);
    ws(8,'WAVE'); ws(12,'fmt ');
    v.setUint32(16,16,true); v.setUint16(20,1,true); v.setUint16(22,1,true);
    v.setUint32(24,sr,true); v.setUint32(28,sr*2,true);
    v.setUint16(32,2,true);  v.setUint16(34,16,true);
    ws(36,'data'); v.setUint32(40,samples.length*2,true);
    for(let i=0;i<samples.length;i++)
        v.setInt16(44+i*2,Math.max(-32768,Math.min(32767,Math.round(samples[i]*32767))),true);
    return new Blob([buf],{type:'audio/wav'});
}

// ─── Utilities ────────────────────────────────────────────────────────────────
function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function escAttr(s) { return String(s).replace(/"/g,'&quot;'); }

// ─── Shared: build rich text with token position highlights ───────────────────
// filterSymbols: only highlight tokens whose symbol is in this array (null = all)
// opts: { onFullPlay, onTokenPlay(tok), textStyle }
function buildHighlightedText(smp, filterSymbols, langColor, opts = {}) {
    const text  = smp.text || '';
    const c     = langColor || '#7eb8f7';
    const { onFullPlay, onTokenPlay, textStyle = '' } = opts;

    const wrap = document.createElement('div');
    wrap.style.cssText = 'font-family:Georgia,serif;line-height:1.7;word-break:break-word;' + textStyle;

    const toks = (smp.tokens || []).filter(t =>
        !filterSymbols || filterSymbols.includes(t.symbol)
    );

    if (!text) {
        wrap.textContent = '?';
        return wrap;
    }

    // Build char→token map (last token wins for overlaps)
    const charTok = new Array(text.length).fill(null);
    toks.forEach(tok => {
        const [ps, pe] = tok.position || [0, 0];
        for (let i = ps; i < Math.min(pe, text.length); i++) charTok[i] = tok;
    });

    // Merge adjacent chars with the same token into spans
    let i = 0;
    while (i < text.length) {
        const tok = charTok[i];
        let j = i + 1;
        while (j < text.length && charTok[j] === tok) j++;

        const seg = document.createElement('span');
        seg.textContent = text.slice(i, j);

        if (tok) {
            seg.style.cssText = `background:${c}28;color:${c};border-radius:2px;padding:0 1px;cursor:pointer;transition:background .1s`;
            seg.addEventListener('mouseenter', () => seg.style.background = c + '50');
            seg.addEventListener('mouseleave', () => seg.style.background = c + '28');
            // Custom tooltip on hover
            const f = tok.analysis;
            const sym = tok.symbol;
            seg.addEventListener('mouseenter', ev => {
                let tip = document.getElementById('_tokTip');
                if (!tip) { tip=document.createElement('div'); tip.id='_tokTip'; Object.assign(tip.style,{position:'fixed',zIndex:'9999',background:'#0d1a28',border:'1px solid #2e4560',borderRadius:'8px',padding:'8px 12px',pointerEvents:'none',display:'none',minWidth:'120px',boxShadow:'0 4px 16px #0008'}); document.body.appendChild(tip); }
                tip.innerHTML = `<div style='font-family:Georgia,serif;font-size:1.3rem;color:${c};margin-bottom:4px'>/${sym}/</div>`
                    + (f?.f1 ? `<div style='font-size:.72rem;color:#7eb8f7;font-family:monospace'>F1 ${f.f1} Hz</div><div style='font-size:.72rem;color:#7eb8f7;font-family:monospace'>F2 ${f.f2} Hz</div>` : `<div style='font-size:.65rem;color:#4a6888'>not analyzed</div>`);
                const r = ev.target.getBoundingClientRect();
                tip.style.display='block';
                tip.style.left = Math.min(r.left, window.innerWidth-130)+'px';
                tip.style.top  = (r.bottom+6)+'px';
            });
            seg.addEventListener('mouseleave', () => { const t=document.getElementById('_tokTip'); if(t) t.style.display='none'; });
            if (onTokenPlay) {
                seg.addEventListener('click', e => { e.stopPropagation(); onTokenPlay(tok); });
            }
        } else {
            if (onFullPlay) {
                seg.style.cursor = 'pointer';
                seg.addEventListener('click', e => { e.stopPropagation(); onFullPlay(); });
            }
        }
        wrap.appendChild(seg);
        i = j;
    }
    return wrap;
}