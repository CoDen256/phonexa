## ADDED Requirements

### Requirement: On-demand pitch-contour comparison for a Shadowing sentence
The system SHALL provide an explicit user action, available per sentence segment once both the reference audio and a user recording exist for that segment, that analyzes the pitch contour of the reference slice and the user's recorded take and displays both as overlaid, time-normalized curves.

#### Scenario: Requesting a pitch comparison with both clips available
- **WHEN** the user has recorded a take for a sentence segment that also has reference audio loaded, and triggers the pitch-comparison action
- **THEN** the system SHALL analyze both clips' pitch and display two curves on a shared timeline

#### Scenario: Requesting a pitch comparison with no recording yet
- **WHEN** the user triggers the pitch-comparison action before recording a take for that segment
- **THEN** the system SHALL NOT attempt the comparison and SHALL indicate that a recording is needed first

### Requirement: Time-normalized contour display
Both the reference and recorded-take pitch curves SHALL be plotted against a shared 0–1 fraction-of-duration x-axis, independent of each clip's absolute duration.

#### Scenario: Reference and recording have different durations
- **WHEN** the reference slice and the user's recording differ in length
- **THEN** both curves SHALL still span the full width of the shared display, each independently normalized to its own duration

### Requirement: Pitch data and recordings remain ephemeral
The system SHALL NOT persist the analyzed pitch curves, the raw recording, or any derived comparison result to the database. All data used for the comparison SHALL be held only in client-side memory for the duration of the current viewing session.

#### Scenario: Navigating away and back
- **WHEN** the user navigates to a different sentence and later returns to a previously-compared sentence
- **THEN** no prior pitch-comparison data SHALL be restored automatically; the comparison SHALL need to be re-triggered if desired

### Requirement: No change to vowel-practice pitch functionality
This capability SHALL NOT alter the behavior, UI, or code paths of the vowel chart's practice panel (`js/practice.js`) or its existing pitch-related display.

#### Scenario: Practice panel behavior is unaffected
- **WHEN** this capability is implemented and shipped
- **THEN** the practice panel's recording, comparison, and spectrogram/pitch-overlay behavior SHALL be identical to its pre-change behavior
