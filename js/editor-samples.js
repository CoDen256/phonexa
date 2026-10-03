/**
 * editor-samples.js — Sample management.
 *
 * Two sample editor modes:
 *   1. Samples tab (seInline):  openSampleEditor(idx)       — no jump button
 *   2. Inline in vowel form:    openSampleInVowelEditor(idx) — shows ↗ Samples button
 *
 * Token analysis opens in a separate tab (js/praat.js, praat.html) — a
 * Praat-faithful static analysis page (waveform + spectrogram + formants +
 * pitch, Praat's own default Burg/autocorrelation settings, no dual-ceiling
 * heuristics). It posts the result back via window.postMessage; see the
 * 'message' listener near the bottom of this file.
 */

const SAMPLE_SERVER = '';


// ─── Module state ─────────────────────────────────────────────────────────────
let _wave      = null;   // { samples: Float32Array, sampleRate, duration(ms) }
let _waveUrl   = null;   // URL that _wave was decoded from
let _wavePeaks = null;   // [Float32Array mn, Float32Array mx]

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
    // Always flush the current draft back to samplesDraft before switching samples.
    // This ensures analysis done in one sample is not lost when opening another.
    if (state.sampleIdx != null && state.sampleIdx >= 0 &&
        state.sampleDraft && state.sampleIdx !== idx) {
        state.samplesDraft[state.sampleIdx] = clone(state.sampleDraft);
        if (typeof setLangSamples === 'function') setLangSamples(state.selKey, state.samplesDraft);
    }
    state.sampleIdx   = idx;
    state.sampleDraft = idx >= 0 ? clone(state.samplesDraft[idx])
        : {text:'', audio:null, phonemic:null, tokens:[], representative:null};
    // Don't reset _wave — can reuse if same audio URL loaded
}

function closeSampleEditor() {
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
    container.querySelector('#seText').addEventListener('input', e => { s.text = e.target.value; renderSampleList(); renderTokenRows(tokContainer); });
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
    const tokContainer = document.createElement('div'); tokContainer.className = 'se-tokens';
    container.appendChild(tokContainer);

    const addTok = document.createElement('button');
    addTok.className = 'add-word-btn'; addTok.type = 'button'; addTok.textContent = '+ Add token';
    addTok.addEventListener('click', () => {
        const fullLen = (s.text||'').length;
        s.tokens = [...(s.tokens||[]), {symbol:'', position:[0, fullLen], analysis:null}];
        renderTokenRows(tokContainer);
    });
    container.appendChild(addTok);

    renderTokenRows(tokContainer);
    attachGlobalDragHandlers();

    if (s.audio) loadSampleAudio(s.audio);
}

// ─── Token rows ───────────────────────────────────────────────────────────────
function renderTokenRows(tokCont) {
    const container = tokCont || document.querySelector('.se-tokens');
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
            ? `<span class="tok-analysis ok">F1 ${an.f1} · F2 ${an.f2}${an.f0 ? ` · F0 ${an.f0}` : ''} Hz</span>`
            : `<span class="tok-analysis pending">not analyzed</span>`;
        bot.innerHTML = `
      <div class="field" style="flex:none;width:60px"><label>Start</label><input type="number" class="tok-ps" value="${ps}" style="width:100%"></div>
      <div class="field" style="flex:none;width:60px"><label>End</label><input type="number" class="tok-pe" value="${pe}" style="width:100%"></div>
      ${an?.slice ? `<button class="btn btn-secondary btn-sm tok-play" type="button">▶ Play</button>` : ''}
      <button class="btn btn-secondary btn-sm tok-analyze" type="button">🔬 Formant Lab</button>
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
        bot.querySelector('.tok-analyze')?.addEventListener('click', () => openFormantLab(i));
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
    });

    document.addEventListener('mouseup', () => { _textDrag = null; });
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

// ─── Formant Lab (praat.html) — opens in a new tab for the WHOLE sample (every
// token as its own section, scrolled/highlighted to the one requested), posts
// each token's result back individually as its own "✓ Apply" is clicked ──────
function openFormantLab(tokIdx) {
    const s = state.sampleDraft;
    if (!s?.tokens?.length) return;
    if (!s.audio) { toast('Add an audio URL first'); return; }

    const qp = new URLSearchParams({
        audio: s.audio,
        sampleText: s.text || '',
        scrollTo: String(tokIdx),
        tokens: JSON.stringify(s.tokens.map(t => ({ symbol: t.symbol || '', position: t.position, analysis: t.analysis || null }))),
    });

    window.open('praat.html?' + qp.toString(), '_blank');
}

window.addEventListener('message', e => {
    if (e.origin !== location.origin) return;
    const data = e.data;
    if (!data || data.type !== 'praat-analysis-result') return;
    // Guard against the user having switched samples/tokens while the Formant Lab tab was open.
    if (state.sampleDraft?.audio !== data.audioUrl) return;
    const tok = state.sampleDraft?.tokens?.[data.tokIdx];
    if (!tok) return;
    tok.analysis = data.analysis;
    markUnsaved();
    renderTokenRows(); renderSampleList();
    toast(`Applied F1 ${data.analysis.f1} · F2 ${data.analysis.f2} Hz to token`);
});

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

// encodeWavBlob lives in audio.js (loaded before this file) — shared, no local copy needed.

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