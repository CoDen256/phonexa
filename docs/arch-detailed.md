# IPA Vowel Chart — Architecture

A browser-only interactive IPA vowel chart with multi-language support, a language editor, and a pronunciation practice tool backed by a local Python analysis server.

---

## Project Goals

- Display IPA vowels from multiple languages simultaneously on a shared trapezoid chart and a formant (F1/F2) plot
- Allow filtering by language, roundness, vowel length, and IPA base symbol
- Support clicking vowels to play audio; diphthongs shown as animated arrows
- Provide a language editor to create/edit language JSON files in-browser with file-system access
- Allow recording your own voice, comparing it to reference vowels, and analysing F1/F2 formants via a local Python server
- Stream microphone audio in real time to the server and receive per-frame formant estimates

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
<script src="js/realtime.js"></script>      <!-- depends on: utils.js, practice.js -->
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

### Server communication — `analyzeWav(wavBlob, signal)`

Single helper used by both the user-recording and reference-vowel analyse buttons:

```js
async function analyzeWav(wavBlob, signal) {
  const form = new FormData();
  form.append('file', wavBlob, 'audio.wav');
  form.append('config', JSON.stringify({ single_segment: true }));
  const resp  = await fetch(SERVER + '/frames', { method: 'POST', body: form, signal });
  const data  = await resp.json();
  const frame = data.frames?.[0];
  if (!frame?.voiced) throw new Error('No voiced speech detected');
  return frame;   // caller reads frame.f1, frame.f2
}
```

The client pre-slices the waveform to the selected window before calling `analyzeWav`, so `single_segment: true` instructs the server to treat the whole uploaded clip as one analysis segment (no slice fractions needed).

### `encodeWAV(samples, sampleRate)`

Pure JS WAV encoder. Writes a 44-byte RIFF/WAVE/fmt/data header then 16-bit signed PCM samples. Always mono. Output: `Blob` with `type:'audio/wav'`. Lives in `js/utils.js` and is shared with `realtime.js`.

---

## js/realtime.js — Real-time Streaming

### Constants

```js
const HTTP_URL   = 'http://localhost:5050';
const STREAM_URL = 'ws://localhost:5051';
```

### WebSocket streaming — `_openStream()` / `analyzeSynthBuffer()`

`_openStream()` opens a persistent WebSocket to `:5051`. On connection it sends `{type:'init', sample_rate}` and then binary int16 PCM chunks at 128 samples per message.

`analyzeSynthBuffer({buffer, sampleRate})` — encodes a synthesised `AudioBuffer` as WAV and POSTs it to `/frames` with `single_segment: true` and `slice_start: 0.1, slice_end: 0.9` (trim 10% from each end):

```js
const form = new FormData();
form.append('file', wav, 'audio.wav');
form.append('config', JSON.stringify({
  single_segment: true, slice_start: 0.1, slice_end: 0.9
}));
const resp  = await fetch(`${HTTP_URL}/frames`, { method: 'POST', body: form });
const frame = (await resp.json()).frames?.[0];
```

### `verifyFromIpaAudio(audio)`

Fetches a language's IPA audio file, decodes it, and posts to `/frames` with `slice_start: 0.15, slice_end: 0.85` to compare the measured F1/F2 against the JSON-declared values. Uses `FormData` multipart:

```js
const form = new FormData();
form.append('file', wav, 'audio.wav');
form.append('config', JSON.stringify({
  single_segment: true, slice_start: 0.15, slice_end: 0.85
}));
const sData   = await fetch(`${HTTP_URL}/frames`, { method: 'POST', body: form }).then(r => r.json());
const measured = sData.frames?.[0] ?? {};
```

### `debugVowel(url)`

Posts audio to `/debug` and logs the raw three-config Praat output to the console:

```js
const form = new FormData();
form.append('file', wav, 'audio.wav');
form.append('config', JSON.stringify({ slice_start: 0.15, slice_end: 0.85 }));
const r = await fetch(`${HTTP_URL}/debug`, { method: 'POST', body: form });
```

---

## analyze_server.py — Local Formant Analysis Server

Flask HTTP server on `:5050` and a `websockets` server on `:5051`. Start with:

```bash
pip install flask flask-cors parselmouth numpy websockets
python analyze_server.py
```

Both servers share the same analysis pipeline (`analyse_segment_to_frame`). The HTTP server handles file-based one-shot or sliding-window requests; the WebSocket server handles continuous microphone streaming.

### Key constants

```python
SEGMENT_SAMPLES = 4096   # ring buffer / default window — ~93 ms at 44 100 Hz
SEGMENT_STEP_MS = 10     # ms between analyses in the stream
F1_VALID_RANGE  = (80,  1200)
F2_VALID_RANGE  = (400, 3200)
```

---

### `ConnConfig` — All tunable analysis parameters

```python
@dataclass
class ConnConfig:
    # SCAN (primary — wide ceiling, many poles)
    max_f:        float = 5000    # Praat maximum_formant
    n_formants:   int   = 5       # Praat max_number_of_formants
    window_ms:    float = 25      # Praat window_length
    pre_emphasis: float = 50      # Praat pre_emphasis_from

    # BACK (back-vowel disambiguation — narrow ceiling, 2 poles)
    back_ceiling:       float = 1800   # Praat maximum_formant for BACK pass
    back_ceiling_ratio: float = 0.95   # BACK wins only if F2_back < ceiling × ratio
    back_front_ratio:   float = 0.75   # BACK wins only if F2_back < F2_scan × ratio
    back_hard_max:      float = 850    # absolute cap — blocks BACK for /e/ spurious poles
    back_max_bw:        float = 300    # max bandwidth for BACK F2 — rejects ghost poles

    # Energy gate
    rms_floor: float = 0.005   # skip Praat below this RMS; 0 = disabled

    # Sliding median (stream only)
    median_n: int = 5

    # Segment layout (HTTP /frames only)
    single_segment:  bool = True    # True  = whole slice is one segment → one frame
    segment_samples: int  = 4096    # window size in samples (when single_segment=False)
    segment_step_ms: int  = 10      # step between windows in ms (when single_segment=False)
```

`update_from_dict(d)` applies a dict of overrides, coercing each value to the field's declared type. Booleans use `bool(value)` to avoid `bool('false') == True`. Sent live by the stream client as `{type:'config', …}` messages.

---

### `SegmentInfo` — Positional DTO

Passed through the full analysis pipeline instead of six positional arguments:

```python
@dataclass
class SegmentInfo:
    at_ms:       int    # end position in ms from slice/stream start
    at:          int    # end position in samples
    index:       int    # sequential index within the slice/stream
    samples:     int    # number of samples in this segment
    duration_ms: float  # = samples / sample_rate × 1000
    step_ms:     int    # step between consecutive segments in ms
```

---

### HTTP endpoints (`Flask`, `:5050`)

---

#### `GET /ping`

Returns `{"ok": true}`. Used by the browser to check server connectivity before showing "✓ Server connected".

---

#### `POST /frames`

The primary analysis endpoint. Accepts a multipart form body:

| Field | Type | Description |
|-------|------|-------------|
| `file` | file upload | Audio data — any format parselmouth supports (WAV, MP3, FLAC, OGG) **or** raw int16 PCM (detected by magic bytes; anything not starting with a known audio container header is treated as PCM) |
| `config` | JSON string | All `ConnConfig` fields plus `sample_rate` (int, default 44100, used only for raw PCM) |
| `slice_start` | float form field | Start fraction of the audio to analyse (default `0.0`) |
| `slice_end` | float form field | End fraction (default `1.0`) |

**Segment mode** (controlled by `single_segment` in `config`):

| `single_segment` | Behaviour |
|-----------------|-----------|
| `true` (default) | The entire slice is one segment → exactly one frame returned. Equivalent to the former `/analyze` endpoint. Use when the client has already trimmed the audio to the desired window. |
| `false` | Sliding window: `segment_samples`-wide window steps by `segment_step_ms` across the slice → multiple frames returned. Use for timeline visualisation. |

**Response:**

```json
{
  "audio_duration_ms": 676.8,
  "slice": {
    "start": 0.15, "end": 0.85,
    "start_ms": 101.5, "end_ms": 575.3,
    "duration_ms": 473.8, "samples": 20892
  },
  "frames": [ /* array of frame objects */ ]
}
```

**Frame object** (one per analysis window):

```json
{
  "segment": {
    "at_ms": 575,       "at": 20892,
    "index": 0,         "samples": 20892,
    "duration_ms": 473.8, "step_ms": 473,
    "is_valid_duration": true
  },
  "voiced": true,
  "rms": 0.055,
  "is_above_rms": true,
  "f1": 325,            "f2": 592,
  "f1_median": 325,     "f2_median": 592,
  "f1_raw": 325,        "f2_raw": 592,
  "f1_back": 591.2,     "f2_back": 591.2,
  "f1_scan": 325.4,     "f2_scan": 2744.1,
  "used_back_config": true,
  "phantom_fix_applied": false,
  "is_valid_f1_range": true,
  "is_valid_f2_range": true,
  "median_n": 5
}
```

For a `rms < rms_floor` (silent) frame, only `segment`, `voiced: false`, `rms`, and `is_above_rms: false` are present.

---

#### `POST /debug`

Raw Praat diagnostic endpoint. Same multipart input as `/frames` (`file` + `config`). `slice_start` / `slice_end` are extra keys inside `config` (default 0.15 / 0.85). Does **not** use the shared analysis pipeline — all three Praat configurations are called explicitly so intermediate values are fully visible.

**Response:**

```json
{
  "sample_rate": 44100,
  "duration_ms": 474,
  "analysis_t_ms": 237,
  "slice_start": 0.15,
  "slice_end": 0.85,
  "configs": {
    "FRONT": { "ceiling": 5500, "n": 5, "formants": {"F1": 310.2, "BW1": 62.1, "F2": 2388.5, "BW2": 184.3, ...} },
    "BACK":  { "ceiling": 1800, "n": 2, "formants": {"F1": 312.0, "BW1": 59.8, "F2": 591.4,  "BW2": 71.2} },
    "SCAN":  { "ceiling": 5000, "n": 5, "formants": {"F1": 310.5, "BW1": 61.0, "F2": 2744.1, "BW2": 220.9, ...} }
  }
}
```

---

### WebSocket stream server (`websockets`, `:5051`)

Handles one persistent connection per client. The client sends 128-sample int16 binary chunks continuously; the server accumulates them in a 4096-sample ring buffer and emits a frame JSON message every `SEGMENT_STEP_MS` (10 ms) of new audio.

**Control messages (client → server, JSON text):**

| Message | Effect |
|---------|--------|
| `{"type":"init", "sample_rate": 44100}` | Full restart: new session, flush ring buffer and analysis state |
| `{"type":"reset"}` | Flush analysis state (continuity + median), keep config and ring buffer |
| `{"type":"config", "rms_floor": 0.005, …}` | Live-update any `ConnConfig` field; takes effect on the next analysis |

**Frame output (server → client, JSON text):**

Same structure as the `/frames` frame object, with the following differences:
- `segment.step_ms` is always `SEGMENT_STEP_MS` (10)
- `f1_median` / `f2_median` are populated using the server-side sliding median of `median_n` frames
- The stream always uses `SEGMENT_SAMPLES = 4096` and cannot be resized after init

**Frame states:**

| State | Condition | Fields present |
|-------|-----------|---------------|
| A — silent | `rms < rms_floor` | `segment`, `voiced: false`, `rms`, `is_above_rms: false` |
| B — unvoiced | Praat ran, no valid formants | All fields; `voiced: false`, formant fields `null` |
| C — voiced | Valid F1/F2 found | All fields; `voiced: true`, `f1`/`f2`/`f1_median`/`f2_median` populated |

---

### Audio loading — `decode_audio(audio_data, sample_rate_hint)`

Accepts either bytes or a Flask file upload object. Detection by magic bytes:

| Magic bytes | Format | Decoding |
|-------------|--------|----------|
| `RIFF` | WAV | temp file → `parselmouth.Sound` |
| `FORM` | AIFF | temp file → `parselmouth.Sound` |
| `fLaC` | FLAC | temp file → `parselmouth.Sound` |
| `OggS` | OGG | temp file → `parselmouth.Sound` |
| `ID3` / `\xff\xfb` | MP3 | temp file → `parselmouth.Sound` |
| anything else | raw int16 PCM | `np.frombuffer(..., dtype=np.int16) / 32768.0`; sample rate from `sample_rate_hint` |

---

### Formant analysis pipeline

Every frame — whether from `/frames` or `/stream` — passes through `analyse_segment_to_frame(segment, sample_rate, seg, config, state)`.

#### Step 1 — Energy gate

```
RMS(segment) < config.rms_floor  →  return silent frame A (skip Praat)
```

#### Step 2 — Dual-ceiling Praat LPC

Two `to_formant_burg()` calls on the same audio segment:

| Config | `max_number_of_formants` | `maximum_formant` | Purpose |
|--------|--------------------------|-------------------|---------|
| BACK   | 2 | `back_ceiling` (1800 Hz) | Back-vowel disambiguation: with only 2 poles and a narrow ceiling, Praat reliably finds F1 + a low F2 for /u/, /o/ etc. |
| SCAN   | `n_formants` (5) | `max_f` (5000 Hz) | General-purpose: handles all vowels; correct for front vowels but confuses F3 for F2 in back vowels |

#### Step 3 — `select_best_formants(f1_back, f2_back, f1_scan, f2_scan, config)`

BACK wins (its F2 is used) when **all** of:
1. Both BACK and SCAN returned results
2. `f2_back < back_ceiling × back_ceiling_ratio` — F2 is well below the ceiling (not a ceiling artefact)
3. `f2_back < f2_scan × back_front_ratio` — F2 is substantially lower than SCAN's (back vowel pattern)
4. `f2_back < back_hard_max` — absolute cap; blocks spurious ~900 Hz poles for /e/

If BACK doesn't win: SCAN is used. If SCAN also failed: BACK is used as a last resort. If both failed: `(None, None)` — frame B.

#### Step 4 — `fix_phantom_resonance(f1, f2, sound, config, f2_back)`

Corrects a phantom LPC pole that appears between F1 and the real F2 for close front vowels (/i/, /y/).

**Suppress entirely** if `f2_back` is in 350–1000 Hz (BACK already found a credible F2; the selected value is likely correct).

**Standard phantom condition** — fires when `f1 < 350 Hz AND f2/f1 < 1.7`:
Re-scans with more poles and returns the first candidate `> f1 × 2.0` within `F2_VALID_RANGE`.

**Back-vowel rescue** — fires when `f2_back is None AND f1 < 350 AND f2 > 2600`:
The pattern of low F1, no BACK result, and very high SCAN F2 indicates SCAN labelled /u/'s F3 as F2. Retries with a narrow-ceiling LPC (`back_ceiling × 0.65`) to isolate F1 (~300 Hz) and F2 (~600 Hz).

#### Step 5 — Validity checks

```
is_valid_f1_range = F1_VALID_RANGE[0] <= f1_raw <= F1_VALID_RANGE[1]
is_valid_f2_range = F2_VALID_RANGE[0] <= f2_raw <= F2_VALID_RANGE[1]
voiced            = both ranges valid
```

#### Step 6 — `AnalysisState.apply_voiced(f1_raw, f2_raw)` (continuity + median)

Only for voiced frames:

1. **Continuity** (`ConnState`): if `f1_new > f2_prev` or `f2_new < f1_prev`, the tracks have crossed — swap F1/F2 to maintain continuity
2. **Sliding median** (`deque` of `median_n` values per formant): JS-style rounding (`math.floor(x + 0.5)`) to match the browser-side smoothing

Returns `(f1, f2, f1_median, f2_median)` as rounded integers.

---

## tests/server_tests.py — Regression and Calibration Test Suite

```bash
# Run a test layer
python tests/server_tests.py single_frame           # Layer 1 — /frames one-frame mode
python tests/server_tests.py frames                 # Layer 2 — /frames sliding window
python tests/server_tests.py debug                  # Layer 3 — /debug raw Praat
python tests/server_tests.py stream                 # Layer 4 — /stream per-frame
python tests/server_tests.py stream_median_stability # Layer 5 — stable vowel position

# Update saved references
python tests/server_tests.py stream --update

# Compare current output against saved references
python tests/server_tests.py compare

# Calibration: F1/F2 accuracy + stream vs /frames consistency
python tests/server_tests.py --calibrate              # all VOWEL_EXPECTED entries
python tests/server_tests.py --calibrate u_practice   # one case
```

### Test layers

| Layer | Command | What it tests |
|-------|---------|--------------|
| 1 | `single_frame` | `/frames` with `single_segment: true`; checks `f1`/`f2` within tolerance against saved reference |
| 2 | `frames` | `/frames` with `single_segment: false` (sliding window); checks per-frame formant values |
| 3 | `debug` | `/debug` raw Praat output; checks FRONT/BACK/SCAN pole values |
| 4 | `stream` | WebSocket stream; checks per-frame `f1`, `f1_median`, `rms`, `voiced`, flags |
| 5 | `stream_median_stability` | Steady-state vowel recording; checks that the median dot stays within ±50 Hz of expected position |

### Calibration layer (`--calibrate`)

Reads saved reference JSON files from `test/references/stream/` and `test/references/frames/` without running a live server. For each `case_id` in `VOWEL_EXPECTED`:

- **Per-endpoint accuracy**: count voiced frames where F1 and F2 fall within `VOWEL_EXPECTED[id]` ranges; display as percentage with `✓` / `~` / `✗`
- **F2 distribution**: bucket counts (`<600`, `600–900`, `900–1500`, `>1500`) plus mean and median
- **Root-cause breakdown** of out-of-range frames:
    - `back_none` — BACK config returned `None`, SCAN picked wrong value
    - `phantom_bad` — phantom fix fired and returned wrong pole
    - `criterion_miss` — BACK had a value but selection criterion didn't choose it
- **Cross-endpoint consistency**: mean F1/F2 Δ between `/stream` and `/frames` references; pass if both Δ ≤ `CROSS_ENDPOINT_TOL_HZ` (50 Hz)

```python
VOWEL_EXPECTED = {
    'u':          {'f1': (200, 500), 'f2': (400,  900)},
    'u_practice': {'f1': (200, 500), 'f2': (400,  900)},
    'i':          {'f1': (150, 400), 'f2': (1800, 2900)},
    'a':          {'f1': (550, 950), 'f2': (1000, 2100)},
    ...
}
```

### Reference files

```
test/references/
  single_frame/   {case_id}.json
  frames/         {case_id}.json
  debug/          {case_id}.json
  stream/         {case_id}.json
  stream_median_stability/  {case_id}.json

test/resources/
  live_speech.wav
  u_practice.wav
  lang/me/audio/i.wav
  lang/me/audio/u.wav
  ...
```

### Test config defaults

```python
DEFAULT_CONN_CONFIG = {
    'max_f': 5000, 'n_formants': 5, 'window_ms': 25, 'pre_emphasis': 50,
    'back_ceiling': 1200, 'back_ceiling_ratio': 0.95, 'back_front_ratio': 0.75,
    'back_hard_max': 850,
    'rms_floor': 0,      # gate disabled — every window analysed
    'median_n': 5,
    'single_segment': False, 'segment_samples': 4096, 'segment_step_ms': 10,
}
```

`rms_floor: 0` ensures all audio windows are analysed regardless of recording volume, giving deterministic results for regression testing. `single_segment: False` is the test default so `frames` cases produce multiple frames; `single_frame` cases explicitly override to `single_segment: True`.

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

**Multipart form data for all server requests** — all HTTP analysis endpoints (`/frames`, `/debug`) accept `multipart/form-data` with a `file` field and a `config` JSON field. Audio format is detected from magic bytes (WAV/AIFF/FLAC/OGG/MP3 → parselmouth; anything else → raw int16 PCM). This unifies file and raw-PCM inputs and keeps all parameters in one place.

**Single-segment mode is the HTTP default** — `ConnConfig.single_segment = True`. Sending a pre-trimmed WAV with no config override yields exactly one frame for the whole clip — the common case for practice panel and IPA audio verification. Sliding-window mode requires explicitly setting `single_segment: false`.

**Dual-ceiling formant analysis** — every segment is analysed by two independent Praat LPC passes (SCAN: wide ceiling/many poles; BACK: narrow ceiling/2 poles). The selection criterion prefers BACK when its F2 is below the ceiling threshold and substantially lower than SCAN's, correcting F3-as-F2 confusion for back vowels. A post-selection phantom-resonance fix handles the complementary error for close front vowels.

**`SegmentInfo` DTO** — positional metadata (`at_ms`, `at`, `index`, `samples`, `duration_ms`, `step_ms`) for one analysis window is bundled into a single dataclass and passed through the pipeline, avoiding long positional argument lists and making the frame output self-describing.

**Shared pipeline for HTTP and WebSocket** — `analyse_segment_to_frame(segment, sample_rate, seg, config, state)` is the single entry point used by both `/frames` and the WebSocket stream handler. The only difference is how the segment is obtained (sliced from file vs accumulated in a ring buffer) and whether continuity/median state persists across calls.