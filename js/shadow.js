/**
 * shadow.js — Shadowing practice page (shadow.html).
 *
 * Sessions: 1 file (identified by name+size+lastModified — see
 * fileIdentityId) = 1 session, stored in IndexedDB (see sessionGet/
 * saveSession). A session holds one *analysis* per silence-sensitivity
 * value used on it — each analysis has its own (extendable) range, its
 * segments, and its cached transcripts. Re-picking a file whose session
 * already has an analysis for the current sensitivity prefills the range
 * picker to it (see syncSensitivityCacheNote); loading that exact range is
 * a pure cache hit (ensureBufferForAnalysis), and loading a LARGER range
 * with the same start extends it (extendAnalysisTo) instead of redoing it:
 * only the newly-added audio is decoded — the already-decoded prefix is
 * reused straight out of memory — and the segmentation threshold from the
 * original analysis is reused too, so old segment boundaries never shift.
 * Old segments/transcripts before the extension point are left untouched;
 * only a possibly-truncated last segment is re-examined against the new
 * audio (see extendAnalysisTo's doc comment) before appending new ones.
 *
 * Decoding a range: WAV is parsed straight from its RIFF header and
 * Blob.slice() reads just the needed byte range off disk (cheap regardless
 * of file length — 3h+ files are fine); everything else has no cheap
 * byte-exact seek client-side, so it's captured in real time (an <audio>
 * element seeks to the start, plays muted through a ScriptProcessorNode
 * tap, raw samples are collected until the end of the range — bounded to
 * MAX_NONWAV_SLICE_SEC to stay responsive).
 *
 * Per sentence: play the reference slice (from the decoded AudioBuffer via
 * an AudioBufferSourceNode start/offset/duration), record yourself with
 * MediaRecorder, play your take back, or compare (reference then yours).
 *
 * Transcription can use a local /transcribe endpoint on formanter.py
 * (faster-whisper — see requirements-transcribe.txt) or, as a no-install
 * alternative, the Hugging Face Inference API directly from the browser.
 * Either way, results are cached in the sentence's analysis entry above.
 */

const MAX_NONWAV_SLICE_SEC = 1800;      // 30 min cap on real-time capture for non-WAV formats
const WAV_DECODE_WARN_BYTES = 1.2e9;    // ~1.2 GB decoded (Float32) — advisory threshold, browsers commonly
                                         // fail to hold much more than ~2GB in one ArrayBuffer/AudioBuffer

// ─── IndexedDB: 'sessions' (one row per file — see fileIdentityId — holding one
// analysis per silence-sensitivity value used), 'fileHandles' remembers File
// System Access API handles so a file doesn't need re-picking every visit ──
function shOpen() {
  return new Promise((res, rej) => {
    const rq = indexedDB.open('ipa-shadow', 3);
    rq.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'fileId' });
      if (!db.objectStoreNames.contains('fileHandles')) db.createObjectStore('fileHandles', { keyPath: 'id' });
      // 'segments' (v2's flat range-keyed cache) is superseded by 'sessions' — left in place
      // rather than deleted so an upgrade never risks touching data it doesn't understand.
    };
    rq.onsuccess = e => res(e.target.result);
    rq.onerror = rej;
  });
}
function fileIdentityId(file) { return `${file.name}|${file.size}|${file.lastModified}`; }

// ─── Sessions: 1 file = 1 session; each session holds one analysis per
// silence-sensitivity value, each with its own (extendable) range, its
// segments, and its cached transcripts. ──────────────────────────────────────
async function sessionGet(fileId) {
  if (!fileId) return null;
  try {
    const db = await shOpen();
    return new Promise(res => {
      const tx = db.transaction('sessions', 'readonly');
      const rq = tx.objectStore('sessions').get(fileId);
      rq.onsuccess = () => res(rq.result ?? null);
      rq.onerror = () => res(null);
    });
  } catch (e) { return null; }
}
async function sessionPut(session) {
  try { const db = await shOpen(); const tx = db.transaction('sessions', 'readwrite'); tx.objectStore('sessions').put(session); }
  catch (e) { console.warn('sessionPut failed:', e); }
}
async function sessionGetAll() {
  try {
    const db = await shOpen();
    return new Promise(res => {
      const tx = db.transaction('sessions', 'readonly');
      const rq = tx.objectStore('sessions').getAll();
      rq.onsuccess = () => res(rq.result || []);
      rq.onerror = () => res([]);
    });
  } catch (e) { return []; }
}
async function sessionDeleteAnalysis(fileId, minSilenceMs) {
  const session = await sessionGet(fileId);
  if (!session) return;
  delete session.analyses[minSilenceMs];
  if (!Object.keys(session.analyses).length) {
    try { const db = await shOpen(); const tx = db.transaction('sessions', 'readwrite'); tx.objectStore('sessions').delete(fileId); }
    catch (e) { console.warn('session delete failed:', e); }
  } else {
    await sessionPut(session);
  }
}
/** Persists currentAnalysis into currentFileId's session (transcripts/segments already live-mutated on it). */
async function saveSession() {
  if (!currentFileId || !currentAnalysis) return;
  let session = await sessionGet(currentFileId);
  if (!session) session = { fileId: currentFileId, fileName: currentFile?.name, fileSize: currentFile?.size, createdAt: Date.now(), analyses: {} };
  session.fileName = currentFile?.name;
  session.fileSize = currentFile?.size;
  session.updatedAt = Date.now();
  if (!currentAnalysis.createdAt) currentAnalysis.createdAt = Date.now();
  session.analyses[currentAnalysis.minSilenceMs] = currentAnalysis;
  await sessionPut(session);
  refreshSessionList();
}

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

// ─── Audio buffer helpers (decode, and concatenate two ranges of the same file) ─
async function decodeAudioBuffer(arrayBuffer) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const buf = await ctx.decodeAudioData(arrayBuffer);
  ctx.close();
  return buf;
}
/** Appends bufB's samples after bufA's, channel by channel — used to extend a session's range without re-decoding the already-decoded prefix. */
function concatAudioBuffers(bufA, bufB, ctx) {
  const channels = Math.max(bufA.numberOfChannels, bufB.numberOfChannels);
  const out = ctx.createBuffer(channels, bufA.length + bufB.length, bufA.sampleRate);
  for (let ch = 0; ch < channels; ch++) {
    const data = out.getChannelData(ch);
    data.set(ch < bufA.numberOfChannels ? bufA.getChannelData(ch) : new Float32Array(bufA.length), 0);
    data.set(ch < bufB.numberOfChannels ? bufB.getChannelData(ch) : new Float32Array(bufB.length), bufA.length);
  }
  return out;
}

// ─── Sentence boundary detection — see js/vad.js (detectSentences,
// detectLeadingSilenceMs) and js/audio.js (computeMonoData), both loaded
// before this file in shadow.html.

// ─── Session state ─────────────────────────────────────────────────────────────
// currentAnalysis is one entry of a file's session (see sessionGet/saveSession);
// currentSegments/currentTranscripts always point at currentAnalysis.segments/
// .transcripts directly (same object, not a copy) so mutating them already
// mutates the analysis — persisting just means writing that same object back.
let currentFile = null, currentFileId = null, currentWavHeader = null, currentDuration = null, maxSecGlobal = 0;
let currentBuffer = null, currentAnalysis = null, currentSegments = null, currentTranscripts = {};
let currentSliceStart = 0, currentSliceEnd = 0;   // just for progress/error messaging during decode
let pendingResumeSensitivity = null;               // set by resumeSession() when the target file isn't loaded yet
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
// encodeWavBlob()/extractMonoSlice() are now shared — see js/audio.js (loaded
// before this file in shadow.html).
// formanter.py always runs its HTTP server on :5050 (see its __main__ block),
// regardless of what serves shadow.html itself — so just always talk to that.
// CORS is already enabled there, so this works even when shadow.html is
// served from a different origin.
const TRANSCRIBE_SERVER = 'http://localhost:5050';
function getTranscribeServer() { return TRANSCRIBE_SERVER; }
function getTranscribeBackend() { return document.getElementById('transcribeBackend')?.value || 'local'; }
async function checkTranscribeServer() {
  const el = document.getElementById('transcribeBadge');
  if (!el) return;
  if (getTranscribeBackend() === 'hf') {
    const hasToken = !!localStorage.getItem('shadowHfToken');
    el.textContent = hasToken ? '📝 Online (Hugging Face): ✓ token set' : '📝 Online (Hugging Face): ⚠ no API token set below';
    el.className = hasToken ? 'cache-badge hit' : 'cache-badge';
    return;
  }
  try {
    const r = await fetch(TRANSCRIBE_SERVER + '/ping', { signal: AbortSignal.timeout(1500) });
    if (r.ok) { el.textContent = `📝 Local transcription server: ✓ connected (${TRANSCRIBE_SERVER})`; el.className = 'cache-badge hit'; return; }
    el.textContent = `📝 Local transcription server: got HTTP ${r.status} from ${TRANSCRIBE_SERVER}`;
    el.className = 'cache-badge';
  } catch (e) {
    el.textContent = `📝 Local transcription server: unreachable at ${TRANSCRIBE_SERVER} — run formanter.py`;
    el.className = 'cache-badge';
  }
}
function getTranscribeLanguage() {
  const sel = document.getElementById('transcribeLanguage');
  if (!sel) return '';
  if (sel.value === '__other') return document.getElementById('transcribeLanguageOther')?.value.trim() || '';
  return sel.value;
}
// currentTranscripts IS currentAnalysis.transcripts (same object) — the mutation
// at the call site already happened; this just persists that analysis.
async function cacheTranscript(idx, text) {
  await saveSession();
}

function blobToBase64(blob) {
  return blob.arrayBuffer().then(buf => {
    let binary = '';
    const bytes = new Uint8Array(buf), chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    return btoa(binary);
  });
}

/**
 * Online fallback for when installing faster-whisper locally isn't wanted.
 * Calls the Hugging Face Inference API directly from the browser — the
 * audio never touches formanter.py. Requires a free HF account/token
 * (huggingface.co/settings/tokens). No segment timestamps in this simple
 * binary-upload form, so it only supports per-sentence transcription, not
 * the whole-slice + realign flow.
 *
 * A language hint is passed as generate_kwargs (the same mechanism
 * transformers' own Whisper pipeline uses to force a language locally),
 * which HF's inference backend forwards to the underlying pipeline call.
 * Not independently verified against a live call — if it's silently
 * ignored by whatever provider serves the chosen model, the error/response
 * shown on screen is the real one from HF, so that's diagnosable.
 */
async function transcribeViaHuggingFace(blob, language) {
  const token = (localStorage.getItem('shadowHfToken') || '').trim();
  if (!token) throw new Error('No Hugging Face API token set — add one in the Online settings box above');
  const model = (localStorage.getItem('shadowHfModel') || 'openai/whisper-large-v3').trim();
  // router.huggingface.co replaced the old api-inference.huggingface.co host (that hostname no
  // longer resolves at all). Model id is org/name — don't percent-encode the slash in the path.
  const url = `https://router.huggingface.co/hf-inference/models/${model}`;
  const headers = { 'Authorization': 'Bearer ' + token };
  let body;
  if (language) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify({
      inputs: await blobToBase64(blob),
      parameters: { generate_kwargs: { language, task: 'transcribe' } },
    });
  } else {
    headers['Content-Type'] = 'audio/wav';
    body = blob;
  }
  const resp = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(60000) });
  const data = await resp.json().catch(() => null);
  if (!resp.ok) {
    if (data?.error && /loading/i.test(data.error)) {
      throw new Error(`Model is loading on Hugging Face's servers (~${Math.ceil(data.estimated_time || 20)}s) — try again shortly`);
    }
    throw new Error(data?.error || ('HTTP ' + resp.status));
  }
  return data?.text || '';
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
    const lang = getTranscribeLanguage();
    let text;
    if (getTranscribeBackend() === 'hf') {
      text = await transcribeViaHuggingFace(blob, lang);
    } else {
      const form = new FormData();
      form.append('file', blob, 'slice.wav');
      if (lang) form.append('language', lang);
      const resp = await fetch(getTranscribeServer() + '/transcribe', { method: 'POST', body: form, signal: AbortSignal.timeout(60000) });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || ('HTTP ' + resp.status));
      }
      const data = await resp.json();
      text = data.text;
    }
    text = text || '(no speech detected)';
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

/**
 * Transcribes the ENTIRE loaded slice in a single Whisper call — far more
 * context than an isolated per-sentence fragment, usually much more accurate
 * — then splits the returned segments back onto our own sentence rows by
 * matching each Whisper segment's midpoint timestamp to the nearest sentence.
 */
function assignWhisperSegmentsToSentences(whisperSegments) {
  const buckets = currentSegments.map(() => []);
  for (const ws of whisperSegments) {
    const mid = (ws.start_ms + ws.end_ms) / 2;
    let bestIdx = -1, bestDist = Infinity;
    currentSegments.forEach((seg, idx) => {
      const dist = (mid >= seg.start && mid <= seg.end) ? 0 : (mid < seg.start ? seg.start - mid : mid - seg.end);
      if (dist < bestDist) { bestDist = dist; bestIdx = idx; }
    });
    if (bestIdx >= 0) buckets[bestIdx].push(ws.text.trim());
  }
  buckets.forEach((texts, idx) => {
    if (!texts.length) return;
    const text = texts.join(' ').trim();
    currentTranscripts[idx] = text;
    cacheTranscript(idx, text);
    const row = rowRefs[idx];
    if (row) {
      const out = row.querySelector('.sent-transcript');
      out.textContent = text;
      out.style.display = 'block';
    }
  });
}
async function transcribeWholeSlice() {
  if (!currentBuffer || !currentSegments?.length) return;
  if (getTranscribeBackend() === 'hf') {
    setStatus('Whole-slice mode needs the local backend (for segment timestamps) — switch to Local, or use per-sentence transcription.');
    return;
  }
  const btn = document.getElementById('transcribeWholeBtn');
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  setStatus('Transcribing the whole slice in one call (more context → usually more accurate)…');
  try {
    const samples = computeMonoData(currentBuffer);
    const blob = encodeWavBlob(samples, currentBuffer.sampleRate);
    const form = new FormData();
    form.append('file', blob, 'slice.wav');
    const lang = getTranscribeLanguage();
    if (lang) form.append('language', lang);
    const resp = await fetch(getTranscribeServer() + '/transcribe', { method: 'POST', body: form, signal: AbortSignal.timeout(300000) });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || ('HTTP ' + resp.status));
    }
    const data = await resp.json();
    assignWhisperSegmentsToSentences(data.segments || []);
    setStatus(`Whole-slice transcription done — matched onto ${currentSegments.length} sentences.`);
  } catch (e) {
    setStatus('Whole-slice transcription failed: ' + e.message);
  }
  if (btn) { btn.disabled = false; btn.textContent = '📝 Transcribe whole slice'; }
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

/** One row per (file, silence-sensitivity) analysis — a file can have several. */
async function refreshSessionList() {
  const el = document.getElementById('sessionList');
  if (!el) return;
  const sessions = await sessionGetAll();
  if (!sessions.length) { el.innerHTML = '<div class="cache-empty">No sessions yet</div>'; return; }
  const rows = [];
  sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).forEach(session => {
    Object.values(session.analyses || {}).sort((a, b) => a.minSilenceMs - b.minSilenceMs).forEach(an => {
      const nTranscribed = Object.keys(an.transcripts || {}).length;
      rows.push(`
        <div class="cache-item">
          <span class="cache-name">${escapeHtml(session.fileName || '(unnamed)')}</span>
          <span class="cache-n">${an.minSilenceMs}ms · ${secToClock(an.rangeStart / 1000)}–${secToClock(an.rangeEnd / 1000)} · ${an.segments.length} sentences · ${nTranscribed} transcribed</span>
          <button class="sent-btn session-resume-btn" data-file="${escapeHtml(session.fileId)}" data-sens="${an.minSilenceMs}" type="button">▶ Resume</button>
          <button class="cache-forget" data-file="${escapeHtml(session.fileId)}" data-sens="${an.minSilenceMs}" title="Forget this analysis">✕</button>
        </div>`);
    });
  });
  el.innerHTML = rows.join('');
  el.querySelectorAll('.session-resume-btn').forEach(btn => {
    btn.addEventListener('click', () => resumeSession(btn.dataset.file, parseInt(btn.dataset.sens, 10)));
  });
  el.querySelectorAll('.cache-forget').forEach(btn => {
    btn.addEventListener('click', async () => {
      const sens = parseInt(btn.dataset.sens, 10);
      await sessionDeleteAnalysis(btn.dataset.file, sens);
      if (btn.dataset.file === currentFileId && sens === currentAnalysis?.minSilenceMs) setCacheBadge(false);
      refreshSessionList();
    });
  });
}

/** Switches to (or stays on) minSilenceMs on the currently-loaded file and loads its cached range. */
async function selectSensitivityAndLoad(minSilenceMs) {
  const slider = document.getElementById('silenceSlider');
  slider.value = minSilenceMs;
  document.getElementById('silenceVal').textContent = minSilenceMs + ' ms';
  await syncSensitivityCacheNote();   // prefills the range picker from this session's stored range
  const startText = document.getElementById('rangeStart'), endText = document.getElementById('rangeEnd');
  await loadOrExtendSlice(clockToSec(startText.value), clockToSec(endText.value));
}

/**
 * Resumes a session row from the Sessions list. If the file was opened via
 * "📂 Open file" (a remembered File System Access handle exists for it),
 * reopens it automatically. Otherwise a file can't be reopened without a user
 * gesture through the file picker (browser security) — prompts the user to
 * pick/drop it, and jumps straight to this analysis once they do.
 */
async function resumeSession(fileId, minSilenceMs) {
  if (currentFileId === fileId) { await selectSensitivityAndLoad(minSilenceMs); return; }

  const handles = await fhGetAll();
  const entry = handles.find(h => h.id === fileId);
  if (entry) {
    try {
      let perm = await entry.handle.queryPermission({ mode: 'read' });
      if (perm !== 'granted') perm = await entry.handle.requestPermission({ mode: 'read' });
      if (perm === 'granted') {
        const file = await entry.handle.getFile();
        entry.lastOpened = Date.now();
        await fhAdd(entry);
        renderRecentFiles();
        pendingResumeSensitivity = minSilenceMs;
        await handleFile(file);
        return;
      }
    } catch (e) { /* fall through to the manual prompt below */ }
  }

  pendingResumeSensitivity = minSilenceMs;
  setStatus(`Choose or drop that file to resume — it'll jump straight to the ${minSilenceMs}ms analysis once it matches.`);
}

/** Shows (and, if found, prefills the range picker to) the current file's cached analysis for the selected sensitivity. */
async function syncSensitivityCacheNote() {
  const note = document.getElementById('sensitivityCacheNote');
  if (!note) return;
  if (!currentFileId) { note.textContent = ''; return; }
  const minSilenceMs = parseInt(document.getElementById('silenceSlider').value, 10);
  const session = await sessionGet(currentFileId);
  const existing = session?.analyses?.[minSilenceMs];
  if (!existing) { note.textContent = ''; return; }
  const nTranscribed = Object.keys(existing.transcripts || {}).length;
  note.textContent = `↺ cached: ${secToClock(existing.rangeStart / 1000)}–${secToClock(existing.rangeEnd / 1000)} · ${existing.segments.length} sentences · ${nTranscribed} transcribed — range below prefilled; move the end to extend`;
  const startSlider = document.getElementById('rangeStartSlider'), endSlider = document.getElementById('rangeEndSlider');
  const startText = document.getElementById('rangeStart'), endText = document.getElementById('rangeEnd');
  if (startSlider && maxSecGlobal) {
    const s = Math.round(existing.rangeStart / 1000), e = Math.min(maxSecGlobal, Math.round(existing.rangeEnd / 1000));
    startSlider.value = s; endSlider.value = e;
    startText.value = secToClock(s); endText.value = secToClock(e);
    updateRangeDurLabel();
  }
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
  currentFile = null; currentFileId = null; currentWavHeader = null; currentDuration = null;
  currentBuffer = null; currentAnalysis = null; currentSegments = null; currentTranscripts = {};
  document.getElementById('fileInfo').style.display = 'none';
  document.getElementById('rangeWrap').style.display = 'none';
  document.getElementById('sentenceListWrap').style.display = 'none';
  document.getElementById('cacheBadge').textContent = '';
  document.getElementById('cacheBadge').className = 'cache-badge';
  const note = document.getElementById('sensitivityCacheNote'); if (note) note.textContent = '';
  showProgress(false);
  setStatus('');
}

/** Fresh, from-scratch segmentation of the whole currentBuffer — becomes a new analysis entry. */
async function runSegmentation() {
  if (!currentBuffer) return;
  showProgress(true, 'Analysing audio for sentence boundaries…', true);
  await new Promise(r => requestAnimationFrame(r));   // let the UI paint before the sync scan
  const params = readParams();
  const mono = computeMonoData(currentBuffer);
  const { segments, threshold } = detectSentences(mono, currentBuffer.sampleRate, params);
  currentAnalysis = {
    minSilenceMs: params.minSilenceMs,
    rangeStart: Math.round(currentSliceStart * 1000),
    rangeEnd: Math.round(currentSliceEnd * 1000),
    threshold, segments, transcripts: {},
    createdAt: Date.now(), updatedAt: Date.now(),
  };
  currentSegments = currentAnalysis.segments;
  currentTranscripts = currentAnalysis.transcripts;
  showProgress(false);
  setCacheBadge(false);
  await saveSession();
  renderSentenceList();
  setStatus(`Found ${segments.length} sentence${segments.length !== 1 ? 's' : ''}`);
}

/** Decodes [startSec,endSec] into a standalone buffer, without touching currentBuffer. */
async function decodeRangeToBuffer(startSec, endSec) {
  if (currentWavHeader) {
    showProgress(true, 'Reading WAV slice from disk…');
    setProgressPct(30);
    const buf = await sliceWavFile(currentFile, currentWavHeader, startSec, endSec);
    setProgressPct(70);
    setProgressLabel('Decoding…');
    const result = await decodeAudioBuffer(buf);
    setProgressPct(100);
    showProgress(false);
    return result;
  }
  showProgress(true, 'Decoding selected range in real time…');
  const result = await decodeSliceViaCapture(currentFile, startSec, endSec, p => setProgressPct(p * 100));
  showProgress(false);
  return result;
}
async function decodeFullRange(startSec, endSec) {
  currentSliceStart = startSec; currentSliceEnd = endSec;
  currentBuffer = await decodeRangeToBuffer(startSec, endSec);
}
/**
 * `analysis` typically comes from a fresh sessionGet() read (a new deserialized
 * object each time), so it's never the SAME object as an already-loaded
 * currentAnalysis even when the content is identical — compare by value.
 */
function analysisMatchesLoaded(analysis) {
  return !!(currentAnalysis && currentBuffer
    && currentAnalysis.minSilenceMs === analysis.minSilenceMs
    && currentAnalysis.rangeStart === analysis.rangeStart
    && currentAnalysis.rangeEnd === analysis.rangeEnd);
}
/** No-op when `analysis`'s range is already the one loaded; otherwise decodes its stored range fresh. */
async function ensureBufferForAnalysis(analysis) {
  if (analysisMatchesLoaded(analysis)) return;   // exactly what's already in memory — nothing to do
  await decodeFullRange(analysis.rangeStart / 1000, analysis.rangeEnd / 1000);
  currentAnalysis = analysis;
  currentSegments = analysis.segments;
  currentTranscripts = analysis.transcripts;
}

/**
 * Extends the currently-loaded analysis forward to newEndSec: decodes ONLY the
 * newly-added byte range (the old range's audio is reused straight out of
 * currentBuffer, never re-decoded), reuses the analysis's original threshold
 * (see detectSentences), and appends the new segments.
 *
 * Boundary correctness: if the old range's LAST segment ends right at the old
 * range's edge, it may have been cut off mid-sentence rather than by genuine
 * silence. In that case, re-analyse (old last segment's start) → newEnd as one
 * unit (reusing in-memory tail samples, not re-decoding them) and replace the
 * old last segment with the result — its transcript (if any) is invalidated
 * since the sentence's audio changed. Every other old segment/transcript,
 * keyed by array position, is untouched.
 */
async function extendAnalysisTo(newEndSec) {
  const a = currentAnalysis;
  const oldEndSec = a.rangeEnd / 1000;
  const params = { minSilenceMs: a.minSilenceMs, threshold: a.threshold };

  const newChunkBuffer = await decodeRangeToBuffer(oldEndSec, newEndSec);

  const oldMono = computeMonoData(currentBuffer);
  const newMono = computeMonoData(newChunkBuffer);
  const oldDurationMs = currentBuffer.duration * 1000;

  let segments = a.segments.slice();
  const last = segments[segments.length - 1];
  const wasTruncated = last && last.end >= oldDurationMs - 40;   // small tolerance

  if (wasTruncated) {
    const lookbackStartMs = last.start;
    const lookbackStartSample = Math.floor(lookbackStartMs / 1000 * currentBuffer.sampleRate);
    const tail = oldMono.slice(lookbackStartSample);
    const mergedSamples = new Float32Array(tail.length + newMono.length);
    mergedSamples.set(tail, 0); mergedSamples.set(newMono, tail.length);
    const { segments: mergedSegs } = detectSentences(mergedSamples, currentBuffer.sampleRate, params);
    segments.pop();
    delete a.transcripts[last.index];
    mergedSegs.forEach(s => segments.push({ start: s.start + lookbackStartMs, end: s.end + lookbackStartMs }));
  } else {
    const { segments: freshSegs } = detectSentences(newMono, currentBuffer.sampleRate, params);
    freshSegs.forEach(s => segments.push({ start: s.start + oldDurationMs, end: s.end + oldDurationMs }));
  }
  segments = segments.map((s, idx) => ({ index: idx, start: s.start, end: s.end }));

  currentBuffer = concatAudioBuffers(currentBuffer, newChunkBuffer, getPlayCtx());
  a.rangeEnd = Math.round(newEndSec * 1000);
  a.segments = segments;
  a.updatedAt = Date.now();
  currentSegments = a.segments;
  currentTranscripts = a.transcripts;
  await saveSession();
}

async function loadOrExtendSlice(startSec, endSec) {
  if (!currentFile) return;
  if (!currentWavHeader) endSec = Math.min(endSec, startSec + MAX_NONWAV_SLICE_SEC);
  resetPlaybackAndRecordings();
  document.getElementById('sentenceListWrap').style.display = 'none';

  const params = readParams();
  const startMs = Math.round(startSec * 1000), endMs = Math.round(endSec * 1000);
  const session = await sessionGet(currentFileId);
  const existing = session?.analyses?.[params.minSilenceMs];
  const sameStart = existing && Math.abs(existing.rangeStart - startMs) < 500;

  const loadBtn = document.getElementById('loadSliceBtn');
  loadBtn.disabled = true;
  try {
    if (existing && sameStart && endMs <= existing.rangeEnd + 100) {
      await ensureBufferForAnalysis(existing);
      setCacheBadge(true, existing.createdAt);
      setStatus(`Restored from session — ${existing.segments.length} sentences, no re-analysis needed`);
    } else if (existing && sameStart) {
      await ensureBufferForAnalysis(existing);
      const before = existing.segments.length;
      await extendAnalysisTo(endSec);
      setCacheBadge(false);
      setStatus(`Extended session — ${currentSegments.length} sentences now (added ${currentSegments.length - before})`);
    } else {
      currentBuffer = null; currentAnalysis = null; currentSegments = null; currentTranscripts = {};
      await decodeFullRange(startSec, endSec);
      await runSegmentation();
    }
  } catch (e) {
    showProgress(false);
    let hint = '';
    if (currentWavHeader) {
      // Upper-bound estimate (the actual sub-range decoded — restore, extend-tail, or fresh —
      // is never larger than the whole requested range), fine for an advisory hint.
      const bytes = estimateDecodedBytes(currentWavHeader.fmt, endSec - startSec);
      if (bytes > WAV_DECODE_WARN_BYTES) {
        hint = ` This range decodes to ~${fmtBytes(bytes)} of raw audio — likely too large for your browser to hold in memory at once. Try a shorter range.`;
      }
    }
    setStatus('Could not decode selected range: ' + e.message + hint);
    loadBtn.disabled = false;
    return;
  }
  loadBtn.disabled = false;
  renderSentenceList();
  refreshSessionList();
}

async function handleFile(file) {
  resetSession();
  currentFile = file;
  currentFileId = fileIdentityId(file);
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
  await syncSensitivityCacheNote();

  if (pendingResumeSensitivity != null) {
    const targetSens = pendingResumeSensitivity;
    pendingResumeSensitivity = null;
    await selectSensitivityAndLoad(targetSens);
  } else {
    setStatus('Pick a time range below, then load it.');
  }
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
    loadOrExtendSlice(clockToSec(startText.value), clockToSec(endText.value));
  });

  // ── Segmentation params ──
  const slider = document.getElementById('silenceSlider');
  slider.addEventListener('input', () => {
    document.getElementById('silenceVal').textContent = slider.value + ' ms';
  });
  slider.addEventListener('change', () => syncSensitivityCacheNote());
  document.getElementById('reanalyzeBtn').addEventListener('click', () => runSegmentation());
  document.getElementById('clearCacheBtn').addEventListener('click', async () => {
    if (!currentFileId || !currentAnalysis) return;
    await sessionDeleteAnalysis(currentFileId, currentAnalysis.minSilenceMs);
    setCacheBadge(false);
    refreshSessionList();
  });

  document.getElementById('transcribeAllBtn')?.addEventListener('click', () => transcribeAll());
  document.getElementById('transcribeWholeBtn')?.addEventListener('click', () => transcribeWholeSlice());

  const langSelect = document.getElementById('transcribeLanguage');
  const langOther = document.getElementById('transcribeLanguageOther');
  if (langSelect) {
    const saved = localStorage.getItem('shadowTranscribeLanguage') || '';
    if (saved && [...langSelect.options].some(o => o.value === saved)) langSelect.value = saved;
    else if (saved) { langSelect.value = '__other'; langOther.value = saved; langOther.style.display = 'inline-block'; }
    langSelect.addEventListener('change', () => {
      const isOther = langSelect.value === '__other';
      langOther.style.display = isOther ? 'inline-block' : 'none';
      if (!isOther) localStorage.setItem('shadowTranscribeLanguage', langSelect.value);
    });
    langOther?.addEventListener('change', () => localStorage.setItem('shadowTranscribeLanguage', langOther.value.trim()));
  }

  const backendSelect = document.getElementById('transcribeBackend');
  const hfSettings = document.getElementById('hfSettings');
  const hfTokenInput = document.getElementById('hfTokenInput');
  const hfModelInput = document.getElementById('hfModelInput');
  const wholeSliceBtn = document.getElementById('transcribeWholeBtn');
  const wholeSliceHint = document.getElementById('wholeSliceHint');
  function applyBackendUI() {
    const isHf = backendSelect.value === 'hf';
    hfSettings.style.display = isHf ? 'flex' : 'none';
    if (wholeSliceBtn) wholeSliceBtn.disabled = isHf;
    if (wholeSliceHint) wholeSliceHint.style.display = isHf ? 'inline' : 'none';
    checkTranscribeServer();
  }
  if (backendSelect) {
    backendSelect.value = localStorage.getItem('shadowTranscribeBackend') || 'local';
    hfTokenInput.value = localStorage.getItem('shadowHfToken') || '';
    hfModelInput.value = localStorage.getItem('shadowHfModel') || 'openai/whisper-large-v3';
    applyBackendUI();
    backendSelect.addEventListener('change', () => {
      localStorage.setItem('shadowTranscribeBackend', backendSelect.value);
      applyBackendUI();
    });
    hfTokenInput.addEventListener('change', () => {
      localStorage.setItem('shadowHfToken', hfTokenInput.value.trim());
      checkTranscribeServer();
    });
    hfModelInput.addEventListener('change', () => localStorage.setItem('shadowHfModel', hfModelInput.value.trim()));
  }

  refreshSessionList();
  renderRecentFiles();
  checkTranscribeServer();
});
