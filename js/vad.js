/**
 * vad.js — energy-based voice-activity detection, shared between shadow.js
 * (sentence AND chapter segmentation on huge uploaded files — entirely
 * client-side, since audio is never sent to or stored by the server) and
 * praat.js's ingestion mode (auto-suggesting slice boundaries on a freshly
 * dropped file). Depends on computeMonoData() from js/audio.js — load that
 * first.
 */

/** Same energy-threshold heuristic as detectSentences, but just the onset of the first speech. */
function detectLeadingSilenceMs(buffer) {
  const windowMs = 20;
  const sr = buffer.sampleRate;
  const data = computeMonoData(buffer);
  const winSize = Math.max(1, Math.round(sr * windowMs / 1000));
  const nWin = Math.ceil(data.length / winSize);
  const rms = new Float32Array(nWin);
  for (let w = 0; w < nWin; w++) {
    const start = w * winSize, end = Math.min(start + winSize, data.length);
    let sum = 0;
    for (let i = start; i < end; i++) sum += data[i] * data[i];
    rms[w] = Math.sqrt(sum / Math.max(1, end - start));
  }
  const sorted = Float32Array.from(rms).sort();
  const floor = sorted[Math.floor(sorted.length * 0.15)] || 0;
  const peak = sorted[sorted.length - 1] || 0.0001;
  const threshold = Math.max(floor * 2.5, peak * 0.035, 0.0025);
  for (let w = 0; w < nWin; w++) {
    if (rms[w] > threshold) return Math.max(0, w * windowMs - 40);   // small pad-back so the onset isn't clipped
  }
  return 0;   // all silence — nothing to trim
}

/**
 * Splits mono samples into speech segments separated by silence gaps of at
 * least `minSilenceMs`. Shorter gaps (e.g. between words) are merged into
 * the surrounding speech, so a "sentence" can contain internal pauses.
 *
 * Takes raw samples (not an AudioBuffer) so a short in-memory sub-range —
 * e.g. the tail of an already-decoded buffer plus a freshly-decoded
 * extension — can be re-analysed without constructing a full AudioBuffer.
 *
 * The energy threshold is normally derived from this call's own sample
 * percentile stats, but extending a session's range must reuse the
 * ORIGINAL threshold (pass `params.threshold`) rather than recompute it —
 * recomputing from a longer (or shorter) buffer shifts the percentile
 * stats and can silently redraw old, already-cached sentence boundaries.
 * Always returns the threshold actually used, so callers can cache it.
 */
function detectSentences(monoSamples, sampleRate, params = {}) {
  const windowMs      = 20;
  const minSilenceMs  = params.minSilenceMs  ?? 300;
  const minSentenceMs = params.minSentenceMs ?? 350;
  const padMs         = params.padMs         ?? 70;

  const winSize = Math.max(1, Math.round(sampleRate * windowMs / 1000));
  const nWin = Math.ceil(monoSamples.length / winSize);
  const rms = new Float32Array(nWin);
  for (let w = 0; w < nWin; w++) {
    const start = w * winSize, end = Math.min(start + winSize, monoSamples.length);
    let sum = 0;
    for (let i = start; i < end; i++) sum += monoSamples[i] * monoSamples[i];
    rms[w] = Math.sqrt(sum / Math.max(1, end - start));
  }

  let threshold = params.threshold;
  if (threshold == null) {
    const sorted = Float32Array.from(rms).sort();
    const floor  = sorted[Math.floor(sorted.length * 0.15)] || 0;
    const peak   = sorted[sorted.length - 1] || 0.0001;
    threshold = Math.max(floor * 2.5, peak * 0.035, 0.0025);
  }

  const isSpeech = new Uint8Array(nWin);
  for (let w = 0; w < nWin; w++) isSpeech[w] = rms[w] > threshold ? 1 : 0;

  const minSilenceWin = Math.max(1, Math.round(minSilenceMs / windowMs));
  let i = 0;
  while (i < nWin) {
    if (!isSpeech[i]) {
      let j = i; while (j < nWin && !isSpeech[j]) j++;
      if (j - i < minSilenceWin) for (let k = i; k < j; k++) isSpeech[k] = 1;
      i = j;
    } else i++;
  }

  const rawSegments = [];
  i = 0;
  while (i < nWin) {
    if (isSpeech[i]) {
      let j = i; while (j < nWin && isSpeech[j]) j++;
      rawSegments.push({ start: i * windowMs, end: j * windowMs });
      i = j;
    } else i++;
  }

  const durMs = monoSamples.length / sampleRate * 1000;
  const padded = rawSegments
      .map(s => ({ start: Math.max(0, s.start - padMs), end: Math.min(durMs, s.end + padMs) }))
      .filter(s => s.end - s.start >= minSentenceMs);

  const merged = [];
  for (const s of padded) {
    const last = merged[merged.length - 1];
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else merged.push({ ...s });
  }

  const segments = merged.map((s, idx) => ({ index: idx, start: Math.round(s.start), end: Math.round(s.end) }));
  return { segments, threshold };
}

/**
 * Chapter-tier boundaries are just ANOTHER detectSentences pass over the
 * same mono samples — a much larger minSilenceMs (only long pauses count as
 * a chapter break), sharing the sentence tier's own auto-derived threshold
 * (both tiers must agree on what counts as "silence"; only the gap-merge
 * width differs) and a correspondingly larger minSentenceMs floor so a tiny
 * trailing blip after a long gap doesn't become its own chapter.
 */
function detectChapters(monoSamples, sampleRate, chapterSilenceMs, sentenceThreshold) {
  return detectSentences(monoSamples, sampleRate, {
    minSilenceMs: chapterSilenceMs,
    minSentenceMs: Math.max(chapterSilenceMs, 2000),
    threshold: sentenceThreshold,
  });
}

/**
 * ~95th percentile of (pre-merge) silence-gap durations, so the chapter
 * slider's pre-filled default only catches the longest ~5% of pauses in
 * this file — same heuristic as the sentence tier's auto-threshold, just
 * measuring gap LENGTH instead of RMS level.
 */
function suggestChapterSilenceMs(monoSamples, sampleRate) {
  const windowMs = 20;
  const winSize = Math.max(1, Math.round(sampleRate * windowMs / 1000));
  const nWin = Math.ceil(monoSamples.length / winSize);
  const rms = new Float32Array(nWin);
  for (let w = 0; w < nWin; w++) {
    const start = w * winSize, end = Math.min(start + winSize, monoSamples.length);
    let sum = 0;
    for (let i = start; i < end; i++) sum += monoSamples[i] * monoSamples[i];
    rms[w] = Math.sqrt(sum / Math.max(1, end - start));
  }
  const sorted = Float32Array.from(rms).sort();
  const floor = sorted[Math.floor(sorted.length * 0.15)] || 0;
  const peak = sorted[sorted.length - 1] || 0.0001;
  const threshold = Math.max(floor * 2.5, peak * 0.035, 0.0025);

  const gaps = [];
  let i = 0;
  while (i < nWin) {
    if (rms[i] <= threshold) {
      let j = i; while (j < nWin && rms[j] <= threshold) j++;
      gaps.push((j - i) * windowMs);
      i = j;
    } else i++;
  }
  if (!gaps.length) return 4000;
  gaps.sort((a, b) => a - b);
  const idx = Math.min(gaps.length - 1, Math.floor(gaps.length * 0.95));
  return Math.max(1500, Math.min(15000, gaps[idx]));
}
