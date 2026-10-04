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

// ─── Per-language DB cache (tokens/samples) — fetched once per language
// select. Vowels themselves no longer need a separate sync step: each vowel
// object in state.langDraft.vowels already IS its own DB row (fetched
// straight from GET /api/v1/vowels?languageId=, carrying its own `id`). ────
async function ensureDbLanguageData() {
  if (!state.langDraft?.id) return;
  const langId = state.langDraft.id;

  state.dbLanguageTokens = await fetch(`/api/v1/tokens?languageId=${langId}`)
    .then(r => r.ok ? r.json() : []).catch(() => []);
  state.dbLanguageSamples = await fetch('/api/v1/sounds')
    .then(r => r.ok ? r.json() : []).catch(() => [])
    .then(all => all.filter(s => s.languageId === langId));

  if (state.vowelIdx != null && state.vowelIdx >= 0) renderVowelAssignmentUI(state.vowelIdx);
  if (typeof renderVowelCards === 'function') renderVowelCards();
}

function dbVowelIdFor(vowelIdx) {
  return state.langDraft?.vowels?.[vowelIdx]?.id ?? null;
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

function iconBtn(icon, title) {
  const b = document.createElement('button');
  b.type = 'button'; b.title = title;
  b.style.cssText = 'padding:1px 5px;font-size:.78rem;line-height:1.4;border-radius:4px;border:1px solid #2e4560;background:#1a2e48;color:#d8e8f4;cursor:pointer;flex-shrink:0';
  b.textContent = icon;
  return b;
}

/** Which OTHER vowel (if any) this token is currently assigned to, for the "used elsewhere" hint. */
function vowelSymbolFor(vowelId) {
  const v = (state.langDraft?.vowels || []).find(v => v.id === vowelId);
  return v?.symbols?.[0] || null;
}

function renderTokensSection(wrap, dbVowelId, vowelIdx) {
  // Only the first render needs the full skeleton (filter input etc.) — the
  // list itself is torn down/rebuilt on every star/assign click, which used
  // to reset its scrollbar to the top every time; preserve it across rebuilds.
  const prevList = wrap.querySelector('.ve-tok-list');
  const savedScrollTop = prevList ? prevList.scrollTop : 0;

  wrap.innerHTML = '';
  wrap.style.cssText = '';
  const link = state.langDraft.vowels[vowelIdx];

  const current = document.createElement('div');
  current.style.cssText = 'font-size:.72rem;color:#8fa8c0;margin-bottom:6px;display:flex;align-items:center;gap:6px';
  if (link?.representativeSampleId) {
    const smp = (state.dbLanguageSamples || []).find(s => s.id === link.representativeSampleId);
    current.innerHTML = `★ Representative: <b style="color:#d8e8f4">${escapeHtmlEt(smp ? (smp.text || '(untitled)') : '#' + link.representativeSampleId)}</b>`;
    if (link.representativeAudioUrl) {
      const playBtn = iconBtn('▶', 'Play representative sample');
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
  list.className = 've-tok-list';
  list.style.cssText = 'display:flex;flex-direction:column;gap:3px;max-height:260px;overflow-y:auto';
  wrap.appendChild(list);

  const renderList = () => {
    const q = filterInput.value.trim().toLowerCase();
    list.innerHTML = '';
    state.dbLanguageTokens
      .filter(t => !q || (t.symbol || '').toLowerCase().includes(q) || (t.sampleText || '').toLowerCase().includes(q))
      // Assigned-to-this-vowel first, then unassigned, then assigned elsewhere.
      .slice().sort((a, b) => {
        const rank = t => t.vowelId === dbVowelId ? 0 : (t.vowelId == null ? 1 : 2);
        return rank(a) - rank(b);
      })
      .slice(0, 50)
      .forEach(t => {
        const assigned = t.vowelId === dbVowelId;
        const assignedElsewhere = t.vowelId != null && !assigned;
        const isRepresentative = link?.representativeSampleId === t.sampleId;
        const row = document.createElement('div');
        row.style.cssText = `font-size:.72rem;color:#8fa8c0;display:flex;align-items:center;gap:4px;padding:3px 5px;border-radius:5px;${assigned ? 'background:#16321f;border:1px solid #2a5a3a' : 'background:#0d1a28'}`;

        const label = document.createElement('span');
        label.style.cssText = 'flex:1;min-width:0;font-family:Georgia,serif;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
        label.title = 'Open in Formant Lab';
        label.innerHTML = `<span style="color:#7eb8f7">/${escapeHtmlEt(t.symbol || '?')}/</span> ${highlightedSampleText(t)}`
          + (assignedElsewhere ? ` <span style="color:#6a8298;font-style:italic">— used by /${escapeHtmlEt(vowelSymbolFor(t.vowelId) || '?')}/</span>` : '');
        label.addEventListener('click', () => window.open(`praat.html?sampleId=${t.sampleId}&scrollTo=${t.id}`, '_blank'));
        row.appendChild(label);

        const playTokBtn = iconBtn('◉', 'Play token slice');
        playTokBtn.addEventListener('click', () => playTokenSliceRange(t));
        row.appendChild(playTokBtn);

        const playSmpBtn = iconBtn('▶', 'Play full sample');
        playSmpBtn.addEventListener('click', () => playSample(t));
        row.appendChild(playSmpBtn);

        const starBtn = iconBtn(isRepresentative ? '★' : '☆', isRepresentative ? 'This sample is the representative' : 'Set this token\'s sample as the representative');
        starBtn.style.color = isRepresentative ? '#ffd166' : '';
        starBtn.addEventListener('click', async () => {
          const resp = await fetch(`/api/v1/vowels/${dbVowelId}`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ representativeSampleId: t.sampleId }),
          });
          if (resp.ok) Object.assign(state.langDraft.vowels[vowelIdx], await resp.json());
          renderTokensSection(wrap, dbVowelId, vowelIdx);
          statusLine(wrap, `★ Representative set to "${t.sampleText || '(untitled)'}"`);
        });
        row.appendChild(starBtn);

        const assignBtn = iconBtn(assigned ? '✕' : '+', assigned ? 'Unassign from this vowel' : (assignedElsewhere ? `Reassign from /${vowelSymbolFor(t.vowelId)}/ to this vowel` : 'Assign to this vowel'));
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
  // Restore scroll position only for THIS render pass (e.g. after a star/
  // assign click re-invokes renderTokensSection) — not on every filter
  // keystroke, where resetting to the top of the new result set is correct.
  list.scrollTop = savedScrollTop;
}
