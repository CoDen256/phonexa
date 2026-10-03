/**
 * editor-tokens.js — Phase 5d: vowel<->token and vowel<->representative-sample
 * assignment, replacing the old symbol-text-matching "linked samples" UI
 * (editor-vowels.js/editor-form.js used to independently filter
 * `samplesDraft` by `token.symbol ∈ vowel.symbols` — exactly the kind of
 * implicit, ambiguity-prone association the DB's explicit FKs replace).
 *
 * Token/sample authoring itself (text, time ranges, analysis) no longer
 * happens in this editor at all — see Formant Lab (js/praat.js, ?sampleId=
 * mode) and the Sound/Token browsers. This file only assigns EXISTING
 * tokens/samples to a vowel — one unified list: assign/unassign a token,
 * and mark any token's own sample as the vowel's representative, from the
 * same row (no separate representative-sample search list).
 */

function escapeHtmlEt(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ─── Per-language DB cache — fetched once per language select, re-synced
// whenever a vowel is added/applied (see editor-form.js's applyVowel) ─────────
async function ensureDbLanguageData() {
  if (!state.langDraft) return;
  const vowels = state.langDraft.vowels || [];

  try {
    const resp = await fetch(`/api/v1/languages/${state.langDraft.key}/vowels/sync`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(vowels),
    });
    state.dbVowelLinks = resp.ok ? await resp.json() : null;
  } catch (e) { state.dbVowelLinks = null; }

  let dbLang = null;
  try {
    const langs = await fetch('/api/v1/languages').then(r => r.ok ? r.json() : []);
    dbLang = langs.find(l => l.key === state.langDraft.key) || null;
  } catch (e) { /* ignore */ }

  if (!dbLang) { state.dbLanguageTokens = []; state.dbLanguageSamples = []; return; }

  state.dbLanguageTokens = await fetch(`/api/v1/tokens?languageId=${dbLang.id}`)
    .then(r => r.ok ? r.json() : []).catch(() => []);
  state.dbLanguageSamples = await fetch('/api/v1/sounds')
    .then(r => r.ok ? r.json() : []).catch(() => [])
    .then(all => all.filter(s => s.languageId === dbLang.id));

  if (state.vowelIdx != null && state.vowelIdx >= 0) renderVowelAssignmentUI(state.vowelIdx);
  if (typeof renderVowelCards === 'function') renderVowelCards();
}

function dbVowelIdFor(vowelIdx) {
  return state.dbVowelLinks?.[vowelIdx]?.id ?? null;
}

// ─── Render the merged Tokens list for the currently-open vowel ────────────
function renderVowelAssignmentUI(vowelIdx) {
  const wrap = document.getElementById('veTokensWrap');
  if (!wrap) return;

  const dbVowelId = dbVowelIdFor(vowelIdx);
  if (dbVowelId == null || state.dbLanguageTokens == null) {
    wrap.textContent = 'Could not reach the database — try reselecting the language.';
    return;
  }
  renderTokensSection(wrap, dbVowelId, vowelIdx);
}

function sampleFor(t) {
  return (state.dbLanguageSamples || []).find(s => s.id === t.sampleId);
}

function highlightedSampleText(t) {
  const text = t.sampleText || '';
  if (t.charStart == null || t.charEnd == null || t.charStart >= t.charEnd) return escapeHtmlEt(text) || '(untitled)';
  const pre = text.slice(0, t.charStart), mid = text.slice(t.charStart, t.charEnd), post = text.slice(t.charEnd);
  return `${escapeHtmlEt(pre)}<b style="color:#7eb8f7;background:#7eb8f733;border-radius:2px;padding:0 1px">${escapeHtmlEt(mid)}</b>${escapeHtmlEt(post)}`;
}

function playSample(t) {
  const smp = sampleFor(t);
  if (smp?.audioUrl) new Audio(smp.audioUrl).play().catch(() => {});
}

async function playTokenSliceRange(t) {
  const smp = sampleFor(t);
  if (!smp?.audioUrl || t.timeStartMs == null || t.timeEndMs == null) { playSample(t); return; }
  try {
    const wav = await fetchDecodeAudio(smp.audioUrl);
    const i0 = Math.floor(t.timeStartMs / 1000 * wav.sampleRate);
    const i1 = Math.ceil(t.timeEndMs / 1000 * wav.sampleRate);
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const buf = ctx.createBuffer(1, Math.max(1, i1 - i0), wav.sampleRate);
    buf.getChannelData(0).set(wav.samples.slice(i0, i1));
    const src = ctx.createBufferSource();
    src.buffer = buf; src.connect(ctx.destination); src.start();
    src.onended = () => ctx.close();
  } catch (e) { playSample(t); }
}

function statusLine(wrap, text) {
  const el = wrap.querySelector('.ve-tok-status');
  if (el) { el.textContent = text; setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, 3000); }
}

function renderTokensSection(wrap, dbVowelId, vowelIdx) {
  wrap.innerHTML = '';
  wrap.style.cssText = '';
  const link = state.dbVowelLinks[vowelIdx];

  const current = document.createElement('div');
  current.style.cssText = 'font-size:.72rem;color:#8fa8c0;margin-bottom:6px;display:flex;align-items:center;gap:6px';
  if (link?.representativeSampleId) {
    const smp = (state.dbLanguageSamples || []).find(s => s.id === link.representativeSampleId);
    current.innerHTML = `★ Representative: <b style="color:#d8e8f4">${escapeHtmlEt(smp ? (smp.text || '(untitled)') : '#' + link.representativeSampleId)}</b>`;
    if (link.representativeAudioUrl) {
      const playBtn = document.createElement('button');
      playBtn.className = 'btn btn-secondary btn-sm'; playBtn.type = 'button'; playBtn.textContent = '▶';
      playBtn.addEventListener('click', () => playUrl(link.representativeAudioUrl));
      current.appendChild(playBtn);
    }
  } else {
    current.textContent = 'No representative sample set yet — click ★ on a token below.';
  }
  wrap.appendChild(current);

  const filterInput = document.createElement('input');
  filterInput.type = 'text';
  filterInput.placeholder = 'Search this language\'s tokens by symbol or sample text…';
  filterInput.style.cssText = 'width:100%;box-sizing:border-box;background:#1a2e48;border:1px solid #2e4560;border-radius:5px;color:#d8e8f4;font-size:.72rem;padding:4px 7px;margin-bottom:4px';
  wrap.appendChild(filterInput);

  const status = document.createElement('span');
  status.className = 've-tok-status';
  status.style.cssText = 'font-size:.68rem;color:#4ade80;display:block;min-height:1.2em';
  wrap.appendChild(status);

  const list = document.createElement('div');
  list.style.cssText = 'display:flex;flex-direction:column;gap:3px;max-height:260px;overflow-y:auto';
  wrap.appendChild(list);

  const renderList = () => {
    const q = filterInput.value.trim().toLowerCase();
    list.innerHTML = '';
    state.dbLanguageTokens
      .filter(t => !q || (t.symbol || '').toLowerCase().includes(q) || (t.sampleText || '').toLowerCase().includes(q))
      .slice(0, 50)
      .forEach(t => {
        const assigned = t.vowelId === dbVowelId;
        const isRepresentative = link?.representativeSampleId === t.sampleId;
        const row = document.createElement('div');
        row.style.cssText = `font-size:.72rem;color:#8fa8c0;display:flex;align-items:center;gap:6px;padding:3px 5px;border-radius:5px;${assigned ? 'background:#16321f;border:1px solid #2a5a3a' : 'background:#0d1a28'}`;

        const label = document.createElement('span');
        label.style.cssText = 'flex:1;font-family:Georgia,serif';
        label.innerHTML = `<span style="color:#7eb8f7">/${escapeHtmlEt(t.symbol || '?')}/</span> ${highlightedSampleText(t)}`;
        row.appendChild(label);

        const playTokBtn = document.createElement('button');
        playTokBtn.className = 'btn btn-secondary btn-sm'; playTokBtn.type = 'button'; playTokBtn.title = 'Play token slice';
        playTokBtn.textContent = '▶ tok';
        playTokBtn.addEventListener('click', () => playTokenSliceRange(t));
        row.appendChild(playTokBtn);

        const playSmpBtn = document.createElement('button');
        playSmpBtn.className = 'btn btn-secondary btn-sm'; playSmpBtn.type = 'button'; playSmpBtn.title = 'Play full sample';
        playSmpBtn.textContent = '▶ smp';
        playSmpBtn.addEventListener('click', () => playSample(t));
        row.appendChild(playSmpBtn);

        const starBtn = document.createElement('button');
        starBtn.className = 'btn btn-secondary btn-sm'; starBtn.type = 'button';
        starBtn.title = isRepresentative ? 'This sample is the representative' : 'Set this token\'s sample as the representative';
        starBtn.textContent = isRepresentative ? '★' : '☆';
        starBtn.style.color = isRepresentative ? '#ffd166' : '';
        starBtn.addEventListener('click', async () => {
          const resp = await fetch(`/api/v1/vowels/${dbVowelId}`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ representativeSampleId: t.sampleId }),
          });
          if (resp.ok) state.dbVowelLinks[vowelIdx] = await resp.json();
          renderTokensSection(wrap, dbVowelId, vowelIdx);
          statusLine(wrap, `★ Representative set to "${t.sampleText || '(untitled)'}"`);
        });
        row.appendChild(starBtn);

        const assignBtn = document.createElement('button');
        assignBtn.className = 'btn btn-secondary btn-sm'; assignBtn.type = 'button';
        assignBtn.textContent = assigned ? '✕ Unassign' : '+ Assign';
        assignBtn.addEventListener('click', async () => {
          const newVowelId = assigned ? null : dbVowelId;
          await fetch(`/api/v1/tokens/${t.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ vowelId: newVowelId }) });
          t.vowelId = newVowelId;
          renderTokensSection(wrap, dbVowelId, vowelIdx);
          statusLine(wrap, assigned ? 'Unassigned' : 'Assigned ✓');
          if (typeof renderVowelCards === 'function') renderVowelCards();
        });
        row.appendChild(assignBtn);

        list.appendChild(row);
      });
  };
  filterInput.addEventListener('input', renderList);
  renderList();
}
