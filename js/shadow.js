/**
 * shadow.js — Shadowing practice page (shadow.html).
 *
 * Audio is NEVER uploaded or stored server-side (an earlier version of this
 * page did exactly that and was reverted — a multi-hour file meant a
 * multi-GB server-side decode on upload, again on split, and again on every
 * single chapter-audio request, since nothing was cached between requests).
 * Decoding happens locally, same approach this page used before that
 * rework: WAV is parsed straight from its RIFF header and Blob.slice()
 * reads just the needed byte range off disk (cheap regardless of file
 * length — 3h+ files are fine); everything else has no cheap byte-exact
 * seek client-side, so it's captured in real time (an <audio> element seeks
 * to the start, plays muted through a ScriptProcessorNode tap, raw samples
 * are collected until the end of the range — bounded to
 * MAX_NONWAV_SLICE_SEC to stay responsive).
 *
 * "Is this the same file I uploaded before?" is answered by a cheap
 * client-computed fingerprint (file size + a few small sampled byte ranges
 * — see computeFingerprint — never the whole file), sent to
 * POST /api/v1/shadowing/media/find-or-create. That's the ONLY thing that
 * travels to the server about the audio; the actual segmentation (sentence
 * AND chapter tier — see js/vad.js) runs entirely client-side against the
 * locally-decoded buffer, and only the resulting {kind,startMs,endMs}
 * boundaries are persisted. Segment boundaries are stored in ABSOLUTE file
 * time (ms from the very start of the original file) regardless of which
 * byte range happens to be decoded locally at any given moment — see
 * segOffsetInBuffer, which converts an absolute segment into an offset
 * into whatever's currently in currentBuffer (and reports "not loaded" if
 * the currently-decoded range doesn't cover it).
 *
 * Per sentence: play the reference slice (from the decoded AudioBuffer via
 * an AudioBufferSourceNode start/offset/duration), record yourself with
 * MediaRecorder, play your take back, or compare (reference then yours).
 * Recordings themselves are NOT persisted server-side — only done/text are
 * durable progress; a recording is lost on reload, same as always.
 *
 * Transcription can use a local /transcribe endpoint on formanter.py
 * (faster-whisper) or the Hugging Face Inference API directly from the
 * browser — backend/url/token/model come from the per-user
 * 'transcribeBackend' Setting (configured on settings.html).
 */

const MAX_NONWAV_SLICE_SEC = 1800;      // 30 min cap on real-time capture for non-WAV formats
const WAV_DECODE_WARN_BYTES = 1.2e9;    // ~1.2 GB decoded (Float32) — advisory threshold, browsers commonly
                                         // fail to hold much more than ~2GB in one ArrayBuffer/AudioBuffer

// ─── IndexedDB: only 'fileHandles' is used now (File System Access API
// handles, so a file doesn't need re-picking every visit) — the old
// 'sessions'/'segments' stores from before server-side persistence existed
// are left in place (never deleted on upgrade, so an old browser profile's
// data is never touched by something that doesn't understand it) but
// nothing here reads/writes them anymore; segments/progress live server-side.
function shOpen() {
  return new Promise((res, rej) => {
    const rq = indexedDB.open('ipa-shadow', 3);
    rq.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'fileId' });
      if (!db.objectStoreNames.contains('fileHandles')) db.createObjectStore('fileHandles', { keyPath: 'id' });
    };
    rq.onsuccess = e => res(e.target.result);
    rq.onerror = rej;
  });
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

// ─── Content fingerprint — file size + a few small sampled byte ranges (never
// the whole file), so the server can recognize a re-uploaded file without
// ever seeing its bytes. ─────────────────────────────────────────────────────
async function computeFingerprint(file) {
  const sampleSize = 65536;
  const ranges = [[0, Math.min(sampleSize, file.size)]];
  if (file.size > sampleSize * 3) {
    const mid = Math.floor(file.size / 2);
    ranges.push([mid, Math.min(file.size, mid + sampleSize)]);
  }
  if (file.size > sampleSize) {
    ranges.push([Math.max(0, file.size - sampleSize), file.size]);
  }
  const parts = [new TextEncoder().encode(String(file.size))];
  for (const [start, end] of ranges) {
    if (end <= start) continue;
    parts.push(new Uint8Array(await file.slice(start, end).arrayBuffer()));
  }
  const total = parts.reduce((s, p) => s + p.length, 0);
  const combined = new Uint8Array(total);
  let off = 0; for (const p of parts) { combined.set(p, off); off += p.length; }
  const digest = await crypto.subtle.digest('SHA-256', combined);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
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

async function decodeAudioBuffer(arrayBuffer) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const buf = await ctx.decodeAudioData(arrayBuffer);
  ctx.close();
  return buf;
}

// ─── Session state ─────────────────────────────────────────────────────────────
let currentFile = null, currentFileId = null, currentWavHeader = null, currentDuration = null, maxSecGlobal = 0;
let currentBuffer = null;
let currentSliceStart = 0, currentSliceEnd = 0;   // ABSOLUTE file-seconds the loaded currentBuffer covers
let currentFingerprint = null;
let currentMediaId = null, currentMedia = null;   // server identity + metadata + persisted segments
let chapters = [], orphanSentences = [];          // rebuilt from currentMedia.segments by rebuildChapterTree()
const openChapterIds = new Set();                 // survives renderChapterList() rebuilds (e.g. after split/merge)
let suggestedChapterMs = 4000;
let splitArmedSegId = null;
let playCtx = null, activeSource = null;
let micStream = null, activeRecorder = null, activeRecordingSegId = null;
const recordings = {};   // segmentId -> {blob, url, buffer, trimStartMs} — ephemeral, never sent to the server
const rowRefs = {};      // segmentId -> row element

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
  src.start(0, startMs / 1000, Math.max(0.01, (endMs - startMs) / 1000));
  activeSource = src;
  src.onended = () => { if (activeSource === src) activeSource = null; onEnded?.(); };
  return src;
}

/** A segment's ms fields are ABSOLUTE file time; converts to an offset into
 * whatever's currently decoded in currentBuffer, or null if the currently
 * loaded range doesn't cover it (caller should ask the user to load a wider range). */
function segOffsetInBuffer(seg) {
  if (!currentBuffer) return null;
  const startMs = seg.startMs - currentSliceStart * 1000;
  const endMs = seg.endMs - currentSliceStart * 1000;
  if (startMs < -50 || endMs > currentBuffer.duration * 1000 + 50) return null;
  return { startMs: Math.max(0, startMs), endMs: Math.min(currentBuffer.duration * 1000, endMs) };
}

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
function playMine(segId) { playRecording(recordings[segId]); }
function playRefSeg(seg, rate = 1) {
  const off = segOffsetInBuffer(seg);
  if (!off) { setStatus('Load a wider range (covering this sentence) to play it.'); return; }
  playAudioBufferSlice(currentBuffer, off.startMs, off.endMs, rate);
}
function compareSeg(seg) {
  const rec = recordings[seg.id];
  if (!rec) { playRefSeg(seg); return; }
  const off = segOffsetInBuffer(seg);
  if (!off) { setStatus('Load a wider range (covering this sentence) to compare.'); return; }
  playAudioBufferSlice(currentBuffer, off.startMs, off.endMs, 1, () => {
    setTimeout(() => playRecording(rec), 300);
  });
}

// ─── Recording ───────────────────────────────────────────────────────────────
async function getMicStream() {
  if (micStream) return micStream;
  micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  return micStream;
}
async function toggleRecord(segId, row) {
  if (activeRecordingSegId === segId) { activeRecorder.stop(); return; }
  if (activeRecorder) activeRecorder.stop();
  try {
    const stream = await getMicStream();
    const chunks = [];
    const mime = pickRecorderMime();
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = async () => {
      const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
      if (recordings[segId]?.url) URL.revokeObjectURL(recordings[segId].url);
      recordings[segId] = { blob, url: URL.createObjectURL(blob), buffer: null, trimStartMs: 0 };
      activeRecorder = null; activeRecordingSegId = null;
      setRowRecordingState(row, false);
      row.querySelector('.play-mine').disabled = false;
      row.querySelector('.compare-btn').disabled = false;
      row.querySelector('.sent-status').textContent = 'Recorded ✓';
      try {
        const arrayBuf = await blob.arrayBuffer();
        const decodeCtx = new (window.AudioContext || window.webkitAudioContext)();
        const buf = await decodeCtx.decodeAudioData(arrayBuf);
        decodeCtx.close();
        if (recordings[segId]?.blob === blob) {
          recordings[segId].buffer = buf;
          recordings[segId].trimStartMs = detectLeadingSilenceMs(buf);
        }
      } catch (e) { /* trimming unavailable for this recording; url playback still works */ }
    };
    rec.start();
    activeRecorder = rec; activeRecordingSegId = segId;
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

// ─── Transcription (per-user Setting, see js/user.js + settings.html) ──────
let _transcribeSettingsCache = null;
async function getTranscribeSettings() {
  if (_transcribeSettingsCache) return _transcribeSettingsCache;
  const userId = await UserLib.getCurrentUserId();
  const res = await fetch(`/api/v1/settings?userId=${userId}`);
  const all = res.ok ? await res.json() : {};
  _transcribeSettingsCache = Object.assign(
    { backend: 'local', url: 'http://localhost:5050', hfToken: '', hfModel: 'openai/whisper-large-v3' },
    all.transcribeBackend || {},
  );
  return _transcribeSettingsCache;
}
window.addEventListener('phonexa:user-changed', () => { _transcribeSettingsCache = null; });

async function checkTranscribeServer() {
  const el = document.getElementById('transcribeBadge');
  if (!el) return;
  const cfg = await getTranscribeSettings();
  if (cfg.backend === 'hf') {
    const hasToken = !!cfg.hfToken;
    el.textContent = hasToken ? '📝 Online (Hugging Face): ✓ token set' : '📝 Online (Hugging Face): ⚠ set a token in Settings';
    el.className = hasToken ? 'cache-badge hit' : 'cache-badge';
    return;
  }
  try {
    const r = await fetch(cfg.url + '/ping', { signal: AbortSignal.timeout(1500) });
    if (r.ok) { el.textContent = `📝 Local transcription server: ✓ connected (${cfg.url})`; el.className = 'cache-badge hit'; return; }
    el.textContent = `📝 Local transcription server: got HTTP ${r.status} from ${cfg.url}`;
    el.className = 'cache-badge';
  } catch (e) {
    el.textContent = `📝 Local transcription server: unreachable at ${cfg.url} — configure it in Settings`;
    el.className = 'cache-badge';
  }
}
function getTranscribeLanguage() {
  const sel = document.getElementById('transcribeLanguage');
  if (!sel) return '';
  if (sel.value === '__other') return document.getElementById('transcribeLanguageOther')?.value.trim() || '';
  return sel.value;
}

function blobToBase64(blob) {
  return blob.arrayBuffer().then(buf => {
    let binary = '';
    const bytes = new Uint8Array(buf), chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    return btoa(binary);
  });
}

/** Online fallback for when installing faster-whisper locally isn't wanted — see settings.html for token/model config. */
async function transcribeViaHuggingFace(blob, language, cfg) {
  const token = (cfg.hfToken || '').trim();
  if (!token) throw new Error('No Hugging Face API token set — configure one in Settings');
  const model = (cfg.hfModel || 'openai/whisper-large-v3').trim();
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

async function transcribeSentence(seg, row) {
  const off = segOffsetInBuffer(seg);
  if (!off) { setStatus('Load a wider range (covering this sentence) to transcribe it.'); return; }
  const btn = row.querySelector('.transcribe-btn');
  const out = row.querySelector('.sent-transcript');
  btn.disabled = true; btn.textContent = '…';
  out.textContent = 'Transcribing…'; out.style.display = 'block';
  try {
    const { samples, sampleRate } = extractMonoSlice(currentBuffer, off.startMs, off.endMs);
    const blob = encodeWavBlob(samples, sampleRate);
    const cfg = await getTranscribeSettings();
    const lang = getTranscribeLanguage();
    let text;
    if (cfg.backend === 'hf') {
      text = await transcribeViaHuggingFace(blob, lang, cfg);
    } else {
      const form = new FormData();
      form.append('file', blob, 'slice.wav');
      if (lang) form.append('language', lang);
      const resp = await fetch(cfg.url + '/transcribe', { method: 'POST', body: form, signal: AbortSignal.timeout(60000) });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || ('HTTP ' + resp.status));
      }
      const data = await resp.json();
      text = data.text;
    }
    text = text || '(no speech detected)';
    out.textContent = text;
    seg.text = text;
    await fetch(`/api/v1/shadowing/segments/${seg.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
    });
  } catch (e) {
    out.textContent = 'Error: ' + e.message;
  }
  btn.disabled = false; btn.textContent = '📝';
}

// ─── Open a segment in Formant Lab's ingestion mode, pre-loaded with just
// that chunk's audio extracted from the locally-decoded buffer — exactly as
// if it had been drag-and-dropped there. Nothing is uploaded; a plain
// ArrayBuffer is handed to the new tab via postMessage. ─────────────────────
async function openSegmentInFormantLab(seg, row) {
  const status = row.querySelector('.sent-status');
  const prevStatus = status.textContent;
  const off = segOffsetInBuffer(seg);
  if (!off) { status.textContent = 'Load a wider range (covering this sentence) first.'; return; }
  try {
    const { samples, sampleRate } = extractMonoSlice(currentBuffer, off.startMs, off.endMs);
    const blob = encodeWavBlob(samples, sampleRate);
    const buffer = await blob.arrayBuffer();
    const win = window.open('praat.html?ingestFromOpener=1', '_blank');
    if (!win) { status.textContent = 'Popup blocked — allow popups for this site and try again'; return; }
    status.textContent = 'Opening in Formant Lab…';
    const onMessage = e => {
      if (e.origin !== location.origin || e.source !== win) return;
      if (e.data?.type !== 'praat-ready-for-blob') return;
      window.removeEventListener('message', onMessage);
      win.postMessage({ type: 'load-audio-blob', buffer }, location.origin, [buffer]);
      status.textContent = prevStatus;
    };
    window.addEventListener('message', onMessage);
  } catch (e) {
    status.textContent = 'Could not open: ' + e.message;
  }
}

// ─── Waveform (static, per-row) ────────────────────────────────────────────────
function drawStaticWave(canvas, buffer, startMs, endMs) {
  if (!canvas || !buffer) return;
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

// ─── Progress bar (real percentages: file read/decode; indeterminate for segmentation) ─
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

// ─── Uploads list (metadata only — no audio to reopen without re-picking the file) ──
async function refreshMediaList() {
  const el = document.getElementById('mediaList');
  if (!el) return;
  const userId = await UserLib.getCurrentUserId();
  const media = await fetch(`/api/v1/shadowing/media?userId=${userId}`).then(r => r.ok ? r.json() : []).catch(() => []);
  if (!media.length) { el.innerHTML = '<div class="cache-empty">No uploads yet</div>'; return; }
  el.innerHTML = media.map(m => `
    <div class="cache-item">
      <span class="cache-name">${escapeHtml(m.originalFilename || '(unnamed)')}</span>
      <span class="cache-n">${secToClock((m.durationMs || 0) / 1000)}${m.sentenceCount ? ` · ${m.doneCount}/${m.sentenceCount} done` : ' · not split yet'}</span>
      <button class="cache-forget" data-id="${m.id}" title="Delete this upload's progress">✕</button>
    </div>`).join('');
  el.querySelectorAll('.cache-forget').forEach(btn => btn.addEventListener('click', async () => {
    if (!confirm('Delete this upload\'s segments/progress? This cannot be undone.')) return;
    await fetch(`/api/v1/shadowing/media/${btn.dataset.id}`, { method: 'DELETE' });
    if (currentMediaId === parseInt(btn.dataset.id, 10)) resetSession();
    refreshMediaList();
  }));
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

// ─── Segment tree + rendering ───────────────────────────────────────────────
function rebuildChapterTree() {
  const segs = currentMedia?.segments || [];
  chapters = segs.filter(s => s.kind === 'chapter').sort((a, b) => a.orderIndex - b.orderIndex).map(c => ({ ...c, sentences: [] }));
  const chapterById = new Map(chapters.map(c => [c.id, c]));
  orphanSentences = [];
  segs.filter(s => s.kind === 'sentence').sort((a, b) => a.orderIndex - b.orderIndex).forEach(s => {
    const parent = s.parentId != null ? chapterById.get(s.parentId) : null;
    if (parent) parent.sentences.push(s); else orphanSentences.push(s);
  });
}
function findSegmentById(id) { return currentMedia.segments.find(s => s.id === id); }
function chapterProgressText(ch) {
  const total = ch.sentences.length, done = ch.sentences.filter(s => s.done).length;
  return `${done}/${total} done`;
}

function renderChapterList() {
  const container = document.getElementById('chapterList');
  container.innerHTML = '';
  for (const k in rowRefs) delete rowRefs[k];
  const totalSentences = chapters.reduce((s, c) => s + c.sentences.length, 0) + orphanSentences.length;
  document.getElementById('sentCount').textContent = totalSentences;
  document.getElementById('chapterCount').textContent = chapters.length;
  document.getElementById('sentenceListWrap').style.display = totalSentences ? 'block' : 'none';

  chapters.forEach((ch, chIdx) => container.appendChild(renderChapterRow(ch, chIdx)));

  if (orphanSentences.length) {
    const wrap = document.createElement('div');
    wrap.className = 'chapter-row open';
    wrap.innerHTML = `<div class="chapter-header"><span class="chapter-toggle">▸</span><span>Ungrouped sentences</span></div><div class="chapter-sentences"></div>`;
    const body = wrap.querySelector('.chapter-sentences');
    orphanSentences.forEach((seg, i) => body.appendChild(renderSentenceRow(seg, orphanSentences, i)));
    container.appendChild(wrap);
  }
}

function renderChapterRow(ch, chIdx) {
  const wrap = document.createElement('div');
  wrap.className = 'chapter-row' + (openChapterIds.has(ch.id) ? ' open' : '');
  wrap.innerHTML = `
    <div class="chapter-header">
      <span class="chapter-toggle">▸</span>
      <span>Chapter ${chIdx + 1} — ${msToClock(ch.startMs)} – ${msToClock(ch.endMs)}</span>
      <span class="chapter-progress">${chapterProgressText(ch)}</span>
      <button class="sent-btn merge-btn" data-dir="prev" title="Merge with previous chapter" ${chIdx === 0 ? 'disabled' : ''}>⇤ merge</button>
      <button class="sent-btn merge-btn" data-dir="next" title="Merge with next chapter" ${chIdx === chapters.length - 1 ? 'disabled' : ''}>merge ⇥</button>
    </div>
    <div class="chapter-sentences"></div>`;
  wrap.querySelector('.chapter-header').addEventListener('click', e => {
    if (e.target.closest('button')) return;
    wrap.classList.toggle('open');
    if (wrap.classList.contains('open')) openChapterIds.add(ch.id); else openChapterIds.delete(ch.id);
  });
  wrap.querySelectorAll('.merge-btn').forEach(btn => btn.addEventListener('click', async e => {
    e.stopPropagation();
    const other = chapters[btn.dataset.dir === 'prev' ? chIdx - 1 : chIdx + 1];
    if (!other) return;
    const [a, b] = btn.dataset.dir === 'prev' ? [other.id, ch.id] : [ch.id, other.id];
    await mergeSegments(a, b);
  }));
  const body = wrap.querySelector('.chapter-sentences');
  ch.sentences.forEach((seg, i) => body.appendChild(renderSentenceRow(seg, ch.sentences, i)));
  return wrap;
}

function renderSentenceRow(seg, siblings, i) {
  const row = document.createElement('div');
  row.className = 'sent-row' + (seg.done ? ' done' : '');
  row.innerHTML = `
    <div class="sent-idx">${i + 1}</div>
    <div class="sent-main">
      <canvas class="sent-wave"></canvas>
      <div class="sent-meta">
        <span class="sent-dur">${((seg.endMs - seg.startMs) / 1000).toFixed(2)}s</span>
        <span class="sent-time">${msToClock(seg.startMs)} – ${msToClock(seg.endMs)}</span>
      </div>
      <div class="sent-transcript" style="display:${seg.text ? 'block' : 'none'}">${escapeHtml(seg.text || '')}</div>
    </div>
    <div class="sent-controls">
      <label class="done-label"><input type="checkbox" class="done-checkbox" ${seg.done ? 'checked' : ''}> done</label>
      <button class="sent-btn play-ref" title="Play reference">▶</button>
      <button class="sent-btn play-ref-slow" title="Play at half speed">🐌</button>
      <button class="sent-btn rec-btn" title="Record your voice">● Rec</button>
      <span class="rec-dot"></span>
      <button class="sent-btn play-mine" disabled title="Play your recording">▶ You</button>
      <button class="sent-btn compare-btn" disabled title="Play reference then yours">⇄ Compare</button>
      <button class="sent-btn transcribe-btn" title="Transcribe this sentence">📝</button>
      <button class="sent-btn open-formant-lab-btn" title="Open in Formant Lab">🔬</button>
      <button class="sent-btn split-btn" title="Click, then click a point on the waveform to split here">✂</button>
      <button class="sent-btn merge-prev-btn" title="Merge with previous sentence" ${i === 0 ? 'disabled' : ''}>⇤ merge</button>
      <span class="sent-status">${seg.done ? 'Done' : 'Not recorded'}</span>
    </div>`;
  rowRefs[seg.id] = row;

  const canvas = row.querySelector('.sent-wave');
  const off = segOffsetInBuffer(seg);
  if (off) requestAnimationFrame(() => drawStaticWave(canvas, currentBuffer, off.startMs, off.endMs));

  row.querySelector('.done-checkbox').addEventListener('change', async e => {
    seg.done = e.target.checked;
    row.classList.toggle('done', seg.done);
    row.querySelector('.sent-status').textContent = seg.done ? 'Done' : (recordings[seg.id] ? 'Recorded ✓' : 'Not recorded');
    const hdr = row.closest('.chapter-row')?.querySelector('.chapter-progress');
    if (hdr) {
      const ch = chapters.find(c => c.sentences.includes(seg));
      if (ch) hdr.textContent = chapterProgressText(ch);
    }
    await fetch(`/api/v1/shadowing/segments/${seg.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ done: seg.done }),
    });
  });

  row.querySelector('.play-ref').addEventListener('click', () => playRefSeg(seg));
  row.querySelector('.play-ref-slow').addEventListener('click', () => playRefSeg(seg, 0.6));
  row.querySelector('.rec-btn').addEventListener('click', () => toggleRecord(seg.id, row));
  row.querySelector('.play-mine').addEventListener('click', () => playMine(seg.id));
  row.querySelector('.compare-btn').addEventListener('click', () => compareSeg(seg));
  row.querySelector('.transcribe-btn').addEventListener('click', () => transcribeSentence(seg, row));
  row.querySelector('.open-formant-lab-btn').addEventListener('click', () => openSegmentInFormantLab(seg, row));
  row.querySelector('.split-btn').addEventListener('click', () => armSplit(seg, canvas));
  row.querySelector('.merge-prev-btn').addEventListener('click', () => {
    const prev = siblings[i - 1];
    if (prev) mergeSegments(prev.id, seg.id);
  });
  return row;
}

// ─── Manual editing: split / merge ──────────────────────────────────────────
function armSplit(seg, canvas) {
  if (splitArmedSegId === seg.id) { splitArmedSegId = null; canvas.style.cursor = ''; return; }
  splitArmedSegId = seg.id;
  canvas.style.cursor = 'crosshair';
  setStatus('Click a point on the waveform to split there (click ✂ again to cancel).');
  const onClick = async e => {
    if (splitArmedSegId !== seg.id) return;
    const rect = canvas.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    canvas.style.cursor = '';
    splitArmedSegId = null;
    const atMs = Math.round(seg.startMs + frac * (seg.endMs - seg.startMs));
    await splitSegment(seg.id, atMs);
  };
  canvas.addEventListener('click', onClick, { once: true });
}
async function splitSegment(segId, atMs) {
  const resp = await fetch(`/api/v1/shadowing/segments/${segId}/split`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ atMs }),
  });
  if (!resp.ok) { const err = await resp.json().catch(() => ({})); setStatus('Split failed: ' + (err.error || '')); return; }
  await reloadCurrentMedia();
}
async function mergeSegments(idA, idB) {
  const resp = await fetch('/api/v1/shadowing/segments/merge', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ segmentIdA: idA, segmentIdB: idB }),
  });
  if (!resp.ok) { const err = await resp.json().catch(() => ({})); setStatus('Merge failed: ' + (err.error || '')); return; }
  await reloadCurrentMedia();
}
async function reloadCurrentMedia() {
  const scrollY = window.scrollY;
  const res = await fetch(`/api/v1/shadowing/media/${currentMediaId}`);
  currentMedia = await res.json();
  rebuildChapterTree();
  renderChapterList();
  requestAnimationFrame(() => window.scrollTo(0, scrollY));
}

// ─── Client-side segmentation (sentence + chapter tier — js/vad.js) ────────
async function runClientSegmentation() {
  if (!currentBuffer) { setStatus('Load a range first.'); return; }
  const sentenceMs = parseInt(document.getElementById('sentenceSlider').value, 10);
  const chapterMs = parseInt(document.getElementById('chapterSlider').value, 10);
  showProgress(true, 'Analysing for sentence & chapter boundaries…', true);
  await new Promise(r => requestAnimationFrame(r));   // let the UI paint before the sync scan

  const mono = computeMonoData(currentBuffer);
  const { segments: sentenceSegs, threshold } = detectSentences(mono, currentBuffer.sampleRate, { minSilenceMs: sentenceMs });
  const { segments: chapterSegs } = detectChapters(mono, currentBuffer.sampleRate, chapterMs, threshold);
  showProgress(false);

  // Boundaries from detectSentences/detectChapters are relative to the start
  // of currentBuffer — add currentSliceStart to get ABSOLUTE file-ms, the
  // only thing the server ever stores (see segOffsetInBuffer's doc comment).
  const baseMs = currentSliceStart * 1000;
  let nextLocalId = 1;
  const segmentsOut = [];
  const chapterRows = chapterSegs.map(ch => ({ localId: nextLocalId++, startMs: baseMs + ch.start, endMs: baseMs + ch.end, orderIndex: ch.index }));
  chapterRows.forEach(c => segmentsOut.push({ localId: c.localId, kind: 'chapter', parentLocalId: null, orderIndex: c.orderIndex, startMs: c.startMs, endMs: c.endMs }));
  sentenceSegs.forEach(se => {
    const startMs = baseMs + se.start, endMs = baseMs + se.end;
    const mid = (startMs + endMs) / 2;
    const parent = chapterRows.find(c => mid >= c.startMs && mid <= c.endMs);
    segmentsOut.push({ localId: nextLocalId++, kind: 'sentence', parentLocalId: parent ? parent.localId : null, orderIndex: se.index, startMs, endMs });
  });

  const resp = await fetch(`/api/v1/shadowing/media/${currentMediaId}/segment`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sentenceSilenceMs: sentenceMs, chapterSilenceMs: chapterMs, segments: segmentsOut }),
  });
  if (!resp.ok) { setStatus('Split failed.'); return; }
  currentMedia = await resp.json();
  rebuildChapterTree();
  document.getElementById('segmentParamsRow').style.display = 'none';
  renderChapterList();
  refreshMediaList();
  setStatus(`Found ${sentenceSegs.length} sentence${sentenceSegs.length !== 1 ? 's' : ''} in ${chapterSegs.length} chapter${chapterSegs.length !== 1 ? 's' : ''}.`);
}

// ─── Upload / decode flow ───────────────────────────────────────────────────
function resetPlaybackAndRecordings() {
  stopActiveSource();
  if (activeRecorder) { try { activeRecorder.stop(); } catch (e) {} activeRecorder = null; activeRecordingSegId = null; }
  Object.values(recordings).forEach(r => r?.url && URL.revokeObjectURL(r.url));
  for (const k in recordings) delete recordings[k];
}
function resetSession() {
  resetPlaybackAndRecordings();
  currentFile = null; currentFileId = null; currentWavHeader = null; currentDuration = null;
  currentBuffer = null; currentFingerprint = null; currentMediaId = null; currentMedia = null;
  chapters = []; orphanSentences = []; openChapterIds.clear();
  document.getElementById('fileInfo').style.display = 'none';
  document.getElementById('rangeWrap').style.display = 'none';
  document.getElementById('segmentParamsRow').style.display = 'none';
  document.getElementById('sentenceListWrap').style.display = 'none';
  showProgress(false);
  setStatus('');
}

/** Decodes [startSec,endSec] (ABSOLUTE file-seconds) into currentBuffer. */
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

async function loadSelectedRange(startSec, endSec) {
  if (!currentFile) return;
  if (!currentWavHeader) endSec = Math.min(endSec, startSec + MAX_NONWAV_SLICE_SEC);
  resetPlaybackAndRecordings();

  const loadBtn = document.getElementById('loadSliceBtn');
  loadBtn.disabled = true;
  try {
    currentBuffer = await decodeRangeToBuffer(startSec, endSec);
    currentSliceStart = startSec; currentSliceEnd = endSec;
  } catch (e) {
    showProgress(false);
    let hint = '';
    if (currentWavHeader) {
      const bytes = estimateDecodedBytes(currentWavHeader.fmt, endSec - startSec);
      if (bytes > WAV_DECODE_WARN_BYTES) hint = ` This range decodes to ~${fmtBytes(bytes)} of raw audio — likely too large for your browser to hold in memory at once. Try a shorter range.`;
    }
    setStatus('Could not decode selected range: ' + e.message + hint);
    loadBtn.disabled = false;
    return;
  }
  loadBtn.disabled = false;

  if (currentMedia.segments.length) {
    document.getElementById('segmentParamsRow').style.display = 'none';
    renderChapterList();
    setStatus(`Loaded — showing ${currentMedia.sentenceCount} already-split sentence${currentMedia.sentenceCount === 1 ? '' : 's'} (${currentMedia.doneCount} done).`);
  } else {
    const mono = computeMonoData(currentBuffer);
    const sentenceMs = parseInt(document.getElementById('sentenceSlider').value, 10);
    suggestedChapterMs = suggestChapterSilenceMs(mono, currentBuffer.sampleRate, sentenceMs);
    document.getElementById('chapterSlider').value = suggestedChapterMs;
    document.getElementById('chapterVal').textContent = suggestedChapterMs + ' ms';
    document.getElementById('segmentParamsRow').style.display = 'flex';
    setStatus('Range loaded — choose sensitivities below and click Split.');
  }
}

async function handleFile(file) {
  resetSession();
  currentFile = file;
  currentFileId = fileIdentityId(file);
  setStatus('Reading file info…');

  if (await looksLikeWav(file)) currentWavHeader = await readWavHeaderInfo(file);
  let duration;
  if (currentWavHeader) duration = currentWavHeader.dataSize / (currentWavHeader.fmt.sampleRate * currentWavHeader.fmt.blockAlign);
  else duration = await probeDuration(file);
  if (duration == null) { setStatus('Could not read audio duration — unsupported or corrupt file?'); return; }
  currentDuration = duration;

  document.getElementById('fileInfo').style.display = 'flex';
  document.getElementById('fileName').textContent = file.name;
  document.getElementById('fileDuration').textContent =
      `${secToClock(duration)}${currentWavHeader ? ' · WAV (instant slice decode)' : ' · non-WAV (real-time slice decode)'}`;

  setStatus('Checking for existing progress on this file…');
  currentFingerprint = await computeFingerprint(file);
  const userId = await UserLib.getCurrentUserId();
  const resp = await fetch('/api/v1/shadowing/media/find-or-create', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId, fingerprint: currentFingerprint, originalFilename: file.name, fileSizeBytes: file.size,
      durationMs: Math.round(duration * 1000), sampleRateHz: currentWavHeader?.fmt.sampleRate, channels: currentWavHeader?.fmt.channels,
    }),
  });
  currentMedia = await resp.json();
  currentMediaId = currentMedia.id;
  rebuildChapterTree();

  setupRangeUI(duration);
  if (currentMedia.segments.length) {
    const maxEndSec = Math.min(maxSecGlobal, Math.ceil(Math.max(...currentMedia.segments.map(s => s.endMs)) / 1000));
    document.getElementById('rangeEndSlider').value = maxEndSec;
    document.getElementById('rangeEnd').value = secToClock(maxEndSec);
    updateRangeDurLabel();
    setStatus(`Resuming — ${currentMedia.sentenceCount} sentences already split (${currentMedia.doneCount} done)…`);
    await loadSelectedRange(0, maxEndSec);   // auto-load so the resumed list appears without an extra click
  } else {
    setStatus('Pick a time range below, load it, then choose sensitivities and split.');
  }
  refreshMediaList();
}

// ─── Extract audio from a pasted YouTube URL — the server never sees more than
// the URL itself; the extracted WAV is wrapped as a File and handed to the
// exact same handleFile() path a dropped/opened local file goes through, so
// nothing downstream (range picker, client-side VAD, fingerprint resume,
// per-sentence record/compare/done/Formant-Lab-handoff) needs to know or
// care that this file didn't come from local disk. ─────────────────────────
async function extractYoutubeAudio() {
  const input = document.getElementById('ytUrlInput');
  const btn = document.getElementById('ytExtractBtn');
  const url = input.value.trim();
  if (!url) return;
  btn.disabled = true;
  showProgress(true, 'Extracting audio from YouTube… this can take a while for longer videos.', true);
  setStatus('');
  try {
    const resp = await fetch('/api/v1/youtube-extract', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(600000),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || ('HTTP ' + resp.status));
    }
    const blob = await resp.blob();
    showProgress(false);
    const idMatch = url.match(/(?:v=|youtu\.be\/)([\w-]{6,})/);
    const file = new File([blob], `youtube-${idMatch ? idMatch[1] : 'audio'}.wav`, { type: 'audio/wav' });
    await handleFile(file);
  } catch (e) {
    showProgress(false);
    setStatus('YouTube extraction failed: ' + e.message);
  }
  btn.disabled = false;
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
document.addEventListener('DOMContentLoaded', async () => {
  await UserLib.mountPicker('userPicker');
  window.addEventListener('phonexa:user-changed', () => { resetSession(); refreshMediaList(); });

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

  document.getElementById('ytExtractBtn').addEventListener('click', () => extractYoutubeAudio());

  document.getElementById('deleteMediaBtn').addEventListener('click', async () => {
    if (!currentMediaId) return;
    if (!confirm('Delete this upload\'s segments/progress? This cannot be undone.')) return;
    await fetch(`/api/v1/shadowing/media/${currentMediaId}`, { method: 'DELETE' });
    resetSession();
    refreshMediaList();
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
    loadSelectedRange(clockToSec(startText.value), clockToSec(endText.value));
  });

  // ── Segmentation params ──
  const sentenceSlider = document.getElementById('sentenceSlider');
  sentenceSlider.addEventListener('input', () => { document.getElementById('sentenceVal').textContent = sentenceSlider.value + ' ms'; });
  const chapterSlider = document.getElementById('chapterSlider');
  chapterSlider.addEventListener('input', () => { document.getElementById('chapterVal').textContent = chapterSlider.value + ' ms'; });
  document.getElementById('splitParamsBtn').addEventListener('click', () => runClientSegmentation());
  document.getElementById('resplitBtn').addEventListener('click', () => {
    if (!currentMedia) return;
    if (!confirm('Re-splitting discards all manual edits and done-progress for this upload. Continue?')) return;
    sentenceSlider.value = currentMedia.sentenceSilenceMs || 300;
    chapterSlider.value = currentMedia.chapterSilenceMs || suggestedChapterMs;
    document.getElementById('sentenceVal').textContent = sentenceSlider.value + ' ms';
    document.getElementById('chapterVal').textContent = chapterSlider.value + ' ms';
    document.getElementById('segmentParamsRow').style.display = 'flex';
  });

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

  checkTranscribeServer();
  renderRecentFiles();
  await refreshMediaList();

  const deepLinkMediaId = parseInt(new URLSearchParams(location.search).get('mediaId'), 10);
  if (deepLinkMediaId) {
    const res = await fetch(`/api/v1/shadowing/media/${deepLinkMediaId}`);
    if (res.ok) {
      const media = await res.json();
      setStatus(`To continue "${media.originalFilename || 'this upload'}" (${media.sentenceCount} sentences, ${media.doneCount} done), choose or drop that same file below.`);
    }
  }
});
