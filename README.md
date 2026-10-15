## Running it

```bash
docker compose up -d
```

Starts Postgres + the Flask app (`formanter.py`) on `:5050`. First run: apply migrations
with `alembic upgrade head` (see `alembic.ini`/`alembic/`). Visit `http://localhost:5050`.

Optional local speech-to-text for Shadowing's transcription feature:
`pip install -r requirements-transcribe.txt` (installs `faster-whisper`; not in the base
image, so the base server stays light). `WHISPER_MODEL` env var picks the model size
(tiny/base/small/medium/large-v3, default `base`). YouTube extraction needs `yt-dlp` +
`ffmpeg`, both already in the Docker image.

## Description

A Postgres-backed phonetics practice and analysis tool: an interactive multi-language IPA
vowel chart, a language/vowel editor, a spectrogram-based formant analysis workbench
("Formant Lab"), a long-audio shadowing practice page, and a live microphone
formant tracker (the original piece of this project, unchanged since day one).

---

## Pages

### Chart (`index.html`)
- IPA trapezoid + formant (F1/F2) scatter plot, multiple languages at once
- Filters (language, roundness, monophthong/diphthong, long/short/variable, IPA base
  symbol, averages-vs-tokens toggle) — persisted server-side per profile, restored on load
- Proximity-clustered dots with a disambiguation picker; diphthongs as animated arrows
  (double-click within 5s for half-speed)
- Right-click a vowel → "Practice this vowel" opens the practice panel directly
- **Practice panel**: record via mic, live spectrogram with a draggable analysis window
  feeding live F1/F2 onto the formant plot, Compare (silence-trimmed reference then yours)

### Language editor (`editor.html`)
- Full language/vowel CRUD against the database (no File System Access, no local JSON —
  that model was retired; everything round-trips through `/api/v1/languages`/`/vowels`)
- Live IPA trapezoid + formant preview while editing; vowel↔token/representative-sample
  relationships are explicit, not inferred from symbol text

### Formant Lab (`praat.html`)
- A spectrogram analysis workbench with four ways to load audio: drop/pick a local file,
  pick an existing DB sample, record from the mic, or (historically) a YouTube URL —
  YouTube extraction now lives in Shadowing instead (see below)
- Ingest mode: drag-select one or more regions on the spectrogram, each becomes its own
  saved Sample+Token with its own Praat analysis (formants/pitch), re-analyzable later
  without destroying prior analysis history
- Sample mode (`praat.html?sampleId=`): edit an existing sample's tokens — drag the
  time range on the spectrogram and the character range on the sample's text
  independently; trim the sample's audio (shifts every token/analysis in place)

### Shadowing (`shadow.html`)
- Practice reading along with a long audio source (audiobook, lecture, video) — audio is
  decoded **entirely in the browser**, never uploaded or stored server-side
- Sources: drop/pick a local file, "📂 Open file" (remembers access via the File System
  Access API, Chromium only), or paste a YouTube URL (server downloads+extracts the audio
  once via `yt-dlp`+`ffmpeg`, capped at ~2h, and hands it back as a plain file — the server
  never sees more of it than that)
- Client-side VAD splits the loaded range into chapters (long pauses) and sentences
  (shorter pauses) — sliders for both sensitivities, auto-suggested chapter threshold
- Per sentence: play reference, record yourself, compare, mark done, transcribe
  (local Whisper server or Hugging Face), manually split/merge
- Resuming the same file (even renamed) is recognized by a small content fingerprint
  (file size + a few sampled byte ranges — never read the whole file) and restores your
  split + progress without re-uploading or re-splitting anything
- "🔬 Open in Formant Lab" hands a sentence's audio to Formant Lab for deeper analysis

### Sound Browser / Token Browser (`sounds.html` / `tokens.html`)
- Browse every Sample/Token in the DB; inline highlighted-text playback (click a
  highlighted token to play just that slice, click elsewhere to play the whole sample)
- Token Browser: per-token Current/Manual F1/F2, pick which analysis session a token's
  mean is derived from

### Token Drill (`drill.html`)
- Standalone practice page: pick a vowel, hear it, record yourself, compare — reachable
  from the chart's right-click menu ("Practice this vowel") or on its own

### Settings (`settings.html`)
- Switch/create a named profile (simple, no password — see Design Decisions)
- Configure the transcription backend (local Whisper server URL, or Hugging Face
  token+model) used by Shadowing
- Read-only overview of Shadowing progress across all your uploads

### Live mic practice (`js/realtime.js`, `/stream`)
- Streams microphone audio over a WebSocket (`/stream`, same port as everything else —
  see `formanter.py`'s own header for a correction of an old `:5051` claim) in small
  int16 chunks; server returns per-frame F1/F2 with continuity correction and sliding
  median, RMS, voiced flag, and the raw dual-ceiling Praat diagnostics
- This is the original piece of the project and has been deliberately **frozen** —
  every later phase verifies `git diff --stat -- js/realtime.js formanter.py` touches
  neither `/stream` nor `/frames` before shipping
- → see `docs/arch-detailed.md` for the full algorithm and wire-protocol documentation,
  `docs/glossary.md` for term definitions, `docs/ws.md` for the historical record of
  migrating smoothing from client to server

---

## Core Abstractions

### The IPA trapezoid coordinate system
Vowels are positioned on a trapezoidal grid using two normalised coordinates:
- **`h`** (height): `0` = Close (top), `1` = Open (bottom)
- **`b`** (backness): `0` = Front (left), `1` = Back (right)

The left edge is slanted (narrower at top), matching the IPA chart convention.

### The formant coordinate system
- **F2** on the X axis, **reversed** (high F2 = front vowels on the left)
- **F1** on the Y axis (high F1 = open vowels at the bottom)
- Range: F1 150–1000 Hz, F2 400–2800 Hz

Position on the trapezoid and formant values are independent — a vowel can have one,
both, or neither.

### The filter system
Five independent `Set`-based filters (language, roundness, vowel type
monophthong/diphthong, length long/short/variable, IPA base symbol) plus two booleans
(`showAverages`, `showTokens`) — a vowel passes if it matches every non-empty set.
`passesFilters(lk, v)` (`js/filters.js`) is the single gate used by all rendering paths.
State is restored from the active profile's `ipaChartFilters` Setting on load and
persisted on every change (`js/charts.js`).

### Proximity clustering
Recomputed on every render (no persistent cluster state): visible monophthong vowels
within a 22px SVG radius are grouped into one dot; clicking shows a disambiguation
picker. Diphthongs are excluded and always render individually as arrows.

### Sample ≈ Sound
A `Sample` row covers the whole lifecycle from "just-uploaded audio, nothing else known"
to "fully tokenized library entry" — `language_id`/`text`/`url` are all nullable.
An earlier design had a separate `Sound` concept; real migrated data showed Sample:Sound
was ~always 1:1, so they were merged (see `db/models.py`'s own docstring for the full
reasoning — it's maintained as a running design-decision log, read it directly for
anything schema-related rather than trusting a description here).

---

## Key Design Decisions

**No auth, anywhere.** This is a single-operator personal tool and that's been an
explicit, repeatedly-reconfirmed accepted risk (see `db/models.py`). `User` is a named
profile picker, not an account — no password, no session security. If this is ever
exposed beyond `localhost`, this decision needs revisiting first.

**Shadowing never stores or decodes audio server-side.** An earlier version did exactly
that (server-side Praat decode on upload, on split, and on every chapter-audio request)
and it was reverted in the same session it shipped: a long file meant repeated multi-GB
decodes with nothing cached between requests. Audio decoding and VAD segmentation both
moved back to the browser; only segment boundaries and per-sentence progress are
persisted, keyed by a client-computed content fingerprint rather than the file itself.

**`type` is an explicit field, not inferred.** Vowel length/diphthong status is declared
in the schema, not derived from the IPA symbol (e.g. presence of `ː`) — reliable
regardless of transcription conventions.

**Cardinal vowels are just another language.** The 23 cardinal reference vowels are a
`Language` row like any other (key `cardinal`), rendered muted as a reference layer.
No special-casing in the renderer.

**A Token's mean F1/F2 is computed on read, from whichever `SampleAnalysis` it points
at — never cached.** Re-analyzing a sample with different Praat settings adds a new
analysis row (history preserved); repointing one token at it never requires touching
any other token. A `manual_f1`/`manual_f2` override wins over the derived mean when set.

**Destructive operations require explicit confirmation.** The DB admin import
(`POST /api/v1/admin/import`) truncates and rebuilds; re-splitting a Shadowing upload
discards manual edits/progress for it. Both are gated behind an explicit confirm step.

**The realtime pipeline (`/frames`, `/debug`, `/stream`) is frozen.** It predates
everything else in this project and still works exactly as originally built — see
`docs/arch-detailed.md` for the dual-ceiling Praat formant-selection algorithm, which
is the one genuinely novel piece of signal-processing design in this codebase.

---

## Backlog

The old ad-hoc TODO list that used to live here turned out to already be mostly done —
worth recording what actually happened to each item rather than silently deleting it:

- ~~changing slider automatically updates F1/F2~~ — done (practice panel's draggable
  analysis window feeds the formant plot live)
- ~~separate f1/f2 for actual sounds vs. averages, filterable~~ — done (`Vowel.f1/f2` is
  the average/specified value; `Token`s carry per-occurrence values; `showAverages`/
  `showTokens` filter toggle)
- ~~monophthong/diphthong as a separate filter from vowel length~~ — done (`vtype` and
  `length` are independent filter sets)
- ~~other possible IPA symbols per vowel~~ — done (`Vowel.symbols` is an array)
- ~~can't fully remove a language~~ — done (`DELETE /api/v1/languages/<id>`)
- ~~each vowel comes with an average, not tied to one audio~~ — done, this is the whole
  point of the `Vowel` vs. `Token` split
- ~~word/phrase examples each with their own audio slice + F1/F2~~ — done via
  `Sample`/`Token`/`SampleAnalysis`

Genuinely still open:
- A frequency-range sanity check when typing F1/F2 directly into the vowel editor
  (catch obviously-wrong values, e.g. F1 > F2) doesn't exist
- The old "selecting the left part of the sound slider sometimes locks it" bug was filed
  against the pre-spectrogram waveform-slider practice panel, since rebuilt around a real
  spectrogram with a different drag implementation — likely moot, not specifically re-verified
- Formant Lab's YouTube picker was removed in favor of Shadowing's (see Shadowing above);
  no outstanding work there, just noting the move for anyone who remembers the old location
