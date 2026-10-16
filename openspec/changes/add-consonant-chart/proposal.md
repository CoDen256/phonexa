> **Mockup**: `mockup.html` in this change directory is the validated interactive design exploration (grid + strip views, real 4-language dataset) this proposal formalizes. Open it directly in a browser.

## Why

The app's entire IPA toolset (chart, editor, practice panel) covers vowels only — there is no way to browse, compare, or teach consonant inventories across languages, even though consonants are half of any phonology. Place-of-articulation terminology also genuinely overlaps (a flat list like "Dental, Apical, Laminal, Alveolar..." mixes *where* a sound is made with *what part of the tongue* makes it), which is exactly why no clean consonant data model exists yet. A validated UI/UX mockup (grid + per-language strip, with an unambiguous feature model) already exists from design exploration — this proposal turns it into a shippable, read-only browsing feature.

## What Changes

- Add a new consonant chart page (parallel to `index.html`'s vowel chart) with two views:
  - **Overview grid**: place (columns) × manner (rows), cells hold color-coded pills (one per distinct phone per language), each showing a voicing dot and a fully-composed IPA symbol (base letter + computed diacritics).
  - **Per-language strip**: pick one language, see its full consonant inventory grouped by manner as cards — mirrors the existing vowel chart's `renderDetail()` card pattern.
- Add a `Consonant` schema entity (new table, not a reuse of `Vowel` — none of `height/backness/f1/f2` apply) with explicit fields for manner, passive place, active articulator, voicing, secondary articulation (multi-valued), syllabicity, and optional co-articulated place.
- Add filter/highlight controls across four dimensions (language, secondary articulation, active articulator, voicing, syllabicity), reusing the existing vowel chart's `passesFilters` Set-based philosophy (AND across categories, OR within a category) — as a highlight/dim treatment rather than a hard hide, since the goal is cross-language comparison, not narrowing.
- Add a symbol-composition function that derives every diacritic (secondary-articulation superscripts, velarized/pharyngealized tilde overlay, active-articulator underscripts, syllabic mark) from the feature fields — never hand-baked into a stored symbol string.
- Seed initial data (English/German/Russian/French, ~70 phones) via a one-off script, matching the existing `lang/*.json` → DB migration precedent.

**Out of scope / non-goals** (explicitly deferred, not forgotten):
- No practice panel, recording, or comparison flow for consonants.
- No acoustic scoring of any kind (VOT, spectral centroid, formant transitions) — a manner-specific research problem, not a UI feature.
- No `editor.html` CRUD UI for consonants — data entry is migration/seed-script only in this change.
- No changes to any existing vowel page (chart, editor, practice panel, drill).

## Capabilities

### New Capabilities
- `consonant-inventory`: the `Consonant` data model — schema, feature taxonomy (passive place / active articulator / secondary articulation / voicing / syllabicity / co-articulation), and the symbol-composition rules that render a phone's full IPA representation from its feature fields.
- `consonant-chart-ui`: the browsing UI itself — the overview grid, the per-language strip, the four-dimension filter/highlight system, and the pill inspector panel.

### Modified Capabilities
- None. This change is additive only; no existing vowel-related spec behavior changes.

## Impact

- **New DB table**: `consonants` (new Alembic migration), seeded via a new one-off script under `scripts/` (e.g. `scripts/seed_consonants.py`), following the pattern of `scripts/migrate_legacy_to_db.py`.
- **New API surface**: `GET /api/v1/consonants` (and per-language variant), read-only — no write endpoints needed since there's no editor UI in scope.
- **New frontend page**: `consonants.html` + `js/consonants.js` (+ `js/consonants-charts.js` if the grid/strip rendering warrants a split, mirroring `js/charts.js`'s separation), `css/consonants.css` reusing the existing dark/light CSS custom-property tokens from `css/index.css`.
- **No impact** to `formanter.py`, `/frames`, `/stream`, the practice panel, Formant Lab, Shadowing, or any `Vowel`/`Token`/`SampleAnalysis` table or route.
- Reference audio reuses the existing `Sample`/`representative_sample_id` pattern already proven by `Vowel` — no new audio storage/playback pipeline.
