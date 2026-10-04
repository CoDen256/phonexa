/**
 * sounds.js — Sound Library browser (sounds.html).
 *
 * Read-only view over GET /api/v1/sounds (formanter.py) — lets you actually
 * listen to what scripts/migrate_legacy_to_db.py loaded instead of just
 * reading storage_key strings off a table. Expect this to be superseded by
 * a real ingestion/library UI in a later phase.
 */

let allSounds = [];
let sortKey = 'id';
let sortDir = 1; // 1 = asc, -1 = desc

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtDuration(ms) {
  if (ms == null) return '—';
  const s = ms / 1000;
  return s >= 60 ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}` : `${s.toFixed(2)}s`;
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function sortedSounds(sounds) {
  const dir = sortDir;
  return [...sounds].sort((a, b) => {
    let av = a[sortKey], bv = b[sortKey];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;   // nulls last regardless of direction
    if (bv == null) return -1;
    if (typeof av === 'string') { av = av.toLowerCase(); bv = bv.toLowerCase(); }
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    return 0;
  });
}

function updateSortIndicators() {
  document.querySelectorAll('.sounds-table th[data-key]').forEach(th => {
    th.querySelector('.sort-arrow')?.remove();
    if (th.dataset.key === sortKey) {
      const arrow = document.createElement('span');
      arrow.className = 'sort-arrow';
      arrow.textContent = sortDir === 1 ? '▲' : '▼';
      th.appendChild(arrow);
    }
  });
}

function renderRows(sounds) {
  const body = document.getElementById('soundsBody');
  body.innerHTML = sortedSounds(sounds).map(s => {
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
      <td>${escapeHtml(s.text || '—')}</td>
      <td>${location}</td>
      <td>${fmtDuration(s.durationMs)}</td>
      <td>${fmtDate(s.createdAt)}</td>
      <td>${fmtDate(s.updatedAt)}</td>
      <td>
        <a class="sent-btn" href="praat.html?sampleId=${s.id}" target="_blank" rel="noopener">🔬 Formant Lab</a>
        <button class="sent-btn del-btn" type="button" data-id="${s.id}" title="Delete this sample and all its tokens">🗑</button>
      </td>
    </tr>`;
  }).join('');
  document.getElementById('soundCount').textContent = `${sounds.length} of ${allSounds.length} sound(s)`;
  updateSortIndicators();
  body.querySelectorAll('.del-btn').forEach(btn => btn.addEventListener('click', () => deleteSound(+btn.dataset.id)));
}

async function deleteSound(id) {
  const smp = allSounds.find(s => s.id === id);
  if (!confirm(`Delete sample #${id} ("${smp?.text || 'untitled'}")? This also deletes all its tokens and analysis history, and removes the audio file. This cannot be undone.`)) return;
  try {
    const resp = await fetch(`/api/v1/samples/${id}`, { method: 'DELETE' });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    allSounds = allSounds.filter(s => s.id !== id);
    applyFilter();
  } catch (e) {
    alert('Delete failed: ' + e.message);
  }
}

function applyFilter() {
  const q = document.getElementById('filterInput').value.trim().toLowerCase();
  if (!q) { renderRows(allSounds); return; }
  renderRows(allSounds.filter(s =>
    (s.storageKey || '').toLowerCase().includes(q) ||
    (s.sourceUrl || '').toLowerCase().includes(q) ||
    (s.originalFilename || '').toLowerCase().includes(q) ||
    (s.text || '').toLowerCase().includes(q)
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
  document.querySelectorAll('.sounds-table th[data-key]').forEach(th => {
    th.addEventListener('click', () => {
      if (sortKey === th.dataset.key) sortDir *= -1;
      else { sortKey = th.dataset.key; sortDir = 1; }
      applyFilter();
    });
  });
  load();
});
