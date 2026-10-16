# consonant-chart-ui Specification

## Purpose
TBD - created by archiving change add-consonant-chart. Update Purpose after archive.
## Requirements
### Requirement: Overview grid view
The system SHALL provide a place (columns) × manner (rows) grid showing every loaded consonant as a color-coded pill (colored by language, matching the existing vowel chart's per-language color convention), grouped into its manner/place cell. A pill SHALL show a voicing indicator (filled dot = voiced, hollow dot = voiceless) and the computed IPA symbol with all applicable diacritics.

#### Scenario: Place/manner combination with no loaded phones
- **WHEN** a given place×manner cell has no matching `Consonant` row among currently-loaded languages
- **THEN** the cell SHALL render as a visually subdued/hatched empty cell, not an empty box indistinguishable from "not yet checked"

#### Scenario: Multiple languages occupy the same cell
- **WHEN** two or more languages each have a distinct consonant at the same place/manner combination
- **THEN** each SHALL render as its own pill within that cell, distinguishable by language color

### Requirement: Per-language strip view
The system SHALL provide a second view where selecting one language shows its full consonant inventory grouped by manner, as cards, each showing the same feature breakdown available in the grid's inspector.

#### Scenario: Switching the strip's selected language
- **WHEN** the user selects a different language in the strip view
- **THEN** the displayed cards SHALL update to that language's full inventory, grouped by manner, with no phones from other languages shown

### Requirement: Four-dimension filter/highlight system
The system SHALL provide toggleable filters across four dimensions — language, secondary articulation, active articulator, voicing, and syllabicity — combined as AND-across-dimensions, OR-within-a-dimension (matching the existing vowel chart's `passesFilters` semantics). Matching phones SHALL be visually highlighted; non-matching phones SHALL be dimmed rather than hidden, in both the grid and strip views.

#### Scenario: Highlighting a secondary articulation across languages
- **WHEN** the user toggles the "Palatalized" filter
- **THEN** every currently-loaded consonant with `palatalized` in its secondary articulation SHALL be visually highlighted, and all other consonants SHALL be dimmed but still visible

#### Scenario: Combining filters across dimensions
- **WHEN** the user toggles both "Voiced" and "Apical" filters simultaneously
- **THEN** only consonants that are both voiced AND apical SHALL be highlighted; a consonant matching only one of the two SHALL be dimmed

#### Scenario: No filters active
- **WHEN** no filter in any dimension is toggled on
- **THEN** all loaded consonants SHALL render at full visibility with no dimming applied

### Requirement: Pill inspector
The system SHALL show a full feature breakdown (manner, passive place, active articulator, voicing, secondary articulation badges, syllabic flag, and any free-text note) when a pill or card is activated, and SHALL play the consonant's reference audio if `representative_sample_id` resolves to a playable sample.

#### Scenario: Inspecting a consonant with no reference audio
- **WHEN** the user activates a pill whose `Consonant` row has no `representative_sample_id`
- **THEN** the full feature breakdown SHALL still display, with playback simply unavailable (no error state)

