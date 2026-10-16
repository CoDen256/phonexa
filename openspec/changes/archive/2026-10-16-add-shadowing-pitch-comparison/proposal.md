## Why

Shadowing's "Compare" action (`compareSeg()` in `js/shadow.js`) is pure sequential playback — reference audio, then your recording, back to back — with zero analysis. For prosody-heavy practice (matching a sentence's intonation, stress, rhythm), hearing both clips in sequence doesn't show you *where* your pitch diverged from the reference. The Formant Lab / practice-panel machinery to run a Praat pitch analysis on an audio buffer already exists and is proven (`SpectroLib.runPraatAnalysis`, already used by `js/practice.js`); Shadowing just never calls it. This adds a visual pitch-contour comparison to Shadowing specifically, without touching the practice panel, which already has its own (separate, not-in-scope-here) path to the same underlying analysis.

## What Changes

- Add an on-demand pitch-contour comparison to the Shadowing per-sentence Compare flow: after playback, show the reference sentence's pitch curve and your recording's pitch curve, time-normalized onto a shared timeline so contour shape (not just average pitch) is visible.
- Analysis runs client-triggered, per comparison click, via the existing Praat-analysis server call — no new persisted data. Matches `ShadowingMedia`'s existing design stance that a user's recorded take is "deliberately never persisted... to keep storage bounded for multi-hour books" — the pitch comparison is equally ephemeral.
- No mean-F0 number is treated as the primary signal; a whole-sentence pitch mean would collapse the prosodic shape that is the actual thing worth comparing for a multi-second utterance.

**Explicitly out of scope / non-goals:**
- No changes to `js/practice.js`, the vowel-practice pitch readout, or any practice-panel UI — that pitch infrastructure (`drawFormantPitchOverlay`, `computeMeansForRange`'s `f0`) already exists separately and is not part of this change.
- No persistence of pitch data, recordings, or comparison results to the database.
- No numeric pitch-accuracy score, no semitone-normalization, no automatic pass/fail judgment — this change ships the visual comparison only; scoring is explicitly deferred.
- No changes to `formanter.py`'s `/stream`, `/frames` core pipeline, or the dual-ceiling formant algorithm.

## Capabilities

### New Capabilities
- `shadowing-pitch-comparison`: on-demand, ephemeral pitch-contour analysis and side-by-side visualization for a Shadowing sentence's reference audio vs. the user's own recorded take.

### Modified Capabilities
- None. No existing spec-level behavior changes; this is additive to the Shadowing comparison flow.

## Impact

- **Frontend only for the comparison UI**: changes to `js/shadow.js` (extend `compareSeg()` or add an adjacent pitch-comparison entry point) and `shadow.html` (a small contour display area near the sentence row).
- **Reuses existing server endpoint**: the same Praat analysis call path `js/spectro.js`'s `SpectroLib.runPraatAnalysis` already uses (and that `js/practice.js` already calls) — no new server route expected; if the existing endpoint's response shape needs a lighter "pitch-only" mode for sentence-length audio, that's a possible server-side addition scoped in design.md, not a new pipeline.
- **No DB impact**: no new tables, no new columns on `ShadowingMedia`/`ShadowingSegment` — recordings and derived pitch curves stay client-side and ephemeral, consistent with existing Shadowing storage policy.
- **No impact** to the vowel chart, practice panel, Formant Lab, Token Drill, or the frozen realtime `/stream` pipeline.
