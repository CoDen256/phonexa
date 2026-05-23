/**
 * editor-samples.js — Sample management panel + editor for the language editor.
 *
 * Provides:
 *   renderSampleList()    — renders the sample cards in the samples panel
 *   openSampleEditor(idx) — opens idx>=0 (existing) or -1 (new)
 *   closeSampleEditor()   — clears sample editing state
 *   buildSampleForm()     — builds the right-pane sample editor
 *   switchToSamplesTab()  — activates the samples panel
 *   switchToVowelsTab()   — activates the vowels panel
 *
 * Waveform and analysis adapted from practice.js.
 * Requires: utils.js globals ($s,$t), state, clone(), toast(), markUnsaved(),
 *           makeDividerLabel() (editor-form.js), closeVowelEditor() (editor-lang.js)
 */

const SAMPLE_SERVER = 'http://localhost:5050';

// ─── Module-level waveform state ──────────────────────────────────────────────
let _wave      = null;   // { samples: Float32Array, sampleRate, duration(ms) }
let _leftFrac  = 0.0;    // left handle 0-1
let _rightFrac = 1.0;    // right handle 0-1
let _activeTok = null;   // index of token whose slice is loaded, or null
let _dragging  = null;   // 'left' | 'right' | null
let _waveResizeObs = null;

// ─── Tab switching ─────────────────────────────────────────────────────────────
function switchToSamplesTab() {
    state.samplesTab = true;
    document.getElementById('vowelPanel')?.style.setProperty('display','none');
    document.getElementById('samplesPanel')?.style.removeProperty('display');
    document.getElementById('tabVowelsList')?.classList.remove('active');
    document.getElementById('tabSamplesList')?.classList.add('active');
    updatePaneHint();
    renderSampleList();
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
    const hasEditor = state.vowelIdx !== null || state.sampleIdx !== null;
    ph.style.display = hasEditor ? 'none' : 'block';
    ph.textContent = state.samplesTab
        ? 'Select a sample to edit · or + Add Sample'
        : 'Select a vowel on the chart or card to edit';
}

// ─── Sample list ───────────────────────────────────────────────────────────────
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

        // Delete
        const del = document.createElement('button');
        del.className = 'vc-del-btn'; del.textContent = '×'; del.title = 'Delete sample';
        del.addEventListener('click', e => {
            e.stopPropagation();
            if (!confirm(`Delete sample "${s.text || '?'}"?`)) return;
            state.samplesDraft.splice(i, 1);
            if (state.sampleIdx === i)      closeSampleEditor();
            else if (state.sampleIdx > i)   state.sampleIdx--;
            markUnsaved(); renderSampleList();
        });
        card.appendChild(del);

        // Body
        const chips = (s.tokens || []).map(t => {
            const ok = t.analysis?.f1 ? '●' : '○';
            return `<span class="sc-token-chip">${ok} ${t.symbol}</span>`;
        }).join('');
        const body = document.createElement('div');
        body.innerHTML = `
      <div class="sc-text">${escHtml(s.text || '?')}</div>
      ${s.phonemic ? `<div class="sc-phonemic">${escHtml(s.phonemic)}</div>` : ''}
      <div class="sc-tokens">${chips || '<span style="font-size:.62rem;color:var(--muted)">no tokens</span>'}</div>`;
        card.appendChild(body);
        card.addEventListener('click', () => openSampleEditor(i));
        el.appendChild(card);
    });

    // Update tab count
    const t = document.getElementById('tabSamplesList');
    if (t) t.textContent = `Samples (${samples.length})`;
    const hd = document.getElementById('samplesSectionTitle');
    if (hd) hd.textContent = `Samples (${samples.length})`;
}

// ─── Open / close sample editor ───────────────────────────────────────────────
function openSampleEditor(idx) {
    if (state.vowelIdx !== null) closeVowelEditor();
    state.sampleIdx   = idx;
    state.sampleDraft = idx >= 0
        ? clone(state.samplesDraft[idx])
        : {text:'', audio:null, phonemic:null, tokens:[]};

    _wave = null; _leftFrac = 0; _rightFrac = 1; _activeTok = null;

    document.getElementById('veInline').style.display = 'none';
    const se = document.getElementById('seInline');
    se.style.display = 'block';
    buildSampleForm();
    updatePaneHint();
    renderSampleList();
}

function closeSampleEditor() {
    state.sampleIdx = null; state.sampleDraft = null;
    _wave = null; _activeTok = null;
    if (_waveResizeObs) { _waveResizeObs.disconnect(); _waveResizeObs = null; }
    document.getElementById('seInline').style.display = 'none';
    updatePaneHint();
    renderSampleList();
}

function applySample() {
    if (!state.sampleDraft) return;
    if (!state.samplesDraft) state.samplesDraft = [];
    if (state.sampleIdx < 0) state.samplesDraft.push(state.sampleDraft);
    else state.samplesDraft[state.sampleIdx] = state.sampleDraft;
    markUnsaved();
    const txt = state.sampleDraft.text;
    const idx = state.sampleIdx < 0 ? state.samplesDraft.length - 1 : state.sampleIdx;
    state.sampleIdx = idx;
    state.sampleDraft = clone(state.samplesDraft[idx]);
    renderSampleList();
    toast(`Sample "${txt}" saved`);
}

// ─── Build sample form ────────────────────────────────────────────────────────
function buildSampleForm() {
    const sec = document.getElementById('seInline');
    if (!sec || !state.sampleDraft) return;
    sec.innerHTML = '';
    const s = state.sampleDraft;
    const c = state.langDraft?.color || '#7eb8f7';

    // Header
    const hdr = document.createElement('div'); hdr.className = 've-inline-header';
    hdr.innerHTML = `<span class="ve-inline-title">${state.sampleIdx < 0 ? 'New Sample' : 'Edit sample'}</span>`;
    const cancelBtn = document.createElement('button'); cancelBtn.className = 'btn btn-secondary btn-sm'; cancelBtn.textContent = 'Cancel'; cancelBtn.type = 'button';
    const applyBtn  = document.createElement('button'); applyBtn.className  = 'btn btn-primary btn-sm';   applyBtn.textContent = 'Apply';  applyBtn.type = 'button';
    hdr.appendChild(cancelBtn); hdr.appendChild(applyBtn);
    cancelBtn.addEventListener('click', closeSampleEditor);
    applyBtn.addEventListener('click', applySample);
    sec.appendChild(hdr);

    // Text + phonemic
    const metaRow = document.createElement('div'); metaRow.className = 've-meta';
    metaRow.innerHTML = `
    <div class="field" style="flex:2"><label>Text <span style="font-size:.55rem;opacity:.4">plain — no markup</span></label><input type="text" id="seText" value="${escAttr(s.text||'')}" placeholder="feet"></div>
    <div class="field" style="flex:1"><label>Phonemic</label><input type="text" id="sePhonemic" value="${escAttr(s.phonemic||'')}" placeholder="/fiːt/"></div>`;
    sec.appendChild(metaRow);
    sec.querySelector('#seText').addEventListener('input', e => { s.text = e.target.value; renderSampleList(); renderTokenRows(); });
    sec.querySelector('#sePhonemic').addEventListener('input', e => { s.phonemic = e.target.value || null; });

    // Audio URL
    const audioRow = document.createElement('div'); audioRow.className = 've-meta';
    audioRow.innerHTML = `
    <div class="field" style="flex:1"><label>Audio URL</label>
      <div style="display:flex;gap:4px">
        <input type="url" id="seAudioUrl" value="${escAttr(s.audio||'')}" placeholder="https://… or lang/…" style="flex:1;min-width:0">
        <button class="btn btn-secondary btn-sm" id="seLoadAudio" type="button">⟳ Load</button>
        <button class="btn btn-secondary btn-sm" id="sePlayAudio" type="button">▶</button>
      </div>
    </div>`;
    sec.appendChild(audioRow);
    sec.querySelector('#seAudioUrl').addEventListener('input', e => { s.audio = e.target.value || null; });
    sec.querySelector('#seLoadAudio').addEventListener('click', () => loadSampleAudio(s.audio));
    sec.querySelector('#sePlayAudio').addEventListener('click', () => { if (s.audio) new Audio(s.audio).play().catch(()=>{}); });

    // ── Waveform ────────────────────────────────────────────────────────────────
    sec.appendChild(makeDividerLabel('Audio slice'));

    const waveInfo = document.createElement('div');
    waveInfo.style.cssText = 'font-size:.62rem;color:var(--muted);margin-bottom:3px';
    waveInfo.id = 'seWaveInfo';
    waveInfo.textContent = s.audio ? 'Click "⟳ Load" to decode audio' : 'Add an audio URL and click "⟳ Load"';
    sec.appendChild(waveInfo);

    const waveWrap = document.createElement('div'); waveWrap.className = 'waveform-wrap'; waveWrap.id = 'seWaveWrap';
    waveWrap.innerHTML = `<canvas id="seWaveCanvas"></canvas>`;
    sec.appendChild(waveWrap);

    const timeRow = document.createElement('div');
    timeRow.style.cssText = 'display:flex;justify-content:space-between;font-size:.6rem;color:var(--muted);padding:2px 2px 6px;font-family:monospace';
    timeRow.innerHTML = `<span id="seSliceL">0 ms</span><span id="seSliceLen">—</span><span id="seSliceR">0 ms</span>`;
    sec.appendChild(timeRow);

    attachWaveHandlers(waveWrap);
    // Draw once layout settles
    requestAnimationFrame(() => { drawWaveform(); });
    // Resize observer to redraw on pane resize
    if (window.ResizeObserver) {
        _waveResizeObs = new ResizeObserver(() => drawWaveform());
        _waveResizeObs.observe(waveWrap);
    }

    // ── Tokens ──────────────────────────────────────────────────────────────────
    sec.appendChild(makeDividerLabel('Tokens'));
    const tokContainer = document.createElement('div'); tokContainer.id = 'seTokens';
    sec.appendChild(tokContainer);
    renderTokenRows();

    const addTok = document.createElement('button'); addTok.className = 'add-word-btn'; addTok.type = 'button'; addTok.textContent = '+ Add token';
    addTok.addEventListener('click', () => {
        s.tokens = [...(s.tokens || []), {symbol:'', position:[0,0], analysis:null}];
        renderTokenRows();
    });
    sec.appendChild(addTok);

    if (s.audio) loadSampleAudio(s.audio);
}

// ─── Token rows ───────────────────────────────────────────────────────────────
function renderTokenRows() {
    const container = document.getElementById('seTokens');
    if (!container || !state.sampleDraft) return;
    container.innerHTML = '';
    const s = state.sampleDraft;
    const c = state.langDraft?.color || '#7eb8f7';
    const allSymbols = [...new Set((state.langDraft?.vowels || []).flatMap(v => v.symbols || []))].filter(Boolean);

    (s.tokens || []).forEach((tok, i) => {
        const isAct = _activeTok === i;
        const row   = document.createElement('div');
        row.className = 'token-row' + (isAct ? ' active' : '');
        if (isAct) row.style.borderColor = c;

        // Symbol selector
        const symOpts = ['', ...allSymbols].map(sym =>
            `<option value="${escAttr(sym)}" ${tok.symbol===sym?'selected':''}>${sym||'—'}</option>`
        ).join('');

        // Text highlight
        const text = s.text || '';
        const [ps, pe] = tok.position || [0, 0];
        const before = escHtml(text.slice(0, ps));
        const mid    = escHtml(text.slice(ps, pe));
        const after  = escHtml(text.slice(pe));
        const hl = `${before}<mark style="background:${c}33;color:${c};border-radius:2px;padding:0 1px">${mid||'?'}</mark>${after}`;

        const an = tok.analysis;
        const anHtml = an?.f1
            ? `<span class="tok-analysis ok">F1 ${an.f1} · F2 ${an.f2} Hz</span>`
            : `<span class="tok-analysis pending">not analyzed</span>`;

        const sliceHtml = an?.slice
            ? `<span style="font-size:.6rem;color:#4a6888;font-family:monospace">[${an.slice[0]}–${an.slice[1]} ms]</span>` : '';

        row.innerHTML = `
      <div style="display:flex;gap:6px;align-items:center;margin-bottom:5px">
        <select class="tok-sym-sel">${symOpts}</select>
        <span style="flex:1;font-size:.8rem;font-family:Georgia,serif;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">${hl}</span>
        <button class="btn btn-secondary btn-sm tok-del" type="button" title="Remove">✕</button>
      </div>
      <div style="display:flex;gap:6px;align-items:flex-end;flex-wrap:wrap">
        <div class="field" style="flex:none;width:62px"><label>Start</label><input type="number" class="tok-ps" min="0" max="${text.length}" value="${ps}" style="width:100%"></div>
        <div class="field" style="flex:none;width:62px"><label>End</label><input type="number" class="tok-pe" min="0" max="${text.length}" value="${pe}" style="width:100%"></div>
        <button class="btn btn-secondary btn-sm tok-mark" type="button" title="Mark position in text">✎ Mark</button>
        <button class="btn ${isAct?'btn-primary':'btn-secondary'} btn-sm tok-slice" type="button">${isAct?'⏱ Editing slice':'⏱ Set slice'}</button>
        <button class="btn btn-secondary btn-sm tok-analyze" type="button" ${_wave?'':'disabled'}>⚡ Analyze</button>
        ${anHtml} ${sliceHtml}
      </div>`;

        row.querySelector('.tok-sym-sel').addEventListener('change', e => { tok.symbol = e.target.value; renderSampleList(); });
        row.querySelector('.tok-ps').addEventListener('input', e => {
            tok.position = [Math.min(+e.target.value, (tok.position[1]||0)), tok.position[1]||0];
            renderTokenRows();
        });
        row.querySelector('.tok-pe').addEventListener('input', e => {
            tok.position = [tok.position[0]||0, Math.max(+e.target.value, tok.position[0]||0)];
            renderTokenRows();
        });
        row.querySelector('.tok-del').addEventListener('click', () => {
            s.tokens.splice(i, 1);
            if (_activeTok === i) _activeTok = null;
            else if (_activeTok > i) _activeTok--;
            renderTokenRows(); renderSampleList();
        });
        row.querySelector('.tok-slice').addEventListener('click', () => {
            if (isAct) { _activeTok = null; }
            else {
                _activeTok = i;
                // Restore handles from existing analysis slice
                if (an?.slice && _wave) {
                    _leftFrac  = an.slice[0] / _wave.duration;
                    _rightFrac = an.slice[1] / _wave.duration;
                    drawWaveform(); updateSliceDisplay();
                }
            }
            renderTokenRows();
        });
        row.querySelector('.tok-mark').addEventListener('click', () => showCharPicker(i, row));
        row.querySelector('.tok-analyze').addEventListener('click', () => analyzeToken(i));

        container.appendChild(row);
    });
}

// ─── Character position picker ────────────────────────────────────────────────
function showCharPicker(tokIdx, rowEl) {
    const s    = state.sampleDraft;
    const text = s.text || '';
    if (!text) { toast('Enter sample text first'); return; }
    document.getElementById('seCharPicker')?.remove();

    const tok = s.tokens[tokIdx];
    let picking = 'start';  // 'start' | 'end'

    const wrap = document.createElement('div'); wrap.id = 'seCharPicker';
    wrap.style.cssText = 'margin-top:5px;padding:5px 6px;background:#0d1a28;border:1px solid var(--border);border-radius:6px;user-select:none';
    const hint = document.createElement('div');
    hint.style.cssText = 'font-size:.6rem;color:var(--muted);margin-bottom:4px;font-family:system-ui';

    const render = () => {
        wrap.innerHTML = ''; wrap.appendChild(hint);
        hint.textContent = picking === 'start' ? 'Click character to set start…' : 'Click character to set end…';
        const charRow = document.createElement('div');
        charRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:1px;font-family:Georgia,serif;font-size:1rem';
        const [ps, pe] = tok.position || [0, 0];
        [...text].forEach((ch, ci) => {
            const sp = document.createElement('span');
            const inSel = ci >= ps && ci < pe;
            sp.style.cssText = `padding:1px 3px;border-radius:3px;cursor:pointer;${inSel?'background:'+( state.langDraft?.color||'#7eb8f7')+'33;color:'+(state.langDraft?.color||'#7eb8f7'):''}`
            sp.textContent = ch === ' ' ? '·' : ch;
            sp.title = `char ${ci}`;
            sp.addEventListener('click', () => {
                if (picking === 'start') {
                    tok.position = [ci, Math.max(ci + 1, pe)];
                    picking = 'end';
                } else {
                    tok.position = [ps, ci + 1];
                    picking = 'start';
                }
                render(); renderTokenRows();
            });
            charRow.appendChild(sp);
        });
        wrap.appendChild(charRow);
        const done = document.createElement('button'); done.className = 'btn btn-secondary btn-sm'; done.type = 'button'; done.textContent = 'Done'; done.style.marginTop = '5px';
        done.addEventListener('click', () => wrap.remove());
        wrap.appendChild(done);
    };
    render();
    rowEl.appendChild(wrap);
}

// ─── Waveform ─────────────────────────────────────────────────────────────────
async function loadSampleAudio(url) {
    if (!url) { document.getElementById('seWaveInfo').textContent = 'Add an audio URL and click "⟳ Load"'; return; }
    const info = document.getElementById('seWaveInfo');
    if (info) info.textContent = 'Loading…';
    try {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const ab   = await resp.arrayBuffer();
        const actx = new (window.AudioContext || window.webkitAudioContext)();
        const dec  = await actx.decodeAudioData(ab);
        actx.close();
        _wave = { samples: dec.getChannelData(0), sampleRate: dec.sampleRate, duration: dec.duration * 1000 };
        _leftFrac = 0; _rightFrac = 1;
        drawWaveform(); updateSliceDisplay();
        if (info) info.textContent = `${(_wave.duration / 1000).toFixed(2)}s · ${(_wave.sampleRate / 1000).toFixed(1)} kHz`;
        renderTokenRows();  // enable analyze buttons
    } catch(e) {
        if (info) info.textContent = 'Failed: ' + e.message;
        console.warn('loadSampleAudio:', e);
    }
}

function drawWaveform() {
    const canvas = document.getElementById('seWaveCanvas');
    if (!canvas) return;
    const wrap = canvas.parentElement;
    const W = canvas.width  = wrap ? wrap.clientWidth  || 400 : 400;
    const H = canvas.height = wrap ? wrap.clientHeight || 60  : 60;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#0d1a28'; ctx.fillRect(0, 0, W, H);

    const c = state.langDraft?.color || '#7eb8f7';
    if (!_wave) {
        ctx.fillStyle = '#1e3048'; ctx.fillRect(0, H/2 - 1, W, 2);
        return;
    }
    const { samples } = _wave;
    const step = Math.max(1, Math.floor(samples.length / W));
    const lx = Math.floor(_leftFrac  * W);
    const rx = Math.ceil(_rightFrac  * W);

    // Selection bg
    ctx.fillStyle = c + '18'; ctx.fillRect(lx, 0, rx - lx, H);

    // Bars
    for (let x = 0; x < W; x++) {
        const i0 = Math.floor((x / W) * samples.length);
        const i1 = Math.min(samples.length, i0 + step);
        let mn = 0, mx = 0;
        for (let i = i0; i < i1; i++) { if (samples[i] < mn) mn = samples[i]; if (samples[i] > mx) mx = samples[i]; }
        const yT = Math.floor((1 - mx) * H / 2);
        const yB = Math.ceil((1 - mn)  * H / 2);
        ctx.fillStyle = (x >= lx && x <= rx) ? c + 'cc' : c + '44';
        ctx.fillRect(x, yT, 1, Math.max(1, yB - yT));
    }
    // Handle lines
    ctx.fillStyle = c; ctx.fillRect(lx, 0, 2, H); ctx.fillRect(rx - 1, 0, 2, H);
}

function attachWaveHandlers(wrap) {
    const getX = (e, touch) => {
        const r   = wrap.getBoundingClientRect();
        const cxp = touch ? e.touches[0].clientX : e.clientX;
        return Math.max(0, Math.min(1, (cxp - r.left) / r.width));
    };
    const startDrag = frac => {
        const dl = Math.abs(frac - _leftFrac), dr = Math.abs(frac - _rightFrac);
        _dragging = dl < dr ? 'left' : 'right';
    };
    const moveDrag = frac => {
        if (!_dragging || !_wave) return;
        if (_dragging === 'left')  _leftFrac  = Math.min(frac, _rightFrac - 0.005);
        else                       _rightFrac = Math.max(frac, _leftFrac  + 0.005);
        drawWaveform(); updateSliceDisplay();
    };

    wrap.addEventListener('mousedown', e => { if (!_wave) return; startDrag(getX(e)); e.preventDefault(); });
    document.addEventListener('mousemove', e => { if (_dragging) moveDrag(getX(e)); });
    document.addEventListener('mouseup',   ()  => { _dragging = null; });

    wrap.addEventListener('touchstart', e => { if (!_wave) return; startDrag(getX(e, true)); e.preventDefault(); }, {passive:false});
    wrap.addEventListener('touchmove',  e => { moveDrag(getX(e, true)); e.preventDefault(); }, {passive:false});
    wrap.addEventListener('touchend',   ()  => { _dragging = null; });
}

function updateSliceDisplay() {
    if (!_wave) return;
    const sl = _leftFrac  * _wave.duration;
    const sr = _rightFrac * _wave.duration;
    const g  = id => document.getElementById(id);
    if (g('seSliceL'))   g('seSliceL').textContent   = sl.toFixed(0)   + ' ms';
    if (g('seSliceR'))   g('seSliceR').textContent   = sr.toFixed(0)   + ' ms';
    if (g('seSliceLen')) g('seSliceLen').textContent = (sr - sl).toFixed(0) + ' ms';
}

// ─── Token analysis ───────────────────────────────────────────────────────────
async function analyzeToken(tokenIdx) {
    if (!_wave) { toast('Load audio first'); return; }
    const tok = state.sampleDraft?.tokens?.[tokenIdx];
    if (!tok) return;

    const startMs  = _leftFrac  * _wave.duration;
    const endMs    = _rightFrac * _wave.duration;
    const i0 = Math.floor(_leftFrac  * _wave.samples.length);
    const i1 = Math.ceil( _rightFrac * _wave.samples.length);
    const slice = _wave.samples.slice(i0, i1);

    const btn = document.querySelectorAll('.tok-analyze')[tokenIdx];
    if (btn) { btn.disabled = true; btn.textContent = '…'; }

    try {
        const form = new FormData();
        form.append('file',   encodeWavBlob(slice, _wave.sampleRate), 'slice.wav');
        form.append('config', JSON.stringify({single_segment: true}));
        const resp = await fetch(`${SAMPLE_SERVER}/frames`, {method:'POST', body:form});
        if (!resp.ok) throw new Error('Server ' + resp.status);
        const data  = await resp.json();
        const frame = data.frames?.[0];
        if (!frame?.voiced) { toast('No voiced speech in slice'); return; }

        tok.analysis = {
            slice:        [Math.round(startMs), Math.round(endMs)],
            f1:           frame.f1,
            f2:           frame.f2,
            ceiling:      frame.used_back_config ? 1800 : 5000,
            preEmphasis:  50,
            maxFormants:  5,
            windowLength: 25,
        };
        markUnsaved();
        toast(`F1 ${frame.f1} Hz · F2 ${frame.f2} Hz`);
        renderTokenRows(); renderSampleList();
    } catch(e) {
        toast('Analysis failed: ' + e.message);
        console.warn(e);
    } finally {
        if (btn) { btn.disabled = !_wave; btn.textContent = '⚡ Analyze'; }
    }
}

// ─── WAV encoder ─────────────────────────────────────────────────────────────
function encodeWavBlob(samples, sr) {
    const buf  = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buf);
    const ws   = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
    ws(0,'RIFF'); view.setUint32(4, 36 + samples.length * 2, true);
    ws(8,'WAVE'); ws(12,'fmt ');
    view.setUint32(16,16,true); view.setUint16(20,1,true); view.setUint16(22,1,true);
    view.setUint32(24,sr,true); view.setUint32(28,sr*2,true);
    view.setUint16(32,2,true);  view.setUint16(34,16,true);
    ws(36,'data'); view.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i++)
        view.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), true);
    return new Blob([buf], {type:'audio/wav'});
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function escHtml(s)  { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function escAttr(s)  { return String(s).replace(/"/g,'&quot;'); }