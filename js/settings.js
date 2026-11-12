// ─── Settings page ───────────────────────────────────────────────────────
// Per-profile config: transcription provider (smia STT, used by Shadowing) and a
// read-only Shadowing progress overview. Profile switching itself is
// js/user.js's shared picker, mounted in this page's header like everywhere
// else — switching profiles here just re-renders this page's two sections.

const DEFAULT_TRANSCRIBE_PROVIDER = 'hf_whisper';

// The stored value's shape is now {provider}. A pre-smia value ({backend, url,
// hfToken, hfModel}) has no provider → default; the rest is ignored and is
// dropped for good the next time the form is saved (save writes a fresh object).
async function loadTranscribeSettings() {
  const userId = await UserLib.getCurrentUserId();
  const res = await fetch(`${API_BASE}/api/v1/settings?userId=${userId}`);
  const all = res.ok ? await res.json() : {};
  const stored = all.transcribeBackend || {};
  return { provider: (typeof stored.provider === 'string' && stored.provider) || DEFAULT_TRANSCRIBE_PROVIDER };
}

// Providers come from smia (via phonexa's /transcribe/providers), so a new
// smia provider shows up here with no phonexa change. If smia can't be
// reached, still show the saved choice so the form stays usable.
async function renderTranscribeForm() {
  const cfg = await loadTranscribeSettings();
  const select = document.getElementById('providerSelect');
  const note = document.getElementById('providerNote');
  let providers = [];
  note.textContent = '';
  try {
    const r = await fetch(API_BASE + '/transcribe/providers', { signal: AbortSignal.timeout(6000) });
    const data = await r.json().catch(() => ({}));
    if (r.ok) providers = data.providers || [];
    else note.textContent = `⚠ ${data.error || 'HTTP ' + r.status}`;
  } catch (e) {
    note.textContent = '⚠ smia not reachable — showing your saved choice only';
  }
  if (!providers.includes(cfg.provider)) providers = [cfg.provider, ...providers];
  select.innerHTML = providers.map(p => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join('');
  select.value = cfg.provider;
}

async function saveTranscribeForm() {
  const value = { provider: document.getElementById('providerSelect').value || DEFAULT_TRANSCRIBE_PROVIDER };
  const userId = await UserLib.getCurrentUserId();
  const status = document.getElementById('transcribeSaveStatus');
  status.textContent = 'Saving…';
  try {
    const res = await fetch(`${API_BASE}/api/v1/settings/transcribeBackend?userId=${userId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    status.textContent = '✓ Saved';
    setTimeout(() => { status.textContent = ''; }, 2000);
  } catch (e) {
    status.textContent = 'Failed to save: ' + e.message;
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function secToClock(sec) {
  sec = Math.max(0, sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

async function renderShadowingProgress() {
  const el = document.getElementById('shadowingProgressList');
  const userId = await UserLib.getCurrentUserId();
  const media = await fetch(`${API_BASE}/api/v1/shadowing/media?userId=${userId}`).then(r => r.ok ? r.json() : []).catch(() => []);
  if (!media.length) { el.innerHTML = '<div class="cache-empty">No Shadowing uploads yet</div>'; return; }
  el.innerHTML = media.map(m => {
    const pct = m.sentenceCount ? Math.round(100 * m.doneCount / m.sentenceCount) : 0;
    const progressText = m.sentenceCount
      ? `${m.doneCount}/${m.sentenceCount} sentences done (${pct}%) · ${m.chapterCount} chapter${m.chapterCount === 1 ? '' : 's'}`
      : 'Not split yet';
    return `
      <div class="cache-item">
        <span class="cache-name">${escapeHtml(m.originalFilename || '(unnamed)')}</span>
        <span class="cache-n">${secToClock((m.durationMs || 0) / 1000)} · ${progressText}</span>
        <a class="sent-btn" href="shadow.html?mediaId=${m.id}">▶ Open in Shadowing</a>
      </div>`;
  }).join('');
}

document.addEventListener('DOMContentLoaded', async () => {
  await UserLib.mountPicker('userPicker');
  window.addEventListener('phonexa:user-changed', () => {
    renderTranscribeForm();
    renderShadowingProgress();
  });

  document.getElementById('saveTranscribeBtn').addEventListener('click', saveTranscribeForm);

  await renderTranscribeForm();
  await renderShadowingProgress();
});
