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
 *  - standalone: drag/drop or pick a file.
 *  - from the editor (editor-samples.js), as a new tab/window via
 *    ?audio=<url>&tokIdx=<i>&symbol=<sym>&sampleText=<text>&cfg=<json>.
 *    "Apply to token" posts the result back via window.opener.postMessage
 *    instead of the editor having to embed any of this analysis UI itself.
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
let selStart = 0, selEnd = 0; // fractions of duration
let dragging = false;
let activeSource = null;

function setStatus(text) { const el = document.getElementById('uploadStatus'); if (el) el.textContent = text; }

// ─── WAV encoder (mono, channel 0 — matches what formanter.py's decode_audio
// already does server-side for any multi-channel input, so sending anything
// more than one channel there would be pointless) ──────────────────────────────
function encodeWavBlob(samples, sampleRate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buf);
  const writeStr = (off, str) => { for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i)); };
  writeStr(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); writeStr(8, 'WAVE');
  writeStr(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  writeStr(36, 'data'); view.setUint32(40, samples.length * 2, true);
  for (let i = 0, off = 44; i < samples.length; i++, off += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
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
  selStart = 0; selEnd = 1;
  analysisResult = null;
  document.getElementById('dropzone').style.display = 'none';
  document.getElementById('praatPanels').style.display = 'block';
  document.getElementById('paramsRow').style.display = 'flex';
  document.getElementById('channelInfo').textContent =
      `${buffer.numberOfChannels} ch · ${(buffer.sampleRate / 1000).toFixed(1)} kHz · ${buffer.duration.toFixed(2)}s`;
  buildWaveLanes();
  drawWaveLanes();
  await runAnalyze();
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

  // Selection band
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

  document.getElementById('analyzeBtn').addEventListener('click', () => runAnalyze());
  document.getElementById('playSelectionBtn').addEventListener('click', () => playRange(selEnd > selStart ? selStart : 0, selEnd > selStart ? selEnd : 1));
  document.getElementById('playAllBtn').addEventListener('click', () => playRange(0, 1));
  document.getElementById('applyBtn').addEventListener('click', applyToToken);

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
