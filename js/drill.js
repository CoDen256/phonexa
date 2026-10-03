/**
 * drill.js — Token Drill: a standalone static-practice page. Play a DB
 * token's reference slice, record yourself, play it back, compare — the
 * same four-action loop js/shadow.js already proved out for Shadowing, but
 * reimplemented self-contained here (shadow.js is untouched) and applied
 * to any DB token instead of an uploaded file's auto-detected sentences.
 *
 * Reuses: fetchDecodeAudio (js/audio.js, reference-slice decode+cache) and
 * detectLeadingSilenceMs (js/vad.js, recording trim) — both already shared
 * infrastructure. Everything else here (MediaRecorder lifecycle, compare
 * sequencing) mirrors js/shadow.js's pattern but is its own copy.
 */

const drillState = {
  languages: [],
  vowels: [],        // for the selected language: [{id, symbols, desc}]
  tokens: [],         // joined with audioUrl
  recordings: {},     // tokenId -> {blob, url, buffer, trimStartMs}
};

let drillPlayCtx = null;
let drillActiveSource = null;
let drillMicStream = null;
let drillActiveRecorder = null;
let drillActiveRecordingTokenId = null;

function escapeHtmlDr(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function getDrillPlayCtx() {
  if (!drillPlayCtx || drillPlayCtx.state === 'closed') drillPlayCtx = new (window.AudioContext || window.webkitAudioContext)();
  return drillPlayCtx;
}
function stopDrillActiveSource() {
  if (drillActiveSource) { try { drillActiveSource.stop(); } catch (e) {} drillActiveSource = null; }
}

async function playRefToken(tok) {
  if (!tok.audioUrl || tok.timeStartMs == null || tok.timeEndMs == null) {
    if (tok.audioUrl) new Audio(tok.audioUrl).play().catch(() => {});
    return;
  }
  try {
    const wav = await fetchDecodeAudio(tok.audioUrl);
    const i0 = Math.floor(tok.timeStartMs / 1000 * wav.sampleRate);
    const i1 = Math.ceil(tok.timeEndMs / 1000 * wav.sampleRate);
    stopDrillActiveSource();
    const ctx = getDrillPlayCtx();
    const buf = ctx.createBuffer(1, Math.max(1, i1 - i0), wav.sampleRate);
    buf.getChannelData(0).set(wav.samples.slice(i0, i1));
    const src = ctx.createBufferSource();
    src.buffer = buf; src.connect(ctx.destination); src.start();
    drillActiveSource = src;
    src.onended = () => { if (drillActiveSource === src) drillActiveSource = null; };
    return new Promise(resolve => { src.onended = () => { if (drillActiveSource === src) drillActiveSource = null; resolve(); }; });
  } catch (e) {
    new Audio(tok.audioUrl).play().catch(() => {});
  }
}

function trimSilenceEnabled() { return document.getElementById('trimSilenceToggle')?.checked ?? true; }

function playRecording(rec, onEnded) {
  if (!rec) return;
  if (trimSilenceEnabled() && rec.buffer) {
    stopDrillActiveSource();
    const ctx = getDrillPlayCtx();
    const src = ctx.createBufferSource();
    src.buffer = rec.buffer;
    src.connect(ctx.destination);
    const startSec = rec.trimStartMs / 1000;
    src.start(0, startSec, rec.buffer.duration - startSec);
    drillActiveSource = src;
    src.onended = () => { if (drillActiveSource === src) drillActiveSource = null; onEnded?.(); };
  } else {
    const a = new Audio(rec.url);
    if (onEnded) a.onended = onEnded;
    a.play().catch(() => {});
  }
}

function playMine(tokenId) { playRecording(drillState.recordings[tokenId]); }

async function compareToken(tok) {
  const rec = drillState.recordings[tok.id];
  if (!rec) { await playRefToken(tok); return; }
  await playRefToken(tok);
  setTimeout(() => playRecording(rec), 300);
}

async function getDrillMicStream() {
  if (drillMicStream) return drillMicStream;
  drillMicStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  return drillMicStream;
}
function pickDrillRecorderMime() {
  for (const m of ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', '']) {
    if (!m || MediaRecorder.isTypeSupported(m)) return m;
  }
  return '';
}

async function toggleDrillRecord(tok, row) {
  if (drillActiveRecordingTokenId === tok.id) { drillActiveRecorder.stop(); return; }
  if (drillActiveRecorder) drillActiveRecorder.stop();
  const status = row.querySelector('.drill-status');
  const recBtn = row.querySelector('.drill-rec-btn');
  try {
    const stream = await getDrillMicStream();
    const chunks = [];
    const mime = pickDrillRecorderMime();
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = async () => {
      const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
      if (drillState.recordings[tok.id]?.url) URL.revokeObjectURL(drillState.recordings[tok.id].url);
      drillState.recordings[tok.id] = { blob, url: URL.createObjectURL(blob), buffer: null, trimStartMs: 0 };
      drillActiveRecorder = null; drillActiveRecordingTokenId = null;
      recBtn.textContent = '● Rec'; recBtn.classList.remove('recording');
      row.querySelector('.drill-play-mine').disabled = false;
      row.querySelector('.drill-compare').disabled = false;
      status.textContent = 'Recorded ✓';
      try {
        const arrayBuf = await blob.arrayBuffer();
        const decodeCtx = new (window.AudioContext || window.webkitAudioContext)();
        const buf = await decodeCtx.decodeAudioData(arrayBuf);
        decodeCtx.close();
        if (drillState.recordings[tok.id]?.blob === blob) {
          drillState.recordings[tok.id].buffer = buf;
          drillState.recordings[tok.id].trimStartMs = detectLeadingSilenceMs(buf);
        }
      } catch (e) { /* trimming unavailable; url playback still works */ }
    };
    rec.start();
    drillActiveRecorder = rec; drillActiveRecordingTokenId = tok.id;
    recBtn.textContent = '■ Stop'; recBtn.classList.add('recording');
    status.textContent = 'Recording…';
  } catch (e) {
    status.textContent = 'Mic error: ' + e.message;
  }
}

function highlightedSampleTextDr(tok) {
  const text = tok.sampleText || '';
  if (tok.charStart == null || tok.charEnd == null || tok.charStart >= tok.charEnd) return escapeHtmlDr(text) || '(untitled)';
  const pre = text.slice(0, tok.charStart), mid = text.slice(tok.charStart, tok.charEnd), post = text.slice(tok.charEnd);
  return `${escapeHtmlDr(pre)}<mark>${escapeHtmlDr(mid)}</mark>${escapeHtmlDr(post)}`;
}

function renderDrillRow(tok) {
  const row = document.createElement('div');
  row.className = 'drill-row';
  const rec = drillState.recordings[tok.id];

  const main = document.createElement('div');
  main.className = 'drill-main';
  main.innerHTML = `<span class="drill-symbol">/${escapeHtmlDr(tok.symbol || '?')}/</span>`
    + `<span class="drill-text">${highlightedSampleTextDr(tok)}</span>`;
  row.appendChild(main);

  const controls = document.createElement('div');
  controls.className = 'drill-controls';
  controls.innerHTML = `
    <button class="drill-btn drill-play-ref" type="button" title="Play reference">▶ Ref</button>
    <button class="drill-btn drill-rec-btn" type="button" title="Record your voice">● Rec</button>
    <button class="drill-btn drill-play-mine" type="button" title="Play your recording" ${rec ? '' : 'disabled'}>▶ You</button>
    <button class="drill-btn drill-compare" type="button" title="Play reference then yours" ${rec ? '' : 'disabled'}>⇄ Compare</button>
    <span class="drill-status">${rec ? 'Recorded ✓' : 'Not recorded'}</span>`;
  row.appendChild(controls);

  controls.querySelector('.drill-play-ref').addEventListener('click', () => playRefToken(tok));
  controls.querySelector('.drill-rec-btn').addEventListener('click', () => toggleDrillRecord(tok, row));
  controls.querySelector('.drill-play-mine').addEventListener('click', () => playMine(tok.id));
  controls.querySelector('.drill-compare').addEventListener('click', () => compareToken(tok));

  return row;
}

function renderDrillList() {
  const q = (document.getElementById('filterInput').value || '').trim().toLowerCase();
  const list = document.getElementById('drillList');
  const empty = document.getElementById('drillEmpty');
  list.innerHTML = '';
  const filtered = drillState.tokens.filter(t =>
    !q || (t.symbol || '').toLowerCase().includes(q) || (t.sampleText || '').toLowerCase().includes(q));
  document.getElementById('drillCount').textContent = `${filtered.length} token${filtered.length === 1 ? '' : 's'}`;
  empty.style.display = filtered.length ? 'none' : 'block';
  filtered.forEach(t => list.appendChild(renderDrillRow(t)));
}

async function loadVowelsForLanguage(languageId) {
  const vowelSelect = document.getElementById('vowelSelect');
  vowelSelect.innerHTML = '<option value="">All vowels</option>';
  drillState.vowels = languageId
    ? await fetch(`/api/v1/vowels?languageId=${languageId}`).then(r => r.ok ? r.json() : []).catch(() => [])
    : [];
  drillState.vowels.forEach(v => {
    const opt = document.createElement('option');
    opt.value = v.id;
    opt.textContent = (v.symbols || []).join(' / ') || `#${v.id}`;
    vowelSelect.appendChild(opt);
  });
}

async function loadTokensForLanguage(languageId, vowelId) {
  if (!languageId) { drillState.tokens = []; renderDrillList(); return; }
  let url = `/api/v1/tokens?languageId=${languageId}`;
  if (vowelId) url += `&vowelId=${vowelId}`;
  const [tokens, sounds] = await Promise.all([
    fetch(url).then(r => r.ok ? r.json() : []).catch(() => []),
    fetch('/api/v1/sounds').then(r => r.ok ? r.json() : []).catch(() => []),
  ]);
  const audioById = new Map(sounds.map(s => [s.id, s.audioUrl]));
  drillState.tokens = tokens.map(t => ({ ...t, audioUrl: audioById.get(t.sampleId) || null }));
  renderDrillList();
}

async function onLanguageChange() {
  const languageId = document.getElementById('langSelect').value;
  await loadVowelsForLanguage(languageId);
  await loadTokensForLanguage(languageId, document.getElementById('vowelSelect').value);
}

async function onVowelChange() {
  const languageId = document.getElementById('langSelect').value;
  await loadTokensForLanguage(languageId, document.getElementById('vowelSelect').value);
}

async function initDrill() {
  const langSelect = document.getElementById('langSelect');
  const vowelSelect = document.getElementById('vowelSelect');
  const filterInput = document.getElementById('filterInput');

  const params = new URLSearchParams(location.search);
  const presetLangKey = params.get('lang');
  const presetSymbol = params.get('symbol');

  drillState.languages = await fetch('/api/v1/languages').then(r => r.ok ? r.json() : []).catch(() => []);
  langSelect.innerHTML = drillState.languages.map(l => `<option value="${l.id}">${escapeHtmlDr(l.label)}</option>`).join('')
    || '<option value="">No languages</option>';

  let presetLang = presetLangKey ? drillState.languages.find(l => l.key === presetLangKey) : null;
  if (presetLang) langSelect.value = presetLang.id;

  langSelect.addEventListener('change', onLanguageChange);
  vowelSelect.addEventListener('change', onVowelChange);
  filterInput.addEventListener('input', renderDrillList);
  document.getElementById('trimSilenceToggle').addEventListener('change', () => {});

  if (langSelect.value) {
    await loadVowelsForLanguage(langSelect.value);
    if (presetSymbol) {
      const match = drillState.vowels.find(v => (v.symbols || []).includes(presetSymbol));
      if (match) vowelSelect.value = match.id;
    }
    await loadTokensForLanguage(langSelect.value, vowelSelect.value);
  }
}

initDrill();
