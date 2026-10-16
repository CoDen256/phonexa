## 1. Audio plumbing

- [ ] 1.1 Add a helper in `js/shadow.js` to decode the user's `MediaRecorder` `Blob` into `{getChannelData, sampleRate}` via `AudioContext.decodeAudioData`
- [ ] 1.2 Add a helper to slice the segment's `[start_ms, end_ms]` reference audio from the already-decoded full-file buffer into the same `{getChannelData, sampleRate}` shape

## 2. Analysis integration

- [ ] 2.1 Call `SpectroLib.runPraatAnalysis` on both the reference slice and the user recording, reusing the existing call shape already proven in `js/practice.js`
- [ ] 2.2 Confirm no change is required to the server endpoint for sentence-length clips; if response size/latency is a problem for longer sentences, scope a pitch-only request mode as a follow-up (not blocking v1)

## 3. Contour display

- [ ] 3.1 Add a small canvas/SVG area near the sentence row for the overlaid pitch curves
- [ ] 3.2 Plot both curves time-normalized to a shared 0–1 x-axis, visually distinguishing reference vs. your-take (e.g. reusing the existing gold/white convention from the vowel chart's analyzed-formant overlays)
- [ ] 3.3 Handle the "no recording yet" case per spec — action unavailable or clearly indicates a recording is needed first

## 4. Wiring & UI entry point

- [ ] 4.1 Add a "🎵 Pitch" action next to the existing "⇄ Compare" button in the sentence row, enabled only when both reference and recording are available
- [ ] 4.2 Ensure the comparison state (curves, canvas) is purely in-memory and cleared when switching sentences or re-recording — no persistence anywhere

## 5. Verification

- [ ] 5.1 Manually verify `js/practice.js` and the vowel chart's practice-panel pitch display are byte-for-byte unchanged (`git diff --stat -- js/practice.js` touches nothing)
- [ ] 5.2 Manually verify no new DB columns/tables/migrations were introduced and no `ShadowingMedia`/`ShadowingSegment` row gains new persisted fields
- [ ] 5.3 Test on a sentence with a markedly different reference vs. recorded-take duration to confirm the time-normalized overlay stays readable
