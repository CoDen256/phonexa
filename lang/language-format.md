# Language Format

Language data lives in `lang/{key}/lang.json`. Samples live in `lang/{key}/samples.json`.
The chart discovers languages via `lang/index.json`.

---

## `lang/index.json`

Lists which language folders are active. Adding a language is just adding its folder name here.

```json
{
  "languages": ["cardinal", "en", "de", "ru", "no"]
}
```

Folder names starting with `_` are skipped (useful for `_template`, draft languages, etc.).

---

## `lang/{key}/lang.json`

```json
{
  "key":    "en",
  "label":  "English (GA)",
  "color":  "#60a5fa",
  "vowels": [ ]
}
```

| Field    | Type   | Description |
|----------|--------|-------------|
| `key`    | string | Unique identifier; must match the folder name |
| `label`  | string | Display name shown in UI |
| `color`  | string | CSS color used for all dots, labels, and chips for this language |
| `vowels` | array  | Ordered list of vowel objects |

---

## Vowel object — monophthong

```json
{
  "symbols":        ["iː", "i"],
  "heightBackness": [0.03, 0.04],
  "type":           "long",
  "rounded":        false,
  "desc":           "Close front unrounded (long)",
  "f1":             270,
  "f2":             2290,
  "audio":          null,
  "wikiUrl":        "https://en.wikipedia.org/wiki/Close_front_unrounded_vowel",
  "target":         null
}
```

### Fields

| Field            | Type         | Required | Description |
|------------------|--------------|----------|-------------|
| `symbols`        | string[]     | yes      | IPA symbol(s). First element is the canonical symbol used as identifier and displayed on chart. Subsequent elements are alternative notations |
| `heightBackness` | `[h, b]`     | yes      | Position on IPA trapezoid. `h`: `0` = Close (top), `1` = Open (bottom). `b`: `0` = Front (left), `1` = Back (right) |
| `type`           | string       | yes      | See **Vowel types** below |
| `rounded`        | boolean      | yes      | Lip rounding of this vowel. Determines label placement: rounded → right of dot, unrounded → left |
| `desc`           | string       | no       | Articulatory description shown in tooltip |
| `f1`             | number/null  | no       | Average first formant in Hz across all tokens. `null` if not measured yet |
| `f2`             | number/null  | no       | Average second formant in Hz across all tokens. `null` if not measured yet |
| `audio`          | string/null  | no       | URL or path to audio representing the average/canonical realisation — either synthesized from `f1`/`f2` or a curated human recording. If `null`, the UI synthesizes from `f1`/`f2` when the formant chart is open. Clicking the vowel plays the first token from `samples.json` instead |
| `wikiUrl`        | string       | no       | Wikipedia link (stored for reference, unused in UI currently) |
| `target`         | object/null  | yes      | `null` for monophthongs. For diphthongs, see **Diphthong target** below |

### Vowel types

The `type` field controls both rendering and filter behaviour. It is **always explicit** — never inferred from the IPA symbol.

| Value       | Rendered as | Filter chips that show it |
|-------------|-------------|--------------------------|
| `short`     | Dot + label | Monophthong, Short, Variable |
| `long`      | Dot + label | Monophthong, Long, Variable |
| `variable`  | Dot + label | Monophthong, Long, Short, Variable — shown whenever any non-diphthong length chip is active |
| `diphthong` | Arrow       | Diphthong only |

---

## Vowel object — diphthong

A diphthong is a vowel with `"type": "diphthong"` and a `target` object describing the endpoint of the glide. The top-level `heightBackness`, `rounded`, `f1`, and `f2` fields describe the **source** (start) of the glide.

```json
{
  "symbols":        ["eɪ"],
  "heightBackness": [0.40, 0.02],
  "type":           "diphthong",
  "rounded":        false,
  "desc":           "Diphthong e → ɪ",
  "f1":             476,
  "f2":             2089,
  "audio":          null,
  "wikiUrl":        "https://en.wikipedia.org/wiki/Close-mid_front_unrounded_vowel",
  "target": {
    "heightBackness": [0.25, 0.20],
    "rounded":        false,
    "f1":             429,
    "f2":             2033
  }
}
```

### Diphthong target fields

| Field                    | Type        | Description |
|--------------------------|-------------|-------------|
| `target.heightBackness`  | `[h, b]`    | Position of the glide endpoint on the IPA trapezoid |
| `target.rounded`         | boolean     | Lip rounding of the target vowel (may differ from the source) |
| `target.f1`              | number/null | Average F1 of the target vowel in Hz. `null` if not measured |
| `target.f2`              | number/null | Average F2 of the target vowel in Hz. `null` if not measured |

On the **IPA chart**: rendered as an arrow from `heightBackness` to `target.heightBackness` with the IPA label beside the midpoint.  
On the **formant plot**: rendered as a dot at `(f1, f2)` — the source position only.

---

## Cardinal vowels (`lang/cardinal/lang.json`)

The cardinal language behaves like any other language but is treated as a reference layer:
- Always loaded, regardless of the language filter
- Rendered in a muted style (lower opacity, smaller dots) beneath language vowels
- Shown as small reference dots in the language editor charts
- Has `audio` populated with canonical Wikipedia recordings; no `samples.json`

---

## `lang/{key}/samples.json`

A flat array of sample objects. Each sample is a word, phrase, or isolated vowel recording
in which one or more vowel tokens are identified.

The **first sample** whose token matches a vowel's `symbols[0]` is the representative
isolated recording and is what plays when the user clicks that vowel on the chart.

```json
[
  {
    "text":     "feet",
    "audio":    "lang/en/audio/words/feet.ogg",
    "phonemic": "/fiːt/",
    "tokens": [
      {
        "symbol":   "i",
        "position": [1, 3],
        "analysis": {
          "slice":        [80, 320],
          "f1":           265,
          "f2":           2310,
          "ceiling":      5500,
          "preEmphasis":  50,
          "maxFormants":  5,
          "windowLength": 25
        }
      }
    ]
  }
]
```

### Sample fields

| Field      | Type        | Required | Description |
|------------|-------------|----------|-------------|
| `text`     | string      | yes      | Plain text of the sample (no HTML markup). For isolated vowel recordings this is the IPA symbol itself |
| `audio`    | string/null | no       | URL or path to audio of this sample |
| `phonemic` | string/null | no       | Phonemic transcription in `/.../` notation. Set for isolated vowel samples (`/i/`, `/uː/`); `null` for word samples that haven't been transcribed |
| `tokens`   | array       | yes      | List of vowel tokens identified in this sample |

### Token fields

| Field      | Type           | Required | Description |
|------------|----------------|----------|-------------|
| `symbol`   | string         | yes      | IPA symbol of the vowel; must match `symbols[0]` of a vowel in `lang.json` |
| `position` | `[start, end]` | yes      | Start (inclusive) and end (exclusive) character indices in `text` where this token appears. Used by the UI to highlight the vowel portion |
| `analysis` | object/null    | no       | Acoustic analysis for this token. `null` if not yet measured |

### Analysis fields

| Field          | Type           | Description |
|----------------|----------------|-------------|
| `slice`        | `[start, end]` | Start and end of the token in milliseconds within the sample's `audio` |
| `f1`           | number         | Measured first formant frequency (Hz) for this token |
| `f2`           | number         | Measured second formant frequency (Hz) for this token |
| `ceiling`      | number         | Max formant ceiling used in Praat analysis (Hz). Corresponds to `ConnConfig.max_f` |
| `preEmphasis`  | number         | Pre-emphasis frequency used (Hz). Corresponds to `ConnConfig.pre_emphasis` |
| `maxFormants`  | number         | Maximum number of formants requested from Praat. Corresponds to `ConnConfig.n_formants` |
| `windowLength` | number         | Praat analysis window length (ms). Corresponds to `ConnConfig.window_ms` |

---

## Relationship between `f1`/`f2` in lang.json and analysis in samples.json

- `lang.json` `f1`/`f2` — **average** formant values across all or representative tokens. Used for chart positioning and synthesis. Filled in manually or computed from token analyses.
- `samples.json` token `analysis.f1`/`analysis.f2` — **measured** formant values for that specific token in that specific recording, with the exact analysis parameters recorded. Source of truth for individual realisations.

---

## Local audio files

Audio URLs can point to local files instead of remote URLs. Paths are relative to `index.html`:

```json
"audio": "lang/en/audio/words/feet.ogg"
```

Supported formats: `.ogg`, `.mp3`, `.wav` (browser-dependent; Ogg Vorbis works in all modern browsers).

Files must be served over HTTP(S) — `file://` URLs block audio due to CORS restrictions.

---

## Adding a new language

1. Create a folder: `lang/{key}/`
2. Copy `lang/_template/lang.json` and fill in your vowels
3. Optionally create `lang/{key}/samples.json` with token examples
4. Add `"{key}"` to the `languages` array in `lang/index.json`
5. Click **Reload languages** in the chart, or use the editor