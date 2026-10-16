## 1. Schema & migration

- [x] 1.1 Add `Consonant` model to `db/models.py` (language_id FK, symbols array, manner, passive_place, active_articulator nullable, voicing, secondary_articulation array, syllabic bool, coarticulated_place nullable, desc, wiki_url, representative_sample_id nullable FK to samples, sort_order, timestamps) with enums covering unseeded values per design.md decision 2
- [x] 1.2 Generate and review Alembic migration for the new `consonants` table
- [x] 1.3 Apply migration locally and verify table shape against `db/models.py`

## 2. Symbol composition (shared logic, used by seed validation and frontend)

- [x] 2.1 Port `buildSymbol(p)` from the validated mockup into a reusable `js/consonant-symbol.js` module — base letter + active-articulator underscript + velarized/pharyngealized tilde overlay + syllabic mark + ordered superscripts, computed only from feature fields
- [x] 2.2 Unit-check the composition against the mockup's known cases: Russian soft л (palatalized), Russian hard л (velarized+pharyngealized), English aspirated stops, English/French labialized `w`/`ɥ`, English syllabic n̩/l̩

## 3. Seed data

- [x] 3.1 Write `scripts/seed_consonants.py` inserting the validated 4-language (en/de/ru/fr) dataset from the mockup (~70 phones), creating any missing `Language` rows as needed
- [x] 3.2 Run seed script against local DB and spot-check a sample of rows (including the Russian л pair) via direct query

## 4. API

- [x] 4.1 Add `GET /api/v1/consonants` (optionally filterable by `language_id`) returning all `Consonant` fields needed to drive the UI (including resolved `representative_sample_id` → audio URL where present)
- [x] 4.2 Add a request test covering: empty result for an unknown language, full inventory for a known language, presence of secondary_articulation arrays in the payload

## 5. Frontend — data & grid view

- [x] 5.1 Scaffold `consonants.html` + `css/consonants.css` (reuse existing dark/light CSS custom-property tokens from `css/index.css`), linked from the existing header nav alongside the vowel chart
- [x] 5.2 `js/consonants.js`: fetch `/api/v1/consonants`, build the place×manner grid (hatched empty cells, per-language colored pills, voicing dot, composed symbol via the shared module)
- [x] 5.3 Pill inspector panel: full feature breakdown + reference-audio playback when available (scenario: no-audio case shows breakdown without error)

## 6. Frontend — strip view & filters

- [x] 6.1 Per-language strip view: language selector, manner-grouped cards reusing the same feature-breakdown rendering as the inspector
- [x] 6.2 Four-dimension filter/highlight controls (language, secondary articulation, active articulator, voicing, syllabicity) implementing AND-across/OR-within semantics as highlight+dim (not hide), applied consistently to both grid and strip
- [x] 6.3 View-switcher tabs between grid and strip, matching the validated mockup's interaction

## 7. Verification

- [x] 7.1 Manually verify all mockup remarks are preserved in the shipped UI: single voicing dot per pill, visible labialization mark on `w`/`ɥ`, visible tilde+superscript on velarized/pharyngealized consonants, visible apical/laminal underscripts, visible syllabic mark, all four new filter groups present and working
- [x] 7.2 Confirm zero changes to `formanter.py`, `/stream`, `/frames`, any vowel-related file, or any existing route/table
