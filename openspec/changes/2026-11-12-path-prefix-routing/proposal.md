## Why

phonexa is currently reachable only on its own hostname (D148): `mjolnir`'s Caddy
serves it from a dedicated site block because its frontend hardcodes absolute
paths (`fetch('/api/v1/…')`) and opens its live-mic WebSocket at
`location.host + '/stream'` — and `js/realtime.js` is frozen. Every other
service in the stack is routed by **path prefix** (`/mjolnir`, `/builder`,
`/stabbur`, `/smia`, `/adminer`); phonexa is the single exception, and it costs a
DNS record, a second certificate, a separate origin with no cross-links, and
three extra environment variables.

The operator wants phonexa brought to the same standard as the rest of the stack:
**`https://<host>/phonexa/`, no subdomain.**

Two findings make this far smaller than D148 assumed:

1. **phonexa's entire static layer is already prefix-agnostic.** Every page link,
   `<script src>`, `<link href>` and CSS `url()` in the repo is relative
   (`css/index.css`, `js/shadow.js`, `shadow.html`). Nothing there needs to
   change. What is absolute is the *network* layer only: 74 path literals across
   18 JS files, plus the audio URLs the backend builds itself.
2. **`js/realtime.js` already carries a base-URL constant.** `const HTTP_URL = ''`
   (line 13), used as `` fetch(`${HTTP_URL}/frames`) ``, is a vestige of the old
   standalone `:5051` server — it is the house `API_BASE` pattern under a
   different name. The frozen file's change is two **configuration constants**,
   not a line of its pipeline.

## What Changes

- **Adopt the house prefix pattern**, exactly as `stabbur` and `smia` implement it
  (D46): the backend reads `X-Forwarded-Prefix`, injects it into every served HTML
  page as `window.PHONEXA_PREFIX`, and the frontend reads it back as
  `const API_BASE = window.PHONEXA_PREFIX || ''`. Unset header → empty string →
  today's behaviour, so standalone development is unchanged.
- `formanter.py`: template the prefix into served HTML (`serve_index`,
  `serve_static` for `.html`); make the ~9 server-built `/audio/{storage_key}`
  URLs prefix-aware (`audioUrl`, `representativeAudioUrl` in the vowel, consonant,
  sample, token and practice-bootstrap payloads).
- **74 absolute path literals in 18 JS files** become `` `${API_BASE}/…` ``.
- `js/realtime.js`: **two constants only** — `HTTP_URL` adopts
  `window.PHONEXA_PREFIX || ''`, and `STREAM_URL` splices the same prefix in
  before `/stream`. No change to the frame pipeline, the ring buffer, or the
  wire protocol.
- **Freeze amendment.** The freeze is currently enforced as
  `git diff --stat -- js/realtime.js` being *empty* — a file-level check that
  cannot express "the algorithm is frozen, the deployment config is not". Narrow
  it, in `README.md`, to what it is actually for: the frame pipeline
  (`/frames`, `/debug`, `/stream`) and its wire protocol. Endpoint URL
  construction is deployment configuration and is explicitly outside it.
- Sibling changes in the other repos (not this one): `mjolnir` replaces the
  phonexa site block with a `handle_path /phonexa/*` block carrying the same
  `basic_auth` gate plus `header_up X-Forwarded-Prefix`; `tun` supersedes D148 and
  drops the DNS step from `DEPLOY.md`.

**Non-goals:**
- No change to the frame pipeline, the `/stream` wire protocol, or the
  dual-ceiling Praat algorithm. The freeze is narrowed, not lifted.
- No application-level authentication in phonexa. The gate stays Caddy
  `basic_auth` on the operator token's hash (D148's *auth* half survives intact;
  only its *routing* half is superseded).
- No subdomain kept as an alias — the operator does not want one.
- No change to phonexa's standalone development mode, which must keep working
  with no prefix and no configuration.
- No restructuring of pages into subdirectories (see the flat-pages constraint in
  `design.md`).

## Capabilities

### New Capabilities
- `prefix-aware-routing`: phonexa serves correctly both at a domain root and under
  an arbitrary reverse-proxy path prefix, with no per-deployment frontend build.

### Modified Capabilities
- None in this repo. `tun-deployment` (from `deployable-in-tun`) states only that
  the backend is reachable by the reverse proxy over `tun-shared`, which is true
  under either routing scheme.

## Impact

- `formanter.py` (HTML templating + audio URL construction; **no `/stream`,
  `/frames` or `/debug` hunks**), 18 files under `js/`, every `.html` page gains
  one injected global, `README.md`'s freeze wording.
- Requires the sibling `mjolnir` change to land before phonexa is reachable at
  `/phonexa/`; the two are safe to deploy in either order only if the Caddy block
  and the backend change land together — see `design.md` §6.
- Supersedes D148's routing half. `phonexa-site-block` (mjolnir, implemented
  2026-11-12) is superseded rather than reverted, so its verified findings about
  `basic_auth` and WebSocket upgrades stay on the record.
- Shared-origin trade-off accepted by the operator: under a path prefix phonexa
  shares an origin with hub and builder, whose session cookie is `Path=/`
  (`hub/src/auth.js:85`). See `design.md` §5.
