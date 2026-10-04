/**
 * spectro.js — shared Praat-spectrogram rendering, mean-F1/F2-over-range
 * analysis, drag-to-adjust-slice, and playback-cursor machinery. Extracted
 * from js/praat.js (which had it first and is the best-exercised reference
 * implementation) so js/practice.js's live spectrogram+slice view is the
 * SAME code, not a lookalike — both pages call straight into this module.
 *
 * Every function here takes its state as explicit parameters (no module-
 * level globals). Namespaced under `SpectroLib` (not bare globals) since
 * js/praat.js keeps its own identically-named functions as thin wrappers
 * around these — bare globals would collide with and shadow them.
 */

const SpectroLib = (() => {

// ─── Spectrogram image ──────────────────────────────────────────────────────
// `analysisResult` shape: { duration_ms, formants:[{t_ms,f1..f5,b1..b5}],
//   pitch:[{t_ms,f0}], spectrogram:{times_ms,freqs_hz,power_db} }  — see
// formanter.py's run_full_praat_analysis().
function drawSpectrogramCrop(cv, W, H, winStart, winEnd, analysisResult) {
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

function freqAxisMax(analysisResult) {
  const sg = analysisResult?.spectrogram;
  return sg?.freqs_hz?.length ? sg.freqs_hz[sg.freqs_hz.length - 1] : 5000;
}

function drawFormantPitchOverlay(ctx, W, H, winStart, winEnd, analysisResult, durationMs, pitchFloor, pitchCeil) {
  if (!analysisResult || !durationMs) return;
  const maxFreq = freqAxisMax(analysisResult);
  const winSpan = Math.max(1e-9, winEnd - winStart);
  const toX = frac => ((frac - winStart) / winSpan) * W;

  // Formant dots (red) — left axis, 0..maxFreq
  ctx.fillStyle = '#e8536b';
  for (const row of analysisResult.formants || []) {
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
  for (const row of analysisResult.pitch || []) {
    const frac = row.t_ms / durationMs;
    if (frac < winStart || frac > winEnd || row.f0 == null) { drawing = false; continue; }
    const x = toX(frac);
    const clamped = Math.max(pitchFloor, Math.min(pitchCeil, row.f0));
    const y = H * (1 - (clamped - pitchFloor) / (pitchCeil - pitchFloor));
    if (!drawing) { ctx.moveTo(x, y); drawing = true; } else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

// ─── Mean F1/F2/F0 over a time range ────────────────────────────────────────
function computeMeansForRange(analysisResult, durationMs, startFrac, endFrac) {
  if (!analysisResult || !durationMs || endFrac <= startFrac) return null;
  const t0 = startFrac * durationMs, t1 = endFrac * durationMs;
  const inRange = t => t >= t0 && t <= t1;
  const f1s = [], f2s = [], f0s = [];
  for (const row of analysisResult.formants || []) {
    if (!inRange(row.t_ms)) continue;
    if (row.f1 != null) f1s.push(row.f1);
    if (row.f2 != null) f2s.push(row.f2);
  }
  for (const row of analysisResult.pitch || []) {
    if (!inRange(row.t_ms)) continue;
    if (row.f0 != null) f0s.push(row.f0);
  }
  const mean = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
  return { f1: mean(f1s), f2: mean(f2s), f0: mean(f0s), nFormantFrames: f1s.length };
}

// ─── Run a Praat analysis over a decoded buffer ─────────────────────────────
// Returns the parsed {duration_ms, formants, pitch, spectrogram} response;
// throws on network/server error. `config` — see formanter.py's
// run_full_praat_analysis() docstring for the full param list; pass
// {spectrogram_only:true} to skip the (comparatively expensive) formant/
// pitch tracking and get just the spectrogram back.
async function runPraatAnalysis(buffer, config, serverUrl) {
  const mono = buffer.getChannelData(0);
  const blob = encodeWavBlob(mono, buffer.sampleRate);
  const form = new FormData();
  form.append('file', blob, 'audio.wav');
  form.append('config', JSON.stringify(config || {}));
  const resp = await fetch((serverUrl || '') + '/analyze-praat', { method: 'POST', body: form, signal: AbortSignal.timeout(30000) });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || ('HTTP ' + resp.status));
  }
  return resp.json();
}

// ─── Drag-to-adjust a single slice [start,end] (fractions of the full buffer,
// displayed within its own [winStart,winEnd] zoomed window) — resize either
// edge or move the whole slice. Generic single-slice version of js/praat.js's
// section-list-aware wireMiniDrag (which also has to pick WHICH section a
// click belongs to among several; this only ever has the one). ─────────────
function wireSliceDrag(el, opts) {
  const { getWinStart, getWinEnd, getStart, setStart, getEnd, setEnd, onChange, minLen = 0.0005 } = opts;
  let mode = null, moveOffset = 0;
  const toFrac = e => {
    const rect = el.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const xFrac = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
    const winStart = getWinStart(), winEnd = getWinEnd();
    return winStart + xFrac * (winEnd - winStart);
  };
  const edgeTol = () => 6 / Math.max(1, el.getBoundingClientRect().width);
  const start = e => {
    const f = toFrac(e);
    const s0 = getStart(), s1 = getEnd(), tol = edgeTol();
    if (Math.abs(f - s0) <= tol) mode = 'resize-start';
    else if (Math.abs(f - s1) <= tol) mode = 'resize-end';
    else if (f >= s0 && f <= s1) { mode = 'move'; moveOffset = f - s0; }
    else mode = Math.abs(f - s0) < Math.abs(f - s1) ? 'resize-start' : 'resize-end';
    e.preventDefault();
  };
  const move = e => {
    if (!mode) return;
    const f = toFrac(e);
    const len = getEnd() - getStart();
    if (mode === 'resize-start') setStart(Math.max(0, Math.min(f, getEnd() - minLen)));
    else if (mode === 'resize-end') setEnd(Math.min(1, Math.max(f, getStart() + minLen)));
    else { const newStart = Math.max(0, Math.min(1 - len, f - moveOffset)); setStart(newStart); setEnd(newStart + len); }
    onChange?.();
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

// ─── Playback cursor overlay + a small rAF helper to animate it ─────────────
function drawPlaybackCursor(ctx, W, H, winStart, winEnd, elapsedFrac) {
  const winSpan = Math.max(1e-9, winEnd - winStart);
  if (elapsedFrac < winStart || elapsedFrac > winEnd) return;
  const x = ((elapsedFrac - winStart) / winSpan) * W;
  ctx.save();
  ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
  ctx.restore();
}

/**
 * Runs `onFrame(elapsedFrac)` every animation frame while audio plays,
 * computing elapsedFrac from wall-clock time (same approach js/practice.js's
 * old waveform-cursor animation already used) rather than polling
 * AudioContext state — works uniformly for both <audio> elements and
 * AudioBufferSourceNode playback, neither of which is reliably/cheaply
 * "where am I" queryable mid-playback. `startFrac`/`endFrac` are the
 * absolute fractions (of the full buffer) this particular playback spans.
 * Calls `onDone()` once elapsed reaches the span or `isStopped()` returns true.
 */
function animatePlaybackCursor({ startFrac, endFrac, durationSec, onFrame, onDone, isStopped }) {
  const spanSec = Math.max(0.001, (endFrac - startFrac) * durationSec);
  const t0 = performance.now();
  function tick() {
    if (isStopped?.()) { onDone?.(); return; }
    const elapsed = (performance.now() - t0) / 1000;
    if (elapsed >= spanSec) { onDone?.(); return; }
    onFrame(startFrac + (elapsed / spanSec) * (endFrac - startFrac));
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

return {
  drawSpectrogramCrop, freqAxisMax, drawFormantPitchOverlay,
  computeMeansForRange, runPraatAnalysis, wireSliceDrag,
  drawPlaybackCursor, animatePlaybackCursor,
};

})();
