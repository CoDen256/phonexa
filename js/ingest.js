/**
 * ingest.js — shared "save an audio slice as a library Sample" primitive.
 * Used by Formant Lab's ingestion mode (Phase 2) and Shadowing's
 * "save to library" action (Phase 3) — both call uploadSlice() so the actual
 * POST /api/v1/samples call is written once. Depends on encodeWavBlob() and
 * extractMonoSlice() from js/audio.js — load that script first.
 */

/**
 * @param {AudioBuffer} buffer   decoded source audio (any channel count)
 * @param {number} startMs       slice start, ms into buffer
 * @param {number} endMs         slice end, ms into buffer
 * @param {object} [meta]        optional {languageId, text, phonemic}
 * @returns {Promise<object>}    the created Sample row (id, url, durationMs, ...)
 */
async function uploadSlice(buffer, startMs, endMs, meta = {}) {
  const { samples, sampleRate } = extractMonoSlice(buffer, startMs, endMs);
  const blob = encodeWavBlob(samples, sampleRate);

  const form = new FormData();
  form.append('file', blob, 'slice.wav');
  if (meta.languageId != null) form.append('languageId', String(meta.languageId));
  if (meta.text) form.append('text', meta.text);
  if (meta.phonemic) form.append('phonemic', meta.phonemic);

  const resp = await fetch('/api/v1/samples', { method: 'POST', body: form });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${resp.status}`);
  }
  return resp.json();
}
