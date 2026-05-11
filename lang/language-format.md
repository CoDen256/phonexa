# Language Format

Language data lives in `lang/{key}/lang.json`. The chart discovers languages via `lang/index.json`.

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
  "label":  "English",
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
  "ipa":      "iː",
  "h":        0.03,
  "b":        0.04,
  "rounded":  false,
  "type":     "long",
  "desc":     "Close front unrounded (long)",
  "f1":       270,
  "f2":       2290,
  "ipaAudio": "https://commons.wikimedia.org/wiki/Special:Redirect/file/Close_front_unrounded_vowel.ogg",
  "wikiUrl":  "https://en.wikipedia.org/wiki/Close_front_unrounded_vowel",
  "words": [
    { "text": "f<b>ee</b>t", "audio": "https://…/En-us-feet.ogg" },
    { "text": "s<b>ee</b>n", "audio": null }
  ]
}
```

### Position fields

| Field | Type   | Required | Description |
|-------|--------|----------|-------------|
| `h`   | float  | yes      | Height on IPA trapezoid. `0` = Close (top), `1` = Open (bottom) |
| `b`   | float  | yes      | Backness on IPA trapezoid. `0` = Front (left), `1` = Back (right) |
| `f1`  | number | no       | First formant in Hz. Required to appear on the formant plot |
| `f2`  | number | no       | Second formant in Hz. Required to appear on the formant plot |

### Descriptor fields

| Field      | Type    | Required | Description |
|------------|---------|----------|-------------|
| `ipa`      | string  | yes      | IPA symbol(s) displayed on chart and in tooltips |
| `rounded`  | boolean | yes      | Lip rounding. Determines label placement: rounded → right of dot, unrounded → left |
| `type`     | string  | yes      | See **Vowel types** below |
| `desc`     | string  | no       | Articulatory description shown in tooltip |
| `ipaAudio` | string  | no       | URL to audio of the isolated vowel sound |
| `wikiUrl`  | string  | no       | Wikipedia link (unused in UI currently, stored for reference) |
| `words`    | array   | no       | Example words. `text` supports inline HTML (`<b>` for the vowel portion). `audio` can be `null` |

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

Diphthongs are monophthongs with two additional fields for the **target position** on the IPA trapezoid. The formant values (`f1`, `f2`) represent the source position only.

```json
{
  "ipa":  "eɪ",
  "h":    0.30,
  "b":    0.04,
  "h2":   0.20,
  "b2":   0.18,
  "type": "diphthong",
  "rounded": false,
  "desc": "Close-mid front unrounded → near-close near-front (diphthong)",
  "f1":   430,
  "f2":   2090,
  "ipaAudio": "https://…",
  "words": [ { "text": "f<b>a</b>ce", "audio": "https://…" } ]
}
```

| Field | Description |
|-------|-------------|
| `h`, `b`   | Source position on the IPA trapezoid |
| `h2`, `b2` | Target position. Both required for diphthong arrow to render |

On the **IPA chart**: rendered as a straight arrow from `(h,b)` to `(h2,b2)` with the IPA label placed beside the midpoint.  
On the **formant plot**: rendered as a regular dot at `(f1, f2)` — only the source position is plotted.

---

## Local audio files

Audio URLs can point to local files instead of remote URLs. Paths are relative to `index.html`:

```json
"ipaAudio": "lang/en/audio/vowels/ii-long.ogg",
"audio":    "lang/en/audio/words/feet.ogg"
```

Supported formats: `.ogg`, `.mp3`, `.wav` (browser-dependent; Ogg Vorbis works in all modern browsers).

Files must be served over HTTP(S) — `file://` URLs block audio due to CORS restrictions. Use any static file server (e.g. `python3 -m http.server`).

---

## Cardinal vowels (`lang/cardinal/lang.json`)

The cardinal language behaves like any other language but is treated as a reference layer:
- Always loaded, regardless of the language filter
- Rendered in a muted style (lower opacity, smaller dots) beneath language vowels
- Shown as small reference dots in the language editor charts

The 23 standard cardinal vowels cover the full IPA vowel space and provide a stable reference frame for comparing languages.

---

## Adding a new language

1. Create a folder: `lang/{key}/`
2. Copy `lang/_template/lang.json` and fill in your vowels
3. Add `"{key}"` to the `languages` array in `lang/index.json`
4. Click **Reload languages** in the chart, or use the editor

The editor can create and save all of this directly — connect a folder via **📁 Connect lang/ folder**, then use **+ New Language**.
