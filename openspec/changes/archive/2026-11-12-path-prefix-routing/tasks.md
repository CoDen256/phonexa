## 1. Backend prefix plumbing

- [x] 1.1 Add a `_prefix()` helper to `formanter.py`:
      `request.headers.get('X-Forwarded-Prefix', '').rstrip('/')` — same form as
      `stabbur/app.py` and `smia/app.py`
- [x] 1.2 Substitute `__PHONEXA_PREFIX__` in every served HTML page: `serve_index`
      and `serve_static` when the path ends in `.html`; non-HTML keeps streaming
      through `send_from_directory` untouched
- [x] 1.3 Make the ~9 server-built audio URLs prefix-aware
      (`f'{prefix}/audio/{storage_key}'`): sample, token, vowel
      (`_representative_audio_url`), consonant (`_consonant_audio_url`) and the
      practice-bootstrap payload
- [x] 1.4 Confirm with `git diff` that `formanter.py` has no `/stream`, `/frames`
      or `/debug` hunks

## 2. HTML pages

- [x] 2.1 Add `<script>window.PHONEXA_PREFIX = "__PHONEXA_PREFIX__";</script>` to
      every page, positioned **before** any `js/*.js` tag (`API_BASE` is evaluated
      at module top level): `index.html`, `shadow.html`, `consonants.html`,
      `drill.html`, `editor.html`, `praat.html`, `settings.html`, `sounds.html`,
      `tokens.html`, `debug.html`
- [x] 2.2 Leave every existing relative `href`/`src`/CSS `url()` alone — they
      already resolve correctly under a prefix

## 3. Frontend call sites (74 literals, 18 files)

- [x] 3.1 Add the shared constant — `const API_BASE = window.PHONEXA_PREFIX || '';`
      — following `stabbur/ui/ui.js:13`. Decide during implementation whether it
      lives in `js/utils.js` (already loaded broadly) or is declared per-file;
      prefer one definition if load order permits — **done: defined in the injected inline
      tag as `var API_BASE`, not in `js/utils.js`, because consonants/drill/sounds/
      tokens pages do not load utils.js and two files each declaring `const API_BASE`
      would collide at page scope**
- [x] 3.2 Convert the heavy files: `shadow.js` (15), `praat.js` (12),
      `editor-lang.js` (7)
- [x] 3.3 Convert the mid files: `drill.js`, `lang.js`, `settings.js`,
      `sounds.js`, `tokens.js`, `editor-tokens.js` (4 each), `editor-form.js` (3)
- [x] 3.4 Convert the light files: `consonants.js`, `editor-vowels.js`,
      `filters.js`, `user.js` (2 each), `audio.js`, `ingest.js`, `practice.js`
      (1 each — `practice.js`'s is `/ping`)
- [x] 3.5b **Cross-check the call sites against the server's ROUTE TABLE, not a
      grep of path families.** Added 2026-11-13 after `/analyze-praat` 404'd in
      the browser: the inventory was built by grepping for
      `api/v1|audio|ping|transcribe|stream|frames|debug`, so a route outside
      that list was never converted and never tested. `grep -oP "@app\\.route\\('\\K[^']+" formanter.py`
      enumerates all 21; every one is now either prefixed or unreachable from js/
- [x] 3.5 Grep for survivors:
      `grep -rn "['\"\`]/\(api/v1\|audio/\|ping\|transcribe\)" js/*.js` returns
      nothing outside the `API_BASE` definition

## 4. The frozen file (two constants only)

- [x] 4.1 `js/realtime.js:13` — `const HTTP_URL = window.PHONEXA_PREFIX || '';`
      (`` `${HTTP_URL}/frames` `` and `/debug` then work unchanged)
- [x] 4.2 `js/realtime.js:12` — splice the same prefix into `STREAM_URL` before
      `/stream`
- [x] 4.3 Confirm the diff touches **only** those two constant declarations: no
      ring-buffer, frame-cadence, smoothing or wire-format hunk

## 5. Freeze amendment and docs

- [x] 5.1 `README.md`: restate the freeze as covering the frame pipeline
      (`/frames`, `/debug`, `/stream`) and its wire protocol; state that endpoint
      URL construction is deployment configuration and outside it; replace the
      "`git diff --stat -- js/realtime.js` is empty" verification convention with
      the hunk-level one `formanter.py` has always actually used
- [x] 5.2 `README.md`: document the prefix contract (`X-Forwarded-Prefix` →
      `window.PHONEXA_PREFIX` → `API_BASE`) and the flat-pages constraint
- [x] 5.3 `docs/arch-detailed.md`: check for anything that asserts root-absolute
      URLs and correct it

## 6. Verification

- [x] 6.1 Standalone regression (empty prefix): `docker compose up -d`, every page
      loads, API calls succeed, audio plays, mic tracker connects — behaviour
      byte-identical to before
- [x] 6.2 **Behind a real prefix**: run a scratch Caddy in front of the local
      stack with `handle_path /phonexa/*` + `header_up X-Forwarded-Prefix /phonexa`
      and exercise every page. This is the only configuration that catches a
      missed call site — a survivor is invisible in 6.1 because the prefix is
      empty there — **done: scratch Caddy on `tun-shared`, `handle_path /phonexa/*` +
      `header_up X-Forwarded-Prefix /phonexa`, with a catch-all mimicking mjolnir's.
      All 9 pages, assets, API, audio, `/ping`, `/transcribe/providers`, Shadowing
      media/settings: 0 requests reached the catch-all. **Incomplete, in hindsight:
      curl exercised what page loads and list endpoints fetch, never what a user
      ACTION triggers — `/analyze-praat` (spectrograms) only fires when an
      analysis is run, so it 404'd for the first real user instead**
- [x] 6.3 Audio under the prefix: a vowel's `representativeAudioUrl` and a
      sample's `audioUrl` are prefixed and fetch 200
- [x] 6.4 `/stream` under the prefix: the mic tracker connects and F1/F2 frames
      arrive; compare a frame payload against one captured before the change to
      confirm the wire format is unchanged — **done: driven with synthetic sawtooth
      PCM; the frame JSON through `/phonexa/stream` is byte-identical to the one
      taken directly from `/stream`**
- [x] 6.5 Bare path: `/phonexa` (no trailing slash) redirects 308 to `/phonexa/`
      and the page then loads with its assets — the sibling `mjolnir` change owns
      the `redir`, but verify it here too since phonexa's asset layer depends on it
- [x] 6.6 Shadowing end-to-end under the prefix: media list and settings 200 through
      the prefix; `/transcribe/providers` returns its 503 "not configured" as designed.
      **Upload/split and YouTube ingest not driven: they need a browser and a live
      smia respectively — neither is affected by prefixing, both go through the same
      `API_BASE` call sites already exercised**
- [x] 6.7 `git diff --stat -- js/realtime.js` is **non-empty by design** this time;
      record the two-line diff in the change for the archive — **done, see
      `realtime-diff.md` in this change directory**

## 7. Sibling changes (other repos — proposed, applied separately)

- [x] 7.1 `mjolnir`: propose the supersede of `phonexa-site-block` —
      `redir /phonexa /phonexa/ 308` + `handle_path /phonexa/*` with `basic_auth`
      and `header_up X-Forwarded-Prefix /phonexa`; remove the site block,
      `PHONEXA_SITE_ADDRESS` and `PHONEXA_AUTH_HASH`'s hostname role; rewrite the
      `DEPLOY.md` section
- [x] 7.2 `tun`: supersede D148's routing half in `docs/07-decisions.md` (keep its
      auth half and its verified `basic_auth`/WebSocket findings), amend D147's
      "routing is by subdomain" clause, and drop the DNS step from `DEPLOY.md`
- [x] 7.3 Land phonexa's change **before** mjolnir's: the backend change is a
      no-op without the header, the Caddy change is not safe without the backend
      change (`design.md` §7)
