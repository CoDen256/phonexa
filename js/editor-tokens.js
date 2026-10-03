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
 * tokens/samples to a vowel.
 */

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
}

function dbVowelIdFor(vowelIdx) {
  return state.dbVowelLinks?.[vowelIdx]?.id ?? null;
}

// ─── Render both sections for the currently-open vowel ─────────────────────
function renderVowelAssignmentUI(vowelIdx) {
  const tokensWrap = document.getElementById('veTokensWrap');
  const repWrap = document.getElementById('veRepresentativeWrap');
  if (!tokensWrap || !repWrap) return;

  const dbVowelId = dbVowelIdFor(vowelIdx);
  if (dbVowelId == null || state.dbLanguageTokens == null) {
    tokensWrap.textContent = 'Could not reach the database — try reselecting the language.';
    repWrap.textContent = '';
    return;
  }
  renderTokensSection(tokensWrap, dbVowelId, vowelIdx);
  renderRepresentativeSection(repWrap, vowelIdx);
}

// ─── Tokens: assigned list + unified searchable picker to assign more ──────
function renderTokensSection(wrap, dbVowelId, vowelIdx) {
  wrap.innerHTML = '';
  wrap.style.cssText = '';

  const assigned = state.dbLanguageTokens.filter(t => t.vowelId === dbVowelId);
  const list = document.createElement('div');
  list.style.cssText = 'display:flex;flex-direction:column;gap:3px;margin-bottom:6px';
  if (!assigned.length) {
    const hint = document.createElement('div');
    hint.style.cssText = 'font-size:.65rem;color:#3a5878';
    hint.textContent = 'No tokens assigned to this vowel yet.';
    list.appendChild(hint);
  } else {
    assigned.forEach(t => {
      const row = document.createElement('div');
      row.style.cssText = 'font-size:.72rem;color:#8fa8c0;display:flex;justify-content:space-between;align-items:center;padding:2px 4px;border-radius:4px;background:#0d1a28';
      const label = document.createElement('span');
      label.innerHTML = `<span style="font-family:Georgia,serif;color:#7eb8f7">/${t.symbol || '?'}/</span> ${t.sampleText || ''} <span style="color:#4a6888">(${t.timeStartMs ?? '?'}–${t.timeEndMs ?? '?'} ms)</span>`;
      const rm = document.createElement('button');
      rm.className = 'btn btn-secondary btn-sm'; rm.type = 'button'; rm.textContent = '✕';
      rm.addEventListener('click', async () => {
        await fetch(`/api/v1/tokens/${t.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ vowelId: null }) });
        t.vowelId = null;
        renderVowelAssignmentUI(vowelIdx);
      });
      row.appendChild(label); row.appendChild(rm);
      list.appendChild(row);
    });
  }
  wrap.appendChild(list);

  const filterInput = document.createElement('input');
  filterInput.type = 'text';
  filterInput.placeholder = 'Search this language\'s tokens by symbol or sample text…';
  filterInput.style.cssText = 'width:100%;box-sizing:border-box;background:#1a2e48;border:1px solid #2e4560;border-radius:5px;color:#d8e8f4;font-size:.72rem;padding:4px 7px;margin-bottom:4px';
  wrap.appendChild(filterInput);
  const pickList = document.createElement('div');
  pickList.style.cssText = 'display:flex;flex-direction:column;gap:2px;max-height:160px;overflow-y:auto';
  wrap.appendChild(pickList);

  const renderPickList = () => {
    const q = filterInput.value.trim().toLowerCase();
    pickList.innerHTML = '';
    state.dbLanguageTokens
      .filter(t => t.vowelId !== dbVowelId)
      .filter(t => !q || (t.symbol || '').toLowerCase().includes(q) || (t.sampleText || '').toLowerCase().includes(q))
      .slice(0, 30)
      .forEach(t => {
        const row = document.createElement('div');
        row.style.cssText = 'font-size:.7rem;color:#8fa8c0;cursor:pointer;padding:2px 4px;border-radius:4px';
        row.innerHTML = `<span style="font-family:Georgia,serif;color:#7eb8f7">/${t.symbol || '?'}/</span> ${t.sampleText || ''}` +
          (t.vowelId != null ? ' <span style="color:#4a6888;font-size:.62rem">(assigned elsewhere — reassign)</span>' : '');
        row.addEventListener('mouseenter', () => row.style.background = '#1a2e44');
        row.addEventListener('mouseleave', () => row.style.background = '');
        row.addEventListener('click', async () => {
          await fetch(`/api/v1/tokens/${t.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ vowelId: dbVowelId }) });
          t.vowelId = dbVowelId;
          renderVowelAssignmentUI(vowelIdx);
        });
        pickList.appendChild(row);
      });
  };
  filterInput.addEventListener('input', renderPickList);
  renderPickList();
}

// ─── Representative sample: current + searchable picker to change it ──────
function renderRepresentativeSection(wrap, vowelIdx) {
  wrap.innerHTML = '';
  wrap.style.cssText = '';
  const link = state.dbVowelLinks[vowelIdx];

  const current = document.createElement('div');
  current.style.cssText = 'font-size:.72rem;color:#8fa8c0;margin-bottom:6px;display:flex;align-items:center;gap:6px';
  if (link?.representativeSampleId) {
    const smp = (state.dbLanguageSamples || []).find(s => s.id === link.representativeSampleId);
    const label = document.createElement('span');
    label.textContent = smp ? (smp.text || '(untitled)') : `Sample #${link.representativeSampleId}`;
    current.appendChild(label);
    const playBtn = document.createElement('button');
    playBtn.className = 'btn btn-secondary btn-sm'; playBtn.type = 'button'; playBtn.textContent = '▶';
    playBtn.addEventListener('click', () => playUrl(link.representativeAudioUrl));
    current.appendChild(playBtn);
  } else {
    current.textContent = 'No representative sample set.';
  }
  wrap.appendChild(current);

  const filterInput = document.createElement('input');
  filterInput.type = 'text';
  filterInput.placeholder = 'Search this language\'s samples by text…';
  filterInput.style.cssText = 'width:100%;box-sizing:border-box;background:#1a2e48;border:1px solid #2e4560;border-radius:5px;color:#d8e8f4;font-size:.72rem;padding:4px 7px;margin-bottom:4px';
  wrap.appendChild(filterInput);
  const pickList = document.createElement('div');
  pickList.style.cssText = 'display:flex;flex-direction:column;gap:2px;max-height:160px;overflow-y:auto';
  wrap.appendChild(pickList);

  const renderPickList = () => {
    const q = filterInput.value.trim().toLowerCase();
    pickList.innerHTML = '';
    (state.dbLanguageSamples || [])
      .filter(s => !q || (s.text || '').toLowerCase().includes(q))
      .slice(0, 30)
      .forEach(s => {
        const row = document.createElement('div');
        row.style.cssText = 'font-size:.7rem;color:#8fa8c0;cursor:pointer;padding:2px 4px;border-radius:4px;display:flex;justify-content:space-between';
        row.textContent = s.text || '(untitled)';
        row.addEventListener('mouseenter', () => row.style.background = '#1a2e44');
        row.addEventListener('mouseleave', () => row.style.background = '');
        row.addEventListener('click', async () => {
          const dbVowelId = dbVowelIdFor(vowelIdx);
          const resp = await fetch(`/api/v1/vowels/${dbVowelId}`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ representativeSampleId: s.id }),
          });
          if (resp.ok) state.dbVowelLinks[vowelIdx] = await resp.json();
          renderVowelAssignmentUI(vowelIdx);
        });
        pickList.appendChild(row);
      });
  };
  filterInput.addEventListener('input', renderPickList);
  renderPickList();
}
