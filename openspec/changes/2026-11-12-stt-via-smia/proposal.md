## Why

Shadowing's per-sentence "📝 transcribe" has two backends today: a local `faster-whisper` model loaded inside `formanter.py` (`/transcribe`), and a direct browser call to Hugging Face using a token the user pastes into Settings. Both are now obsolete. smia's `POST /stt` (D16/D17) absorbed exactly this feature — it already ports `transcribeViaHuggingFace` as its `hf_whisper` provider and adds `elevenlabs` — and smia is where provider credentials and the "self-hosting whisper is too heavy for the deployment box" decision live. Keeping a Whisper model in phonexa's image and an HF token in the browser duplicates smia, makes a phonexa deploy heavier than it needs to be, and leaves a third-party API token in browser-readable settings.

## What Changes

- **BREAKING (internal)**: `POST /transcribe` in `formanter.py` stops running Whisper and becomes a thin server-side proxy to smia's `POST /stt` (multipart `audio`, `provider`, `lang`; bearer `SMIA_AUTH_TOKEN`). It keeps its current route and request shape (`file`, `language`) so Shadowing's call site barely changes; the response is `{provider, text}` (the `segments` array is gone — Shadowing only ever read `text`).
- Add `GET /transcribe/providers`, proxying smia's `/providers` and returning the `stt` list, so Settings can offer exactly what smia offers.
- smia's token and address stay server-side (`SMIA_BASE_URL`, `SMIA_AUTH_TOKEN` env on `phonexa-backend`); the browser only ever talks to phonexa. This follows `02-services.md`'s rule; D143's browser-direct exception covers only the single-operator extension.
- Settings: the "Transcription backend" form (local URL / Hugging Face token + model) becomes a single **provider** choice (`hf_whisper` / `elevenlabs`, from `/transcribe/providers`). The `transcribeBackend` setting's stored shape changes to `{provider}`; the old `{backend, url, hfToken, hfModel}` shape is read tolerantly (falls back to `hf_whisper`) and the stale HF token is dropped on the next save.
- Shadowing's backend badge reports smia/provider status instead of pinging a local Whisper server; the direct-to-Hugging-Face client (`transcribeViaHuggingFace`, `blobToBase64`) is removed.
- Remove Whisper: the `faster-whisper` loader and `WHISPER_MODEL` handling in `formanter.py`, `requirements-transcribe.txt`, and the README/docs/comments that describe local transcription.
- **`yt-dlp` and `ffmpeg` stay in the image.** Shadowing's YouTube extraction (`/api/v1/youtube-extract`) is unchanged; smia has no equivalent and this change does not add one.

**Non-goals:**
- No new provider, no smia change (smia's `/stt` already accepts everything needed).
- No segment/word timestamps (smia returns text only; not needed by Shadowing).
- No change to the YouTube extractor or to anything else in the image.
- No changes to `/stream`, `js/realtime.js`, `/frames`.

## Capabilities

### New Capabilities
- `shadowing-transcription`: how Shadowing turns a sentence's audio into text — via smia, provider-selectable per profile, with credentials held server-side only.

### Modified Capabilities
- None (no existing spec covers transcription).

## Impact

- `formanter.py` (the `/transcribe` section only), `js/shadow.js`, `js/settings.js`, `settings.html`, `shadow.html` (badge text), `README.md`, `docs/`, `requirements-transcribe.txt` (deleted), compose env (`SMIA_BASE_URL`, `SMIA_AUTH_TOKEN`, added to `phonexa-backend`; `.env.example`).
- Runtime dependency: a reachable smia. Under `tun` that is `http://smia-backend:5055` over `tun-shared`; standalone phonexa has transcription disabled with a clear message unless `SMIA_BASE_URL` points somewhere.
- Depends on `deployable-in-tun` (for `tun-shared` and env wiring) but is otherwise independent.
- Transcription now requires network egress from smia to Hugging Face / ElevenLabs and consumes that provider's quota — a behavior change from the local-Whisper option, which never left the machine.
