## Context

Today (`formanter.py` ~L938–1024, `js/shadow.js` ~L482–590, `js/settings.js`, `settings.html`):

```
 shadow.js ── backend=local ──► POST {cfg.url}/transcribe ──► faster-whisper in formanter.py
           └─ backend=hf    ──► POST router.huggingface.co (token from Settings, in the browser)
```

smia, per its `stt-api` spec and `app.py`: `POST /stt` takes multipart `audio` + required `provider` + optional `lang`, bearer-token authenticated (`SMIA_AUTH_TOKEN`), returns `{provider, text}`; provider failures are `502 {error}`, a missing/unknown provider is `400 {error, available}`. `GET /providers` returns `{kind: [providers…]}`. `hf_whisper` already forwards `lang` as `generate_kwargs.language`, i.e. identical behavior to phonexa's own HF client.

Shadowing only ever reads `data.text` from a transcription response (verified in `transcribeSentence`), so dropping `segments` loses nothing.

## Goals / Non-Goals

**Goals:** one transcription path (smia), credentials never in the browser, Whisper gone from phonexa, minimal frontend churn.

**Non-Goals:** timestamps, new providers, replacing yt-dlp/ffmpeg, any smia change.

## Decisions

### 1. Server-side proxy, route and shape preserved
```
 shadow.js ──POST /transcribe (file, language, provider)──► formanter.py ──POST /stt (audio, provider, lang, Bearer)──► smia
```
The browser never learns smia's address or token (`02-services.md`; D143's exception is only for the extension). Keeping `POST /transcribe` with form fields `file`/`language` means `transcribeSentence()` changes only by adding `provider` and deleting its HF branch. Field mapping happens in the proxy: `file → audio`, `language → lang`. Uses `requests` (already a dependency); 60 s timeout matching today's client behavior.

### 2. Error mapping surfaces smia's message
smia `400/502` bodies are relayed with their `error` string and status; smia unreachable → `503 {error: "smia not reachable at <host>"}` (host only, never the token); `SMIA_AUTH_TOKEN` unset → `503 {error: "transcription is not configured (SMIA_AUTH_TOKEN)"}`. The existing UI already prints `err.error`, so HF's "model is loading" message (relayed through smia as a 502 string) still reaches the user. phonexa does not retry.

### 3. Provider list comes from smia, not a hard-coded pair
`GET /transcribe/providers` → smia `/providers` → returns `{providers: [...]}` (the `stt` key). Settings renders a `<select>` from it, so a future provider appears with no phonexa change. If smia is unreachable the form shows the saved value and a "smia not reachable" note instead of failing the page.

### 4. Setting shape and migration-by-tolerance
`transcribeBackend` setting becomes `{provider: "hf_whisper"}`. Readers (`shadow.js`, `settings.js`) treat any value without a valid `provider` as the default `hf_whisper`, ignoring `backend/url/hfToken/hfModel`. No DB migration: `Setting` is a key/JSON table already tolerant of shape (the old code merged over defaults). The stale `hfToken` is overwritten the first time the user saves the new form (the form writes a fresh object, not a merge) — so the token disappears from the database without a script. Until then it is simply unused.

### 5. What gets deleted
`_get_whisper_model`, `_whisper_model`, `_whisper_error`, `WHISPER_MODEL`, the faster-whisper decoding block and its long docstring; `requirements-transcribe.txt`; `transcribeViaHuggingFace`, `blobToBase64` (after confirming no other caller), `checkTranscribeServer`'s ping branch; Settings' local/HF fields and their show/hide logic. **Kept on purpose**: `yt-dlp` in `requirements.txt`, `ffmpeg` in the Dockerfile, `/api/v1/youtube-extract` — the operator decided to keep YouTube extraction in phonexa.

### 6. The frozen-code boundary
Only the `/transcribe` section of `formanter.py` changes. `/stream` and `/frames` are not touched; verification is the project's standing `git diff --stat -- js/realtime.js formanter.py` review, confirming the formanter.py hunk is limited to the transcription block.

## Risks / Trade-offs

- **Online-only, quota-bound.** The local option never left the machine; this one sends audio to HF/ElevenLabs via smia and spends quota. → Intended (D17); stated in the proposal.
- **Hard dependency on smia being up.** A smia outage disables only the 📝 action, not Shadowing as a whole. → Clear 503 message; badge reflects status.
- **Cold-start latency** on HF's free tier can exceed 60 s. → Same as today's direct-HF behavior; surfaced by smia's message.
- **Language hint relies on smia forwarding `lang`.** Verified for `hf_whisper`; `elevenlabs` behavior to be confirmed in implementation. → If ignored, the picker is advisory for that provider only.
- **Stale token left in DB until next save.** → Harmless (unused), removed on first save; noted rather than scripted.

## Migration Plan

1. Deploy smia alongside (it is part of `tun`).
2. Ship this change; set `SMIA_AUTH_TOKEN` in phonexa's `.env` (same value as smia's).
3. Open Settings once and save a provider (clears the legacy token).
4. Rollback: revert; the old setting shape is still tolerated by the old code only if saved before — acceptable since nothing is deployed.

## Open Questions

- Exact `/providers` response shape for `stt` (confirm against smia's `provider-catalog` spec while implementing).
