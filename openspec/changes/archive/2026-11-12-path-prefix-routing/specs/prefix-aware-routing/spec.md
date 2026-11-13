## ADDED Requirements

### Requirement: The application serves correctly under an arbitrary path prefix
phonexa SHALL function identically whether it is served at a domain root or under
a reverse-proxy path prefix, without a per-deployment build step and without any
configuration inside phonexa itself.

#### Scenario: Served under a prefix
- **WHEN** a reverse proxy strips a prefix (e.g. `/phonexa`) before forwarding and
  passes that prefix as `X-Forwarded-Prefix`
- **THEN** every page loads, every API call reaches its endpoint, audio plays, and
  the live-mic WebSocket connects

#### Scenario: Served at the domain root
- **WHEN** phonexa is reached directly with no `X-Forwarded-Prefix` header, as in
  standalone development
- **THEN** behaviour is unchanged from before this change, with no prefix applied
  to any URL

### Requirement: The prefix reaches the frontend through a single injected global
The backend SHALL read `X-Forwarded-Prefix`, strip any trailing slash, and inject
it into every HTML page it serves as `window.PHONEXA_PREFIX`, mirroring
`stabbur`'s and `smia`'s `__STABBUR_PREFIX__` / `__SMIA_PREFIX__` substitution.
Frontend modules SHALL derive a single `API_BASE` constant from it and build every
application URL from that constant.

#### Scenario: No header present
- **WHEN** no `X-Forwarded-Prefix` header is sent
- **THEN** the injected value is the empty string and `API_BASE` is empty, so every
  URL is identical to the pre-change form

#### Scenario: Non-HTML responses
- **WHEN** a static asset that is not HTML is requested
- **THEN** it is served byte-for-byte with no substitution attempted

#### Scenario: Load order
- **WHEN** a page is served
- **THEN** `window.PHONEXA_PREFIX` is assigned before any application script that
  reads it is loaded

### Requirement: Server-generated audio URLs are prefix-aware
The backend SHALL include the request's prefix in every audio URL it builds
(`audioUrl`, `representativeAudioUrl`, and the practice-bootstrap payload), since
the frontend does not construct them.

#### Scenario: Audio under a prefix
- **WHEN** a client behind a prefix requests vowels, consonants, samples, tokens or
  the practice bootstrap
- **THEN** every returned audio URL is prefixed, and fetching it returns the audio

### Requirement: The live-mic WebSocket honours the prefix
The `/stream` WebSocket URL SHALL be constructed from the same prefix as every
other URL, while the frame pipeline and the `/stream` wire protocol remain
unchanged.

#### Scenario: WebSocket under a prefix
- **WHEN** the mic tracker opens its stream from a page served under a prefix
- **THEN** the handshake targets the prefixed path, the upgrade succeeds, and
  per-frame results arrive in the same wire format as before

### Requirement: The realtime freeze covers the pipeline, not the endpoint URLs
The project's freeze on the realtime pipeline SHALL be stated as covering the
frame pipeline (`/frames`, `/debug`, `/stream`) and its wire protocol. Endpoint
URL construction SHALL be explicitly outside the freeze, and per-change
verification SHALL check for hunks in the pipeline and protocol rather than for an
empty file diff.

#### Scenario: A permitted change
- **WHEN** a change modifies only the base-URL constants in `js/realtime.js`
- **THEN** the freeze is not violated, and verification confirms no pipeline or
  protocol hunk is present

#### Scenario: A forbidden change
- **WHEN** a change modifies frame handling, buffering, smoothing or the wire
  format
- **THEN** the freeze is violated regardless of how small the diff is

### Requirement: Pages stay at a single directory level
All HTML pages SHALL remain at the application root, because the relative asset
and page links they already use resolve against the serving directory.

#### Scenario: Adding a page
- **WHEN** a new page is added
- **THEN** it is placed at the application root alongside the existing pages
