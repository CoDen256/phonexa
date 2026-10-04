/**
 * tokens.js — Token Browser (tokens.html).
 *
 * Read-only, sortable view over GET /api/v1/tokens (formanter.py) — mirrors
 * js/sounds.js's pattern exactly. Each row opens its owning sample in
 * Formant Lab (praat.html?sampleId=...&scrollTo=<tokenId>) for editing.
 */

let allTokens = [];
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
  body.innerHTML = sortedTokens(tokens).map(t => `<tr>
    <td class="tokens-id">${t.id}</td>
    <td class="tokens-symbol">/${escapeHtml(t.symbol || '?')}/</td>
    <td>${t.vowelId != null ? t.vowelId : '<span class="tokens-missing">unassigned</span>'}</td>
    <td>${escapeHtml(t.sampleText || '—')}</td>
    <td>${escapeHtml(t.languageKey || '—')}</td>
    <td>${fmtRange(t)}</td>
    <td>${fmtDate(t.createdAt)}</td>
    <td>${fmtDate(t.updatedAt)}</td>
    <td>
      <a class="sent-btn" href="praat.html?sampleId=${t.sampleId}&scrollTo=${t.id}" target="_blank" rel="noopener">🔬 Formant Lab</a>
      <button class="sent-btn del-btn" type="button" data-id="${t.id}" title="Delete this token">🗑</button>
    </td>
  </tr>`).join('');
  document.getElementById('tokenCount').textContent = `${tokens.length} of ${allTokens.length} token(s)`;
  updateSortIndicators();
  body.querySelectorAll('.del-btn').forEach(btn => btn.addEventListener('click', () => deleteTokenRow(+btn.dataset.id)));
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
    const resp = await fetch('/api/v1/tokens');
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || ('HTTP ' + resp.status));
    }
    allTokens = await resp.json();
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
