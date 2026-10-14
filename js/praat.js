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
 * and stay in sync). Three mutually exclusive launch modes decide what the
 * sections ARE and what each card's save action does:
 *
 *  - ingestMode (no ?sampleId=, no ?tokens=): sections are auto-suggested
 *    from js/vad.js's detectSentences() (same heuristic Shadowing uses),
 *    adjustable/addable/removable, each independently saveable as its own
 *    library Sample via js/ingest.js's uploadSlice(). The dropped file
 *    itself is never uploaded whole, only saved sections.
 *  - sampleMode (?sampleId=<id>&scrollTo=<tokenId>): the rich, DB-backed
 *    editor — used by the Sound Browser (sounds.html) and Token Browser
 *    (tokens.html)'s "open in Formant Lab" buttons. Sections are that
 *    Sample's real Tokens, each with an editable symbol, a vowel picker,
 *    manual F1/F2 overrides, and a Save button doing a real
 *    POST/PATCH /api/v1/tokens. Analysis runs server-side against the
 *    sample's own stored audio and is explicitly saved ("💾 Save this
 *    analysis") as a comparable SampleAnalysis history row — a dropdown
 *    lets you switch which saved session you're "Previewing" against every
 *    token's current bounds, separate from which session a token has
 *    actually committed to as its "Current" (active) value.
 *  - legacyCtx (?audio=&sampleText=&tokens=<json>&scrollTo=<idx>, from
 *    editor-samples.js): unchanged from before — ephemeral, postMessage-only
 *    Apply, no DB writes at all. This is how the language editor opens
 *    Formant Lab until a later phase retires that flow in favor of sampleMode.
 */

// ─── Query params / launch context ──────────────────────────────────────────────
// Three mutually exclusive modes:
//  - ingestMode: no sampleId, no tokens — drop a file, carve out new Samples.
//  - sampleMode (?sampleId=): the rich, DB-backed editor — real Tokens with a
//    vowel picker, saved+comparable analysis history, create/edit/delete.
//    Used by the Sound Browser and Token Browser's "open in Formant Lab".
//  - legacyCtx (?tokens=, from editor-samples.js): unchanged from before —
//    ephemeral, postMessage-only Apply, no DB writes. Still how the language
//    editor opens Formant Lab until a later phase retires that flow.
const params = new URLSearchParams(location.search);
const dbSampleId = params.has('sampleId') ? parseInt(params.get('sampleId'), 10) : null;
const legacyCtx = (!dbSampleId && params.has('tokens')) ? {
  audioUrl: params.get('audio') || '',
  sampleText: params.get('sampleText') || '',
  scrollTo: params.has('scrollTo') ? parseInt(params.get('scrollTo'), 10) : null,
  tokens: (() => { try { return JSON.parse(params.get('tokens') || '[]'); } catch (e) { return []; } })(),
} : null;
const scrollToTokenId = dbSampleId && params.has('scrollTo') ? parseInt(params.get('scrollTo'), 10) : null;

const sampleMode = !!dbSampleId;
const ingestMode = !sampleMode && !legacyCtx;
const tokenMode = sampleMode || !!legacyCtx;   // either flavor of token-editing mode

// Ingestion mode, pre-loaded with a chunk handed over by an opener tab (e.g.
// Shadowing's "open in Formant Lab" per-segment button) instead of a
// drag-and-dropped file — otherwise behaves exactly like ingestMode.
const ingestFromOpener = ingestMode && params.has('ingestFromOpener');

// ─── State ──────────────────────────────────────────────────────────────────────
let currentBuffer = null;     // decoded AudioBuffer (all channels, for display + playback)
let analysisResult = null;    // { duration_ms, formants, pitch, spectrogram } — the currently-displayed track
let playbackCursorFrac = null;  // absolute fraction (of the whole buffer) currently playing — null when idle
let selStart = 0, selEnd = 0; // fractions of duration — scratch selection, for drawing a brand-new section
let dragging = false;         // scratch-selection drag (main spectrogram, empty space)
let sectionDrag = null;       // { section, mode: 'resize-start'|'resize-end'|'move', moveOffset } — main-spectrogram section drag
let activeSource = null;

let sections = [];        // unified: [{id, mode:'ingest'|'token', start, end, ...mode fields}]
let nextSectionId = 1;
let languagesList = [];    // [{id, key, label, color, enabled}] — ingest mode's per-section language picker
let vowelsList = [];       // [{id, symbols, desc}] — sampleMode's per-token vowel picker (scoped to the sample's language)
let dbSampleData = null;   // sampleMode: the GET /api/v1/samples/<id> response
let analysesHistory = [];  // sampleMode: [{id, version, config, createdAt}] — saved analysis sessions for this sample
let viewedAnalysisId = null; // sampleMode: which session's track is currently loaded into analysisResult (null = live unsaved preview)

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

async function loadVowelsList(languageId) {
  if (!languageId) { vowelsList = []; return; }
  try {
    const resp = await fetch('/api/v1/vowels?languageId=' + languageId);
    vowelsList = resp.ok ? await resp.json() : [];
  } catch (e) { vowelsList = []; }
  renderSections();
}

// ─── Ingest landing: pick an existing sample instead of drag-and-drop ──────────
let existingSamples = [];
function renderExistingSamplesList() {
  const q = (document.getElementById('espFilter')?.value || '').trim().toLowerCase();
  const list = document.getElementById('espList');
  if (!list) return;
  list.innerHTML = existingSamples
    .filter(s => !q || (s.text || '').toLowerCase().includes(q) || (s.originalFilename || '').toLowerCase().includes(q))
    .slice(0, 100)
    .map(s => `<div class="esp-row" data-id="${s.id}" style="font-size:.78rem;color:#c8d8e8;padding:5px 9px;border-radius:5px;background:#0d1a28;border:1px solid #1e3048;cursor:pointer;display:flex;justify-content:space-between;gap:8px">
        <span style="font-family:Georgia,serif;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeAttr(s.text || s.originalFilename || '(untitled)')}</span>
        <span style="color:#4a6888;flex-shrink:0">#${s.id}</span>
      </div>`).join('') || '<div style="font-size:.72rem;color:#3a5878;text-align:center;padding:8px">No samples match.</div>';
  list.querySelectorAll('.esp-row').forEach(row => {
    row.addEventListener('mouseenter', () => row.style.borderColor = '#4a7098');
    row.addEventListener('mouseleave', () => row.style.borderColor = '#1e3048');
    row.addEventListener('click', () => { location.href = `praat.html?sampleId=${row.dataset.id}`; });
  });
}
async function loadExistingSamplePicker() {
  try {
    const resp = await fetch('/api/v1/sounds');
    existingSamples = resp.ok ? await resp.json() : [];
  } catch (e) { existingSamples = []; }
  renderExistingSamplesList();
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
  document.getElementById('existingSamplePicker').style.display = 'none';
  document.getElementById('praatPanels').style.display = 'block';
  document.getElementById('paramsRow').style.display = ingestMode ? 'none' : 'flex';
  document.getElementById('analyzeBtn').style.display = ingestMode ? 'none' : '';
  document.getElementById('channelInfo').textContent =
      `${buffer.numberOfChannels} ch · ${(buffer.sampleRate / 1000).toFixed(1)} kHz · ${buffer.duration.toFixed(2)}s`;
  document.getElementById('sectionsPanel').style.display = 'block';
  document.getElementById('addSectionToolbar').style.display = legacyCtx ? 'none' : 'flex';
  document.getElementById('newSectionBtn').textContent = ingestMode ? '+ New section from selection' : '+ New token from selection';
  document.getElementById('analysisHistoryRow').style.display = sampleMode ? 'flex' : 'none';
  document.getElementById('trimBtn').style.display = sampleMode ? '' : 'none';
  document.getElementById('trimConfirmRow').style.display = 'none';
  document.getElementById('sectionsHint').textContent = ingestMode
    ? '(auto-suggested from silence gaps — drag a section\'s own mini-spectrogram, or its band on the main spectrogram above, to adjust)'
    : sampleMode
    ? '(one per token in this sample — drag to adjust its time range, assign a vowel, and Save; empty-space drag defines a new token)'
    : '(one per token in this sample — drag to adjust its time range, Apply sends that token\'s result back to the editor)';
  if (ingestMode) {
    document.getElementById('fileToolbar').style.display = 'flex';
    suggestSections();
  } else if (sampleMode) {
    seedSectionsFromDbSample();
  } else {
    seedSectionsFromTokens();
  }
  await runAnalyze();
  if (legacyCtx?.scrollTo != null) scrollToSection(s => s.tokIdx === legacyCtx.scrollTo);
  if (scrollToTokenId != null) scrollToSection(s => s.dbTokenId === scrollToTokenId);
}

// ─── Sample mode: fetch the real Sample + its Tokens/analysis-history from the DB ──
async function fetchDbSample() {
  const resp = await fetch(`/api/v1/samples/${dbSampleId}`);
  if (!resp.ok) throw new Error('Could not load sample #' + dbSampleId);
  dbSampleData = await resp.json();
  analysesHistory = dbSampleData.analyses || [];
}

// ─── Sample mode: trim the sample's audio to the current selection ─────────
async function trimAudioToSelection() {
  if (!currentBuffer || selEnd <= selStart || !sampleMode) return;
  const durationMs = currentBuffer.duration * 1000;
  const trimStartMs = selStart * durationMs, trimEndMs = selEnd * durationMs;
  document.getElementById('trimConfirmRow').style.display = 'none';
  setStatus('Trimming…');
  try {
    const { samples, sampleRate } = extractMonoSlice(currentBuffer, trimStartMs, trimEndMs);
    const blob = encodeWavBlob(samples, sampleRate);
    const form = new FormData();
    form.append('file', blob, 'trimmed.wav');
    form.append('trimStartMs', String(trimStartMs));
    const resp = await fetch(`/api/v1/samples/${dbSampleId}/trim`, { method: 'POST', body: form });
    if (!resp.ok) { const err = await resp.json().catch(() => ({})); throw new Error(err.error || 'HTTP ' + resp.status); }
    await fetchDbSample();
    // Cache-bust — same storage_key/URL as before the trim, so a cached
    // response for this exact URL must not be allowed to win.
    const bustedUrl = dbSampleData.audioUrl + (dbSampleData.audioUrl.includes('?') ? '&' : '?') + 't=' + Date.now();
    await handleUrl(bustedUrl);
    setStatus('Trimmed — every token shifted to match the new timeline.');
  } catch (e) {
    setStatus('Trim failed: ' + e.message);
  }
}

function seedSectionsFromDbSample() {
  const durationMs = currentBuffer.duration * 1000;
  const defaultLenFrac = Math.min(1, 300 / durationMs);
  sections = (dbSampleData.tokens || []).map(t => {
    const hasSlice = t.timeStartMs != null && t.timeEndMs != null;
    const start = hasSlice ? t.timeStartMs / durationMs : 0;
    const end = hasSlice ? t.timeEndMs / durationMs : Math.min(1, defaultLenFrac);
    return {
      id: nextSectionId++, mode: 'token', dbTokenId: t.id,
      symbol: t.symbol || '', vowelId: t.vowelId, start, end,
      charStart: t.charStart ?? 0, charEnd: t.charEnd ?? (t.symbol || '').length,
      activeAnalysisId: t.activeAnalysisId, manualF1: t.manualF1, manualF2: t.manualF2,
      dirty: false,
    };
  });
  document.getElementById('tokenContext').style.display = 'block';
  document.getElementById('tokenSampleText').textContent =
      `"${dbSampleData.text || '(untitled)'}" — ${sections.length} token(s)`;
  renderAnalysisHistorySelect();
  renderSections();
  if (dbSampleData.languageId) loadVowelsList(dbSampleData.languageId);
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
  if (ingestMode) {
    sections.push({ id: nextSectionId++, mode: 'ingest', start: selStart, end: selEnd, text: '', phonemic: '', languageId: null, savedSampleId: null });
  } else if (sampleMode) {
    sections.push({
      id: nextSectionId++, mode: 'token', dbTokenId: null, symbol: '', vowelId: null,
      start: selStart, end: selEnd, activeAnalysisId: null, manualF1: null, manualF2: null,
    });
  } else {
    return;   // legacy editor-launched mode: token set is fixed, nothing to add here
  }
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

async function updateSavedSection(s) {
  try {
    const resp = await fetch(`/api/v1/samples/${s.savedSampleId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: s.text, phonemic: s.phonemic }),
    });
    if (!resp.ok) { const err = await resp.json().catch(() => ({})); throw new Error(err.error || 'HTTP ' + resp.status); }
    cardStatus(s, '✓ Updated (filename unchanged)');
  } catch (e) {
    cardStatus(s, 'Update failed: ' + e.message);
  }
}

// ─── Sample mode: seed one section per token, apply back per-card ──────────────
function seedSectionsFromTokens() {
  const durationMs = currentBuffer.duration * 1000;
  const defaultLenFrac = Math.min(1, 300 / durationMs);
  sections = legacyCtx.tokens.map((t, idx) => {
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
      `"${legacyCtx.sampleText}" — ${sections.length} token(s)`;
  // Seed the global analysis params from the focused (scrollTo) token's existing config, if any.
  const focus = sections.find(s => s.tokIdx === legacyCtx.scrollTo) || sections[0];
  const c = focus?.params || {};
  if (c.max_number_of_formants) document.getElementById('pMaxFormants').value = c.max_number_of_formants;
  if (c.maximum_formant)         document.getElementById('pMaxFreq').value = c.maximum_formant;
  if (c.window_length)           document.getElementById('pWindowLen').value = c.window_length;
  if (c.pre_emphasis_from)       document.getElementById('pPreEmph').value = c.pre_emphasis_from;
  if (c.pitch_floor)             document.getElementById('pPitchFloor').value = c.pitch_floor;
  if (c.pitch_ceiling)           document.getElementById('pPitchCeiling').value = c.pitch_ceiling;
  renderSections();
}

// ─── Sample mode: saved analysis history — the "can I compare them" feature ────
function renderAnalysisHistorySelect() {
  const sel = document.getElementById('analysisHistorySelect');
  if (!sel) return;
  const opts = ['<option value="">Live preview (unsaved)</option>'].concat(
    analysesHistory.map(a => {
      const c = a.config || {};
      const when = a.createdAt ? new Date(a.createdAt).toLocaleString() : '';
      return `<option value="${a.id}">Session #${a.id} — ${when} (ceiling ${c.maximum_formant}Hz, window ${c.window_length}s)</option>`;
    })
  );
  sel.innerHTML = opts.join('');
  sel.value = viewedAnalysisId || '';
}

async function onAnalysisHistoryChange() {
  const sel = document.getElementById('analysisHistorySelect');
  const val = sel.value ? parseInt(sel.value, 10) : null;
  viewedAnalysisId = val;
  if (val == null) { await runAnalyze(); return; }   // back to the live preview
  setStatus('Loading session #' + val + '…');
  try {
    const resp = await fetch(`/api/v1/samples/${dbSampleId}/analyses/${val}`);
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const full = await resp.json();
    analysisResult = { ...analysisResult, formants: full.formants, pitch: full.pitch };
    drawSpectrogramOverlay();
    refreshSectionVisuals();
    setStatus('');
  } catch (e) {
    setStatus('Could not load session: ' + e.message);
  }
}

async function saveCurrentAnalysis() {
  const btn = document.getElementById('saveAnalysisBtn');
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  setStatus('Saving analysis session…');
  try {
    const config = {
      max_number_of_formants: +(document.getElementById('pMaxFormants')?.value) || 5,
      maximum_formant: +(document.getElementById('pMaxFreq')?.value) || 5500,
      window_length: +(document.getElementById('pWindowLen')?.value) || 0.025,
      pre_emphasis_from: +(document.getElementById('pPreEmph')?.value) || 50,
      pitch_floor: +(document.getElementById('pPitchFloor')?.value) || 75,
      pitch_ceiling: +(document.getElementById('pPitchCeiling')?.value) || 600,
    };
    const resp = await fetch(`/api/v1/samples/${dbSampleId}/analyze`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || 'HTTP ' + resp.status);
    }
    const saved = await resp.json();
    analysesHistory.push({ id: saved.id, version: saved.version, config: saved.config, createdAt: saved.createdAt });
    viewedAnalysisId = saved.id;
    analysisResult = { ...analysisResult, formants: saved.formants, pitch: saved.pitch };
    renderAnalysisHistorySelect();
    drawSpectrogramOverlay();
    refreshSectionVisuals();
    setStatus(`Saved as session #${saved.id} — now the most recent in the history above.`);
  } catch (e) {
    setStatus('Save failed: ' + e.message);
  }
  if (btn) { btn.disabled = false; btn.textContent = '💾 Save this analysis'; }
}

// Thin wrapper over js/spectro.js's generic version — see that file for the
// real implementation, now shared with js/practice.js.
function computeMeansForRange(startFrac, endFrac) {
  if (!currentBuffer) return null;
  return SpectroLib.computeMeansForRange(analysisResult, currentBuffer.duration * 1000, startFrac, endFrac);
}
function computeSelectionMeans() { return computeMeansForRange(selStart, selEnd); }

function applySection(s) {
  const means = computeMeansForRange(s.start, s.end);
  if (!means || means.f1 == null) { setStatus('No voiced formant frames in this section — adjust its bounds'); return; }
  const [t0, t1] = sectionMs(s);
  const payload = {
    type: 'praat-analysis-result',
    tokIdx: s.tokIdx,
    audioUrl: legacyCtx.audioUrl,
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

// ─── Sample mode: real Token CRUD against the DB ───────────────────────────────
function cardStatus(s, text) {
  const card = document.querySelector(`.section-card[data-id="${s.id}"]`);
  const el = card?.querySelector('.section-card-status');
  if (el) el.textContent = text;
}

async function saveToken(s) {
  const [t0, t1] = sectionMs(s);
  const body = {
    symbol: s.symbol, vowelId: s.vowelId,
    charStart: s.charStart ?? 0, charEnd: s.charEnd ?? (s.symbol || '').length,
    timeStartMs: t0, timeEndMs: t1,
    manualF1: s.manualF1, manualF2: s.manualF2,
  };
  try {
    let resp;
    if (s.dbTokenId) {
      resp = await fetch(`/api/v1/tokens/${s.dbTokenId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
    } else {
      resp = await fetch(`/api/v1/samples/${dbSampleId}/tokens`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
    }
    if (!resp.ok) { const err = await resp.json().catch(() => ({})); throw new Error(err.error || 'HTTP ' + resp.status); }
    const saved = await resp.json();
    s.dbTokenId = saved.id;
    s.dirty = false;
    renderSections();
    cardStatus(s, '✓ Saved');
  } catch (e) {
    cardStatus(s, 'Save failed: ' + e.message);
  }
}

async function deleteToken(s) {
  if (s.dbTokenId) {
    if (!confirm('Delete this saved token? This cannot be undone.')) return;
    try {
      await fetch(`/api/v1/tokens/${s.dbTokenId}`, { method: 'DELETE' });
    } catch (e) { setStatus('Delete failed: ' + e.message); return; }
  }
  sections = sections.filter(x => x.id !== s.id);
  renderSections(); redrawAll();
}

async function useViewedAnalysisForToken(s) {
  if (viewedAnalysisId == null) return;
  s.activeAnalysisId = viewedAnalysisId;
  try {
    if (s.dbTokenId) {
      await fetch(`/api/v1/tokens/${s.dbTokenId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ activeAnalysisId: viewedAnalysisId }),
      });
    }
    refreshSectionVisuals();
    cardStatus(s, `✓ Using session #${viewedAnalysisId}`);
  } catch (e) {
    cardStatus(s, 'Failed: ' + e.message);
  }
}

function currentLabelForToken(s) {
  if (s.manualF1 != null && s.manualF2 != null) {
    return `F1 ${Math.round(s.manualF1)} · F2 ${Math.round(s.manualF2)} Hz (manual)`;
  }
  if (s.activeAnalysisId == null) return 'not analyzed yet';
  if (s.activeAnalysisId !== viewedAnalysisId) return `from session #${s.activeAnalysisId} — switch the dropdown above to compute`;
  const means = computeMeansForRange(s.start, s.end);
  if (!means?.nFormantFrames) return 'no voiced frames';
  return `F1 ${Math.round(means.f1)} · F2 ${Math.round(means.f2)}${means.f0 != null ? ` · F0 ${Math.round(means.f0)}` : ''} Hz`;
}
function previewLabelForToken(s) {
  const means = computeMeansForRange(s.start, s.end);
  if (!means?.nFormantFrames) return 'no voiced frames';
  return `F1 ${Math.round(means.f1)} · F2 ${Math.round(means.f2)}${means.f0 != null ? ` · F0 ${Math.round(means.f0)}` : ''} Hz`;
}
// Ingest mode: read-only — no manual re-analyze there, this just shows what
// the one auto-run default-params analysis found over this section's range.
function ingestSectionMeansLabel(s) {
  const means = computeMeansForRange(s.start, s.end);
  if (!means?.nFormantFrames) return 'no voiced frames in this section';
  return `F1 <b>${Math.round(means.f1)}</b> · F2 <b>${Math.round(means.f2)}</b>${means.f0 != null ? ` · F0 <b>${Math.round(means.f0)}</b>` : ''} Hz`;
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

    const isDbToken = s.mode === 'token' && s.dbTokenId !== undefined;
    const vowel = isDbToken ? vowelsList.find(v => v.id === s.vowelId) : null;

    let header, body;
    if (s.mode === 'ingest') {
      header = `<span class="section-idx">#${i + 1}</span><span class="section-time">${sectionMs(s).join('–')} ms</span>`;
      body = `
        <select class="section-lang">${['<option value="">— language —</option>']
          .concat(languagesList.map(l => `<option value="${l.id}"${s.languageId === l.id ? ' selected' : ''}>${escapeAttr(l.label)}</option>`)).join('')}</select>
        <input type="text" class="section-text" placeholder="text (required)" value="${escapeAttr(s.text)}">
        <input type="text" class="section-phonemic" placeholder="phonemic" value="${escapeAttr(s.phonemic)}">
        <button class="sent-btn section-play" type="button">▶</button>
        ${s.savedSampleId
          ? `<span class="section-saved">✓ Saved #${s.savedSampleId}</span>
             <button class="sent-btn section-update" type="button">✓ Update</button>
             <a class="sent-btn" href="praat.html?sampleId=${s.savedSampleId}" target="_blank" rel="noopener">🔬 Open as sample</a>`
          : `<button class="sent-btn primary section-save" type="button">💾 Save</button>`}
        <button class="sent-btn section-remove" type="button">✕</button>
        <span class="section-card-status muted"></span>
      `;
    } else if (isDbToken) {
      card.style.borderLeft = vowel ? '3px solid #7eb8f7' : '';
      header = `
        <input type="text" class="section-symbol" placeholder="symbol" value="${escapeAttr(s.symbol)}" style="width:3.5em;font-family:Georgia,serif;font-size:1rem;">
        <select class="section-vowel"><option value="">— vowel —</option>${vowelsList.map(v =>
          `<option value="${v.id}"${s.vowelId === v.id ? ' selected' : ''}>/${escapeAttr(v.symbols?.[0] || '?')}/ ${escapeAttr(v.desc || '')}</option>`).join('')}</select>
        <span class="section-time">${sectionMs(s).join('–')} ms</span>
      `;
      body = `
        <div class="section-charsel" data-charsel="${s.id}"></div>
        <span class="section-values" style="display:block">
          <div>Current: <b>${currentLabelForToken(s)}</b>
            ${viewedAnalysisId != null && viewedAnalysisId !== s.activeAnalysisId ? '<button class="sent-btn section-use-analysis" type="button">Use this</button>' : ''}
          </div>
        </span>
        <label class="manual-f1f2">F1 <input type="number" class="section-manual-f1" value="${s.manualF1 ?? ''}" placeholder="auto" style="width:4.5em"></label>
        <label class="manual-f1f2">F2 <input type="number" class="section-manual-f2" value="${s.manualF2 ?? ''}" placeholder="auto" style="width:4.5em"></label>
        <button class="sent-btn section-play" type="button">▶</button>
        <button class="sent-btn primary section-save-token" type="button">💾 Save token</button>
        <button class="sent-btn section-remove" type="button">✕</button>
        <span class="section-dirty-badge" style="display:${s.dirty ? 'inline' : 'none'};color:#fbbf24;font-size:.68rem">● unsaved</span>
        <span class="section-card-status muted"></span>
      `;
    } else {
      header = `<span class="section-idx">/${escapeAttr(s.symbol)}/</span><span class="section-time">${sectionMs(s).join('–')} ms</span>`;
      body = `
        <span class="section-values">—</span>
        <button class="sent-btn section-play" type="button">▶</button>
        <button class="sent-btn primary section-apply" type="button">✓ Apply</button>
      `;
    }

    card.innerHTML = `
      <div class="section-header">${header}</div>
      <div class="section-mini-wrap">
        <canvas class="section-mini"></canvas>
        <div class="section-mini-label"></div>
      </div>
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
      card.querySelector('.section-save')?.addEventListener('click', () => saveSection(s));
      card.querySelector('.section-update')?.addEventListener('click', () => updateSavedSection(s));
    } else if (isDbToken) {
      const markDirty = () => { s.dirty = true; const b = card.querySelector('.section-dirty-badge'); if (b) b.style.display = 'inline'; };
      card.querySelector('.section-symbol').addEventListener('input', e => { s.symbol = e.target.value; markDirty(); });
      card.querySelector('.section-vowel').addEventListener('change', e => {
        s.vowelId = e.target.value ? +e.target.value : null;
        if (s.vowelId && !s.symbol) { s.symbol = vowelsList.find(v => v.id === s.vowelId)?.symbols?.[0] || ''; renderSections(); }
        markDirty();
      });
      card.querySelector('.section-manual-f1').addEventListener('input', e => { s.manualF1 = e.target.value === '' ? null : +e.target.value; markDirty(); });
      card.querySelector('.section-manual-f2').addEventListener('input', e => { s.manualF2 = e.target.value === '' ? null : +e.target.value; markDirty(); });
      card.querySelector('.section-save-token').addEventListener('click', () => saveToken(s));
      card.querySelector('.section-remove').addEventListener('click', () => deleteToken(s));
      card.querySelector('.section-use-analysis')?.addEventListener('click', () => useViewedAnalysisForToken(s));
      buildTokCharSel(card.querySelector('.section-charsel'), s);
    } else {
      card.querySelector('.section-apply').addEventListener('click', () => applySection(s));
    }
    card.querySelector('.section-play').addEventListener('click', () => playRange(s.start, s.end));

    wireMiniDrag(card.querySelector('.section-mini'), s);
  });
  refreshSectionVisuals();
}

// ─── Char-range drag-select (DB tokens only) — restores the pre-Phase-5d
// editor-samples.js UI: render the sample text as one span per character,
// drag the nearer edge of the current [charStart,charEnd) range. Pure DOM
// geometry (span midpoint vs. cursor x) — no Range/Selection API needed. ───
let _charDrag = null;
function hitTestChar(container, clientX) {
  const spans = [...container.querySelectorAll('.tc[data-i]')];
  for (const sp of spans) {
    const rect = sp.getBoundingClientRect();
    if (clientX < rect.left + rect.width / 2) return +sp.dataset.i;
  }
  return (dbSampleData?.text || '').length;
}
function updateTokCharSel(container, s) {
  const c = vowelsList.find(v => v.id === s.vowelId) ? '#7eb8f7' : '#8fa8c0';
  container.querySelectorAll('.tc[data-i]').forEach(sp => {
    const ci = +sp.dataset.i;
    const inSel = ci >= s.charStart && ci < s.charEnd;
    sp.style.background = inSel ? c + '33' : '';
    sp.style.color = inSel ? c : '';
    sp.style.borderLeft = ci === s.charStart ? `2px solid ${c}` : '';
    sp.style.borderRight = ci === s.charEnd - 1 ? `2px solid ${c}` : '';
  });
}
function buildTokCharSel(container, s) {
  if (!container) return;
  container.style.cssText = 'font-family:Georgia,"Noto Serif",serif;font-size:.88rem;padding:4px 6px;line-height:1.6;cursor:col-resize;user-select:none;background:#0d1a28;border:1px solid #1e3048;border-radius:5px;margin-bottom:4px;overflow-x:auto;white-space:nowrap';
  container.innerHTML = '';
  const text = dbSampleData?.text || '';
  if (!text) { container.innerHTML = '<span style="font-size:.65rem;color:#3a5878">(sample has no text — char range unavailable)</span>'; return; }
  [...text].forEach((ch, ci) => {
    const sp = document.createElement('span');
    sp.className = 'tc'; sp.dataset.i = ci;
    sp.style.cssText = 'padding:0 1px;border-radius:2px;white-space:pre;display:inline-block;transition:background .08s,color .08s';
    sp.textContent = ch === ' ' ? ' ' : ch;
    container.appendChild(sp);
  });
  const end = document.createElement('span');
  end.className = 'tc'; end.dataset.i = text.length;
  end.style.cssText = 'display:inline-block;min-width:6px';
  end.textContent = '​';
  container.appendChild(end);
  updateTokCharSel(container, s);

  container.addEventListener('mousedown', e => {
    const ci = hitTestChar(container, e.clientX);
    const distS = Math.abs(ci - s.charStart), distE = Math.abs(ci - s.charEnd);
    _charDrag = { s, which: distS <= distE ? 'start' : 'end', container };
    e.preventDefault();
  });
}
if (!document._praatCharDragBound) {
  document._praatCharDragBound = true;
  document.addEventListener('mousemove', e => {
    if (!_charDrag) return;
    const { s, which, container } = _charDrag;
    const ci = hitTestChar(container, e.clientX);
    if (which === 'start') s.charStart = Math.min(ci, Math.max(0, s.charEnd - 1));
    else s.charEnd = Math.max(ci, s.charStart + 1);
    s.dirty = true;
    const badge = document.querySelector(`.section-card[data-id="${s.id}"] .section-dirty-badge`);
    if (badge) badge.style.display = 'inline';
    updateTokCharSel(container, s);
  });
  document.addEventListener('mouseup', () => { _charDrag = null; });
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
    const isDbToken = s.mode === 'token' && s.dbTokenId !== undefined;
    const miniLabel = card.querySelector('.section-mini-label');
    if (s.mode === 'ingest') {
      if (miniLabel) miniLabel.innerHTML = ingestSectionMeansLabel(s);
    } else if (s.mode === 'token' && !isDbToken) {
      const after = computeMeansForRange(s.start, s.end);
      const valuesEl = card.querySelector('.section-values');
      const before = s.before ? `F1 ${Math.round(s.before.f1)} · F2 ${Math.round(s.before.f2)}` : '—';
      if (valuesEl) valuesEl.innerHTML = `Before: <b>${before}</b>`;
      const afterTxt = after?.nFormantFrames ? `F1 ${Math.round(after.f1)} · F2 ${Math.round(after.f2)}${after.f0 != null ? ` · F0 ${Math.round(after.f0)}` : ''} Hz` : 'no voiced frames';
      if (miniLabel) miniLabel.innerHTML = afterTxt;
    } else if (isDbToken) {
      const valuesEl = card.querySelector('.section-values');
      if (valuesEl) {
        const useBtn = viewedAnalysisId != null && viewedAnalysisId !== s.activeAnalysisId
          ? '<button class="sent-btn section-use-analysis" type="button">Use this</button>' : '';
        valuesEl.innerHTML = `<div>Current: <b>${currentLabelForToken(s)}</b> ${useBtn}</div>`;
        valuesEl.querySelector('.section-use-analysis')?.addEventListener('click', () => useViewedAnalysisForToken(s));
      }
      if (miniLabel) miniLabel.innerHTML = `Previewing: ${previewLabelForToken(s)}`;
      const badge = card.querySelector('.section-dirty-badge');
      if (badge) badge.style.display = s.dirty ? 'inline' : 'none';
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
  if (playbackCursorFrac != null) SpectroLib.drawPlaybackCursor(ctx, W, H, winStart, winEnd, playbackCursorFrac);
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
    if (s.mode === 'token' && s.dbTokenId !== undefined) s.dirty = true;
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
    const done = s.mode === 'ingest' ? !!s.savedSampleId : (s.dbTokenId !== undefined ? !!s.dbTokenId : !!s.before);
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
      else { dragging = true; selStart = f; selEnd = f; }
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
      if (s.mode === 'token' && s.dbTokenId !== undefined) s.dirty = true;
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

// ─── Spectrogram rendering — thin wrappers over js/spectro.js's shared
// implementation (also used by js/practice.js) — shared by the main view
// (winStart=0, winEnd=1) and each section's mini view (its own padded window).
function drawSpectrogramCrop(cv, W, H, winStart, winEnd) {
  SpectroLib.drawSpectrogramCrop(cv, W, H, winStart, winEnd, analysisResult);
}
function freqAxisMax() {
  return SpectroLib.freqAxisMax(analysisResult);
}
function drawFormantPitchOverlay(ctx, W, H, winStart, winEnd) {
  if (!analysisResult || !currentBuffer) return;
  const pitchFloor = +(document.getElementById('pPitchFloor')?.value) || 75;
  const pitchCeil  = +(document.getElementById('pPitchCeiling')?.value) || 600;
  SpectroLib.drawFormantPitchOverlay(ctx, W, H, winStart, winEnd, analysisResult, currentBuffer.duration * 1000, pitchFloor, pitchCeil);
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
  if (playbackCursorFrac != null) SpectroLib.drawPlaybackCursor(ctx, W, H, 0, 1, playbackCursorFrac);
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
async function runAnalyze() {
  if (!currentBuffer) return;
  const btn = document.getElementById('analyzeBtn');
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  // Ingest mode has no params row (no manual re-analyze there), so there's
  // nothing to read from inputs — {} runs with Praat's own defaults, same as
  // every other mode's default values.
  const config = ingestMode ? {} : {
    max_number_of_formants: +(document.getElementById('pMaxFormants')?.value) || 5,
    maximum_formant: +(document.getElementById('pMaxFreq')?.value) || 5500,
    window_length: +(document.getElementById('pWindowLen')?.value) || 0.025,
    pre_emphasis_from: +(document.getElementById('pPreEmph')?.value) || 50,
    pitch_floor: +(document.getElementById('pPitchFloor')?.value) || 75,
    pitch_ceiling: +(document.getElementById('pPitchCeiling')?.value) || 600,
  };
  setStatus('Analyzing (Praat defaults)…');
  try {
    analysisResult = await SpectroLib.runPraatAnalysis(currentBuffer, config);
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
function stopPlayback() {
  if (activeSource) { try { activeSource.stop(); } catch (e) {} activeSource = null; }
  playbackCursorFrac = null;
}
function redrawCursorViews() {
  drawSpectrogramOverlay();
  refreshSectionVisuals();
}
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
  SpectroLib.animatePlaybackCursor({
    startFrac: fracStart, endFrac: fracEnd, durationSec: dur,
    onFrame: f => { playbackCursorFrac = f; redrawCursorViews(); },
    onDone: () => { playbackCursorFrac = null; redrawCursorViews(); },
    isStopped: () => activeSource !== src,
  });
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
  document.getElementById('existingSamplePicker').style.display = ingestMode ? '' : 'none';
  document.getElementById('micRecordPicker').style.display = ingestMode ? '' : 'none';
  document.getElementById('youtubePicker').style.display = ingestMode ? '' : 'none';
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

// ─── Ingest landing: record straight from the microphone ───────────────────────
let ingestMicStream = null, ingestMicRecorder = null;
async function toggleIngestMicRecord() {
  const btn = document.getElementById('micRecordBtn');
  const dot = document.getElementById('micRecordDot');
  if (ingestMicRecorder) { ingestMicRecorder.stop(); return; }
  try {
    if (!ingestMicStream) ingestMicStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const chunks = [];
    const mime = pickRecorderMime();
    const rec = new MediaRecorder(ingestMicStream, mime ? { mimeType: mime } : undefined);
    rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = async () => {
      ingestMicRecorder = null;
      btn.textContent = '🎤 Record';
      btn.classList.remove('rec-active');
      dot.classList.remove('on');
      const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
      setStatus('Decoding recording…');
      try {
        const buf = await decodeArrayBuffer(await blob.arrayBuffer());
        await loadBuffer(buf);
        setStatus('');
      } catch (e) {
        setStatus('Could not decode recording: ' + e.message);
      }
    };
    rec.start();
    ingestMicRecorder = rec;
    btn.textContent = '■ Stop';
    btn.classList.add('rec-active');
    dot.classList.add('on');
    setStatus('Recording…');
  } catch (e) {
    setStatus('Mic error: ' + e.message);
  }
}

// ─── Ingest landing: extract audio from a pasted YouTube URL ───────────────────
async function extractYoutubeAudio() {
  const input = document.getElementById('ytUrlInput');
  const btn = document.getElementById('ytExtractBtn');
  const url = input.value.trim();
  if (!url) return;
  btn.disabled = true;
  setStatus('Extracting audio from YouTube… this can take a while for longer videos.');
  try {
    const resp = await fetch('/api/v1/youtube-extract', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(600000),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || ('HTTP ' + resp.status));
    }
    setStatus('Decoding…');
    const buf = await decodeArrayBuffer(await resp.arrayBuffer());
    await loadBuffer(buf);
    setStatus('');
  } catch (e) {
    setStatus('YouTube extraction failed: ' + e.message);
  }
  btn.disabled = false;
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

  if (ingestMode) {
    loadLanguagesList();
    document.getElementById('existingSamplePicker').style.display = '';
    document.getElementById('espFilter').addEventListener('input', renderExistingSamplesList);
    loadExistingSamplePicker();
    document.getElementById('micRecordPicker').style.display = '';
    document.getElementById('micRecordBtn').addEventListener('click', () => toggleIngestMicRecord());
    document.getElementById('youtubePicker').style.display = '';
    document.getElementById('ytExtractBtn').addEventListener('click', () => extractYoutubeAudio());
  }

  document.getElementById('analyzeBtn').addEventListener('click', () => runAnalyze());
  document.getElementById('playSelectionBtn').addEventListener('click', () => playRange(selEnd > selStart ? selStart : 0, selEnd > selStart ? selEnd : 1));
  document.getElementById('playAllBtn').addEventListener('click', () => playRange(0, 1));
  document.getElementById('trimBtn').addEventListener('click', () => {
    if (!currentBuffer || selEnd <= selStart) { setStatus('Drag a selection on the spectrogram first (empty space, not on a section).'); return; }
    const durationMs = currentBuffer.duration * 1000;
    const t0 = Math.round(selStart * durationMs), t1 = Math.round(selEnd * durationMs);
    document.getElementById('trimConfirmText').textContent =
      `Trim to keep ${t0}–${t1} ms (discarding the rest)? This overwrites the audio file — every token's time range shifts to match.`;
    document.getElementById('trimConfirmRow').style.display = 'flex';
  });
  document.getElementById('trimCancelBtn').addEventListener('click', () => {
    document.getElementById('trimConfirmRow').style.display = 'none';
  });
  document.getElementById('trimConfirmBtn').addEventListener('click', () => trimAudioToSelection());
  document.getElementById('newSectionBtn')?.addEventListener('click', commitSectionFromSelection);
  document.getElementById('newFileBtn')?.addEventListener('click', resetToDropzone);
  document.getElementById('analysisHistorySelect')?.addEventListener('change', onAnalysisHistoryChange);
  document.getElementById('saveAnalysisBtn')?.addEventListener('click', saveCurrentAnalysis);

  wireMainDrag(document.getElementById('spectrogramCanvas').parentElement);

  window.addEventListener('resize', () => { if (currentBuffer) { drawSpectrogramBase(); drawSpectrogramOverlay(); refreshSectionVisuals(); } });

  if (legacyCtx?.audioUrl) handleUrl(legacyCtx.audioUrl);
  if (sampleMode) {
    setStatus('Loading sample…');
    fetchDbSample()
      .then(() => handleUrl(dbSampleData.audioUrl))
      .catch(e => setStatus('Could not load sample: ' + e.message));
  }
  if (ingestFromOpener && window.opener) {
    window.addEventListener('message', e => {
      if (e.origin !== location.origin || e.data?.type !== 'load-audio-blob') return;
      setStatus('Decoding…');
      decodeArrayBuffer(e.data.buffer).then(buf => loadBuffer(buf)).then(() => setStatus(''))
        .catch(err => setStatus('Could not decode: ' + err.message));
    });
    window.opener.postMessage({ type: 'praat-ready-for-blob' }, location.origin);
    setStatus('Waiting for the audio chunk from the opener tab…');
  }
});
