/**
 * praat.js — Formant Lab (praat.html).
 *
 * Standalone page replicating Praat's own Sound/Spectrogram editor window:
 * waveform (per channel) on top, derived spectrogram below with formant
 * dots (red) and a pitch curve (blue, own right-axis scale) overlaid, a
 * draggable time selection shared across both, and a mean F1/F2/F0 readout
 * over that selection.
 *
 * Analysis is done by /analyze-praat on formanter.py — parselmouth's bare
 * default Burg formant / autocorrelation pitch / spectrogram calls, with
 * none of the dual-ceiling/continuity/smoothing heuristics the live
 * practice panel's /frames pipeline uses. See formanter.py for why.
 *
 * Launched two ways:
 *  - standalone, no tokIdx in the URL: "ingestion mode" — besides the usual
 *    single scratch selection, auto-suggested slice REGIONS (from
 *    js/vad.js's detectSentences, same heuristic Shadowing uses) are drawn
 *    on load; each is independently adjustable and saveable as its own
 *    library Sample via js/ingest.js's uploadSlice() (see db/models.py —
 *    Phase 1/2 of the ingestion redesign). The dropped file itself is never
 *    uploaded whole, only the regions you choose to save.
 *  - from the editor (editor-samples.js), as a new tab/window via
 *    ?audio=<url>&tokIdx=<i>&symbol=<sym>&sampleText=<text>&cfg=<json>.
 *    "Apply to token" posts the result back via window.opener.postMessage
 *    instead of the editor having to embed any of this analysis UI itself.
 *    Ingestion-mode regions are NOT shown here — this path keeps its
 *    original single-selection behavior untouched.
 */

// ─── Query params / token context ──────────────────────────────────────────────
const params = new URLSearchParams(location.search);
const tokenCtx = params.has('tokIdx') ? {
  tokIdx: parseInt(params.get('tokIdx'), 10),
  audioUrl: params.get('audio') || '',
  symbol: params.get('symbol') || '',
  sampleText: params.get('sampleText') || '',
  cfg: (() => { try { return JSON.parse(params.get('cfg') || '{}'); } catch (e) { return {}; } })(),
} : null;

// ─── State ──────────────────────────────────────────────────────────────────────
let currentBuffer = null;     // decoded AudioBuffer (all channels, for display + playback)
let analysisResult = null;    // { duration_ms, formants, pitch, spectrogram }
let selStart = 0, selEnd = 0; // fractions of duration — the scratch/working selection
let dragging = false;
let activeSource = null;

// Ingestion mode (standalone, i.e. not opened from the editor for a single token)
const ingestMode = !tokenCtx;
let regions = [];          // [{id, start, end (fractions), text, phonemic, languageId, savedSampleId}]
let editingRegionId = null; // which region the scratch selection is currently editing, if any
let nextRegionId = 1;
let languagesList = [];    // [{id, key, label, color, enabled}] — for the per-region language picker

async function loadLanguagesList() {
  try {
    const resp = await fetch('/api/v1/languages');
    languagesList = resp.ok ? await resp.json() : [];
  } catch (e) { languagesList = []; }
  renderRegionsList();   // refresh in case regions were already drawn before this resolved
}

function setStatus(text) { const el = document.getElementById('uploadStatus'); if (el) el.textContent = text; }

// encodeWavBlob()/extractMonoSlice()/computeMonoData() come from js/audio.js
// (loaded before this file); detectSentences() from js/vad.js.

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
  selStart = 0; selEnd = ingestMode ? 0 : 1;   // ingestion mode starts with no scratch selection — regions carry the content instead
  analysisResult = null;
  regions = []; editingRegionId = null;
  document.getElementById('dropzone').style.display = 'none';
  document.getElementById('praatPanels').style.display = 'block';
  document.getElementById('paramsRow').style.display = 'flex';
  document.getElementById('channelInfo').textContent =
      `${buffer.numberOfChannels} ch · ${(buffer.sampleRate / 1000).toFixed(1)} kHz · ${buffer.duration.toFixed(2)}s`;
  if (ingestMode) {
    document.getElementById('ingestPanel').style.display = 'block';
    document.getElementById('fileToolbar').style.display = 'flex';
    suggestRegions();
    updateRegionEditingLabel();
  }
  buildWaveLanes();
  drawWaveLanes();
  await runAnalyze();
}

// ─── Ingestion mode: region suggestion, list, save ──────────────────────────────
function suggestRegions() {
  const mono = computeMonoData(currentBuffer);
  const { segments } = detectSentences(mono, currentBuffer.sampleRate);
  const durationMs = currentBuffer.duration * 1000;
  regions = segments.map(s => ({
    id: nextRegionId++, start: s.start / durationMs, end: s.end / durationMs,
    text: '', phonemic: '', languageId: null, savedSampleId: null,
  }));
  renderRegionsList();
}

function regionMs(r) {
  const durationMs = currentBuffer.duration * 1000;
  return [Math.round(r.start * durationMs), Math.round(r.end * durationMs)];
}

function renderRegionsList() {
  const list = document.getElementById('regionsList');
  if (!list) return;
  list.innerHTML = '';
  regions.forEach((r, i) => {
    const [t0, t1] = regionMs(r);
    const row = document.createElement('div');
    row.className = 'region-row' + (editingRegionId === r.id ? ' active' : '');
    const langOptions = ['<option value="">— language —</option>']
      .concat(languagesList.map(l => `<option value="${l.id}"${r.languageId === l.id ? ' selected' : ''}>${escapeAttr(l.label)}</option>`))
      .join('');
    row.innerHTML = `
      <span class="region-idx">#${i + 1}</span>
      <span class="region-time">${t0}–${t1} ms</span>
      <select class="region-lang">${langOptions}</select>
      <input type="text" class="region-text" placeholder="text (required)" value="${escapeAttr(r.text)}">
      <input type="text" class="region-phonemic" placeholder="phonemic" value="${escapeAttr(r.phonemic)}">
      <button class="sent-btn region-play" type="button">▶</button>
      <button class="sent-btn region-edit" type="button">✎ Edit bounds</button>
      ${r.savedSampleId
        ? `<span class="region-saved">✓ Saved #${r.savedSampleId}</span>`
        : `<button class="sent-btn primary region-save" type="button">💾 Save</button>`}
      <button class="sent-btn region-remove" type="button">✕</button>
    `;
    row.querySelector('.region-lang').addEventListener('change', e => { r.languageId = e.target.value ? +e.target.value : null; });
    row.querySelector('.region-text').addEventListener('input', e => { r.text = e.target.value; });
    row.querySelector('.region-phonemic').addEventListener('input', e => { r.phonemic = e.target.value; });
    row.querySelector('.region-play').addEventListener('click', () => playRange(r.start, r.end));
    row.querySelector('.region-edit').addEventListener('click', () => {
      editingRegionId = r.id;
      selStart = r.start; selEnd = r.end;
      redrawAll(); renderRegionsList(); updateRegionEditingLabel();
    });
    row.querySelector('.region-remove').addEventListener('click', () => {
      regions = regions.filter(x => x.id !== r.id);
      if (editingRegionId === r.id) { editingRegionId = null; updateRegionEditingLabel(); }
      renderRegionsList(); redrawAll();
    });
    const saveBtn = row.querySelector('.region-save');
    if (saveBtn) saveBtn.addEventListener('click', () => saveRegion(r));
    list.appendChild(row);
  });
}

function updateRegionEditingLabel() {
  const el = document.getElementById('regionEditingLabel');
  const btn = document.getElementById('newRegionBtn');
  if (!el || !btn) return;
  if (editingRegionId != null) {
    const idx = regions.findIndex(r => r.id === editingRegionId);
    el.textContent = idx >= 0 ? `Editing region #${idx + 1} — adjust the selection above, then Update.` : '';
    btn.textContent = '✓ Update region';
  } else {
    el.textContent = '';
    btn.textContent = '+ New region from selection';
  }
}

function commitRegionFromSelection() {
  if (selEnd <= selStart) { setStatus('Select a range first'); return; }
  if (editingRegionId != null) {
    const r = regions.find(x => x.id === editingRegionId);
    if (r) { r.start = selStart; r.end = selEnd; }
    editingRegionId = null;
  } else {
    regions.push({ id: nextRegionId++, start: selStart, end: selEnd, text: '', phonemic: '', languageId: null, savedSampleId: null });
  }
  updateRegionEditingLabel();
  renderRegionsList();
  redrawAll();
}

function escapeAttr(str) { return String(str ?? '').replace(/"/g, '&quot;'); }

async function saveRegion(r) {
  if (!r.text.trim()) { setStatus('Text is required before saving a region'); return; }
  if (!r.languageId) { setStatus('Pick a language before saving a region'); return; }
  const [t0, t1] = regionMs(r);
  try {
    const result = await uploadSlice(currentBuffer, t0, t1, { languageId: r.languageId, text: r.text, phonemic: r.phonemic || undefined });
    r.savedSampleId = result.id;
    renderRegionsList();
    setStatus(`Saved region as Sample #${result.id}`);
  } catch (e) {
    setStatus('Save failed: ' + e.message);
  }
}

function drawRegionBands(ctx, W, H) {
  for (const r of regions) {
    const x0 = r.start * W, x1 = r.end * W;
    const active = editingRegionId === r.id;
    ctx.fillStyle = r.savedSampleId ? 'rgba(74,222,128,0.12)' : (active ? 'rgba(126,184,247,0.10)' : 'rgba(216,232,244,0.07)');
    ctx.fillRect(x0, 0, x1 - x0, H);
    ctx.fillStyle = r.savedSampleId ? '#4ade80' : (active ? '#7eb8f7' : '#4a6888');
    ctx.fillRect(x0, 0, 1, H); ctx.fillRect(x1 - 1, 0, 1, H);
  }
}

// Only offered in ingestion mode (see fileToolbar wiring) — editor-launched
// (tokenCtx) mode is locked to its one launch-time audioUrl, since Apply to
// token always reports that fixed URL back regardless of what's loaded.
function resetToDropzone() {
  stopPlayback();
  currentBuffer = null;
  analysisResult = null;
  regions = []; editingRegionId = null;
  selStart = 0; selEnd = 0;
  document.getElementById('dropzone').style.display = '';
  document.getElementById('fileToolbar').style.display = 'none';
  document.getElementById('praatPanels').style.display = 'none';
  document.getElementById('paramsRow').style.display = 'none';
  document.getElementById('ingestPanel').style.display = 'none';
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

// ─── Waveform lanes (one per channel) ──────────────────────────────────────────
function buildWaveLanes() {
  const wrap = document.getElementById('waveLanes');
  wrap.innerHTML = '';
  for (let ch = 0; ch < currentBuffer.numberOfChannels; ch++) {
    const cv = document.createElement('canvas');
    cv.className = 'wave-lane';
    cv.dataset.channel = ch;
    wrap.appendChild(cv);
  }
  wireSelectionDrag(wrap);
}
function drawWaveLanes() {
  document.querySelectorAll('.wave-lane').forEach(cv => {
    const ch = +cv.dataset.channel;
    const data = currentBuffer.getChannelData(ch);
    const W = cv.width = cv.offsetWidth || 600, H = cv.height = 64;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#0a1520'; ctx.fillRect(0, 0, W, H);
    const step = Math.max(1, Math.ceil(data.length / W));
    for (let x = 0; x < W; x++) {
      let mn = 0, mx = 0;
      for (let i = x * step; i < Math.min((x + 1) * step, data.length); i++) {
        if (data[i] < mn) mn = data[i];
        if (data[i] > mx) mx = data[i];
      }
      const yT = Math.floor((1 - mx) * H / 2), yB = Math.ceil((1 - mn) * H / 2);
      ctx.fillStyle = '#4a90c8';
      ctx.fillRect(x, yT, 1, Math.max(1, yB - yT));
    }
    if (ingestMode) drawRegionBands(ctx, W, H);
    drawSelectionBand(ctx, W, H);
  });
}
function drawSelectionBand(ctx, W, H) {
  if (selEnd <= selStart) return;
  const x0 = selStart * W, x1 = selEnd * W;
  ctx.fillStyle = 'rgba(126,184,247,0.18)'; ctx.fillRect(x0, 0, x1 - x0, H);
  ctx.fillStyle = '#7eb8f7'; ctx.fillRect(x0, 0, 1.5, H); ctx.fillRect(x1 - 1.5, 0, 1.5, H);
}

// ─── Selection dragging — shared between wave lanes and spectrogram ────────────
function wireSelectionDrag(el) {
  const toFrac = e => {
    const rect = el.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  };
  const start = e => {
    if (!currentBuffer) return;
    dragging = true;
    const f = toFrac(e);
    selStart = f; selEnd = f;
    redrawAll(); e.preventDefault();
  };
  const move = e => {
    if (!dragging) return;
    const f = toFrac(e);
    selEnd = f;
    redrawAll(); e.preventDefault();
  };
  const end = () => {
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
  drawWaveLanes();
  drawSpectrogramOverlay();
  updateSelectionReadout();
}

// ─── Spectrogram + formant/pitch overlay ───────────────────────────────────────
function drawSpectrogramBase() {
  const sg = analysisResult?.spectrogram;
  const cv = document.getElementById('spectrogramCanvas');
  if (!sg || !cv) return;
  const W = cv.width = cv.offsetWidth || 600, H = cv.height = cv.offsetHeight || 220;
  const ctx = cv.getContext('2d');
  const nT = sg.times_ms.length, nF = sg.freqs_hz.length;
  if (!nT || !nF) { ctx.fillStyle = '#0a1520'; ctx.fillRect(0, 0, W, H); return; }

  // Praat convention: louder = darker, on a fixed dynamic range below this clip's own peak.
  let maxDb = -Infinity;
  for (const col of sg.power_db) for (const v of col) if (v > maxDb) maxDb = v;
  const dynamicRangeDb = 60;
  const minDb = maxDb - dynamicRangeDb;

  const img = ctx.createImageData(W, H);
  for (let x = 0; x < W; x++) {
    const ti = Math.min(nT - 1, Math.floor((x / W) * nT));
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
function drawSpectrogramOverlay() {
  const cv = document.getElementById('overlayCanvas');
  if (!cv || !currentBuffer) return;
  const W = cv.width = cv.offsetWidth || 600, H = cv.height = cv.offsetHeight || 220;
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  if (!analysisResult) return;

  const durationMs = currentBuffer.duration * 1000;
  const maxFreq = freqAxisMax();
  const pitchFloor = +(document.getElementById('pPitchFloor')?.value) || 75;
  const pitchCeil  = +(document.getElementById('pPitchCeiling')?.value) || 600;

  // Formant dots (red) — left axis, 0..maxFreq
  ctx.fillStyle = '#e8536b';
  for (const row of analysisResult.formants) {
    const x = (row.t_ms / durationMs) * W;
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
    const x = (row.t_ms / durationMs) * W;
    if (row.f0 == null) { drawing = false; continue; }
    const clamped = Math.max(pitchFloor, Math.min(pitchCeil, row.f0));
    const y = H * (1 - (clamped - pitchFloor) / (pitchCeil - pitchFloor));
    if (!drawing) { ctx.moveTo(x, y); drawing = true; } else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Regions + selection band
  if (ingestMode) drawRegionBands(ctx, W, H);
  drawSelectionBand(ctx, W, H);
}

// ─── Selection readout ──────────────────────────────────────────────────────────
function computeSelectionMeans() {
  if (!analysisResult || !currentBuffer || selEnd <= selStart) return null;
  const durationMs = currentBuffer.duration * 1000;
  const t0 = selStart * durationMs, t1 = selEnd * durationMs;
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
function updateSelectionReadout() {
  if (!currentBuffer) return;
  const durationMs = currentBuffer.duration * 1000;
  const t0 = selStart * durationMs, t1 = selEnd * durationMs;
  document.getElementById('selectionTime').textContent =
      selEnd > selStart ? `Selection: ${t0.toFixed(0)}–${t1.toFixed(0)} ms (${(t1 - t0).toFixed(0)} ms)` : 'Selection: —';
  const means = computeSelectionMeans();
  const el = document.getElementById('selectionMeans');
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

// ─── Apply to token (only when opened from the editor) ─────────────────────────
function applyToToken() {
  const means = computeSelectionMeans();
  if (!means || means.f1 == null) { setStatus('Select a voiced region first'); return; }
  const durationMs = currentBuffer.duration * 1000;
  const payload = {
    type: 'praat-analysis-result',
    tokIdx: tokenCtx.tokIdx,
    audioUrl: tokenCtx.audioUrl,
    analysis: {
      slice: [Math.round(selStart * durationMs), Math.round(selEnd * durationMs)],
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
  if (window.opener) {
    window.opener.postMessage(payload, location.origin);
    setStatus(`Applied F1 ${payload.analysis.f1} · F2 ${payload.analysis.f2} Hz — you can close this tab.`);
  } else {
    setStatus('No opener window found — was this tab opened from the editor?');
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

  wireSelectionDrag(document.getElementById('spectrogramCanvas').parentElement);
  if (ingestMode) loadLanguagesList();

  document.getElementById('analyzeBtn').addEventListener('click', () => runAnalyze());
  document.getElementById('playSelectionBtn').addEventListener('click', () => playRange(selEnd > selStart ? selStart : 0, selEnd > selStart ? selEnd : 1));
  document.getElementById('playAllBtn').addEventListener('click', () => playRange(0, 1));
  document.getElementById('applyBtn').addEventListener('click', applyToToken);
  document.getElementById('newRegionBtn')?.addEventListener('click', commitRegionFromSelection);
  document.getElementById('newFileBtn')?.addEventListener('click', resetToDropzone);

  window.addEventListener('resize', () => { if (currentBuffer) { drawWaveLanes(); drawSpectrogramBase(); drawSpectrogramOverlay(); } });

  if (tokenCtx) {
    document.getElementById('tokenContext').style.display = 'block';
    document.getElementById('tokenSymbol').textContent = tokenCtx.symbol ? `/${tokenCtx.symbol}/` : '?';
    document.getElementById('tokenSampleText').textContent = tokenCtx.sampleText ? `"${tokenCtx.sampleText}"` : '(sample)';
    document.getElementById('applyBtn').style.display = 'inline-block';
    const c = tokenCtx.cfg || {};
    if (c.max_number_of_formants) document.getElementById('pMaxFormants').value = c.max_number_of_formants;
    if (c.maximum_formant)         document.getElementById('pMaxFreq').value = c.maximum_formant;
    if (c.window_length)           document.getElementById('pWindowLen').value = c.window_length;
    if (c.pre_emphasis_from)       document.getElementById('pPreEmph').value = c.pre_emphasis_from;
    if (c.pitch_floor)             document.getElementById('pPitchFloor').value = c.pitch_floor;
    if (c.pitch_ceiling)           document.getElementById('pPitchCeiling').value = c.pitch_ceiling;
    if (tokenCtx.audioUrl) handleUrl(tokenCtx.audioUrl);
    if (c.sliceStart != null && c.sliceEnd != null) {
      // Applied after loadBuffer() sets selStart/selEnd=[0,1] — override once duration is known.
      const applySlice = () => {
        if (!currentBuffer) { requestAnimationFrame(applySlice); return; }
        selStart = c.sliceStart / (currentBuffer.duration * 1000);
        selEnd   = c.sliceEnd   / (currentBuffer.duration * 1000);
        redrawAll();
      };
      requestAnimationFrame(applySlice);
    }
  }
});
