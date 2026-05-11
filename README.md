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
- Send the selected audio slice to a local Python server (`analyze_server.py`) to extract F1/F2 formants
- "You" dot plotted on the formant chart at your analysed position
- Load any reference vowel's audio, select a window, analyse it — "Ref⚡" dot plotted alongside the JSON-specified position

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
| Practice panel | `js/practice.js` | Recording, waveform, analysis, comparison |
| Editor chart helpers | `js/editor-charts.js` | Grid drawing, cardinal dots, diphthong arrows, vowel overlay for editor |
| Editor vowel cards | `js/editor-vowels.js` | Vowel card list in the editor overview |
| Editor core | `editor.html` inline | State, language CRUD, inline vowel form, IPA picker, file save |
| Formant analysis | `analyze_server.py` | Flask; receives WAV slice, returns F1/F2 via parselmouth/Praat |

---

## Key Design Decisions

**No build step.** The app is plain HTML/CSS/JS served statically. Language data is JSON fetched at runtime. This makes the project trivially deployable and editable without tooling.

**`type` is an explicit field, not inferred.** Vowel length and diphthong status are declared in the JSON, not derived from the IPA symbol (e.g. presence of `ː`). This makes filtering reliable regardless of transcription conventions used by a language.

**Cardinal vowels are just another language.** The 23 cardinal reference vowels live in `lang/cardinal/lang.json` and load exactly like any language. They render in a muted style as a reference layer on all charts. No special-casing in the renderer.

**Proximity clustering is stateless and recomputed on every render.** There is no persistent cluster state. This means filtering, language toggling, or any data change automatically produces correct clusters. The 22px threshold is a single constant (`PROX`).

**Diphthong playback rate state survives re-renders.** The `_diphState` map (keyed by `lk::ipa`) lives outside the render cycle, so the slow/normal toggle is preserved across chart rebuilds.

**File System Access API with IndexedDB persistence.** The editor writes directly to your `lang/` folder. The `FileSystemDirectoryHandle` is stored in IndexedDB so the permission grant survives page refresh without requiring the user to re-connect the folder every session.

**Practice panel requires HTTPS.** `getUserMedia` is only available in secure contexts. Plain HTTP deployments must either use HTTPS or add the origin to Chrome's insecure-origins allowlist.

**Analysis sends a pre-sliced WAV, not window headers.** Earlier designs sent the full recording plus `X-Window-Start/End` fraction headers. The current approach slices `Float32Array` in JS and sends only the selected portion with `X-Window-Start:0, X-Window-End:1`. This keeps the server logic simple and makes the selection the source of truth.



# TODOS

- changing slider automatically updates F1/F2
- create separate f1/f2 for actual sounds and averages, display separately, filter option? and frequencies per word. 
- add frequency checker when editing of the vowels
- bug: selecting left part of sound slider sometimes locks itc
- monothong / diphtong in a separate filter, not in vowel length
- other possible IPA symbols 
ideas:
- real time formants update?