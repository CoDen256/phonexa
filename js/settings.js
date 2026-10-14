// ─── Settings page ───────────────────────────────────────────────────────
// Per-profile config: transcription backend (used by Shadowing) and a
// read-only Shadowing progress overview. Profile switching itself is
// js/user.js's shared picker, mounted in this page's header like everywhere
// else — switching profiles here just re-renders this page's two sections.

async function loadTranscribeSettings() {
  const userId = await UserLib.getCurrentUserId();
  const res = await fetch(`/api/v1/settings?userId=${userId}`);
  const all = res.ok ? await res.json() : {};
  return Object.assign(
    { backend: 'local', url: 'http://localhost:5050', hfToken: '', hfModel: 'openai/whisper-large-v3' },
    all.transcribeBackend || {},
  );
}

function applyBackendVisibility() {
  const isHf = document.getElementById('backendSelect').value === 'hf';
  document.getElementById('localSettings').style.display = isHf ? 'none' : 'block';
  document.getElementById('hfSettings').style.display = isHf ? 'block' : 'none';
}

async function renderTranscribeForm() {
  const cfg = await loadTranscribeSettings();
  document.getElementById('backendSelect').value = cfg.backend;
  document.getElementById('urlInput').value = cfg.url;
  document.getElementById('hfTokenInput').value = cfg.hfToken;
  document.getElementById('hfModelInput').value = cfg.hfModel;
  applyBackendVisibility();
}

async function saveTranscribeForm() {
  const value = {
    backend: document.getElementById('backendSelect').value,
    url: document.getElementById('urlInput').value.trim() || 'http://localhost:5050',
    hfToken: document.getElementById('hfTokenInput').value.trim(),
    hfModel: document.getElementById('hfModelInput').value.trim() || 'openai/whisper-large-v3',
  };
  const userId = await UserLib.getCurrentUserId();
  const status = document.getElementById('transcribeSaveStatus');
  status.textContent = 'Saving…';
  try {
    await fetch(`/api/v1/settings/transcribeBackend?userId=${userId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value }),
    });
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
  const media = await fetch(`/api/v1/shadowing/media?userId=${userId}`).then(r => r.ok ? r.json() : []).catch(() => []);
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

  document.getElementById('backendSelect').addEventListener('change', applyBackendVisibility);
  document.getElementById('saveTranscribeBtn').addEventListener('click', saveTranscribeForm);

  await renderTranscribeForm();
  await renderShadowingProgress();
});
