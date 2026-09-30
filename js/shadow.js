/**
 * shadow.js — Shadowing practice page (shadow.html).
 *
 * Flow: user picks/drops an audio file → its duration is probed cheaply
 * (WAV: parsed straight from the RIFF header; anything else: an <audio>
 * element's loadedmetadata, which browsers resolve without decoding the
 * whole file) → user picks a time range → only that range is decoded:
 *   WAV      — Blob.slice() reads just the needed byte range off disk,
 *              rebuilds a small valid WAV (original header + sliced PCM),
 *              decodeAudioData on that tiny buffer. Cheap regardless of
 *              how long the source file is (3h+ files are fine).
 *   Other    — no cheap byte-exact seek is available client-side, so the
 *              slice is captured in real time: an <audio> element seeks to
 *              the start, plays muted through a ScriptProcessorNode tap,
 *              and the raw samples are collected until the end of the
 *              range. Bounded to MAX_NONWAV_SLICE_SEC to stay responsive.
 *
 * The sentence-boundary segmentation of a decoded slice is cached in
 * IndexedDB keyed by (file name, size, lastModified, slice range), so
 * re-loading the same file+range skips re-running the segmenter — only
 * the (cheap, range-scoped) decode step re-runs.
 *
 * Per sentence: play the reference slice (from the decoded AudioBuffer via
 * an AudioBufferSourceNode start/offset/duration), record yourself with
 * MediaRecorder, play your take back, or compare (reference then yours).
 *
 * Transcription (optional) calls a local /transcribe endpoint on formanter.py
 * (faster-whisper — see requirements-transcribe.txt) with that sentence's WAV
 * slice. Nothing is sent anywhere unless that local server is running; the
 * resulting text is cached alongside the sentence's segmentation entry.
 */

const MAX_NONWAV_SLICE_SEC = 1800;      // 30 min cap on real-time capture for non-WAV formats
const WAV_DECODE_WARN_BYTES = 1.2e9;    // ~1.2 GB decoded (Float32) — advisory threshold, browsers commonly
                                         // fail to hold much more than ~2GB in one ArrayBuffer/AudioBuffer

// ─── IndexedDB: 'segments' store caches sentence splits, 'fileHandles' remembers
// File System Access API handles so a file doesn't need re-picking every visit ──
function shOpen() {
  return new Promise((res, rej) => {
    const rq = indexedDB.open('ipa-shadow', 2);
    rq.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('segments')) db.createObjectStore('segments');
      if (!db.objectStoreNames.contains('fileHandles')) db.createObjectStore('fileHandles', { keyPath: 'id' });
    };
    rq.onsuccess = e => res(e.target.result);
    rq.onerror = rej;
  });
}
async function shPut(key, val) {
  try { const db = await shOpen(); const tx = db.transaction('segments', 'readwrite'); tx.objectStore('segments').put(val, key); }
  catch (e) { console.warn('shPut failed:', e); }
}
async function shGet(key) {
  try {
    const db = await shOpen();
    return new Promise(res => {
      const tx = db.transaction('segments', 'readonly');
      const rq = tx.objectStore('segments').get(key);
      rq.onsuccess = () => res(rq.result ?? null);
      rq.onerror = () => res(null);
    });
  } catch (e) { return null; }
}
async function shDelete(key) {
  try { const db = await shOpen(); const tx = db.transaction('segments', 'readwrite'); tx.objectStore('segments').delete(key); }
  catch (e) { console.warn('shDelete failed:', e); }
}
async function shGetAll() {
  try {
    const db = await shOpen();
    return new Promise(res => {
      const tx = db.transaction('segments', 'readonly');
      const store = tx.objectStore('segments');
      const out = [];
      const rq = store.openCursor();
      rq.onsuccess = e => {
        const cur = e.target.result;
        if (cur) { out.push({ key: cur.key, ...cur.value }); cur.continue(); }
        else res(out);
      };
      rq.onerror = () => res(out);
    });
  } catch (e) { return []; }
}
function buildCacheKey(file, startSec, endSec) {
  return `${file.name}|${file.size}|${file.lastModified}|${Math.round(startSec * 1000)}-${Math.round(endSec * 1000)}`;
}
function fileIdentityId(file) { return `${file.name}|${file.size}|${file.lastModified}`; }

// ─── Remembered file handles (File System Access API) ─────────────────────────
// Only the handle is stored, not the audio bytes — re-granting access is near
// instant and avoids ever duplicating a (possibly huge) file into IndexedDB.
async function fhAdd(entry) {
  try { const db = await shOpen(); const tx = db.transaction('fileHandles', 'readwrite'); tx.objectStore('fileHandles').put(entry); }
  catch (e) { console.warn('fhAdd failed:', e); }
}
async function fhDelete(id) {
  try { const db = await shOpen(); const tx = db.transaction('fileHandles', 'readwrite'); tx.objectStore('fileHandles').delete(id); }
  catch (e) { console.warn('fhDelete failed:', e); }
}
async function fhGetAll() {
  try {
    const db = await shOpen();
    return new Promise(res => {
      const tx = db.transaction('fileHandles', 'readonly');
      const rq = tx.objectStore('fileHandles').getAll();
      rq.onsuccess = () => res(rq.result || []);
      rq.onerror = () => res([]);
    });
  } catch (e) { return []; }
}

// ─── WAV header parsing (for byte-exact, disk-cheap slicing) ──────────────────
function readAscii(view, offset, len) {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}
function tryParseWavChunks(buf) {
  const view = new DataView(buf);
  if (buf.byteLength < 12 || readAscii(view, 0, 4) !== 'RIFF' || readAscii(view, 8, 4) !== 'WAVE') return null;
  let offset = 12, fmt = null, dataChunkStart = null, dataSize = null;
  while (offset + 8 <= buf.byteLength) {
    const id = readAscii(view, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const payloadStart = offset + 8;
    if (id === 'fmt ') {
      fmt = {
        audioFormat: view.getUint16(payloadStart, true),
        channels: view.getUint16(payloadStart + 2, true),
        sampleRate: view.getUint32(payloadStart + 4, true),
        blockAlign: view.getUint16(payloadStart + 12, true),
        bitsPerSample: view.getUint16(payloadStart + 14, true),
      };
    } else if (id === 'data') {
      dataChunkStart = offset;
      dataSize = size;
      break;
    }
    offset = payloadStart + size + (size % 2);
  }
  if (!fmt || dataChunkStart == null) return null;
  return { fmt, dataChunkStart, dataPayloadStart: dataChunkStart + 8, dataSize };
}
async function looksLikeWav(file) {
  try {
    const buf = await file.slice(0, 12).arrayBuffer();
    const view = new DataView(buf);
    return readAscii(view, 0, 4) === 'RIFF' && readAscii(view, 8, 4) === 'WAVE';
  } catch (e) { return false; }
}
async function readWavHeaderInfo(file) {
  let prefixSize = 65536;
  const maxPrefix = 8 * 1024 * 1024;
  while (true) {
    const buf = await file.slice(0, Math.min(prefixSize, file.size)).arrayBuffer();
    const info = tryParseWavChunks(buf);
    if (info) {
      if (!info.dataSize || info.dataPayloadStart + info.dataSize > file.size) {
        info.dataSize = file.size - info.dataPayloadStart;
      }
      return info;
    }
    if (prefixSize >= file.size || prefixSize >= maxPrefix) return null;
    prefixSize *= 4;
  }
}
/** Byte-exact slice of a WAV file's PCM data — only reads the needed range off disk. */
async function sliceWavFile(file, header, startSec, endSec) {
  const { fmt, dataChunkStart, dataPayloadStart, dataSize } = header;
  const blockAlign = fmt.blockAlign || (fmt.channels * fmt.bitsPerSample / 8);
  const totalFrames = Math.floor(dataSize / blockAlign);
  const startFrame = Math.max(0, Math.min(totalFrames, Math.floor(startSec * fmt.sampleRate)));
  const endFrame = Math.max(startFrame, Math.min(totalFrames, Math.ceil(endSec * fmt.sampleRate)));
  const startByte = dataPayloadStart + startFrame * blockAlign;
  const endByte = dataPayloadStart + endFrame * blockAlign;

  const headerBuf = await file.slice(0, dataPayloadStart).arrayBuffer();
  const pcmBuf = await file.slice(startByte, endByte).arrayBuffer();

  const headerBytes = new Uint8Array(headerBuf);
  const view = new DataView(headerBytes.buffer);
  const newDataSize = pcmBuf.byteLength;
  view.setUint32(dataChunkStart + 4, newDataSize, true);
  view.setUint32(4, dataChunkStart + 8 + newDataSize - 8, true);

  return new Blob([headerBytes, pcmBuf], { type: 'audio/wav' }).arrayBuffer();
}

// ─── Duration probing for non-WAV formats (metadata only, no full decode) ─────
function probeDuration(file) {
  return new Promise(resolve => {
    const url = URL.createObjectURL(file);
    const el = new Audio();
    const cleanup = () => URL.revokeObjectURL(url);
    el.preload = 'metadata';
    el.addEventListener('loadedmetadata', () => { const d = isFinite(el.duration) ? el.duration : null; cleanup(); resolve(d); }, { once: true });
    el.addEventListener('error', () => { cleanup(); resolve(null); }, { once: true });
    el.src = url;
  });
}

/** Real-time capture fallback: seeks to startSec, taps decoded samples through a muted graph until endSec. */
async function decodeSliceViaCapture(file, startSec, endSec, onProgress) {
  const url = URL.createObjectURL(file);
  const el = document.createElement('audio');
  el.preload = 'auto';
  el.src = url;
  try {
    await new Promise((res, rej) => {
      el.addEventListener('loadedmetadata', res, { once: true });
      el.addEventListener('error', () => rej(new Error('Could not load audio')), { once: true });
    });
    await new Promise(res => {
      const onSeeked = () => { el.removeEventListener('seeked', onSeeked); res(); };
      el.addEventListener('seeked', onSeeked);
      el.currentTime = startSec;
    });

    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const source = ctx.createMediaElementSource(el);
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    const silence = ctx.createGain();
    silence.gain.value = 0;
    source.connect(processor);
    processor.connect(silence);
    silence.connect(ctx.destination);

    const chunks = [];
    const sliceDur = Math.max(0.01, endSec - startSec);
    processor.onaudioprocess = e => {
      chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      onProgress?.(Math.min(1, (el.currentTime - startSec) / sliceDur));
    };

    await el.play();
    await new Promise(res => {
      const check = () => {
        if (el.currentTime >= endSec || el.ended || el.paused) { res(); return; }
        requestAnimationFrame(check);
      };
      requestAnimationFrame(check);
    });
    el.pause();
    processor.disconnect(); source.disconnect(); silence.disconnect();

    const total = chunks.reduce((s, c) => s + c.length, 0);
    const samples = new Float32Array(total);
    let off = 0; for (const c of chunks) { samples.set(c, off); off += c.length; }
    const outBuffer = ctx.createBuffer(1, Math.max(1, samples.length), ctx.sampleRate);
    outBuffer.copyToChannel(samples, 0);
    await ctx.close();
    return outBuffer;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ─── Sentence boundary detection (energy-based silence gaps) ──────────────────
function computeMonoData(buffer) {
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0);
  const n = buffer.length;
  const out = new Float32Array(n);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < n; i++) out[i] += data[i] / buffer.numberOfChannels;
  }
  return out;
}

/** Same energy-threshold heuristic as detectSentences, but just the onset of the first speech. */
function detectLeadingSilenceMs(buffer) {
  const windowMs = 20;
  const sr = buffer.sampleRate;
  const data = computeMonoData(buffer);
  const winSize = Math.max(1, Math.round(sr * windowMs / 1000));
  const nWin = Math.ceil(data.length / winSize);
  const rms = new Float32Array(nWin);
  for (let w = 0; w < nWin; w++) {
    const start = w * winSize, end = Math.min(start + winSize, data.length);
    let sum = 0;
    for (let i = start; i < end; i++) sum += data[i] * data[i];
    rms[w] = Math.sqrt(sum / Math.max(1, end - start));
  }
  const sorted = Float32Array.from(rms).sort();
  const floor = sorted[Math.floor(sorted.length * 0.15)] || 0;
  const peak = sorted[sorted.length - 1] || 0.0001;
  const threshold = Math.max(floor * 2.5, peak * 0.035, 0.0025);
  for (let w = 0; w < nWin; w++) {
    if (rms[w] > threshold) return Math.max(0, w * windowMs - 40);   // small pad-back so the onset isn't clipped
  }
  return 0;   // all silence — nothing to trim
}

/**
 * Splits an AudioBuffer into speech segments separated by silence gaps of
 * at least `minSilenceMs`. Shorter gaps (e.g. between words) are merged into
 * the surrounding speech, so a "sentence" can contain internal pauses.
 */
function detectSentences(buffer, params = {}) {
  const windowMs      = 20;
  const minSilenceMs  = params.minSilenceMs  ?? 300;
  const minSentenceMs = params.minSentenceMs ?? 350;
  const padMs         = params.padMs         ?? 70;

  const sr   = buffer.sampleRate;
  const data = computeMonoData(buffer);
  const winSize = Math.max(1, Math.round(sr * windowMs / 1000));
  const nWin = Math.ceil(data.length / winSize);
  const rms = new Float32Array(nWin);
  for (let w = 0; w < nWin; w++) {
    const start = w * winSize, end = Math.min(start + winSize, data.length);
    let sum = 0;
    for (let i = start; i < end; i++) sum += data[i] * data[i];
    rms[w] = Math.sqrt(sum / Math.max(1, end - start));
  }

  const sorted = Float32Array.from(rms).sort();
  const floor  = sorted[Math.floor(sorted.length * 0.15)] || 0;
  const peak   = sorted[sorted.length - 1] || 0.0001;
  const threshold = Math.max(floor * 2.5, peak * 0.035, 0.0025);

  const isSpeech = new Uint8Array(nWin);
  for (let w = 0; w < nWin; w++) isSpeech[w] = rms[w] > threshold ? 1 : 0;

  const minSilenceWin = Math.max(1, Math.round(minSilenceMs / windowMs));
  let i = 0;
  while (i < nWin) {
    if (!isSpeech[i]) {
      let j = i; while (j < nWin && !isSpeech[j]) j++;
      if (j - i < minSilenceWin) for (let k = i; k < j; k++) isSpeech[k] = 1;
      i = j;
    } else i++;
  }

  const rawSegments = [];
  i = 0;
  while (i < nWin) {
    if (isSpeech[i]) {
      let j = i; while (j < nWin && isSpeech[j]) j++;
      rawSegments.push({ start: i * windowMs, end: j * windowMs });
      i = j;
    } else i++;
  }

  const durMs = buffer.duration * 1000;
  const padded = rawSegments
      .map(s => ({ start: Math.max(0, s.start - padMs), end: Math.min(durMs, s.end + padMs) }))
      .filter(s => s.end - s.start >= minSentenceMs);

  const merged = [];
  for (const s of padded) {
    const last = merged[merged.length - 1];
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else merged.push({ ...s });
  }

  return merged.map((s, idx) => ({ index: idx, start: Math.round(s.start), end: Math.round(s.end) }));
}

// ─── Session state ─────────────────────────────────────────────────────────────
let currentFile = null, currentWavHeader = null, currentDuration = null, maxSecGlobal = 0;
let currentCacheKey = null, currentBuffer = null, currentSegments = null, currentTranscripts = {};
let playCtx = null, activeSource = null;
let micStream = null, activeRecorder = null, activeRecordingIdx = null;
const recordings = {};   // idx -> {blob, url}
const rowRefs = {};      // idx -> row element

function getPlayCtx() {
  if (!playCtx || playCtx.state === 'closed') playCtx = new (window.AudioContext || window.webkitAudioContext)();
  return playCtx;
}
function stopActiveSource() {
  if (activeSource) { try { activeSource.stop(); } catch (e) {} activeSource = null; }
}
function playAudioBufferSlice(buffer, startMs, endMs, rate = 1, onEnded) {
  if (!buffer) return null;
  stopActiveSource();
  const ctx = getPlayCtx();
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.playbackRate.value = rate;
  src.connect(ctx.destination);
  src.start(0, startMs / 1000, (endMs - startMs) / 1000);
  activeSource = src;
  src.onended = () => { if (activeSource === src) activeSource = null; onEnded?.(); };
  return src;
}
function playBufferSlice(startMs, endMs, rate = 1, onEnded) { return playAudioBufferSlice(currentBuffer, startMs, endMs, rate, onEnded); }
function playRefSeg(idx, rate = 1) { const seg = currentSegments[idx]; playBufferSlice(seg.start, seg.end, rate); }

function trimSilenceEnabled() { return document.getElementById('trimSilenceToggle')?.checked ?? true; }
/** Plays a user recording, skipping its detected leading silence when the toggle is on and decode succeeded. */
function playRecording(rec, onEnded) {
  if (!rec) return;
  if (trimSilenceEnabled() && rec.buffer) {
    playAudioBufferSlice(rec.buffer, rec.trimStartMs, rec.buffer.duration * 1000, 1, onEnded);
  } else {
    const a = new Audio(rec.url);
    if (onEnded) a.onended = onEnded;
    a.play().catch(() => {});
  }
}
function playMine(idx) { playRecording(recordings[idx]); }
function compareSeg(idx) {
  const seg = currentSegments[idx], rec = recordings[idx];
  if (!rec) { playRefSeg(idx); return; }
  playBufferSlice(seg.start, seg.end, 1, () => {
    setTimeout(() => playRecording(rec), 300);
  });
}

// ─── Recording ───────────────────────────────────────────────────────────────
async function getMicStream() {
  if (micStream) return micStream;
  micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  return micStream;
}
function pickRecorderMime() {
  for (const m of ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', '']) {
    if (!m || MediaRecorder.isTypeSupported(m)) return m;
  }
  return '';
}
async function toggleRecord(idx, row) {
  if (activeRecordingIdx === idx) { activeRecorder.stop(); return; }
  if (activeRecorder) activeRecorder.stop();
  try {
    const stream = await getMicStream();
    const chunks = [];
    const mime = pickRecorderMime();
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = async () => {
      const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
      if (recordings[idx]?.url) URL.revokeObjectURL(recordings[idx].url);
      recordings[idx] = { blob, url: URL.createObjectURL(blob), buffer: null, trimStartMs: 0 };
      activeRecorder = null; activeRecordingIdx = null;
      setRowRecordingState(row, false);
      row.querySelector('.play-mine').disabled = false;
      row.querySelector('.compare-btn').disabled = false;
      row.querySelector('.sent-status').textContent = 'Recorded ✓';
      // Decode in the background to locate leading silence — url-based playback already works meanwhile.
      try {
        const arrayBuf = await blob.arrayBuffer();
        const decodeCtx = new (window.AudioContext || window.webkitAudioContext)();
        const buf = await decodeCtx.decodeAudioData(arrayBuf);
        decodeCtx.close();
        if (recordings[idx]?.blob === blob) {   // guard: a newer recording may have replaced this one meanwhile
          recordings[idx].buffer = buf;
          recordings[idx].trimStartMs = detectLeadingSilenceMs(buf);
        }
      } catch (e) { /* trimming unavailable for this recording; url playback still works */ }
    };
    rec.start();
    activeRecorder = rec; activeRecordingIdx = idx;
    setRowRecordingState(row, true);
  } catch (e) {
    row.querySelector('.sent-status').textContent = 'Mic error: ' + e.message;
  }
}
function setRowRecordingState(row, active) {
  const btn = row.querySelector('.rec-btn'), dot = row.querySelector('.rec-dot'), status = row.querySelector('.sent-status');
  btn.textContent = active ? '■ Stop' : '● Rec';
  btn.classList.toggle('rec-active', active);
  dot.classList.toggle('on', active);
  if (active) status.textContent = 'Recording…';
}

// ─── Transcription (optional local /transcribe server — see formanter.py) ─────
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
function extractMonoSlice(buffer, startMs, endMs) {
  const sr = buffer.sampleRate;
  const data = computeMonoData(buffer);
  const i0 = Math.floor(startMs / 1000 * sr), i1 = Math.min(data.length, Math.ceil(endMs / 1000 * sr));
  return { samples: data.slice(i0, i1), sampleRate: sr };
}
// formanter.py always runs its HTTP server on :5050 (see its __main__ block),
// regardless of what serves shadow.html itself — so just always talk to that.
// CORS is already enabled there, so this works even when shadow.html is
// served from a different origin.
const TRANSCRIBE_SERVER = 'http://localhost:5050';
function getTranscribeServer() { return TRANSCRIBE_SERVER; }
async function checkTranscribeServer() {
  const el = document.getElementById('transcribeBadge');
  if (!el) return;
  try {
    const r = await fetch(TRANSCRIBE_SERVER + '/ping', { signal: AbortSignal.timeout(1500) });
    if (r.ok) { el.textContent = `📝 Transcription server: ✓ connected (${TRANSCRIBE_SERVER})`; el.className = 'cache-badge hit'; return; }
    el.textContent = `📝 Transcription server: got HTTP ${r.status} from ${TRANSCRIBE_SERVER}`;
    el.className = 'cache-badge';
  } catch (e) {
    el.textContent = `📝 Transcription server: unreachable at ${TRANSCRIBE_SERVER} — run formanter.py`;
    el.className = 'cache-badge';
  }
}
async function cacheTranscript(idx, text) {
  if (!currentCacheKey) return;
  const cached = await shGet(currentCacheKey);
  if (!cached) return;
  cached.transcripts = cached.transcripts || {};
  cached.transcripts[idx] = text;
  await shPut(currentCacheKey, cached);
}
async function transcribeSentence(idx, row) {
  if (!currentBuffer || !currentSegments?.[idx]) return;
  const seg = currentSegments[idx];
  const btn = row.querySelector('.transcribe-btn');
  const out = row.querySelector('.sent-transcript');
  btn.disabled = true; btn.textContent = '…';
  out.textContent = 'Transcribing…'; out.style.display = 'block';
  try {
    const { samples, sampleRate } = extractMonoSlice(currentBuffer, seg.start, seg.end);
    const blob = encodeWavBlob(samples, sampleRate);
    const form = new FormData();
    form.append('file', blob, 'slice.wav');
    const resp = await fetch(getTranscribeServer() + '/transcribe', { method: 'POST', body: form, signal: AbortSignal.timeout(60000) });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || ('HTTP ' + resp.status));
    }
    const data = await resp.json();
    const text = data.text || '(no speech detected)';
    out.textContent = text;
    currentTranscripts[idx] = text;
    await cacheTranscript(idx, text);
  } catch (e) {
    out.textContent = 'Error: ' + e.message;
  }
  btn.disabled = false; btn.textContent = '📝';
}
async function transcribeAll() {
  if (!currentSegments) return;
  for (let idx = 0; idx < currentSegments.length; idx++) {
    const row = rowRefs[idx];
    if (row) await transcribeSentence(idx, row);
  }
}

// ─── Waveform (static, per-row) ────────────────────────────────────────────────
function drawStaticWave(canvas, buffer, startMs, endMs) {
  if (!canvas) return;
  const W = canvas.width = canvas.offsetWidth || 300, H = canvas.height = 40;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#1a2e48'; ctx.fillRect(0, 0, W, H);
  const sr = buffer.sampleRate, data = buffer.getChannelData(0);
  const i0 = Math.floor(startMs / 1000 * sr), i1 = Math.min(data.length, Math.ceil(endMs / 1000 * sr));
  const n = i1 - i0; if (n <= 0) return;
  const step = Math.max(1, Math.ceil(n / W));
  for (let x = 0; x < W; x++) {
    let pk = 0;
    const s = i0 + x * step, e = Math.min(i0 + (x + 1) * step, i1);
    for (let i = s; i < e; i++) pk = Math.max(pk, Math.abs(data[i]));
    const h = Math.max(1, pk * (H - 4));
    ctx.fillStyle = '#4a90c8';
    ctx.fillRect(x, (H - h) / 2, 1, h);
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────────
function secToClock(sec) {
  sec = Math.max(0, sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
function clockToSec(str) {
  const parts = String(str).split(':').map(x => parseFloat(x) || 0);
  let sec = 0; for (const p of parts) sec = sec * 60 + p;
  return sec;
}
/** Web Audio always decodes to Float32 per channel, regardless of source bit depth. */
function estimateDecodedBytes(fmt, durationSec) {
  return durationSec * fmt.sampleRate * fmt.channels * 4;
}
function fmtBytes(n) {
  if (n > 1e9) return (n / 1e9).toFixed(2) + ' GB';
  if (n > 1e6) return (n / 1e6).toFixed(0) + ' MB';
  return (n / 1e3).toFixed(0) + ' KB';
}
function msToClock(ms) {
  const s = ms / 1000;
  const m = Math.floor(s / 60), rem = (s - m * 60).toFixed(2);
  return `${m}:${rem.padStart(5, '0')}`;
}
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function setStatus(text) { const el = document.getElementById('uploadStatus'); if (el) el.textContent = text; }
function setCacheBadge(cached, when) {
  const el = document.getElementById('cacheBadge');
  if (!el) return;
  if (cached) { el.textContent = `⚡ Cached${when ? ' · ' + new Date(when).toLocaleString() : ''}`; el.className = 'cache-badge hit'; }
  else { el.textContent = '● Fresh analysis'; el.className = 'cache-badge miss'; }
}
function readParams() {
  return { minSilenceMs: parseInt(document.getElementById('silenceSlider').value, 10) };
}

// ─── Progress bar (real percentages: file read / decode; indeterminate for segmentation) ─
function showProgress(on, label = '', indeterminate = false) {
  const wrap = document.getElementById('progressWrap');
  wrap.style.display = on ? 'flex' : 'none';
  wrap.classList.toggle('indeterminate', !!indeterminate);
  if (on) { setProgressLabel(label); setProgressPct(indeterminate ? 100 : 0); }
}
function setProgressLabel(label) { document.getElementById('progressLabel').textContent = label; }
function setProgressPct(pct) {
  document.getElementById('progressFill').style.width = Math.max(0, Math.min(100, pct)) + '%';
  document.getElementById('progressPct').textContent = Math.round(pct) + '%';
}

// ─── Rendering ─────────────────────────────────────────────────────────────────
function renderSentenceList() {
  const container = document.getElementById('sentenceList');
  container.innerHTML = '';
  for (const k in rowRefs) delete rowRefs[k];
  const has = currentSegments && currentSegments.length > 0;
  document.getElementById('sentenceListWrap').style.display = has ? 'block' : 'none';
  document.getElementById('sentCount').textContent = has ? currentSegments.length : 0;
  if (!has) return;

  currentSegments.forEach((seg, idx) => {
    const row = document.createElement('div');
    row.className = 'sent-row';
    row.innerHTML = `
      <div class="sent-idx">${idx + 1}</div>
      <div class="sent-main">
        <canvas class="sent-wave"></canvas>
        <div class="sent-meta">
          <span class="sent-dur">${((seg.end - seg.start) / 1000).toFixed(2)}s</span>
          <span class="sent-time">${msToClock(seg.start)} – ${msToClock(seg.end)}</span>
        </div>
        <div class="sent-transcript" style="display:none"></div>
      </div>
      <div class="sent-controls">
        <button class="sent-btn play-ref" title="Play reference">▶</button>
        <button class="sent-btn play-ref-slow" title="Play at half speed">🐌</button>
        <button class="sent-btn rec-btn" title="Record your voice">● Rec</button>
        <span class="rec-dot"></span>
        <button class="sent-btn play-mine" disabled title="Play your recording">▶ You</button>
        <button class="sent-btn compare-btn" disabled title="Play reference then yours">⇄ Compare</button>
        <button class="sent-btn transcribe-btn" title="Transcribe this sentence (local Whisper server)">📝</button>
        <span class="sent-status">Not recorded</span>
      </div>`;
    container.appendChild(row);
    rowRefs[idx] = row;

    const canvas = row.querySelector('.sent-wave');
    requestAnimationFrame(() => drawStaticWave(canvas, currentBuffer, seg.start, seg.end));

    if (currentTranscripts[idx]) {
      const out = row.querySelector('.sent-transcript');
      out.textContent = currentTranscripts[idx];
      out.style.display = 'block';
    }

    row.querySelector('.play-ref').addEventListener('click', () => playRefSeg(idx));
    row.querySelector('.play-ref-slow').addEventListener('click', () => playRefSeg(idx, 0.6));
    row.querySelector('.rec-btn').addEventListener('click', () => toggleRecord(idx, row));
    row.querySelector('.play-mine').addEventListener('click', () => playMine(idx));
    row.querySelector('.compare-btn').addEventListener('click', () => compareSeg(idx));
    row.querySelector('.transcribe-btn').addEventListener('click', () => transcribeSentence(idx, row));
  });
}

async function refreshCacheList() {
  const el = document.getElementById('cacheList');
  if (!el) return;
  const list = await shGetAll();
  if (!list.length) { el.innerHTML = '<div class="cache-empty">No cached files yet</div>'; return; }
  el.innerHTML = list.sort((a, b) => b.createdAt - a.createdAt).map(e => `
    <div class="cache-item">
      <span class="cache-name">${escapeHtml(e.fileName || '(unnamed)')}</span>
      <span class="cache-n">${secToClock(e.sliceStartSec || 0)}–${secToClock(e.sliceEndSec || 0)} · ${e.segments?.length || 0} sentences</span>
      <span class="cache-date">${new Date(e.createdAt).toLocaleDateString()}</span>
      <button class="cache-forget" data-key="${e.key}" title="Forget cached analysis">✕</button>
    </div>`).join('');
  el.querySelectorAll('.cache-forget').forEach(btn => {
    btn.addEventListener('click', async () => {
      await shDelete(btn.dataset.key);
      if (btn.dataset.key === currentCacheKey) setCacheBadge(false);
      refreshCacheList();
    });
  });
}

// ─── Range picker ──────────────────────────────────────────────────────────────
function setupRangeUI(duration) {
  maxSecGlobal = Math.max(1, Math.floor(duration));
  const startSlider = document.getElementById('rangeStartSlider');
  const endSlider   = document.getElementById('rangeEndSlider');
  startSlider.min = 0; startSlider.max = maxSecGlobal;
  endSlider.min   = 0; endSlider.max   = maxSecGlobal;

  let defaultEnd;
  if (currentWavHeader) {
    const safeSec = WAV_DECODE_WARN_BYTES / (currentWavHeader.fmt.sampleRate * currentWavHeader.fmt.channels * 4);
    defaultEnd = Math.min(maxSecGlobal, Math.max(60, Math.floor(safeSec)));
  } else {
    defaultEnd = Math.min(maxSecGlobal, 300);
  }
  startSlider.value = 0;
  endSlider.value = defaultEnd;
  document.getElementById('rangeStart').value = secToClock(0);
  document.getElementById('rangeEnd').value = secToClock(defaultEnd);
  updateRangeDurLabel();
  document.getElementById('rangeWrap').style.display = 'block';
}
function updateRangeDurLabel() {
  const s = clockToSec(document.getElementById('rangeStart').value);
  const e = clockToSec(document.getElementById('rangeEnd').value);
  const dur = Math.max(0, e - s);
  let msg = `Selected: ${secToClock(dur)} of ${secToClock(maxSecGlobal)} total`;
  if (!currentWavHeader && dur > MAX_NONWAV_SLICE_SEC) {
    msg += ` — will be clamped to ${secToClock(MAX_NONWAV_SLICE_SEC)} (non-WAV real-time decode limit)`;
  }
  if (currentWavHeader) {
    const bytes = estimateDecodedBytes(currentWavHeader.fmt, dur);
    msg += ` · ~${fmtBytes(bytes)} decoded`;
    if (bytes > WAV_DECODE_WARN_BYTES) msg += ' ⚠ large — your browser may run out of memory, try a shorter range';
  }
  document.getElementById('rangeDurLabel').textContent = msg;
}

// ─── Upload / decode / segmentation flow ───────────────────────────────────────
function resetPlaybackAndRecordings() {
  stopActiveSource();
  if (activeRecorder) { try { activeRecorder.stop(); } catch (e) {} activeRecorder = null; activeRecordingIdx = null; }
  Object.values(recordings).forEach(r => r?.url && URL.revokeObjectURL(r.url));
  for (const k in recordings) delete recordings[k];
}
function resetSession() {
  resetPlaybackAndRecordings();
  currentFile = null; currentWavHeader = null; currentDuration = null;
  currentBuffer = null; currentSegments = null; currentCacheKey = null; currentTranscripts = {};
  document.getElementById('fileInfo').style.display = 'none';
  document.getElementById('rangeWrap').style.display = 'none';
  document.getElementById('sentenceListWrap').style.display = 'none';
  document.getElementById('cacheBadge').textContent = '';
  document.getElementById('cacheBadge').className = 'cache-badge';
  showProgress(false);
  setStatus('');
}

async function runSegmentation() {
  if (!currentBuffer) return;
  showProgress(true, 'Analysing audio for sentence boundaries…', true);
  await new Promise(r => requestAnimationFrame(r));   // let the UI paint before the sync scan
  const params = readParams();
  const segments = detectSentences(currentBuffer, params);
  currentSegments = segments;
  currentTranscripts = {};
  await shPut(currentCacheKey, {
    segments, params, transcripts: {},
    sliceStartSec: currentSliceStart, sliceEndSec: currentSliceEnd,
    fileName: currentFile?.name, size: currentFile?.size,
    createdAt: Date.now(),
  });
  showProgress(false);
  setCacheBadge(false);
  renderSentenceList();
  setStatus(`Found ${segments.length} sentence${segments.length !== 1 ? 's' : ''}`);
  refreshCacheList();
}

let currentSliceStart = 0, currentSliceEnd = 0;

async function loadSlice(startSec, endSec) {
  if (!currentFile) return;
  if (!currentWavHeader) endSec = Math.min(endSec, startSec + MAX_NONWAV_SLICE_SEC);
  resetPlaybackAndRecordings();
  currentBuffer = null; currentSegments = null; currentTranscripts = {};
  document.getElementById('sentenceListWrap').style.display = 'none';
  currentSliceStart = startSec; currentSliceEnd = endSec;
  currentCacheKey = buildCacheKey(currentFile, startSec, endSec);

  const loadBtn = document.getElementById('loadSliceBtn');
  loadBtn.disabled = true;
  try {
    if (currentWavHeader) {
      showProgress(true, 'Reading WAV slice from disk…');
      setProgressPct(30);
      const buf = await sliceWavFile(currentFile, currentWavHeader, startSec, endSec);
      setProgressPct(70);
      setProgressLabel('Decoding…');
      const decodeCtx = new (window.AudioContext || window.webkitAudioContext)();
      currentBuffer = await decodeCtx.decodeAudioData(buf);
      decodeCtx.close();
      setProgressPct(100);
    } else {
      showProgress(true, 'Decoding selected range in real time…');
      currentBuffer = await decodeSliceViaCapture(currentFile, startSec, endSec, p => setProgressPct(p * 100));
    }
  } catch (e) {
    showProgress(false);
    let hint = '';
    if (currentWavHeader) {
      const bytes = estimateDecodedBytes(currentWavHeader.fmt, endSec - startSec);
      if (bytes > WAV_DECODE_WARN_BYTES) {
        hint = ` This range decodes to ~${fmtBytes(bytes)} of raw audio — likely too large for your browser to hold in memory at once. Try a shorter range.`;
      }
    }
    setStatus('Could not decode selected range: ' + e.message + hint);
    loadBtn.disabled = false;
    return;
  }
  showProgress(false);
  loadBtn.disabled = false;

  const cached = await shGet(currentCacheKey);
  if (cached && cached.segments?.length) {
    currentSegments = cached.segments;
    currentTranscripts = cached.transcripts || {};
    if (cached.params?.minSilenceMs) {
      document.getElementById('silenceSlider').value = cached.params.minSilenceMs;
      document.getElementById('silenceVal').textContent = cached.params.minSilenceMs + ' ms';
    }
    setCacheBadge(true, cached.createdAt);
    renderSentenceList();
    setStatus(`Loaded ${cached.segments.length} sentences from cache — no re-analysis needed`);
    refreshCacheList();
    return;
  }
  setCacheBadge(false);
  await runSegmentation();
}

async function handleFile(file) {
  resetSession();
  currentFile = file;
  setStatus('Reading file info…');

  if (await looksLikeWav(file)) {
    currentWavHeader = await readWavHeaderInfo(file);
  }
  let duration;
  if (currentWavHeader) {
    duration = currentWavHeader.dataSize / (currentWavHeader.fmt.sampleRate * currentWavHeader.fmt.blockAlign);
  } else {
    duration = await probeDuration(file);
  }
  if (duration == null) { setStatus('Could not read audio duration — unsupported or corrupt file?'); return; }
  currentDuration = duration;

  document.getElementById('fileInfo').style.display = 'flex';
  document.getElementById('fileName').textContent = file.name;
  document.getElementById('fileDuration').textContent =
      `${secToClock(duration)}${currentWavHeader ? ' · WAV (instant slice decode)' : ' · non-WAV (real-time slice decode)'}`;
  document.getElementById('fullAudio').src = URL.createObjectURL(file);

  setupRangeUI(duration);
  setStatus('Pick a time range below, then load it.');
}

// ─── Remembered files list (populated only for files opened via "📂 Open file",
// since drag-and-drop and <input type=file> never hand back a reusable handle) ─
async function renderRecentFiles() {
  const el = document.getElementById('recentFilesList');
  if (!el) return;
  if (!('showOpenFilePicker' in window)) {
    el.innerHTML = '<div class="cache-empty">Remembered files need a Chromium browser (Chrome/Edge)</div>';
    return;
  }
  const entries = await fhGetAll();
  if (!entries.length) {
    el.innerHTML = '<div class="cache-empty">No remembered files yet — use "📂 Open file" below</div>';
    return;
  }
  el.innerHTML = entries.sort((a, b) => (b.lastOpened || 0) - (a.lastOpened || 0)).map(e => `
    <div class="cache-item">
      <span class="cache-name">${escapeHtml(e.name)}</span>
      <span class="cache-n">${(e.size / 1e6).toFixed(1)} MB</span>
      <button class="sent-btn recent-open-btn" data-id="${e.id}" type="button">▶ Open</button>
      <button class="cache-forget" data-id="${e.id}" title="Forget this file">✕</button>
    </div>`).join('');
  el.querySelectorAll('.recent-open-btn').forEach(btn => {
    btn.addEventListener('click', () => openRecentFile(btn.dataset.id));
  });
  el.querySelectorAll('.cache-forget').forEach(btn => {
    btn.addEventListener('click', async () => { await fhDelete(btn.dataset.id); renderRecentFiles(); });
  });
}
async function openRecentFile(id) {
  const entries = await fhGetAll();
  const entry = entries.find(e => e.id === id);
  if (!entry) return;
  try {
    let perm = await entry.handle.queryPermission({ mode: 'read' });
    if (perm !== 'granted') perm = await entry.handle.requestPermission({ mode: 'read' });
    if (perm !== 'granted') { setStatus('Permission denied for ' + entry.name); return; }
    const file = await entry.handle.getFile();
    entry.lastOpened = Date.now();
    await fhAdd(entry);
    handleFile(file);
  } catch (e) {
    setStatus('Could not reopen file: ' + e.message);
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

  document.getElementById('openFileBtn')?.addEventListener('click', async () => {
    if (!('showOpenFilePicker' in window)) { fileInput.click(); return; }
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [{ description: 'Audio', accept: { 'audio/*': ['.wav', '.mp3', '.ogg', '.oga', '.m4a', '.flac', '.webm'] } }],
      });
      const file = await handle.getFile();
      await fhAdd({ id: fileIdentityId(file), name: file.name, size: file.size, lastModified: file.lastModified, handle, lastOpened: Date.now() });
      renderRecentFiles();
      handleFile(file);
    } catch (e) {
      if (e.name !== 'AbortError') setStatus('Could not open file: ' + e.message);
    }
  });

  // ── Range picker wiring ──
  const startSlider = document.getElementById('rangeStartSlider');
  const endSlider   = document.getElementById('rangeEndSlider');
  const startText   = document.getElementById('rangeStart');
  const endText     = document.getElementById('rangeEnd');

  function onSliderInput() {
    let s = parseInt(startSlider.value, 10), e = parseInt(endSlider.value, 10);
    if (e <= s) { e = Math.min(maxSecGlobal, s + 1); endSlider.value = e; }
    startText.value = secToClock(s);
    endText.value = secToClock(e);
    updateRangeDurLabel();
  }
  function onTextChange() {
    let s = clockToSec(startText.value), e = clockToSec(endText.value);
    s = Math.max(0, Math.min(maxSecGlobal, s));
    e = Math.max(s + 1, Math.min(maxSecGlobal, e));
    startSlider.value = s; endSlider.value = e;
    startText.value = secToClock(s); endText.value = secToClock(e);
    updateRangeDurLabel();
  }
  startSlider.addEventListener('input', onSliderInput);
  endSlider.addEventListener('input', onSliderInput);
  startText.addEventListener('change', onTextChange);
  endText.addEventListener('change', onTextChange);

  document.querySelectorAll('#rangeWrap [data-preset]').forEach(btn => {
    btn.addEventListener('click', () => {
      const p = btn.dataset.preset;
      const s = 0, e = p === 'full' ? maxSecGlobal : Math.min(maxSecGlobal, parseInt(p, 10));
      startSlider.value = s; endSlider.value = e;
      startText.value = secToClock(s); endText.value = secToClock(e);
      updateRangeDurLabel();
    });
  });

  document.getElementById('loadSliceBtn').addEventListener('click', () => {
    loadSlice(clockToSec(startText.value), clockToSec(endText.value));
  });

  // ── Segmentation params ──
  const slider = document.getElementById('silenceSlider');
  slider.addEventListener('input', () => {
    document.getElementById('silenceVal').textContent = slider.value + ' ms';
  });
  document.getElementById('reanalyzeBtn').addEventListener('click', () => runSegmentation());
  document.getElementById('clearCacheBtn').addEventListener('click', async () => {
    if (!currentCacheKey) return;
    await shDelete(currentCacheKey);
    setCacheBadge(false);
    refreshCacheList();
  });

  document.getElementById('transcribeAllBtn')?.addEventListener('click', () => transcribeAll());

  refreshCacheList();
  renderRecentFiles();
  checkTranscribeServer();
});
