## ADDED Requirements

### Requirement: Transcription is performed by smia
The system SHALL transcribe a Shadowing sentence's audio by calling smia's speech-to-text service from the phonexa backend. The system SHALL NOT run a speech-recognition model inside phonexa and SHALL NOT call a third-party transcription provider directly from the browser.

#### Scenario: Transcribing a sentence
- **WHEN** the user triggers transcription on a sentence
- **THEN** the browser sends the sentence audio to phonexa's backend and phonexa forwards it to smia, returning smia's transcription text to the browser

#### Scenario: No local recognition model
- **WHEN** phonexa's image and dependency lists are inspected
- **THEN** they contain no speech-recognition model or its runtime (no `faster-whisper`)

### Requirement: smia credentials stay server-side
The smia address and bearer token SHALL be configured only through the backend's environment (`SMIA_BASE_URL`, `SMIA_AUTH_TOKEN`) and SHALL NOT be sent to, stored by, or readable from the browser.

#### Scenario: Inspecting browser-visible state
- **WHEN** a page, API response or stored setting visible to the browser is inspected
- **THEN** it contains neither the smia token nor a provider API token

### Requirement: The transcription provider is a per-profile choice drawn from smia
The system SHALL let the user choose the transcription provider in Settings from the list smia reports for speech-to-text, store the choice per profile, and send it with every transcription request.

#### Scenario: Listing providers
- **WHEN** the Settings page loads and smia is reachable
- **THEN** the provider choices shown are exactly those smia lists for speech-to-text

#### Scenario: Legacy setting
- **WHEN** a profile's stored transcription setting predates this change (has no provider)
- **THEN** the system uses `hf_whisper` as the provider and ignores the legacy URL and token fields

### Requirement: Failures are reported clearly without leaking secrets
When transcription cannot be completed the system SHALL return a descriptive error to the user without including the smia token.

#### Scenario: smia unreachable
- **WHEN** smia cannot be contacted
- **THEN** the transcription request fails with a "smia not reachable" message and Shadowing otherwise keeps working

#### Scenario: Not configured
- **WHEN** `SMIA_AUTH_TOKEN` is unset on the backend
- **THEN** transcription fails with a message saying transcription is not configured

#### Scenario: Provider error
- **WHEN** smia returns an error for the chosen provider
- **THEN** that error message is shown to the user

#### Scenario: Silence
- **WHEN** smia returns an empty transcription
- **THEN** the UI shows "(no speech detected)" rather than an error

### Requirement: The language hint is forwarded
When the user selects a language for transcription the system SHALL forward it to smia as the language hint; when none is selected it SHALL omit it.

#### Scenario: Language selected
- **WHEN** the user transcribes with language `sv` selected
- **THEN** the request to smia includes `lang=sv`

### Requirement: YouTube extraction is unaffected
Removing local transcription SHALL NOT remove or alter Shadowing's YouTube audio extraction or the `yt-dlp` and `ffmpeg` tooling it depends on.

#### Scenario: Extracting a YouTube URL after the change
- **WHEN** the user pastes a YouTube URL into Shadowing
- **THEN** the audio is extracted exactly as before
