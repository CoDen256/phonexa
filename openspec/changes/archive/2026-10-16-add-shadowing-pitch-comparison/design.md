## Context

`js/shadow.js`'s `compareSeg(seg)` currently does exactly one thing: play the reference audio slice, then play the user's `MediaRecorder` take. No analysis happens anywhere in Shadowing today. Meanwhile `js/practice.js` already runs a full Praat analysis (formants + pitch + spectrogram) on short vowel recordings via `SpectroLib.runPraatAnalysis({getChannelData, sampleRate}, {})`, and `js/spectro.js`'s `drawFormantPitchOverlay`/`computeMeansForRange` already know how to extract and draw a pitch curve from that result. This change reuses that proven analysis call for Shadowing, but the audio shape and the pedagogically-relevant question are both different:

- Practice panel: a single vowel's steady-state, where a *mean* F0 is a meaningful summary.
- Shadowing: a full sentence, where *contour shape* (rise/fall, stress peaks) is the actual signal — a mean would flatten exactly what's worth comparing.

This also interacts with an existing, deliberate storage policy: `ShadowingSegment`'s own model docstring states the user's recorded take "is deliberately never persisted — stays ephemeral client-side, to keep storage bounded for multi-hour books." Any pitch data derived from that recording should honor the same policy.

## Goals / Non-Goals

**Goals:**
- Show the reference sentence's pitch contour and the user's recorded take's pitch contour on a shared, time-normalized timeline, so contour *shape* differences are visible at a glance.
- Trigger analysis only on demand (when the user requests the comparison), not automatically on every recording.
- Keep all pitch data and the recording itself ephemeral — nothing new persisted to `ShadowingMedia`/`ShadowingSegment` or any new table.
- Leave `js/practice.js` and its existing pitch machinery completely untouched — this is a Shadowing-only feature, even though it reuses the same underlying server analysis call.

**Non-Goals:**
- No precise time-alignment (e.g. dynamic time warping) between the two contours — v1 normalizes each clip's own duration to a 0–1 x-axis and overlays them, which is good enough to see "I was flat where the reference rose" without solving general alignment.
- No numeric scoring, no semitone normalization, no pass/fail judgment.
- No persistence of any derived pitch data.
- No change to the core Praat pipeline, `/stream`, `/frames`, or the dual-ceiling formant-selection algorithm.

## Decisions

### 1. Reuse `SpectroLib.runPraatAnalysis`/the existing analysis endpoint, not a new one
`js/practice.js` already proves this call works for arbitrary `{getChannelData, sampleRate}` input. Shadowing's user recording is a `MediaRecorder` `Blob`, not a raw `Float32Array` like the practice panel's `ScriptProcessorNode` capture — so the Shadowing-side integration needs one extra step: `blob.arrayBuffer()` → `AudioContext.decodeAudioData()` → `getChannelData(0)` before it can be passed into the same analysis call. This is a client-side decode step Shadowing already performs elsewhere for reference audio (it decodes the full uploaded file in-browser), so no new capability is introduced, just reuse in a new spot.

### 2. Reference contour is sliced from the already-decoded full file, not re-fetched
Shadowing already holds the whole source file decoded client-side (`js/shadow.js`'s core design: "audio is decoded entirely in the browser, never uploaded or stored server-side"). The reference pitch analysis should run on the segment's own `[start_ms, end_ms]` slice of that already-in-memory buffer — no additional download or server round-trip beyond the one Praat analysis call per clip (two calls per comparison: one for the reference slice, one for the user's recording).

### 3. Time-normalized overlay, not raw-duration overlay
Reference and recorded-take durations will rarely match exactly. Both pitch curves are plotted against a shared 0–1 fraction-of-duration x-axis (matching the existing waveform-slice convention already used throughout `js/spectro.js` and `js/practice.js`), rather than absolute milliseconds, so the two contours are visually comparable regardless of speaking-rate differences. This deliberately sacrifices literal time-alignment for shape-comparability; flagged as a known simplification, not a hidden bug.

### 4. Ephemeral by construction — no new persistence path
Both pitch curves are held in a short-lived in-memory variable scoped to the current comparison UI, discarded when the sentence row is closed/re-recorded/another sentence is opened — mirroring exactly how the recording `Blob` itself is already handled. No new column, table, or `Setting` key is introduced.

### 5. Analysis is per-click, not cached across comparisons
Given Shadowing recordings aren't persisted, there's nothing to cache a result against beyond the current in-memory take — re-running the reference analysis on every compare click (rather than caching it per segment for the session) is simpler and the cost (one extra Praat call on a short sentence clip) is small. If this proves slow in practice, session-level caching of the reference curve (keyed by segment id, cleared on media change) is a cheap follow-up, not required for v1.

## Risks / Trade-offs

- **[Risk] Time-normalization (not true alignment) can mislead for very uneven-paced takes** (e.g. a long user pause mid-sentence skews the whole back half of the normalized curve) → **Mitigation**: documented as a known v1 simplification; revisit with proper alignment only if it proves confusing in practice.
- **[Risk] Extra Praat round-trip adds latency to the Compare action** → **Mitigation**: pitch analysis is triggered by an explicit secondary action (not blocking the existing instant playback-based Compare), so the existing fast path is unaffected; the contour appears when ready.
- **[Trade-off] No caching of reference-curve analysis across repeated comparisons of the same segment** → acceptable per Decision 5; cheap to add later if needed.

## Migration Plan

No database migration. This is a frontend-plus-reused-endpoint change:
1. Add the blob-decode step in `js/shadow.js` to produce `{getChannelData, sampleRate}` from the `MediaRecorder` output.
2. Add a reference-slice decode path reusing the already-in-memory full-file buffer.
3. Add a small contour-plotting function (can factor shared drawing logic out of `js/spectro.js`'s existing pitch-curve drawing, or duplicate minimally if the coordinate systems differ enough — decide at implementation time).
4. Wire a new UI affordance (e.g. a "🎵 Pitch" button next to the existing "⇄ Compare" button) that triggers the two analyses and renders the overlay.
Rollback is trivial: remove the new button/handler; no data migration to reverse.

## Open Questions

- Should the pitch-comparison button be a separate explicit action (e.g. "🎵 Pitch"), or folded into the existing "⇄ Compare" button as a second effect alongside playback? Proposal assumes a separate button so the existing fast playback-only Compare stays unchanged for users who don't want the extra latency.
- Is a per-session (not per-segment-persisted) cache of the reference pitch curve worth building in v1, given a user may compare the same sentence several times in a row while practicing? Leaning no for v1 per Decision 5, revisit if latency is noticeable.
