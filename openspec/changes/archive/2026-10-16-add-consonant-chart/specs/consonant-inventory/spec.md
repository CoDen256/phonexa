## ADDED Requirements

### Requirement: Consonant data model
The system SHALL store each consonant phone as a `Consonant` row, separate from `Vowel`, with explicit (not inferred) columns for: `language_id`, `symbols` (array of bare IPA base letters, no diacritics), `manner`, `passive_place`, `active_articulator` (nullable), `voicing`, `secondary_articulation` (array, zero or more values), `syllabic` (boolean), `coarticulated_place` (nullable), `desc`, `wiki_url`, `representative_sample_id` (nullable FK to `Sample`), `sort_order`.

#### Scenario: Two phones differing only by secondary articulation are distinct rows
- **WHEN** a language has a voiced apical alveolar lateral approximant realized two ways — one palatalized, one velarized+pharyngealized (e.g. Russian's soft and hard л)
- **THEN** both are stored as separate `Consonant` rows sharing identical `manner`/`passive_place`/`active_articulator`/`voicing`, differing only in `secondary_articulation`

#### Scenario: Active articulator is optional
- **WHEN** a consonant's active articulator is fully implied by its manner and place (e.g. a plain bilabial nasal)
- **THEN** `active_articulator` SHALL be storable as `NULL` rather than requiring a redundant value

#### Scenario: Co-articulated phone stores both places
- **WHEN** a phone has two simultaneous primary constrictions (e.g. a labial-velar approximant)
- **THEN** `passive_place` holds the phone's primary grid placement and `coarticulated_place` holds the secondary place, both queryable

### Requirement: Passive place and active articulator are independent axes
The system SHALL NOT represent place of articulation as a single flat enum mixing location (passive place) and articulating body part (active articulator). These SHALL be two independent columns, each with its own enumerated value set.

#### Scenario: Apical and laminal variants of the same place are distinguishable
- **WHEN** two consonants share the same `passive_place` (e.g. Postalveolar) but differ in which part of the tongue forms the constriction
- **THEN** they SHALL be distinguishable via `active_articulator` (`Apical` vs `Laminal`) without requiring a different `passive_place` value

### Requirement: Secondary articulation is multi-valued
The system SHALL allow zero or more secondary articulations (`labialized`, `palatalized`, `velarized`, `pharyngealized`, `glottalized`, `aspirated`) to be recorded simultaneously on a single `Consonant` row.

#### Scenario: A consonant with two simultaneous secondary articulations
- **WHEN** a consonant is both velarized and pharyngealized at once
- **THEN** `secondary_articulation` SHALL contain both values on the same row, not require two rows or a separate combined enum value

### Requirement: Symbol rendering is computed, never stored pre-rendered
The system SHALL compute a consonant's full displayed IPA symbol (base letter plus any diacritics for active articulator, velarization/pharyngealization, syllabicity, and secondary articulation) from its feature columns at render time. The system SHALL NOT persist a pre-composed symbol string containing diacritics.

#### Scenario: Labialized co-articulated phone renders its diacritic
- **WHEN** a consonant has `secondary_articulation` containing `labialized`
- **THEN** its rendered symbol SHALL include the labialization mark (ʷ), regardless of whether the base symbol is a plain consonant letter or a letter that is itself inherently co-articulated (e.g. `w`)

#### Scenario: Velarized-or-pharyngealized renders a tilde overlay
- **WHEN** a consonant's `secondary_articulation` contains `velarized`, `pharyngealized`, or both
- **THEN** its rendered symbol SHALL include a combining tilde overlay through the base letter, plus the specific superscript(s) (ˠ and/or ˤ) disambiguating which one(s) apply

#### Scenario: Syllabic consonant renders the syllabic mark
- **WHEN** a consonant has `syllabic = true`
- **THEN** its rendered symbol SHALL include a combining vertical-line-below mark

### Requirement: Enumerations support unseeded values
The `manner`, `passive_place`, and `active_articulator` enumerations SHALL include values not used by any currently-seeded language (e.g. click, ejective, and implosive manners; radical and epiglottal places), so that adding a new language's consonant inventory does not require a schema migration.

#### Scenario: A future language using an unseeded manner value
- **WHEN** a new language's consonant uses a manner value (e.g. `click`) not present in any existing seeded row
- **THEN** the value SHALL already be a valid enum member, requiring only a new `Consonant` row, not a schema change
