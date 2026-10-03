/**
 * praat.js — Formant Lab (praat.html).
 *
 * Standalone page replicating Praat's own Spectrogram editor window: the
 * derived spectrogram with formant dots (red) and a pitch curve (blue, own
 * right-axis scale) overlaid — no separate amplitude waveform panel; the
 * spectrogram IS the main view here, same as every per-section mini view.
 *
 * Analysis is done by /analyze-praat on formanter.py — parselmouth's bare
 * default Burg formant / autocorrelation pitch / spectrogram calls, with
 * none of the dual-ceiling/continuity/smoothing heuristics the live
 * practice panel's /frames pipeline uses. See formanter.py for why.
 *
 * One unified concept — a SECTION — is a labeled sub-range of whatever's
 * loaded, shown as a band on the main spectrogram AND as its own small card
 * with a zoomed "mini-spectrogram" (the section's range padded a bit on
 * each side, so you can drag either edge to extend/shrink right there, or
 * drag the main spectrogram's band — both write to the same section object
 * and stay in sync). Launched two ways, which decide what the sections ARE
 * and what each card's save/apply action does:
 *
 *  - standalone (no ?tokens= in the URL): "ingestion mode" — sections are
 *    auto-suggested from js/vad.js's detectSentences() (same heuristic
 *    Shadowing uses), adjustable/addable/removable, each independently
 *    saveable as its own library Sample via js/ingest.js's uploadSlice().
 *    The dropped file itself is never uploaded whole, only saved sections.
 *  - from the editor (editor-samples.js), via
 *    ?audio=<url>&sampleText=<text>&tokens=<json>&scrollTo=<idx>: "sample
 *    mode" — one section per token in the sample, each with a Before
 *    (existing stored value) / After (freshly computed from this section's
 *    current bounds) F1/F2/F0 readout and its own Apply button, posting
 *    that ONE token's result back via window.opener.postMessage — same
 *    payload shape as before, just sent per-card instead of from one
 *    global button. Opening it "for" one token just scrolls/highlights
 *    that token's card; every token in the sample is always shown.
 */

// ─── Query params / launch context ──────────────────────────────────────────────
const params = new URLSearchParams(location.search);
const sampleCtx = params.has('tokens') ? {
  audioUrl: params.get('audio') || '',
  sampleText: params.get('sampleText') || '',
  scrollTo: params.has('scrollTo') ? parseInt(params.get('scrollTo'), 10) : null,
  tokens: (() => { try { return JSON.parse(params.get('tokens') || '[]'); } catch (e) { return []; } })(),
} : null;

const ingestMode = !sampleCtx;

// ─── State ──────────────────────────────────────────────────────────────────────
let currentBuffer = null;     // decoded AudioBuffer (all channels, for display + playback)
let analysisResult = null;    // { duration_ms, formants, pitch, spectrogram }
let selStart = 0, selEnd = 0; // fractions of duration — scratch selection, ingest mode only (drawing a brand-new section)
let dragging = false;         // scratch-selection drag (main spectrogram, empty space, ingest mode)
let sectionDrag = null;       // { section, mode: 'resize-start'|'resize-end'|'move', moveOffset } — main-spectrogram section drag
let activeSource = null;

let sections = [];        // unified: [{id, mode:'ingest'|'token', start, end, ...mode fields}]
let nextSectionId = 1;
let languagesList = [];    // [{id, key, label, color, enabled}] — ingest mode's per-section language picker

function setStatus(text) { const el = document.getElementById('uploadStatus'); if (el) el.textContent = text; }
function escapeAttr(str) { return String(str ?? '').replace(/"/g, '&quot;'); }

// encodeWavBlob()/extractMonoSlice()/computeMonoData() come from js/audio.js
// (loaded before this file); detectSentences() from js/vad.js; uploadSlice()
// from js/ingest.js.

async function loadLanguagesList() {
  try {
    const resp = await fetch('/api/v1/languages');
    languagesList = resp.ok ? await resp.json() : [];
  } catch (e) { languagesList = []; }
  renderSections();   // refresh in case sections were already drawn before this resolved
}

// ─── Audio loading ──────────────────────────────────────────────────────────────
async function decodeArrayBuffer(ab) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const buf = await ctx.decodeAudioData(ab);
  ctx.close();
  return buf;
}
function fetchArrayBuffer(url) {
  // XHR, not fetch() — tolerates local servers without CORS headers (same as editor-samples.js)
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url); xhr.responseType = 'arraybuffer';
    xhr.onload = () => xhr.status < 400 ? resolve(xhr.response) : reject(new Error('HTTP ' + xhr.status));
    xhr.onerror = () => reject(new Error('Network error'));
    xhr.send();
  });
}

async function loadBuffer(buffer) {
  currentBuffer = buffer;
  selStart = 0; selEnd = 0;
  analysisResult = null;
  sections = [];
  document.getElementById('dropzone').style.display = 'none';
  document.getElementById('praatPanels').style.display = 'block';
  document.getElementById('paramsRow').style.display = 'flex';
  document.getElementById('channelInfo').textContent =
      `${buffer.numberOfChannels} ch · ${(buffer.sampleRate / 1000).toFixed(1)} kHz · ${buffer.duration.toFixed(2)}s`;
  document.getElementById('sectionsPanel').style.display = 'block';
  document.getElementById('ingestToolbar').style.display = ingestMode ? 'flex' : 'none';
  document.getElementById('sectionsHint').textContent = ingestMode
    ? '(auto-suggested from silence gaps — drag a section\'s own mini-spectrogram, or its band on the main spectrogram above, to adjust)'
    : '(one per token in this sample — drag to adjust its time range, Apply sends that token\'s result back to the editor)';
  if (ingestMode) {
    document.getElementById('fileToolbar').style.display = 'flex';
    suggestSections();
  } else {
    seedSectionsFromTokens();
  }
  await runAnalyze();
  if (sampleCtx?.scrollTo != null) scrollToSection(s => s.tokIdx === sampleCtx.scrollTo);
}

// ─── Section model ──────────────────────────────────────────────────────────────
function sectionMs(s) {
  const durationMs = currentBuffer.duration * 1000;
  return [Math.round(s.start * durationMs), Math.round(s.end * durationMs)];
}
function sectionWindow(s) {
  const durationMs = currentBuffer.duration * 1000;
  const lenMs = (s.end - s.start) * durationMs;
  const padMs = Math.max(300, lenMs * 0.2);
  const padFrac = padMs / durationMs;
  return { winStart: Math.max(0, s.start - padFrac), winEnd: Math.min(1, s.end + padFrac) };
}
function sectionAt(frac) {
  for (let i = sections.length - 1; i >= 0; i--) {
    const s = sections[i];
    if (frac >= s.start && frac <= s.end) return s;
  }
  return null;
}
function nearestEdge(s, frac, elWidthPx) {
  const tol = 6 / Math.max(1, elWidthPx);
  if (Math.abs(frac - s.start) <= tol) return 'start';
  if (Math.abs(frac - s.end) <= tol) return 'end';
  return null;
}

// ─── Ingestion mode: auto-suggest + create/remove ───────────────────────────────
function suggestSections() {
  const mono = computeMonoData(currentBuffer);
  const { segments } = detectSentences(mono, currentBuffer.sampleRate);
  const durationMs = currentBuffer.duration * 1000;
  sections = segments.map(s => ({
    id: nextSectionId++, mode: 'ingest', start: s.start / durationMs, end: s.end / durationMs,
    text: '', phonemic: '', languageId: null, savedSampleId: null,
  }));
  renderSections();
}

function commitSectionFromSelection() {
  if (selEnd <= selStart) { setStatus('Select a range first'); return; }
  sections.push({ id: nextSectionId++, mode: 'ingest', start: selStart, end: selEnd, text: '', phonemic: '', languageId: null, savedSampleId: null });
  selStart = 0; selEnd = 0;
  renderSections(); redrawAll();
}

async function saveSection(s) {
  if (!s.text.trim()) { setStatus('Text is required before saving a section'); return; }
  if (!s.languageId) { setStatus('Pick a language before saving a section'); return; }
  const [t0, t1] = sectionMs(s);
  try {
    const result = await uploadSlice(currentBuffer, t0, t1, { languageId: s.languageId, text: s.text, phonemic: s.phonemic || undefined });
    s.savedSampleId = result.id;
    renderSections();
    setStatus(`Saved section as Sample #${result.id}`);
  } catch (e) {
    setStatus('Save failed: ' + e.message);
  }
}

// ─── Sample mode: seed one section per token, apply back per-card ──────────────
function seedSectionsFromTokens() {
  const durationMs = currentBuffer.duration * 1000;
  const defaultLenFrac = Math.min(1, 300 / durationMs);
  sections = sampleCtx.tokens.map((t, idx) => {
    const an = t.analysis || {};
    const hasSlice = Array.isArray(an.slice);
    const start = hasSlice ? an.slice[0] / durationMs : 0;
    const end = hasSlice ? an.slice[1] / durationMs : Math.min(1, defaultLenFrac);
    return {
      id: nextSectionId++, mode: 'token', tokIdx: idx, symbol: t.symbol || '?',
      start, end,
      before: an.f1 != null ? { f1: an.f1, f2: an.f2, f0: an.f0 } : null,
      params: an,
    };
  });
  document.getElementById('tokenContext').style.display = 'block';
  document.getElementById('tokenSampleText').textContent =
      `"${sampleCtx.sampleText}" — ${sections.length} token(s)`;
  // Seed the global analysis params from the focused (scrollTo) token's existing config, if any.
  const focus = sections.find(s => s.tokIdx === sampleCtx.scrollTo) || sections[0];
  const c = focus?.params || {};
  if (c.max_number_of_formants) document.getElementById('pMaxFormants').value = c.max_number_of_formants;
  if (c.maximum_formant)         document.getElementById('pMaxFreq').value = c.maximum_formant;
  if (c.window_length)           document.getElementById('pWindowLen').value = c.window_length;
  if (c.pre_emphasis_from)       document.getElementById('pPreEmph').value = c.pre_emphasis_from;
  if (c.pitch_floor)             document.getElementById('pPitchFloor').value = c.pitch_floor;
  if (c.pitch_ceiling)           document.getElementById('pPitchCeiling').value = c.pitch_ceiling;
  renderSections();
}

function computeMeansForRange(startFrac, endFrac) {
  if (!analysisResult || !currentBuffer || endFrac <= startFrac) return null;
  const durationMs = currentBuffer.duration * 1000;
  const t0 = startFrac * durationMs, t1 = endFrac * durationMs;
  const inRange = t => t >= t0 && t <= t1;
  const f1s = [], f2s = [], f0s = [];
  for (const row of analysisResult.formants) {
    if (!inRange(row.t_ms)) continue;
    if (row.f1 != null) f1s.push(row.f1);
    if (row.f2 != null) f2s.push(row.f2);
  }
  for (const row of analysisResult.pitch) {
    if (!inRange(row.t_ms)) continue;
    if (row.f0 != null) f0s.push(row.f0);
  }
  const mean = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
  return { f1: mean(f1s), f2: mean(f2s), f0: mean(f0s), nFormantFrames: f1s.length };
}
function computeSelectionMeans() { return computeMeansForRange(selStart, selEnd); }

function applySection(s) {
  const means = computeMeansForRange(s.start, s.end);
  if (!means || means.f1 == null) { setStatus('No voiced formant frames in this section — adjust its bounds'); return; }
  const [t0, t1] = sectionMs(s);
  const payload = {
    type: 'praat-analysis-result',
    tokIdx: s.tokIdx,
    audioUrl: sampleCtx.audioUrl,
    analysis: {
      slice: [t0, t1],
      f1: Math.round(means.f1), f2: Math.round(means.f2),
      f0: means.f0 != null ? Math.round(means.f0) : null,
      max_number_of_formants: +(document.getElementById('pMaxFormants')?.value) || 5,
      maximum_formant: +(document.getElementById('pMaxFreq')?.value) || 5500,
      window_length: +(document.getElementById('pWindowLen')?.value) || 0.025,
      pre_emphasis_from: +(document.getElementById('pPreEmph')?.value) || 50,
      pitch_floor: +(document.getElementById('pPitchFloor')?.value) || 75,
      pitch_ceiling: +(document.getElementById('pPitchCeiling')?.value) || 600,
    },
  };
  if (!window.opener) { setStatus('No opener window found — was this tab opened from the editor?'); return; }
  window.opener.postMessage(payload, location.origin);
  s.before = { f1: payload.analysis.f1, f2: payload.analysis.f2, f0: payload.analysis.f0 };
  refreshSectionVisuals();
  setStatus(`Applied F1 ${payload.analysis.f1} · F2 ${payload.analysis.f2} Hz to token #${s.tokIdx + 1} (/${s.symbol}/)`);
}

// ─── Rendering: card list (structural — rebuild on add/remove only) ────────────
function renderSections() {
  const list = document.getElementById('sectionsList');
  if (!list) return;
  list.innerHTML = '';
  sections.forEach((s, i) => {
    const card = document.createElement('div');
    card.className = 'section-card';
    card.dataset.id = s.id;

    const header = s.mode === 'ingest'
      ? `<span class="section-idx">#${i + 1}</span><span class="section-time">${sectionMs(s).join('–')} ms</span>`
      : `<span class="section-idx">/${escapeAttr(s.symbol)}/</span><span class="section-time">${sectionMs(s).join('–')} ms</span>`;

    const body = s.mode === 'ingest' ? `
      <select class="section-lang">${['<option value="">— language —</option>']
        .concat(languagesList.map(l => `<option value="${l.id}"${s.languageId === l.id ? ' selected' : ''}>${escapeAttr(l.label)}</option>`)).join('')}</select>
      <input type="text" class="section-text" placeholder="text (required)" value="${escapeAttr(s.text)}">
      <input type="text" class="section-phonemic" placeholder="phonemic" value="${escapeAttr(s.phonemic)}">
      <button class="sent-btn section-play" type="button">▶</button>
      ${s.savedSampleId
        ? `<span class="section-saved">✓ Saved #${s.savedSampleId}</span>`
        : `<button class="sent-btn primary section-save" type="button">💾 Save</button>`}
      <button class="sent-btn section-remove" type="button">✕</button>
    ` : `
      <span class="section-values">—</span>
      <button class="sent-btn section-play" type="button">▶</button>
      <button class="sent-btn primary section-apply" type="button">✓ Apply</button>
    `;

    card.innerHTML = `
      <div class="section-header">${header}</div>
      <canvas class="section-mini"></canvas>
      <div class="section-body">${body}</div>
    `;
    list.appendChild(card);

    if (s.mode === 'ingest') {
      card.querySelector('.section-lang').addEventListener('change', e => { s.languageId = e.target.value ? +e.target.value : null; });
      card.querySelector('.section-text').addEventListener('input', e => { s.text = e.target.value; });
      card.querySelector('.section-phonemic').addEventListener('input', e => { s.phonemic = e.target.value; });
      card.querySelector('.section-remove').addEventListener('click', () => {
        sections = sections.filter(x => x.id !== s.id);
        renderSections(); redrawAll();
      });
      const saveBtn = card.querySelector('.section-save');
      if (saveBtn) saveBtn.addEventListener('click', () => saveSection(s));
    } else {
      card.querySelector('.section-apply').addEventListener('click', () => applySection(s));
    }
    card.querySelector('.section-play').addEventListener('click', () => playRange(s.start, s.end));

    wireMiniDrag(card.querySelector('.section-mini'), s);
  });
  refreshSectionVisuals();
}

// ─── Rendering: cheap per-tick visual refresh (canvases + text only, no DOM rebuild) ──
function refreshSectionVisuals() {
  sections.forEach(s => {
    const card = document.querySelector(`.section-card[data-id="${s.id}"]`);
    if (!card) return;
    const timeEl = card.querySelector('.section-time');
    if (timeEl) timeEl.textContent = sectionMs(s).join('–') + ' ms';
    const cv = card.querySelector('.section-mini');
    if (cv) {
      const { winStart, winEnd } = sectionWindow(s);
      drawSpectrogramWindow(cv, winStart, winEnd, s.start, s.end);
    }
    if (s.mode === 'token') {
      const after = computeMeansForRange(s.start, s.end);
      const valuesEl = card.querySelector('.section-values');
      if (valuesEl) {
        const before = s.before ? `F1 ${Math.round(s.before.f1)} · F2 ${Math.round(s.before.f2)}` : '—';
        const afterTxt = after?.nFormantFrames ? `F1 ${Math.round(after.f1)} · F2 ${Math.round(after.f2)}${after.f0 != null ? ` · F0 ${Math.round(after.f0)}` : ''} Hz` : 'no voiced frames';
        valuesEl.innerHTML = `Before: <b>${before}</b> &nbsp;→&nbsp; After: <b>${afterTxt}</b>`;
      }
    }
  });
}

function scrollToSection(predicate) {
  const s = sections.find(predicate);
  if (!s) return;
  const card = document.querySelector(`.section-card[data-id="${s.id}"]`);
  if (!card) return;
  card.classList.add('highlight');
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ─── Mini-spectrogram (zoomed, per-section) — shares the crop/overlay helpers
// below with the main spectrogram view (winStart=0, winEnd=1 there). ──────────
function drawSpectrogramWindow(cv, winStart, winEnd, selStartFrac, selEndFrac) {
  const W = cv.width = cv.offsetWidth || 260, H = cv.height = cv.offsetHeight || 60;
  drawSpectrogramCrop(cv, W, H, winStart, winEnd);
  const ctx = cv.getContext('2d');
  drawFormantPitchOverlay(ctx, W, H, winStart, winEnd);
  const winSpan = Math.max(1e-9, winEnd - winStart);
  const toX = f => ((f - winStart) / winSpan) * W;
  const x0 = toX(Math.max(winStart, selStartFrac)), x1 = toX(Math.min(winEnd, selEndFrac));
  ctx.fillStyle = 'rgba(126,184,247,0.18)'; ctx.fillRect(x0, 0, x1 - x0, H);
  ctx.fillStyle = '#7eb8f7'; ctx.fillRect(x0, 0, 1.5, H); ctx.fillRect(x1 - 1.5, 0, 1.5, H);
}

function wireMiniDrag(el, s) {
  let mode = null, moveOffset = 0;
  const toFrac = e => {
    const rect = el.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const xFrac = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
    const { winStart, winEnd } = sectionWindow(s);
    return winStart + xFrac * (winEnd - winStart);
  };
  const start = e => {
    const f = toFrac(e);
    const edge = nearestEdge(s, f, el.getBoundingClientRect().width);
    if (edge) mode = edge === 'start' ? 'resize-start' : 'resize-end';
    else if (f >= s.start && f <= s.end) { mode = 'move'; moveOffset = f - s.start; }
    else mode = Math.abs(f - s.start) < Math.abs(f - s.end) ? 'resize-start' : 'resize-end';
    e.preventDefault();
  };
  const move = e => {
    if (!mode) return;
    const f = toFrac(e);
    const len = s.end - s.start;
    if (mode === 'resize-start') s.start = Math.max(0, Math.min(f, s.end - 0.0005));
    else if (mode === 'resize-end') s.end = Math.min(1, Math.max(f, s.start + 0.0005));
    else { const newStart = Math.max(0, Math.min(1 - len, f - moveOffset)); s.start = newStart; s.end = newStart + len; }
    refreshSectionVisuals(); redrawAll();
    e.preventDefault();
  };
  const end = () => { mode = null; };
  el.addEventListener('mousedown', start);
  el.addEventListener('touchstart', start, { passive: false });
  document.addEventListener('mousemove', move);
  document.addEventListener('touchmove', move, { passive: false });
  document.addEventListener('mouseup', end);
  document.addEventListener('touchend', end);
}

function drawSelectionBand(ctx, W, H) {
  if (selEnd <= selStart) return;
  const x0 = selStart * W, x1 = selEnd * W;
  ctx.fillStyle = 'rgba(126,184,247,0.18)'; ctx.fillRect(x0, 0, x1 - x0, H);
  ctx.fillStyle = '#7eb8f7'; ctx.fillRect(x0, 0, 1.5, H); ctx.fillRect(x1 - 1.5, 0, 1.5, H);
}
function drawSectionBands(ctx, W, H) {
  for (const s of sections) {
    const x0 = s.start * W, x1 = s.end * W;
    const done = s.mode === 'ingest' ? !!s.savedSampleId : !!s.before;
    ctx.fillStyle = done ? 'rgba(74,222,128,0.12)' : 'rgba(216,232,244,0.07)';
    ctx.fillRect(x0, 0, x1 - x0, H);
    ctx.fillStyle = done ? '#4ade80' : '#4a6888';
    ctx.fillRect(x0, 0, 1, H); ctx.fillRect(x1 - 1, 0, 1, H);
  }
}

// ─── Main-spectrogram dragging: resize/move an existing section, or (ingest
// mode, empty space) draw a brand-new scratch selection for "+ New section" ──
function wireMainDrag(el) {
  const toFrac = e => {
    const rect = el.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    return Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
  };
  const start = e => {
    if (!currentBuffer) return;
    const f = toFrac(e);
    const rectWidth = el.getBoundingClientRect().width;
    const edgeHit = sections.find(s => nearestEdge(s, f, rectWidth));
    if (edgeHit) {
      sectionDrag = { section: edgeHit, mode: nearestEdge(edgeHit, f, rectWidth) === 'start' ? 'resize-start' : 'resize-end' };
    } else {
      const inside = sectionAt(f);
      if (inside) sectionDrag = { section: inside, mode: 'move', moveOffset: f - inside.start };
      else if (ingestMode) { dragging = true; selStart = f; selEnd = f; }
    }
    redrawAll(); e.preventDefault();
  };
  const move = e => {
    const f = toFrac(e);
    if (sectionDrag) {
      const { section: s, mode } = sectionDrag;
      const len = s.end - s.start;
      if (mode === 'resize-start') s.start = Math.max(0, Math.min(f, s.end - 0.0005));
      else if (mode === 'resize-end') s.end = Math.min(1, Math.max(f, s.start + 0.0005));
      else { const newStart = Math.max(0, Math.min(1 - len, f - sectionDrag.moveOffset)); s.start = newStart; s.end = newStart + len; }
      refreshSectionVisuals(); redrawAll();
      e.preventDefault();
      return;
    }
    if (!dragging) return;
    selEnd = f; redrawAll(); e.preventDefault();
  };
  const end = () => {
    if (sectionDrag) { sectionDrag = null; return; }
    if (!dragging) return;
    dragging = false;
    if (selEnd < selStart) { const t = selStart; selStart = selEnd; selEnd = t; }
    redrawAll();
  };
  el.addEventListener('mousedown', start);
  el.addEventListener('touchstart', start, { passive: false });
  document.addEventListener('mousemove', move);
  document.addEventListener('touchmove', move, { passive: false });
  document.addEventListener('mouseup', end);
  document.addEventListener('touchend', end);
}

function redrawAll() {
  drawSpectrogramOverlay();
  updateSelectionReadout();
}

// ─── Spectrogram rendering — shared by the main view (winStart=0, winEnd=1)
// and each section's mini view (its own padded window). ────────────────────────
function drawSpectrogramCrop(cv, W, H, winStart, winEnd) {
  const ctx = cv.getContext('2d');
  const sg = analysisResult?.spectrogram;
  if (!sg) { ctx.fillStyle = '#0a1520'; ctx.fillRect(0, 0, W, H); return; }
  const nT = sg.times_ms.length, nF = sg.freqs_hz.length;
  if (!nT || !nF) { ctx.fillStyle = '#0a1520'; ctx.fillRect(0, 0, W, H); return; }

  // Praat convention: louder = darker, on a fixed dynamic range below this clip's own peak.
  let maxDb = -Infinity;
  for (const col of sg.power_db) for (const v of col) if (v > maxDb) maxDb = v;
  const dynamicRangeDb = 60;
  const minDb = maxDb - dynamicRangeDb;
  const winSpan = Math.max(1e-9, winEnd - winStart);

  const img = ctx.createImageData(W, H);
  for (let x = 0; x < W; x++) {
    const frac = winStart + (x / W) * winSpan;
    const ti = Math.max(0, Math.min(nT - 1, Math.floor(frac * nT)));
    const col = sg.power_db[ti];
    for (let y = 0; y < H; y++) {
      // y=0 is the top of the canvas (high frequency); invert to match freq axis (0 at bottom)
      const freqFrac = 1 - y / H;
      const fi = Math.min(nF - 1, Math.floor(freqFrac * nF));
      const db = col[fi];
      const t = Math.max(0, Math.min(1, (db - minDb) / dynamicRangeDb));
      const gray = Math.round(255 * (1 - t));   // loud → dark
      const off = (y * W + x) * 4;
      img.data[off] = gray; img.data[off + 1] = gray; img.data[off + 2] = gray; img.data[off + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}
function freqAxisMax() {
  const sg = analysisResult?.spectrogram;
  return sg?.freqs_hz?.length ? sg.freqs_hz[sg.freqs_hz.length - 1] : 5000;
}
function drawFormantPitchOverlay(ctx, W, H, winStart, winEnd) {
  if (!analysisResult || !currentBuffer) return;
  const durationMs = currentBuffer.duration * 1000;
  const maxFreq = freqAxisMax();
  const pitchFloor = +(document.getElementById('pPitchFloor')?.value) || 75;
  const pitchCeil  = +(document.getElementById('pPitchCeiling')?.value) || 600;
  const winSpan = Math.max(1e-9, winEnd - winStart);
  const toX = frac => ((frac - winStart) / winSpan) * W;

  // Formant dots (red) — left axis, 0..maxFreq
  ctx.fillStyle = '#e8536b';
  for (const row of analysisResult.formants) {
    const frac = row.t_ms / durationMs;
    if (frac < winStart || frac > winEnd) continue;
    const x = toX(frac);
    for (let i = 1; i <= 5; i++) {
      const hz = row['f' + i];
      if (hz == null || hz > maxFreq) continue;
      const y = H * (1 - hz / maxFreq);
      ctx.fillRect(x - 1, y - 1, 2, 2);
    }
  }

  // Pitch curve (blue) — own right axis, pitchFloor..pitchCeiling
  ctx.strokeStyle = '#4db8ff'; ctx.lineWidth = 1.8; ctx.lineJoin = 'round';
  ctx.beginPath();
  let drawing = false;
  for (const row of analysisResult.pitch) {
    const frac = row.t_ms / durationMs;
    if (frac < winStart || frac > winEnd || row.f0 == null) { drawing = false; continue; }
    const x = toX(frac);
    const clamped = Math.max(pitchFloor, Math.min(pitchCeil, row.f0));
    const y = H * (1 - (clamped - pitchFloor) / (pitchCeil - pitchFloor));
    if (!drawing) { ctx.moveTo(x, y); drawing = true; } else ctx.lineTo(x, y);
  }
  ctx.stroke();
}
function drawSpectrogramBase() {
  const cv = document.getElementById('spectrogramCanvas');
  if (!cv) return;
  const W = cv.width = cv.offsetWidth || 600, H = cv.height = cv.offsetHeight || 220;
  drawSpectrogramCrop(cv, W, H, 0, 1);
}
function drawSpectrogramOverlay() {
  const cv = document.getElementById('overlayCanvas');
  if (!cv || !currentBuffer) return;
  const W = cv.width = cv.offsetWidth || 600, H = cv.height = cv.offsetHeight || 220;
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  drawFormantPitchOverlay(ctx, W, H, 0, 1);
  drawSectionBands(ctx, W, H);
  drawSelectionBand(ctx, W, H);
}

// ─── Selection readout (ingest mode's scratch selection, for drawing new sections) ──
function updateSelectionReadout() {
  if (!currentBuffer) return;
  const durationMs = currentBuffer.duration * 1000;
  const t0 = selStart * durationMs, t1 = selEnd * durationMs;
  const timeEl = document.getElementById('selectionTime');
  if (timeEl) timeEl.textContent =
      selEnd > selStart ? `Selection: ${t0.toFixed(0)}–${t1.toFixed(0)} ms (${(t1 - t0).toFixed(0)} ms)` : 'Selection: —';
  const means = computeSelectionMeans();
  const el = document.getElementById('selectionMeans');
  if (!el) return;
  if (!means || !means.nFormantFrames) { el.textContent = 'no voiced formant frames in selection'; return; }
  el.textContent = `Mean F1 ${means.f1.toFixed(0)} · F2 ${means.f2.toFixed(0)} Hz`
      + (means.f0 != null ? ` · F0 ${means.f0.toFixed(0)} Hz` : '')
      + ` (${means.nFormantFrames} frames)`;
}

// ─── Analyze ───────────────────────────────────────────────────────────────────
// Same-origin, relative URL — matches editor-samples.js's SAMPLE_SERVER convention
// (this page is reached from the editor, which already assumes formanter.py serves it).
const ANALYZE_SERVER = '';
async function runAnalyze() {
  if (!currentBuffer) return;
  const btn = document.getElementById('analyzeBtn');
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  setStatus('Analyzing (Praat defaults)…');
  try {
    const mono = currentBuffer.getChannelData(0);
    const blob = encodeWavBlob(mono, currentBuffer.sampleRate);
    const form = new FormData();
    form.append('file', blob, 'audio.wav');
    form.append('config', JSON.stringify({
      max_number_of_formants: +(document.getElementById('pMaxFormants')?.value) || 5,
      maximum_formant: +(document.getElementById('pMaxFreq')?.value) || 5500,
      window_length: +(document.getElementById('pWindowLen')?.value) || 0.025,
      pre_emphasis_from: +(document.getElementById('pPreEmph')?.value) || 50,
      pitch_floor: +(document.getElementById('pPitchFloor')?.value) || 75,
      pitch_ceiling: +(document.getElementById('pPitchCeiling')?.value) || 600,
    }));
    const resp = await fetch(ANALYZE_SERVER + '/analyze-praat', { method: 'POST', body: form, signal: AbortSignal.timeout(30000) });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || ('HTTP ' + resp.status));
    }
    analysisResult = await resp.json();
    drawSpectrogramBase();
    drawSpectrogramOverlay();
    updateSelectionReadout();
    refreshSectionVisuals();
    setStatus('');
  } catch (e) {
    setStatus('Analysis failed: ' + e.message);
  }
  if (btn) { btn.disabled = false; btn.textContent = '⚡ Analyze'; }
}

// ─── Playback ───────────────────────────────────────────────────────────────────
function stopPlayback() { if (activeSource) { try { activeSource.stop(); } catch (e) {} activeSource = null; } }
function playRange(fracStart, fracEnd) {
  if (!currentBuffer) return;
  stopPlayback();
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const src = ctx.createBufferSource();
  src.buffer = currentBuffer;
  src.connect(ctx.destination);
  const dur = currentBuffer.duration;
  src.start(0, fracStart * dur, Math.max(0.001, (fracEnd - fracStart) * dur));
  activeSource = src;
  src.onended = () => { if (activeSource === src) activeSource = null; ctx.close(); };
}

// Only offered in ingestion mode (see fileToolbar wiring) — editor-launched
// (sample) mode is locked to its one launch-time audioUrl, since Apply always
// reports that fixed URL back regardless of what's currently loaded.
function resetToDropzone() {
  stopPlayback();
  currentBuffer = null;
  analysisResult = null;
  sections = [];
  selStart = 0; selEnd = 0;
  document.getElementById('dropzone').style.display = '';
  document.getElementById('fileToolbar').style.display = 'none';
  document.getElementById('praatPanels').style.display = 'none';
  document.getElementById('paramsRow').style.display = 'none';
  document.getElementById('sectionsPanel').style.display = 'none';
  setStatus('');
}

async function handleFile(file) {
  setStatus('Decoding…');
  try {
    const buf = await decodeArrayBuffer(await file.arrayBuffer());
    await loadBuffer(buf);
    setStatus('');
  } catch (e) {
    setStatus('Could not decode: ' + e.message);
  }
}
async function handleUrl(url) {
  setStatus('Fetching audio…');
  try {
    const ab = await fetchArrayBuffer(url);
    setStatus('Decoding…');
    const buf = await decodeArrayBuffer(ab);
    await loadBuffer(buf);
    setStatus('');
  } catch (e) {
    setStatus('Could not load audio: ' + e.message);
  }
}

// ─── Wiring ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const dz = document.getElementById('dropzone');
  const fileInput = document.getElementById('audioFile');
  dz.addEventListener('click', () => fileInput.click());
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
  dz.addEventListener('drop', e => {
    e.preventDefault(); dz.classList.remove('drag');
    const f = e.dataTransfer.files?.[0];
    if (f) handleFile(f);
  });
  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    if (f) handleFile(f);
  });

  if (ingestMode) loadLanguagesList();

  document.getElementById('analyzeBtn').addEventListener('click', () => runAnalyze());
  document.getElementById('playSelectionBtn').addEventListener('click', () => playRange(selEnd > selStart ? selStart : 0, selEnd > selStart ? selEnd : 1));
  document.getElementById('playAllBtn').addEventListener('click', () => playRange(0, 1));
  document.getElementById('newSectionBtn')?.addEventListener('click', commitSectionFromSelection);
  document.getElementById('newFileBtn')?.addEventListener('click', resetToDropzone);

  wireMainDrag(document.getElementById('spectrogramCanvas').parentElement);

  window.addEventListener('resize', () => { if (currentBuffer) { drawSpectrogramBase(); drawSpectrogramOverlay(); refreshSectionVisuals(); } });

  if (sampleCtx?.audioUrl) handleUrl(sampleCtx.audioUrl);
});
