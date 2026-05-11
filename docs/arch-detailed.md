# IPA Vowel Chart — Architecture

A browser-only interactive IPA vowel chart with multi-language support, a language editor, and a pronunciation practice tool backed by a local Python analysis server.

---

## Project Goals

- Display IPA vowels from multiple languages simultaneously on a shared trapezoid chart and a formant (F1/F2) plot
- Allow filtering by language, roundness, vowel length, and IPA base symbol
- Support clicking vowels to play audio; diphthongs shown as animated arrows
- Provide a language editor to create/edit language JSON files in-browser with file-system access
- Allow recording your own voice, comparing it to reference vowels, and analysing F1/F2 formants via a local Python server

---

## Data Format

### `lang/index.json`

The only file that needs to be edited to add a language:

```json
{
  "languages": ["cardinal", "en", "de", "ru", "no"]
}
```

Folder names starting with `_` are skipped.

### `lang/{key}/lang.json` — Language schema

```json
{
  "key": "en",
  "label": "English",
  "color": "#60a5fa",
  "vowels": [ /* array of vowel objects */ ]
}
```

### Vowel object — monophthong

```json
{
  "ipa":      "iː",
  "h":        0.03,
  "b":        0.04,
  "rounded":  false,
  "type":     "long",
  "desc":     "Close front unrounded (long)",
  "f1":       270,
  "f2":       2290,
  "ipaAudio": "https://…/Close_front_unrounded_vowel.ogg",
  "wikiUrl":  "https://en.wikipedia.org/wiki/…",
  "words": [
    { "text": "f<b>ee</b>t", "audio": "https://…/En-us-feet.ogg" }
  ]
}
```

### Vowel object — diphthong

Same as monophthong, plus `h2`/`b2` for the target position on the IPA trapezoid:

```json
{
  "ipa":  "eɪ",
  "h":    0.30,  "b":  0.04,
  "h2":   0.20,  "b2": 0.18,
  "type": "diphthong",
  ...
}
```

### Coordinate system

**IPA trapezoid** (`h`, `b`):
- `h` = height: `0` = Close (top), `1` = Open (bottom)
- `b` = backness: `0` = Front (left), `1` = Back (right)
- Interpolated along the trapezoid's slanted left edge

**Formant plot** (`f1`, `f2`):
- F1 range: 150–1000 Hz (Y axis, top = low F1)
- F2 range: 400–2800 Hz (X axis, right = low F2, i.e. back vowels)

### Vowel `type` field

| Value       | Shown by filter chip | Filter behaviour |
|-------------|----------------------|-----------------|
| `short`     | Short / Monophthong  | Also shown by Variable chip |
| `long`      | Long / Monophthong   | Also shown by Variable chip |
| `variable`  | Variable             | Shown by Long, Short, and Variable chips |
| `diphthong` | Diphthong            | Only shown by Diphthong chip; rendered as arrow |

---

## index.html — Main Chart Page

### Page layout

```
<header>            title · reload button · editor link · 🎤 Practice button
<div id="app">
  <aside.sidebar>   filter panel (built by buildSidebar)
  <main.chart-area>
    <div.chart-row>
      tabs: [IPA Chart] [Formant Plot]
      <svg id="chartIpa">      IPA trapezoid
      <svg id="chartFormant">  Formant scatter
    </div>
    <div id="detail">   vowel cards for selected language (renderDetail)
  </main>
</div>
<div id="vowelPicker">  disambiguation popup (appears on cluster click)
<div id="tip">          hover tooltip
<div id="practicePanel"> fixed bottom bar (practice + analysis)
```

### Script loading order (matters — each file depends on previous)

```html
<script src="js/utils.js"></script>         <!-- $s $t ipaW isDiph encodeWAV -->
<script>/* language loading, LANGS, IPA constants, geometry, filters, tooltip, picker */</script>
<script src="js/diphthong.js"></script>     <!-- depends on: $s $t playUrlAtRate LANGS -->
<script src="js/charts.js"></script>        <!-- depends on: everything above -->
<script src="js/practice.js"></script>      <!-- depends on: charts.js, LANGS, filters -->
<script>/* sidebar chips, renderDetail, init, reload button */</script>
```

### Global state (inline script, after utils)

```js
const LANGS = {};                    // populated by loadLanguages()
const filters = {
  languages: new Set(),
  roundness: new Set(),
  length:    new Set(['monophthong']),  // default: monophthongs visible
  ipaBase:   new Set(),
};
let curAudio = null;
let recordedVowel = null;            // {f1, f2} from practice panel analysis
const analyzedFormants = {};         // lk::ipa → {f1, f2} from reference analysis
```

### IPA constants

```js
const IPA_BASE_ORDER = [
  'i','y','ɨ','ʉ','ɯ','u',
  'ɪ','ʏ','ʊ',
  'e','ø','ɘ','ɵ','ɤ','o',
  'ə',
  'ɛ','œ','ɜ','ɞ','ʌ','ɔ',
  'æ','ɐ',
  'a','ɶ','ä','ɑ','ɒ',
];
```

Used to order the IPA base filter chips in the sidebar.

### Chart geometry

```js
// IPA trapezoid (SVG viewBox 1270 × 730)
const TRAP = {
  TL:{x:155,y:110}, TR:{x:1115,y:110},  // top-left, top-right
  BL:{x:390,y:618}, BR:{x:1115,y:618},  // bottom-left, bottom-right
};
// trapPos(h, b) → {x, y}  — linear interpolation along trapezoid edges

// Formant plot (same SVG viewBox)
const FP = { x0:90, x1:1150, y0:60, y1:660 };
const F2MIN=400, F2MAX=2800, F1MIN=150, F1MAX=1000;
// formantPos(f1, f2) → {x, y}  — F2 reversed on X axis (front=left)
```

---

## js/charts.js — Chart Rendering

### `buildVowels(svg, getPos, svgId, showArrows=false)`

The core rendering function called by both `renderIpa` and `renderFormant`.

1. **Collect** all vowels from `LANGS` that pass `passesFilters(lk, v)`
2. **Separate** diphthongs (IPA chart only, when `showArrows=true`) from monophthongs
3. **Cluster** monophthongs: greedy proximity grouping, radius = `PROX=22px`. Any vowels whose SVG positions are within 22px share a cluster
4. **Render clusters**:
   - Each vowel in a cluster gets its own `r=3` dot at exact position
   - Label goes left (unrounded) or right (rounded) of its dot
   - Single-vowel cluster: clicking dot/label plays sound + fires `pulse()`
   - Multi-vowel cluster: small dashed indicator ring; hovering shows `showClusterTip()`; clicking shows picker
5. **Render diphthongs** (IPA chart): calls `renderDiph()` from `diphthong.js`

Layers (SVG render order, back to front): `arrowL` → `langL` → `cardL` → `dotL`

Cardinals are always present via the `cardinal` language key and are drawn in `cardL` (below language labels).

### `renderIpa()`

Draws the IPA trapezoid grid, calls `buildVowels` with `getPos = trapPos(h, b)`, `showArrows=true`.

### `renderFormant()`

Draws F1/F2 grid axes, calls `buildVowels` with `getPos = formantPos(f1, f2)`.

After normal vowels, overlays:
- **Analyzed formants** (`analyzedFormants` map): filled circle + dashed connector to JSON position, for any reference vowel that has been analysed in the practice panel
- **Your recording** (`recordedVowel`): white "You" dot
- **Reference analysed** (`refAnalyzed`): gold "Ref⚡" dot

### `buildSidebar()`

Builds four filter sections. Each section uses a `chip(label, filterSet, value, color)` factory that toggles a `Set` entry and calls `renderAll()`. Sections:

1. **Languages** — one chip per loaded language key, colored with `lang.color`
2. **Roundness** — Rounded / Unrounded
3. **Length** — Monophthong / Diphthong / Long / Short / Variable
4. **IPA Base** — one chip per base symbol found in currently-visible vowels (order follows `IPA_BASE_ORDER`)

### `renderDetail()`

Below the charts. When a language chip is selected (exactly one), renders a horizontal strip of vowel cards for that language. Each card shows IPA symbol, description, rounded·type, F1/F2 formants, example word chips (with audio if available), and a play button.

### `renderAll()`

```js
function renderAll() { renderIpa(); renderFormant(); renderDetail(); updateCount(); }
```

Called on every filter change and on language reload.

---

## js/diphthong.js — Diphthong Rendering

### `renderDiph(arrowL, dotL, x1, y1, x2, y2, v, lang, lk, svgId)`

Renders one diphthong as a straight line arrow:
- Source: filled `r=3` dot at `(x1,y1)`
- Target: outline `r=3.5` dot at `(x2,y2)`
- Line: shortened by arrowhead length, faint by default
- Arrowhead: filled polygon at target
- Label: `<text>` at midpoint, offset perpendicular to the arrow direction (`lx = mid + uy×SIDE, ly = mid - ux×SIDE`), dark drop-shadow for readability, no background rect
- Hit area: wide transparent `<line>` across the full length, 22px stroke-width
- Click interaction: rate-aware playback (see below) + `pulseDiphthong()`
- Hover: shows single-vowel tooltip via `showTip()`

### Rate-aware click (per-diphthong state)

```js
const _diphState = {};  // key: `${lk}::${ipa}` → {lastClick, slowed}
```

- First click, or click >5s after previous: plays at 1.0× speed, resets `slowed=false`
- Each subsequent click within 5s: toggles `slowed`. `false→true` plays at 0.5×, `true→false` plays at 1.0×
- State is stored outside the render cycle so it survives chart re-renders

### `pulseDiphthong(svgId, x1, y1, x2, y2, color)`

Animation sequence on click:
1. Double ring burst at source (sizes 4+2, staggered 90ms)
2. Single dot travels from source to target, ease-in-out, ~55 frames
3. Double ring burst at target when dot arrives

### `spawnRing(svg, x, y, color, r0, speed, opStart)`

Spawns one expanding+fading ring at a point. Reusable helper called by `pulseDiphthong` and `pulse`.

---

## js/practice.js — Practice Panel

### State

```js
const SERVER = 'http://localhost:5050';  // local Python server address

// User recording
let recState = 'idle';                   // 'idle' | 'recording' | 'ready'
let recBlob, recObjectURL, recSamples;   // WAV blob + object URL + raw Float32Array
let recSampleRate = 22050;
let waveStart = 0.33, waveEnd = 0.67;   // selection window as fractions 0–1
let waveDrag = null, waveCursorPos = null;

// Reference vowel (loaded when a vowel is clicked while panel is open)
let refSamples, refSampleRate;
let refStart = 0.33, refEnd = 0.67;
let refDrag = null, refCursorPos = null;
let refAnalyzed = null;                  // {f1, f2} from server analysis
let refVowelMeta = null;                 // {v, lang, lk} of the reference vowel
```

### Waveform system

`makeWavePainter(canvasId, infoId, getStart, getEnd, getCursor, getDrag)` → `drawFn()`

Factory that returns a drawing function. Draws:
- Dark background
- Amplitude bars (peak per pixel column), blue within selection, dark outside
- Semi-transparent blue fill over selected region
- White cursor line + played-region fill when `cursorPos !== null`
- Two draggable handles with triangle grips (blue when idle, white when dragged)
- Time label below: `"120 – 380 ms  (600 ms total)"`

`addWaveDrag(canvasId, ...)` — attaches mousedown/touchstart to the canvas, mousemove/touchmove/mouseup/touchend to document for drag-outside-canvas support.

`playSlice(samples, sr, getStart, getEnd, setCursor, redraw, onEnded)` — slices `samples[floor(start*len) .. floor(end*len)]`, encodes as WAV, plays it, animates cursor via `performance.now()` timing, revokes the blob URL on end.

### Recording flow

1. `getUserMedia({audio: {channelCount:1, sampleRate:22050}})` — mic access
2. `AudioContext` + `ScriptProcessorNode(4096)` — captures raw PCM chunks
3. On stop: concatenate chunks → `Float32Array` → `encodeWAV()` → `Blob`
4. Waveform drawn, handles reset to 0.33–0.67, buttons enabled

### Comparison mode

```js
function isCompareMode() {
  return !!(recObjectURL && practicePanel.classList.contains('open'));
}
```

When compare mode is active:
- `playUrl(url)` plays the reference vowel, then on `audio.onended` fires `playSelection()` after 350ms
- `playUrlAtRate(url, rate)` same, with rate-adjusted audio
- Waveform cursor animates during playback in the panel

### `onVowelClicked(v, lang, lk)`

Called from every vowel click handler in `buildVowels` (alongside `playUrl`). If the panel is open and the vowel has audio, calls `loadRefAudio(url)`.

### `loadRefAudio(url)`

1. `fetch(url, {mode:'cors'})` → `ArrayBuffer`
2. `AudioContext.decodeAudioData()` → `AudioBuffer`
3. `getChannelData(0).slice()` → `Float32Array` (mono)
4. Draws ref waveform, shows ref waveform canvas, enables Analyse button
5. Displays JSON-specified F1/F2 if available

### Server communication

Both user and reference analysis send a WAV slice with `X-Window-Start:0, X-Window-End:1` — the slice IS the selected portion, so the server analyses the whole clip.

```js
const sliceBlob = encodeWAV(samples.slice(s, e), sampleRate);
fetch(SERVER + '/analyze', {
  method: 'POST', body: sliceBlob,
  headers: { 'Content-Type': 'audio/wav', 'X-Window-Start': '0', 'X-Window-End': '1' }
});
```

### `encodeWAV(samples, sampleRate)`

Pure JS WAV encoder. Writes a 44-byte RIFF/WAVE/fmt/data header then 16-bit signed PCM samples. Always mono. Output: `Blob` with `type:'audio/wav'`.

---

## analyze_server.py — Local Formant Analysis Server

Flask server on `http://localhost:5050`. Must be started manually by the user.

### Endpoints

**`GET /ping`** — returns `{"ok": true}`. Used by the browser to check if the server is running before showing "✓ Server connected".

**`POST /analyze`**  
- Body: raw WAV bytes (`Content-Type: audio/wav`)
- Headers: `X-Window-Start` (float, fraction 0–1), `X-Window-End` (float, fraction 0–1)
- Writes body to a temp file, loads with `parselmouth.Sound`
- Runs "To Formant (burg)" with ceiling 5500 Hz (female default)
- Calls "Get mean" on formants 1 and 2 over the specified window
- Checks for NaN (no formant detected) → returns 400
- Returns: `{"f1": 320.1, "f2": 2180.4, "duration_ms": 450.0, "window_ms": [148.5, 301.5]}`

### Error conditions → 400

- No audio data in body
- Audio too short (< 50ms)
- Window start ≥ window end after clamping
- Praat returns NaN (no formants detected — try a different window)

### Setup

```bash
pip install flask flask-cors parselmouth
python analyze_server.py
```

---

## editor.html — Language Editor

### Layout

```
<div.top-bar>        back link · title · 📁 Connect folder button
<div.editor-layout>
  <aside.lang-sidebar>   language list + New Language button
  <main#mainPanel>       built dynamically by renderMain()
```

### State

```js
const state = {
  langs: {},           // all loaded language objects, keyed by lang.key
  selKey: null,        // currently selected language key
  langDraft: null,     // deep clone being edited (from state.langs[selKey])
  vowelIdx: null,      // index of vowel being edited, or null
  vowelDraft: null,    // deep clone of that vowel
  dirHandle: null,     // FileSystemDirectoryHandle for direct file saves
  unsaved: false,
  chartTab: 'ipa',     // 'ipa' | 'form' — which chart tab is active
};
```

### renderMain()

Called whenever a language is selected or changes are applied. Rebuilds the right panel:

1. **Language form** — key, label, color inputs; Save button
2. **Chart tabs** — IPA Chart / Formant Plot, switchable
3. **Chart SVGs** — `langIpaSvg` and `langFormSvg` (built by `renderLangIpa()` and `renderLangFormant()`)
4. **Chart click handlers** — when editing, click on IPA chart sets `vowelDraft.h/b`; click on formant chart sets `vowelDraft.f1/f2`. Tracks a "diphthong click state" when `type==='diphthong'` to alternate between source and target position
5. **Inline vowel editor** (`#veInline`) — shown when `state.vowelIdx !== null`
6. **Vowel cards** — horizontal wrap of all vowels

### Chart geometry (editor — smaller viewBox 700×420)

```js
// IPA trapezoid
const LT = { TL:{x:90,y:42}, TR:{x:648,y:42}, BL:{x:234,y:378}, BR:{x:648,y:378} };
// ltPos(h, b)  → {x, y}
// ltHB(px, py) → {h, b}  (inverse — used for chart click → position)

// Formant plot
const LF = { x0:60, x1:685, y0:30, y1:390 };
// lfPos(f1, f2)  → {x, y}
// lfF1F2(px, py) → {f1, f2}  (inverse)
F1MIN=150, F1MAX=1000, F2MIN=400, F2MAX=2800  // same ranges as index.html
```

### Vowel editor (inline, `buildInlineForm`)

Built inline in the main panel whenever `state.vowelIdx !== null`. Rebuilds on `openVowelEditor(idx)`.

Sections:
1. **Header** — title ("Edit: /eɪ/" or "New Vowel"), Apply + Cancel buttons
2. **IPA preview + text input + picker grid** — clicking a glyph appends it to the IPA field; modifier buttons (ː ʲ etc.) insert at cursor position
3. **Description + Type dropdown + Rounded checkbox**
   - Type: `short | long | diphthong | variable`
   - When `diphthong`, h2/b2 fields appear for target position
4. **Coordinate inputs** — h, b, F1, F2 (as number inputs; chart clicks also update these)
5. **Audio URL + Wikipedia URL** — free-text URL inputs
6. **Words list** — each word: text (with HTML bold markup), audio URL, delete button; Add word button

All field changes call `refreshCharts()` immediately → both chart SVGs re-render with the draft vowel highlighted.

### `openVowelEditor(idx)`

- `idx = -1` → new vowel draft with default values
- `idx >= 0` → deep clone of `state.langDraft.vowels[idx]`
- Shows `#veInline`, rebuilds form, calls `renderVowelCards()` + `refreshCharts()`

### `applyVowel()`

Writes `state.vowelDraft` into `state.langDraft.vowels[idx]` (or pushes if new), calls `closeVowelEditor()` + `markUnsaved()`.

### `refreshCharts()`

```js
function refreshCharts() { renderLangIpa(); renderLangFormant(); }
```

Called on every vowel draft field change. Re-renders both charts with the draft vowel highlighted.

### `renderLangIpa()` / `renderLangFormant()` (in `js/editor-charts.js`)

Both follow the same pattern:
1. Draw grid (`drawGridIpa` or `drawGridFormant`)
2. Draw cardinal reference dots (`drawCardinalDots`) — small muted dots from the `cardinal` language
3. Build vowels array = `state.langDraft.vowels` with draft in place of original at `state.vowelIdx`
4. Call `drawVowelsOnChart()` which groups vowels by snapped position, draws dots, labels (skipping diphthong labels — those go on the arrow), and diphthong arrows via `drawDiphArrow()`

Active vowel (being edited) is highlighted: larger dot (`r=7` vs `r=5`), brighter label with glow filter, label is 17px vs 13px.

### File persistence

**`FileSystemDirectoryHandle`** (File System Access API):
- User clicks "📁 Connect lang/ folder" → `showDirectoryPicker({mode:'readwrite'})`
- Handle stored in IndexedDB (db: `ipa-editor`, key: `dirHandle`) so it survives page refresh
- On load: `tryRestoreHandle()` reads from IDB, checks `queryPermission` — if `granted`, silently restores without user interaction
- On save: writes `lang/{key}/lang.json` and updates `lang/index.json`
- Fallback (no handle): downloads `lang.json` to the user's Downloads folder

---

## js/utils.js — Shared Utilities

Used by both `index.html` and `editor.html`.

```js
const NS = 'http://www.w3.org/2000/svg';

$s(tag, attrs)       // createElementNS + setAttribute for all attrs
$t(str, attrs)       // $s('text') + textContent
ipaW(ipa, fontSize)  // estimated pixel width of IPA string (accounts for ː being narrow)
svgPt(svgEl, clientX, clientY)  // convert client coords → SVG viewBox coords
isDiph(v)            // v.type === 'diphthong' && v.h2 != null && v.b2 != null
encodeWAV(samples, sampleRate)   // Float32Array → Blob (audio/wav), mono, 16-bit PCM
```

---

## Tooltip system (inline in index.html)

`showTip(e, v, lang)` — single vowel tooltip. Shows IPA, language, description, `⊙ Rounded · long`, F1/F2, word example chips.

`showClusterTip(e, members)` — multi-vowel cluster tooltip. Shows one row per vowel (IPA + language + description + rounded·type + F1/F2 + words), plus "Click to choose which sound to play" hint.

`moveTip(e)` — repositions tooltip to follow cursor, clamped to viewport.

`hideTip()` — `display:none`.

---

## Disambiguation picker (inline in index.html)

`showPicker(cx, cy, group, svgId, dx, dy)` — fixed-position popup listing all vowels in a cluster. Each row: colored IPA symbol + language name + play button. Clicking plays that vowel's audio and fires `pulse()` at the original dot position.

`hidePicker()` — hides the picker. Also called from `document` click listener.

---

## Filter system (inline in index.html)

`passesFilters(lk, v)` — AND logic across all four filter dimensions:

- **Languages**: `filters.languages.has(lk)`, or empty = all pass
- **Roundness**: `filters.roundness.has('rounded'|'unrounded')`, or empty = all pass
- **Length**: multi-chip logic (see table in Data Format section):
  - `variable` vowels pass whenever Long or Short chip is active
  - Long/Short/Variable chips each have specific show/hide rules
  - Diphthong chip shows ONLY diphthongs; Monophthong chip shows everything except diphthongs
- **IPA Base**: `filters.ipaBase.has(getBase(v.ipa))`. `getBase` strips modifiers (ː etc.) and returns the first character

---

## CSS architecture

Both stylesheets use the same CSS custom properties:

```css
:root {
  --bg: #1a2636;      --surface: #213040;   --surface2: #253848;
  --border: #2e4560;  --muted: #6a8298;     --accent: #7eb8f7;
  --card: #1e2d40;    --input: #192736;
}
```

Scrollbars styled globally via `::-webkit-scrollbar` (thin, 6px, dark blue thumb) + Firefox `scrollbar-color`.

**index.css** — chart layout (chart-row, sidebar, chart-wrap, SVG panels), filter chips, detail cards (dcard-*), tooltip, picker, practice panel, diphthong-related styles.

**editor.css** — editor layout (top-bar, editor-layout, lang-sidebar, main-panel), form fields, IPA picker grid, vowel cards, waveform canvas, toast.

---

## Audio playback

### `playUrl(url)` / `playUrlAtRate(url, rate)`

Creates `new Audio(url)`, sets `playbackRate`, calls `.play()`. No global audio management — multiple sounds can overlap.

**Comparison mode hook**: when `isCompareMode()` is true (panel open + recording exists), both functions append `playSelection()` (the user's recording, sliced to the selected window) 350ms after the reference vowel ends.

### `playUrlAtRate` with diphthong rate toggle

Diphthongs track their own state in `_diphState[lk::ipa]`:
- Click → if >5s since last click: reset to normal speed; else toggle slow/normal
- Normal = 1.0×, slow = 0.5×

### Audio for local files

Paths are relative to `index.html`. Example: `lang/en/audio/words/feet.ogg`. Files must be served (not opened via `file://`), and the server must support range requests for audio seeking.

---

## Language loading

```js
async function loadLanguages() {
  // 1. fetch lang/index.json (cache-busted with ?t=timestamp)
  // 2. parallel fetch of lang/{name}/lang.json for each listed name
  // 3. Populate LANGS = { [key]: langObject }
  // 4. buildSidebar(); renderAll();
}
```

Reload button re-runs `loadLanguages()` with a fresh timestamp. The editor has its own equivalent that also restores the selected language.

---

## Key design decisions

**JSON data, not JS modules** — `lang.json` files are plain JSON, fetched at runtime. No build step. Any text editor can add a language.

**Shared `cardinal` language** — the 23 cardinal vowels live in `lang/cardinal/lang.json` like any other language. They appear on the chart when the Cardinal chip is active and always appear as reference dots in the editor.

**`type` field is explicit** — vowel length/type is not inferred from the IPA symbol. The JSON specifies it. This makes filtering reliable regardless of transcription conventions.

**Proximity clustering** — vowels within 22 SVG units share a cluster dot and disambiguation picker. This is computed fresh on every render from the current positions; no persistent cluster state.

**Diphthongs excluded from clustering** — diphthong vowels are separated before clustering and rendered as arrows. They appear as normal dots on the formant chart (using source F1/F2 only).

**Editor uses File System Access API** — direct write to the `lang/` folder without downloads. `FileSystemDirectoryHandle` is persisted to IndexedDB so re-granting permission after page refresh is unnecessary (if the browser retains the grant).

**Practice panel requires HTTPS** — `navigator.mediaDevices.getUserMedia` is only available in secure contexts (HTTPS or localhost). Plain HTTP deployments will get a "Mic error" on the record button.

**analyze_server.py is local only** — the server runs on `localhost:5050` and is started manually. The HTML checks `/ping` on panel open. CORS is restricted to localhost origins.