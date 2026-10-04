/**
 * tokens.js — Token Browser (tokens.html).
 *
 * Read-only, sortable view over GET /api/v1/tokens (formanter.py) — mirrors
 * js/sounds.js's pattern exactly. Each row opens its owning sample in
 * Formant Lab (praat.html?sampleId=...&scrollTo=<tokenId>) for editing.
 *
 * Sample column uses buildDetailHighlightedText (js/audio.js) — the same
 * token-highlighted-text card the language editor's vowel cards use: here,
 * scoped to just this row's own token (not every token in the sample).
 * Clicking the highlighted token plays its slice; clicking the rest of the
 * text plays the full sample.
 */

let allTokens = [];
let langsByKey = {};
let sortKey = 'id';
let sortDir = 1;

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtRange(t) {
  if (t.timeStartMs == null || t.timeEndMs == null) return '—';
  return `${t.timeStartMs}–${t.timeEndMs} ms`;
}

function fmtF1F2(f1, f2) {
  if (f1 == null || f2 == null) return '—';
  return `F1 ${Math.round(f1)} · F2 ${Math.round(f2)}`;
}
function fmtF1F2Vertical(f1, f2) {
  if (f1 == null || f2 == null) return '—';
  return `<div>F1 ${Math.round(f1)}</div><div>F2 ${Math.round(f2)}</div>`;
}

function sortedTokens(tokens) {
  const dir = sortDir;
  return [...tokens].sort((a, b) => {
    let av = a[sortKey], bv = b[sortKey];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === 'string') { av = av.toLowerCase(); bv = bv.toLowerCase(); }
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    return 0;
  });
}

function updateSortIndicators() {
  document.querySelectorAll('.tokens-table th[data-key]').forEach(th => {
    th.querySelector('.sort-arrow')?.remove();
    if (th.dataset.key === sortKey) {
      const arrow = document.createElement('span');
      arrow.className = 'sort-arrow';
      arrow.textContent = sortDir === 1 ? '▲' : '▼';
      th.appendChild(arrow);
    }
  });
}

function renderRows(tokens) {
  const body = document.getElementById('tokensBody');
  const visible = sortedTokens(tokens);
  body.innerHTML = visible.map(t => {
    const analysisOptions = (t.analyses || []).map(a =>
      `<option value="${a.id}"${a.id === t.activeAnalysisId ? ' selected' : ''}>#${a.id}${a.version ? ' ' + escapeHtml(a.version) : ''} — ${fmtF1F2(a.f1, a.f2)}</option>`
    ).join('');
    return `<tr>
    <td class="tokens-id">${t.id}</td>
    <td class="tokens-symbol">/${escapeHtml(t.symbol || '?')}/</td>
    <td>${t.vowelSymbol ? `/${escapeHtml(t.vowelSymbol)}/` : '<span class="tokens-missing">unassigned</span>'}</td>
    <td class="tokens-sample" data-id="${t.id}"></td>
    <td>${escapeHtml(t.languageKey || '—')}</td>
    <td>${fmtRange(t)}</td>
    <td class="tokens-f1f2">${fmtF1F2Vertical(t.f1, t.f2)}</td>
    <td class="tokens-f1f2">${fmtF1F2Vertical(t.manualF1, t.manualF2)}</td>
    <td>${(t.analyses || []).length
      ? `<select class="analysis-pick" data-id="${t.id}"><option value="">— none —</option>${analysisOptions}</select>`
      : '<span class="tokens-missing">no analyses</span>'}</td>
    <td>${fmtDate(t.createdAt)}</td>
    <td>${fmtDate(t.updatedAt)}</td>
    <td>
      <a class="sent-btn" href="praat.html?sampleId=${t.sampleId}&scrollTo=${t.id}" target="_blank" rel="noopener">🔬 Formant Lab</a>
      <button class="sent-btn del-btn" type="button" data-id="${t.id}" title="Delete this token">🗑</button>
    </td>
  </tr>`;
  }).join('');
  document.getElementById('tokenCount').textContent = `${tokens.length} of ${allTokens.length} token(s)`;
  updateSortIndicators();
  body.querySelectorAll('.del-btn').forEach(btn => btn.addEventListener('click', () => deleteTokenRow(+btn.dataset.id)));
  body.querySelectorAll('.analysis-pick').forEach(sel => sel.addEventListener('change', () => setActiveAnalysis(+sel.dataset.id, sel.value ? +sel.value : null)));
  body.querySelectorAll('.tokens-sample').forEach(td => {
    const t = allTokens.find(t => t.id === +td.dataset.id);
    if (!t) return;
    const color = langsByKey[t.languageKey]?.color || '#7eb8f7';
    const hasSlice = t.timeStartMs != null && t.timeEndMs != null;
    const pseudoSample = {
      text: t.sampleText, audio: t.audioUrl,
      tokens: [{ symbol: t.symbol, position: [t.charStart ?? 0, t.charEnd ?? 0], analysis: hasSlice ? { f1: t.f1, f2: t.f2, slice: [t.timeStartMs, t.timeEndMs] } : null }],
    };
    const play = () => { if (t.audioUrl) new Audio(t.audioUrl).play().catch(() => {}); };
    td.appendChild(buildDetailHighlightedText(pseudoSample, null, color, play));
  });
}

async function setActiveAnalysis(tokenId, analysisId) {
  try {
    const resp = await fetch(`/api/v1/tokens/${tokenId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ activeAnalysisId: analysisId }),
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const t = allTokens.find(t => t.id === tokenId);
    const picked = t.analyses.find(a => a.id === analysisId);
    t.activeAnalysisId = analysisId;
    t.f1 = picked?.f1 ?? null; t.f2 = picked?.f2 ?? null;
    applyFilter();
  } catch (e) {
    alert('Could not switch analysis: ' + e.message);
  }
}

async function deleteTokenRow(id) {
  const tok = allTokens.find(t => t.id === id);
  if (!confirm(`Delete token /${tok?.symbol || '?'}/ (#${id})? This cannot be undone.`)) return;
  try {
    const resp = await fetch(`/api/v1/tokens/${id}`, { method: 'DELETE' });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    allTokens = allTokens.filter(t => t.id !== id);
    applyFilter();
  } catch (e) {
    alert('Delete failed: ' + e.message);
  }
}

function applyFilter() {
  const q = document.getElementById('filterInput').value.trim().toLowerCase();
  if (!q) { renderRows(allTokens); return; }
  renderRows(allTokens.filter(t =>
    (t.symbol || '').toLowerCase().includes(q) ||
    (t.sampleText || '').toLowerCase().includes(q) ||
    (t.languageKey || '').toLowerCase().includes(q)
  ));
}

async function load() {
  try {
    const [tokResp, langs] = await Promise.all([
      fetch('/api/v1/tokens'),
      fetch('/api/v1/languages').then(r => r.ok ? r.json() : []).catch(() => []),
    ]);
    if (!tokResp.ok) {
      const err = await tokResp.json().catch(() => ({}));
      throw new Error(err.error || ('HTTP ' + tokResp.status));
    }
    langsByKey = Object.fromEntries(langs.map(l => [l.key, l]));
    allTokens = await tokResp.json();
    renderRows(allTokens);
  } catch (e) {
    document.getElementById('tokenCount').textContent = 'Failed to load: ' + e.message;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('filterInput').addEventListener('input', applyFilter);
  document.querySelectorAll('.tokens-table th[data-key]').forEach(th => {
    th.addEventListener('click', () => {
      if (sortKey === th.dataset.key) sortDir *= -1;
      else { sortKey = th.dataset.key; sortDir = 1; }
      applyFilter();
    });
  });
  load();
});
