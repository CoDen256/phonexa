## 1. Backend proxy

- [ ] 1.1 Replace the faster-whisper block in `formanter.py` with `POST /transcribe` proxying to `{SMIA_BASE_URL}/stt` (`file → audio`, `language → lang`, `provider`, `Authorization: Bearer $SMIA_AUTH_TOKEN`), 60 s timeout, response `{provider, text}`
- [ ] 1.2 Error mapping: relay smia 400/502 `error`; unreachable → 503 "smia not reachable" (host only); unset token → 503 "not configured"; never echo the token
- [ ] 1.3 Add `GET /transcribe/providers` → smia `/providers`, returning `{providers: <stt list>}`; confirm the `stt` shape against smia's `provider-catalog` spec
- [ ] 1.4 Delete `_get_whisper_model`, `_whisper_model`/`_whisper_error`, `WHISPER_MODEL`, the decode block and obsolete comments; update the file header's "Optional (for /transcribe)" line
- [ ] 1.5 Confirm with `git diff` that the hunk is limited to the transcription section (no `/stream`, `/frames` changes)

## 2. Config

- [ ] 2.1 Add `SMIA_BASE_URL` (default `http://smia-backend:5055`) and `SMIA_AUTH_TOKEN` (default empty) to `phonexa-backend`'s environment in `docker-compose.yml`
- [ ] 2.2 Document both in `.env.example`
- [ ] 2.3 Delete `requirements-transcribe.txt`; remove the Whisper/`WHISPER_MODEL`/"pip install -r requirements-transcribe.txt" text from `README.md` and `docs/`
- [ ] 2.4 Leave `yt-dlp` in `requirements.txt` and `ffmpeg` in the `Dockerfile` (explicitly kept)

## 3. Frontend

- [ ] 3.1 `js/shadow.js`: `getTranscribeSettings` returns `{provider}` (legacy shapes → `hf_whisper`); `transcribeSentence` posts `file`, `language`, `provider` to `/transcribe` only
- [ ] 3.2 Remove `transcribeViaHuggingFace`, the HF branch, and `blobToBase64` (after grepping for other callers)
- [ ] 3.3 Replace `checkTranscribeServer` with a status badge based on `GET /transcribe/providers` (connected + provider / unreachable); update `shadow.html` wording
- [ ] 3.4 `settings.html` / `js/settings.js`: replace the backend/URL/HF fields with one provider `<select>` populated from `/transcribe/providers`; saving writes `{provider}` as a whole object (drops the legacy token); handle smia-unreachable gracefully

## 4. Verification

- [ ] 4.1 With a live smia (`hf_whisper` configured): transcribe a Shadowing sentence end-to-end; language `sv` produces a `lang` form field at smia
- [ ] 4.2 Stop smia: the 📝 action shows "smia not reachable", rest of Shadowing works
- [ ] 4.3 Unset `SMIA_AUTH_TOKEN`: "not configured" message
- [ ] 4.4 Browser network tab and `/api/v1/settings` responses contain no smia token or HF token
- [ ] 4.5 A profile with a legacy `transcribeBackend` value loads, defaults to `hf_whisper`, and loses the old token after saving once
- [ ] 4.6 YouTube extraction still works (`yt-dlp`, `ffmpeg` present in the image)
- [ ] 4.7 `git diff --stat -- js/realtime.js` is empty and `formanter.py` has no `/stream` or `/frames` hunks
