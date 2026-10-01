/**
 * sounds.js — Sound Library browser (sounds.html).
 *
 * Read-only view over GET /api/v1/sounds (formanter.py) — lets you actually
 * listen to what scripts/migrate_legacy_to_db.py loaded instead of just
 * reading storage_key strings off a table. Expect this to be superseded by
 * a real ingestion/library UI in a later phase.
 */

let allSounds = [];

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtDuration(ms) {
  if (ms == null) return '—';
  const s = ms / 1000;
  return s >= 60 ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}` : `${s.toFixed(2)}s`;
}

function renderRows(sounds) {
  const body = document.getElementById('soundsBody');
  body.innerHTML = sounds.map(s => {
    const player = s.audioUrl
      ? `<audio controls preload="none" src="${escapeHtml(s.audioUrl)}"></audio>`
      : '<span class="sounds-missing">no audio location</span>';
    const missing = s.storageKey && !s.hasFile ? '<div class="sounds-missing">⚠ file not found in storage</div>' : '';
    const location = s.storageKey
      ? `<span class="sounds-key">${escapeHtml(s.storageKey)}</span>`
      : `<a href="${escapeHtml(s.sourceUrl)}" target="_blank" rel="noopener" class="sounds-key">${escapeHtml(s.sourceUrl)}</a>`;
    return `<tr>
      <td class="sounds-id">${s.id}</td>
      <td>${player}${missing}</td>
      <td>${location}</td>
      <td><span class="sounds-prov">${escapeHtml(s.provenance)}</span></td>
      <td>${fmtDuration(s.durationMs)}</td>
    </tr>`;
  }).join('');
  document.getElementById('soundCount').textContent = `${sounds.length} of ${allSounds.length} sound(s)`;
}

function applyFilter() {
  const q = document.getElementById('filterInput').value.trim().toLowerCase();
  if (!q) { renderRows(allSounds); return; }
  renderRows(allSounds.filter(s =>
    (s.storageKey || '').toLowerCase().includes(q) ||
    (s.sourceUrl || '').toLowerCase().includes(q) ||
    (s.originalFilename || '').toLowerCase().includes(q) ||
    (s.provenance || '').toLowerCase().includes(q)
  ));
}

async function load() {
  try {
    const resp = await fetch('/api/v1/sounds');
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || ('HTTP ' + resp.status));
    }
    allSounds = await resp.json();
    renderRows(allSounds);
  } catch (e) {
    document.getElementById('soundCount').textContent = 'Failed to load: ' + e.message;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('filterInput').addEventListener('input', applyFilter);
  load();
});
