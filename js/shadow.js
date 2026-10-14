/**
 * shadow.js — Shadowing practice page (shadow.html).
 *
 * Server-backed: an upload is stored once (POST /api/v1/shadowing/media),
 * so re-opening it later — from any browser, on any device — never
 * re-uploads or re-splits. Segmentation (chapters + sentences) runs
 * server-side (see shadowing.py, a Python port of js/vad.js's
 * detectSentences) and is persisted, along with per-sentence done/text
 * progress. The client only ever decodes small bounded ranges on demand —
 * a chapter's own audio (GET .../media/<id>/audio?startMs&endMs), lazily,
 * the first time one of its sentences is opened — never the whole file.
 *
 * Per sentence: play the reference slice (sliced out of its chapter's
 * decoded AudioBuffer via start/offset/duration), record yourself with
 * MediaRecorder, play your take back, or compare (reference then yours).
 * Recordings themselves are NOT persisted server-side — only done/text are
 * durable; a recording is lost on reload, same as a scratch take always was.
 *
 * Transcription can use a local /transcribe endpoint on formanter.py
 * (faster-whisper) or, as a no-install alternative, the Hugging Face
 * Inference API directly from the browser. Backend/url/token/model now
 * come from the per-user 'transcribeBackend' Setting (configured on
 * settings.html), not a hardcoded constant or raw localStorage keys.
 */

let currentMediaId = null, currentMedia = null;   // currentMedia: {..., segments:[...]}
let chapters = [], orphanSentences = [];          // rebuilt from currentMedia.segments by rebuildChapterTree()
const chapterBuffers = {}, chapterBufferPromises = {};   // chapterId -> AudioBuffer (decoded lazily, on first expand)
const segmentBuffers = {}, segmentBufferPromises = {};   // segmentId -> AudioBuffer, for orphan (no-chapter) sentences only
const recordings = {};   // segmentId -> {blob, url, buffer, trimStartMs} — ephemeral, never sent to the server
const rowRefs = {};      // segmentId -> row element
let suggestedChapterMs = 4000;
let splitArmedSegId = null;

let playCtx = null, activeSource = null;
let micStream = null, activeRecorder = null, activeRecordingSegId = null;

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
async function decodeAudioBuffer(arrayBuffer) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const buf = await ctx.decodeAudioData(arrayBuffer);
  ctx.close();
  return buf;
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

// ─── Reference audio — lazy, bounded decode ─────────────────────────────────
// A sentence belonging to a chapter shares that chapter's single decoded
// AudioBuffer (fetched once, the first time any of its sentences is opened);
// an "ungrouped" orphan sentence (no containing chapter) fetches just its
// own small range instead. Either way, the client never holds more than a
// few chapters' worth of audio in memory, never the whole uploaded file.
async function ensureChapterBuffer(chapterId) {
  if (chapterBuffers[chapterId]) return chapterBuffers[chapterId];
  if (chapterBufferPromises[chapterId]) return chapterBufferPromises[chapterId];
  const ch = chapters.find(c => c.id === chapterId);
  if (!ch) return null;
  chapterBufferPromises[chapterId] = (async () => {
    try {
      const resp = await fetch(`/api/v1/shadowing/media/${currentMediaId}/audio?startMs=${ch.startMs}&endMs=${ch.endMs}`);
      if (!resp.ok) return null;
      const buf = await decodeAudioBuffer(await resp.arrayBuffer());
      chapterBuffers[chapterId] = buf;
      return buf;
    } catch (e) { return null; }
  })();
  return chapterBufferPromises[chapterId];
}
async function ensureOwnSegmentBuffer(seg) {
  if (segmentBuffers[seg.id]) return segmentBuffers[seg.id];
  if (segmentBufferPromises[seg.id]) return segmentBufferPromises[seg.id];
  segmentBufferPromises[seg.id] = (async () => {
    try {
      const resp = await fetch(`/api/v1/shadowing/segments/${seg.id}/audio`);
      if (!resp.ok) return null;
      const buf = await decodeAudioBuffer(await resp.arrayBuffer());
      segmentBuffers[seg.id] = buf;
      return buf;
    } catch (e) { return null; }
  })();
  return segmentBufferPromises[seg.id];
}
/** Returns {buffer, offsetMs} — offsetMs is where this segment starts WITHIN `buffer`. */
async function ensureSegmentBuffer(seg, chapter) {
  if (chapter) {
    const buf = await ensureChapterBuffer(chapter.id);
    return buf ? { buffer: buf, offsetMs: seg.startMs - chapter.startMs } : null;
  }
  const buf = await ensureOwnSegmentBuffer(seg);
  return buf ? { buffer: buf, offsetMs: 0 } : null;
}
async function playRefSeg(seg, chapter, rate = 1) {
  const res = await ensureSegmentBuffer(seg, chapter);
  if (!res) return;
  playAudioBufferSlice(res.buffer, res.offsetMs, res.offsetMs + (seg.endMs - seg.startMs), rate);
}
async function compareSeg(seg, chapter) {
  const rec = recordings[seg.id];
  if (!rec) { playRefSeg(seg, chapter); return; }
  const res = await ensureSegmentBuffer(seg, chapter);
  if (!res) return;
  playAudioBufferSlice(res.buffer, res.offsetMs, res.offsetMs + (seg.endMs - seg.startMs), 1, () => {
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
  const btn = row.querySelector('.transcribe-btn');
  const out = row.querySelector('.sent-transcript');
  btn.disabled = true; btn.textContent = '…';
  out.textContent = 'Transcribing…'; out.style.display = 'block';
  try {
    const audioResp = await fetch(`/api/v1/shadowing/segments/${seg.id}/audio`);
    const blob = await audioResp.blob();
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
// that chunk's audio (fetched from the server), exactly as if it had been
// drag-and-dropped there — so it can be split into sections/samples, edited,
// and saved from there. ───────────────────────────────────────────────────
async function openSegmentInFormantLab(seg, row) {
  const status = row.querySelector('.sent-status');
  const prevStatus = status.textContent;
  status.textContent = 'Opening in Formant Lab…';
  try {
    const audioResp = await fetch(`/api/v1/shadowing/segments/${seg.id}/audio`);
    const buffer = await audioResp.arrayBuffer();
    const win = window.open('praat.html?ingestFromOpener=1', '_blank');
    if (!win) { status.textContent = 'Popup blocked — allow popups for this site and try again'; return; }
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
function msToClock(ms) {
  const s = ms / 1000;
  const m = Math.floor(s / 60), rem = (s - m * 60).toFixed(2);
  return `${m}:${rem.padStart(5, '0')}`;
}
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function setStatus(text) { const el = document.getElementById('uploadStatus'); if (el) el.textContent = text; }
function showProgress(on, label = '') {
  const wrap = document.getElementById('progressWrap');
  wrap.style.display = on ? 'flex' : 'none';
  document.getElementById('progressLabel').textContent = label;
}

// ─── Uploads list + upload flow ─────────────────────────────────────────────
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
      <button class="sent-btn media-open-btn" data-id="${m.id}" type="button">▶ Open</button>
      <button class="cache-forget" data-id="${m.id}" title="Delete this upload">✕</button>
    </div>`).join('');
  el.querySelectorAll('.media-open-btn').forEach(btn => btn.addEventListener('click', () => openMedia(parseInt(btn.dataset.id, 10))));
  el.querySelectorAll('.cache-forget').forEach(btn => btn.addEventListener('click', async () => {
    if (!confirm('Delete this upload and all its segments/progress? This cannot be undone.')) return;
    await fetch(`/api/v1/shadowing/media/${btn.dataset.id}`, { method: 'DELETE' });
    if (currentMediaId === parseInt(btn.dataset.id, 10)) resetMediaView();
    refreshMediaList();
  }));
}

async function uploadFile(file) {
  showProgress(true, `Uploading ${file.name}…`);
  setStatus('');
  const userId = await UserLib.getCurrentUserId();
  const form = new FormData();
  form.append('userId', userId);
  form.append('file', file, file.name);
  try {
    const resp = await fetch('/api/v1/shadowing/media', { method: 'POST', body: form });
    const data = await resp.json();
    showProgress(false);
    if (!resp.ok) throw new Error(data.error || ('HTTP ' + resp.status));
    setStatus(`Uploaded ${file.name} — ${secToClock((data.durationMs || 0) / 1000)}`);
    await refreshMediaList();
    await openMedia(data.id, data.suggestedChapterSilenceMs);
  } catch (e) {
    showProgress(false);
    setStatus('Upload failed: ' + e.message);
  }
}

function resetMediaView() {
  stopActiveSource();
  if (activeRecorder) { try { activeRecorder.stop(); } catch (e) {} activeRecorder = null; activeRecordingSegId = null; }
  Object.values(recordings).forEach(r => r?.url && URL.revokeObjectURL(r.url));
  for (const k in recordings) delete recordings[k];
  for (const k in chapterBuffers) delete chapterBuffers[k];
  for (const k in chapterBufferPromises) delete chapterBufferPromises[k];
  for (const k in segmentBuffers) delete segmentBuffers[k];
  for (const k in segmentBufferPromises) delete segmentBufferPromises[k];
  currentMediaId = null; currentMedia = null; chapters = []; orphanSentences = [];
  document.getElementById('fileInfo').style.display = 'none';
  document.getElementById('transcribeStatusRow').style.display = 'none';
  document.getElementById('segmentParamsRow').style.display = 'none';
  document.getElementById('sentenceListWrap').style.display = 'none';
  setStatus('');
}

async function openMedia(id, suggestedChapterMsOverride) {
  resetMediaView();
  currentMediaId = id;
  const res = await fetch(`/api/v1/shadowing/media/${id}`);
  if (!res.ok) { setStatus('Could not load this upload.'); return; }
  currentMedia = await res.json();

  document.getElementById('fileInfo').style.display = 'flex';
  document.getElementById('fileName').textContent = currentMedia.originalFilename || '(unnamed)';
  document.getElementById('fileDuration').textContent = secToClock((currentMedia.durationMs || 0) / 1000);
  document.getElementById('transcribeStatusRow').style.display = 'flex';
  checkTranscribeServer();

  if (!currentMedia.segments.length) {
    suggestedChapterMs = suggestedChapterMsOverride || 4000;
    document.getElementById('chapterSlider').value = suggestedChapterMs;
    document.getElementById('chapterVal').textContent = suggestedChapterMs + ' ms';
    document.getElementById('segmentParamsRow').style.display = 'flex';
    setStatus('Not yet split — choose sensitivities below and click Split.');
  } else {
    document.getElementById('segmentParamsRow').style.display = 'none';
    rebuildChapterTree();
    renderChapterList();
  }
}

async function reloadCurrentMedia() {
  const res = await fetch(`/api/v1/shadowing/media/${currentMediaId}`);
  currentMedia = await res.json();
  for (const k in chapterBuffers) delete chapterBuffers[k];
  for (const k in chapterBufferPromises) delete chapterBufferPromises[k];
  for (const k in segmentBuffers) delete segmentBuffers[k];
  for (const k in segmentBufferPromises) delete segmentBufferPromises[k];
  rebuildChapterTree();
  renderChapterList();
}

// ─── Segment tree + rendering ───────────────────────────────────────────────
function rebuildChapterTree() {
  const segs = currentMedia.segments;
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
    orphanSentences.forEach((seg, i) => body.appendChild(renderSentenceRow(seg, orphanSentences, i, null)));
    container.appendChild(wrap);
  }
}

function renderChapterRow(ch, chIdx) {
  const wrap = document.createElement('div');
  wrap.className = 'chapter-row';
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
    if (wrap.classList.contains('open')) ensureChapterBuffer(ch.id);
  });
  wrap.querySelectorAll('.merge-btn').forEach(btn => btn.addEventListener('click', async e => {
    e.stopPropagation();
    const other = chapters[btn.dataset.dir === 'prev' ? chIdx - 1 : chIdx + 1];
    if (!other) return;
    const [a, b] = btn.dataset.dir === 'prev' ? [other.id, ch.id] : [ch.id, other.id];
    await mergeSegments(a, b);
  }));
  const body = wrap.querySelector('.chapter-sentences');
  ch.sentences.forEach((seg, i) => body.appendChild(renderSentenceRow(seg, ch.sentences, i, ch)));
  return wrap;
}

function renderSentenceRow(seg, siblings, i, chapter) {
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
  ensureSegmentBuffer(seg, chapter).then(res => {
    if (res) requestAnimationFrame(() => drawStaticWave(canvas, res.buffer, res.offsetMs, res.offsetMs + (seg.endMs - seg.startMs)));
  });

  row.querySelector('.done-checkbox').addEventListener('change', async e => {
    seg.done = e.target.checked;
    row.classList.toggle('done', seg.done);
    row.querySelector('.sent-status').textContent = seg.done ? 'Done' : (recordings[seg.id] ? 'Recorded ✓' : 'Not recorded');
    if (chapter) {
      const hdr = row.closest('.chapter-row')?.querySelector('.chapter-progress');
      if (hdr) hdr.textContent = chapterProgressText(chapter);
    }
    await fetch(`/api/v1/shadowing/segments/${seg.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ done: seg.done }),
    });
  });

  row.querySelector('.play-ref').addEventListener('click', () => playRefSeg(seg, chapter));
  row.querySelector('.play-ref-slow').addEventListener('click', () => playRefSeg(seg, chapter, 0.6));
  row.querySelector('.rec-btn').addEventListener('click', () => toggleRecord(seg.id, row));
  row.querySelector('.play-mine').addEventListener('click', () => playMine(seg.id));
  row.querySelector('.compare-btn').addEventListener('click', () => compareSeg(seg, chapter));
  row.querySelector('.transcribe-btn').addEventListener('click', () => transcribeSentence(seg, row));
  row.querySelector('.open-formant-lab-btn').addEventListener('click', () => openSegmentInFormantLab(seg, row));
  row.querySelector('.split-btn').addEventListener('click', () => armSplit(seg.id, canvas));
  row.querySelector('.merge-prev-btn').addEventListener('click', () => {
    const prev = siblings[i - 1];
    if (prev) mergeSegments(prev.id, seg.id);
  });
  return row;
}

// ─── Manual editing: split / merge ──────────────────────────────────────────
function armSplit(segId, canvas) {
  if (splitArmedSegId === segId) { splitArmedSegId = null; canvas.style.cursor = ''; return; }
  splitArmedSegId = segId;
  canvas.style.cursor = 'crosshair';
  setStatus('Click a point on the waveform to split there (click ✂ again to cancel).');
  const onClick = async e => {
    if (splitArmedSegId !== segId) return;
    const rect = canvas.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const seg = findSegmentById(segId);
    canvas.style.cursor = '';
    splitArmedSegId = null;
    if (!seg) return;
    const atMs = Math.round(seg.startMs + frac * (seg.endMs - seg.startMs));
    await splitSegment(segId, atMs);
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

// ─── Wiring ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await UserLib.mountPicker('userPicker');
  window.addEventListener('phonexa:user-changed', () => { resetMediaView(); refreshMediaList(); });

  const dz = document.getElementById('dropzone');
  const fileInput = document.getElementById('audioFile');
  dz.addEventListener('click', () => fileInput.click());
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
  dz.addEventListener('drop', e => {
    e.preventDefault(); dz.classList.remove('drag');
    const f = e.dataTransfer.files?.[0];
    if (f) uploadFile(f);
  });
  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    if (f) uploadFile(f);
  });

  document.getElementById('deleteMediaBtn').addEventListener('click', async () => {
    if (!currentMediaId) return;
    if (!confirm('Delete this upload and all its segments/progress? This cannot be undone.')) return;
    await fetch(`/api/v1/shadowing/media/${currentMediaId}`, { method: 'DELETE' });
    resetMediaView();
    refreshMediaList();
  });

  const sentenceSlider = document.getElementById('sentenceSlider');
  sentenceSlider.addEventListener('input', () => { document.getElementById('sentenceVal').textContent = sentenceSlider.value + ' ms'; });
  const chapterSlider = document.getElementById('chapterSlider');
  chapterSlider.addEventListener('input', () => { document.getElementById('chapterVal').textContent = chapterSlider.value + ' ms'; });

  document.getElementById('splitParamsBtn').addEventListener('click', async () => {
    if (!currentMediaId) return;
    showProgress(true, 'Splitting into chapters & sentences…');
    const resp = await fetch(`/api/v1/shadowing/media/${currentMediaId}/segment`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sentenceSilenceMs: parseInt(sentenceSlider.value, 10), chapterSilenceMs: parseInt(chapterSlider.value, 10) }),
    });
    showProgress(false);
    if (!resp.ok) { setStatus('Split failed.'); return; }
    currentMedia = await resp.json();
    document.getElementById('segmentParamsRow').style.display = 'none';
    rebuildChapterTree();
    renderChapterList();
    refreshMediaList();
  });
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

  await refreshMediaList();

  const deepLinkMediaId = parseInt(new URLSearchParams(location.search).get('mediaId'), 10);
  if (deepLinkMediaId) await openMedia(deepLinkMediaId);
});
