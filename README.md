`docker run --pull always -p 5000:5000 coden256/phonexa`

or visit url (has limited practice functionality) :

https://github.com/CoDen256/phonexa


## Description
A browser-only interactive IPA vowel chart with multi-language support, a language editor, and a pronunciation practice tool backed by a local Python analysis server.

---

## Features

### Chart page (`index.html`)
- Display IPA vowels from multiple languages simultaneously on a shared trapezoid and a formant (F1/F2) scatter plot
- Filter by language, roundness, vowel length/type, and IPA base symbol — filters combine with AND logic
- Hover any vowel for a tooltip; click to play its audio and trigger a pulse animation
- Nearby vowels that would overlap are **proximity-clustered** into a single dot; clicking shows a disambiguation picker
- **Diphthongs** rendered as animated arrows (straight line, arrowhead, label beside arrow); clicking triggers a traveling-dot animation with ring bursts
- Double-click a diphthong within 5 seconds to hear it at half speed

### Practice panel (`js/practice.js`)
- Record your own pronunciation via microphone
- Waveform displayed with two draggable handles to select the analysis window
- Compare: when the panel is open and a recording exists, clicking any vowel plays the reference then your recording
- Send the selected audio slice to a local Python server (`analyze_server.py`) via multipart `POST /frames` to extract F1/F2 formants
- "You" dot plotted on the formant chart at your analysed position
- Load any reference vowel's audio, select a window, analyse it — "Ref⚡" dot plotted alongside the JSON-specified position

### Real-time streaming (`js/realtime.js`)
- Streams microphone audio to the server over WebSocket (`:5051`) in 128-sample int16 chunks
- Server accumulates a 4096-sample ring buffer (~93 ms) and analyses every 10 ms of new audio
- Returns per-frame diagnostics: F1/F2 with continuity correction and sliding median, RMS, voiced flag, intermediate Praat values
- `verifyFromIpaAudio(audio)` — fetches a language's IPA audio file and measures F1/F2 via `/frames` to compare against the JSON-declared values
- `debugVowel(url)` — posts audio to `/debug` and logs raw Praat output from all three analysis configurations

### Language editor (`editor.html`)
- Select or create languages from a sidebar list
- Live IPA trapezoid and formant charts update as you edit any vowel field
- Click the chart to set vowel position; for diphthongs, alternates between source and target
- Inline vowel editor with IPA glyph picker, type/rounded/description/formant/URL/words fields
- Saves directly to the `lang/` folder via the File System Access API (handle persisted in IndexedDB, survives page refresh)
- Falls back to JSON download if no folder is connected

---

## Core Abstractions

### The IPA trapezoid coordinate system
Vowels are positioned on a trapezoidal grid using two normalised coordinates:
- **`h`** (height): `0` = Close (top), `1` = Open (bottom)
- **`b`** (backness): `0` = Front (left), `1` = Back (right)

The left edge is slanted (narrower at top), matching the IPA chart convention. Coordinates are mapped to SVG pixels via linear interpolation along the trapezoid's four corners. See `trapPos(h, b)` in `index.html` and `ltPos(h, b)` in `editor.html`.

### The formant coordinate system
Vowels with F1/F2 data are independently plotted on a scatter chart:
- **F2** on the X axis, **reversed** (high F2 = front vowels on the left)
- **F1** on the Y axis (high F1 = open vowels at the bottom)
- Range: F1 150–1000 Hz, F2 400–2800 Hz

The two charts (trapezoid and formant) are independent views of the same vowel data. Position on the trapezoid and formant values are separate fields — a vowel can have one, both, or neither.

### Language data
Languages are loaded at runtime from JSON files. Each file defines a language and its vowels. The `cardinal` language is a special built-in reference — its vowels appear on every chart as muted reference points regardless of filters.

→ See [`docs/language-format.md`](docs/language-format.md) for the full schema.

### The filter system
Four independent filter sets (language, roundness, length, IPA base), each stored as a `Set`. A vowel passes if it matches all non-empty sets. Vowels with `type: 'variable'` pass length filters for both Long and Short chips.

Filters live in `index.html` inline script. `passesFilters(lk, v)` is the single gate used by all rendering paths. The sidebar is rebuilt (`buildSidebar`) whenever the language set changes.

### Proximity clustering
On every render, visible monophthong vowels whose SVG positions fall within a 22px radius are grouped into a **cluster**. The cluster renders as one dot at the centroid; clicking shows a disambiguation picker listing all vowels in that cluster. This prevents click-target overlap without moving label positions.

Diphthongs are excluded from clustering and always render individually as arrows.

### Comparison mode
When the practice panel is open and a recording exists, `isCompareMode()` returns `true`. In this state every vowel click plays the reference audio, waits for it to finish, then plays your recording. The waveform cursor animates during your recording's playback.

---

## Component Map

| Component | File | Brief role |
|---|---|---|
| SVG helpers, `isDiph`, `encodeWAV` | `js/utils.js` | Shared primitives used everywhere |
| `buildVowels` | `js/charts.js` | Core renderer: clusters, dots, labels, dispatches diphthongs |
| `renderIpa`, `renderFormant` | `js/charts.js` | Draw grids, call `buildVowels`, overlay analyzed + recorded dots |
| `buildSidebar`, `renderDetail` | `js/charts.js` | Filter UI and per-language detail cards |
| `renderDiph`, `pulseDiphthong` | `js/diphthong.js` | Diphthong arrow + click animation |
| Practice panel | `js/practice.js` | Recording, waveform, single-frame analysis via `/frames`, comparison |
| Real-time streaming | `js/realtime.js` | WebSocket stream to `:5051`, IPA verification, debug |
| Editor chart helpers | `js/editor-charts.js` | Grid drawing, cardinal dots, diphthong arrows, vowel overlay for editor |
| Editor vowel cards | `js/editor-vowels.js` | Vowel card list in the editor overview |
| Editor core | `editor.html` inline | State, language CRUD, inline vowel form, IPA picker, file save |
| HTTP analysis server | `analyze_server.py` | Flask on `:5050`; `/frames`, `/debug` — WAV/PCM → F1/F2 via parselmouth |
| WebSocket stream server | `analyze_server.py` | `websockets` on `:5051`; streaming int16 PCM → real-time formant frames |
| Test suite | `tests/server_tests.py` | Regression, accuracy and cross-endpoint consistency tests |

---

## Key Design Decisions

**No build step.** The app is plain HTML/CSS/JS served statically. Language data is JSON fetched at runtime. This makes the project trivially deployable and editable without tooling.

**`type` is an explicit field, not inferred.** Vowel length and diphthong status are declared in the JSON, not derived from the IPA symbol (e.g. presence of `ː`). This makes filtering reliable regardless of transcription conventions used by a language.

**Cardinal vowels are just another language.** The 23 cardinal reference vowels live in `lang/cardinal/lang.json` and load exactly like any language. They render in a muted style as a reference layer on all charts. No special-casing in the renderer.

**Proximity clustering is stateless and recomputed on every render.** There is no persistent cluster state. This means filtering, language toggling, or any data change automatically produces correct clusters. The 22px threshold is a single constant (`PROX`).

**Diphthong playback rate state survives re-renders.** The `_diphState` map (keyed by `lk::ipa`) lives outside the render cycle, so the slow/normal toggle is preserved across chart rebuilds.

**File System Access API with IndexedDB persistence.** The editor writes directly to your `lang/` folder. The `FileSystemDirectoryHandle` is stored in IndexedDB so the permission grant survives page refresh without requiring the user to re-connect the folder every session.

**Practice panel requires HTTPS.** `getUserMedia` is only available in secure contexts. Plain HTTP deployments must either use HTTPS or add the origin to Chrome's insecure-origins allowlist.

**Analysis uses multipart form data, not raw body + headers.** Audio is sent to `/frames` as `multipart/form-data` with a `file` field (WAV or raw int16 PCM, detected by magic bytes) and a `config` JSON field. Slice fractions and all analysis parameters travel in the config object — no custom headers. The client pre-slices the waveform selection before upload, so `single_segment: true` is used (whole clip = one analysis).

**Single server for both HTTP and WebSocket.** `analyze_server.py` runs a Flask HTTP server on `:5050` and an independent `websockets` server on `:5051`. Both share the same analysis pipeline (`analyse_segment_to_frame`).

**Dual-ceiling formant selection.** Every segment is analysed twice by Praat: once with a wide 5000 Hz ceiling (SCAN) and once with a narrow 1800 Hz ceiling (BACK). BACK wins when its F2 is below the ceiling threshold and substantially lower than SCAN's — this corrects the common F3-as-F2 confusion for back vowels. A phantom-resonance fix handles the complementary error for close front vowels.

# TODOS

- add: changing slider automatically updates F1/F2
- add: create separate f1/f2 for actual sounds and averages, display separately, filter option? and frequencies per word.
- add frequency checker when editing the vowels
- bug: selecting left part of sound slider sometimes locks itc
- fix: monothong / diphtong in a separate filter, not in vowel length
- add: other possible IPA symbols for each vowel
- bug: removal and enabling of the langs. e.g. when i want completely remove a lang i can't


  ideas:

- each vowel comes with average, not tied to an audio, can be generated?
- each vowel has uses/words/phrases/letters/examples, each has
  - has spelling
  - maybe // (phonemic) or [] (phonetic)
  - audio
  - f1/f2 and slice of audio + params? ceiling fq and window size, formants?, how measured
- first use is always the representative isolated sound if possible
- chart can display:
  - single mean f1/f2 of a slice
  - single mean f1/f2 of a custom slice
  - dynamic trail of speech / custom slice of speech