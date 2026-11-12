## Context

phonexa today: Flask + flask-sock on `:5050`, serving its own static pages from
the repo root (`serve_index` → `index.html`, `serve_static` → `/<path:path>`).
Routed by `mjolnir`'s Caddy on a dedicated hostname with `basic_auth`
(D148, `phonexa-site-block`, implemented 2026-11-12). Every sibling service is
routed by path prefix instead; `stabbur` (D46) and `smia` (D118) both solve the
"my frontend needs to know its prefix" problem the same way, and that pattern is
what this change adopts.

### What is actually absolute — measured, not estimated

```
 LAYER                         FORM TODAY                        UNDER /phonexa/
 ──────────────────────────────────────────────────────────────────────────────
 page links (href="shadow.html")          relative     ✅ no change needed
 assets (src="js/shadow.js", css/…)       relative     ✅ no change needed
 CSS url(…)                               relative     ✅ no change needed
 ──────────────────────────────────────────────────────────────────────────────
 74 path literals in 18 js/ files         ABSOLUTE     ❌ 404
 ~9 server-built f'/audio/{key}' URLs     ABSOLUTE     ❌ 404   (formanter.py)
 realtime.js /frames, /debug              `${HTTP_URL}/…`       already a constant
 realtime.js /stream                      location.host+'/stream'  ❌ 404  (frozen)
```

The static layer being already relative is why D148's "would have to rewrite
every one of those URLs" overstates the work: nothing about pages, styles or
scripts changes. Only the network layer does.

Per-file literal counts (for task sizing): `shadow.js` 15, `praat.js` 12,
`editor-lang.js` 7, `drill.js`/`lang.js`/`settings.js`/`sounds.js`/`tokens.js`/
`editor-tokens.js` 4 each, `editor-form.js` 3, `consonants.js`/`editor-vowels.js`/
`filters.js`/`user.js` 2 each, `audio.js`/`ingest.js`/`practice.js`/`realtime.js`
1 each.

## Decisions

### 1. Copy stabbur's pattern verbatim, do not invent one
`stabbur/app.py` reads `X-Forwarded-Prefix`, substitutes a `__STABBUR_PREFIX__`
placeholder in its HTML, and `ui/ui.js:13` reads
`const API_BASE = window.STABBUR_PREFIX || ''`. `smia/app.py` mirrors it exactly
(its own comment says so). phonexa gets `window.PHONEXA_PREFIX` and the same
one-line `API_BASE`.

Rejected alternative — **make every path relative** (drop the leading slash, rely
on the page's own directory as the base). It is less code and needs no header, no
templating and no global, and it would work today because every page is flat at
the repo root. Rejected anyway: it makes "all pages live at exactly one directory
level" a silent, load-bearing invariant — adding `drills/advanced.html` later
would resolve `api/v1/…` to `/phonexa/drills/api/v1/…` and fail at runtime with
no compile-time signal. It also diverges from the two services that already
solved this, for no gain the operator asked for.

### 2. Templating applies to every HTML page, not one
stabbur has a single `ui/index.html`, so its substitution sits in one handler.
phonexa serves ten pages through two routes (`serve_index`, and `serve_static`
for everything else). The substitution therefore belongs in a small shared helper
applied whenever the served file is `.html`; non-HTML files stream through
`send_from_directory` untouched as they do today.

Each page gains one line before its own scripts:
`<script>window.PHONEXA_PREFIX = "__PHONEXA_PREFIX__";</script>`. It must come
*before* `js/*.js` loads, because `API_BASE` is evaluated at module top level.

### 3. The server builds audio URLs, so the server must know the prefix
`audioUrl` and `representativeAudioUrl` are built in `formanter.py`
(`f'/audio/{storage_key}'`, ~9 sites across the sample, token, vowel, consonant
and practice-bootstrap payloads) and shipped inside API JSON. The frontend never
constructs them. All nine sites are inside request handlers, so the prefix is
available from the same `X-Forwarded-Prefix` header — one `_prefix()` helper, used
in both the HTML templating and the URL construction.

### 4. The freeze is narrowed, not lifted — and the mechanism is the problem
`README.md` states the realtime pipeline is frozen and that every change verifies
`git diff --stat -- js/realtime.js formanter.py` touches neither `/stream` nor
`/frames`. In practice `formanter.py` is edited freely (`stt-via-smia` did), while
`js/realtime.js` is held to an *empty diff* — a file-level proxy for a
statement about its algorithm.

That proxy cannot express this change. The two lines needed are:

```js
line 12   const STREAM_URL = (…wss|ws…)+'//'+location.host+'/stream';
line 13   const HTTP_URL   = '';
```

Both are deployment configuration. Line 13 is already the house `API_BASE`
pattern under an older name, left over from the standalone `:5051` server the
file's own (stale) docstring still describes. Nothing in the ring buffer, the
frame cadence, the sliding median or the wire protocol is touched.

So the freeze is restated in `README.md` as covering **the frame pipeline and the
`/stream` wire protocol**, with endpoint URL construction explicitly outside it.
The per-change verification becomes "no hunks in the frame pipeline or protocol
handling", matching how `formanter.py` has always actually been verified, instead
of "the file's diff is empty".

Rejected alternative — **keep `/stream` at the domain root in Caddy** so
`location.host + '/stream'` keeps working untouched. Zero edits to the frozen
file, but it claims a global path on the main hostname for one service's benefit
and preserves a line everyone agrees is wrong. Contorting the proxy to protect a
constant is worse than amending a rule to say what it always meant.

### 5. Shared origin is the real cost, and it is accepted
```
 subdomain (today)            path prefix (this change)
 ─────────────────────        ─────────────────────────
 phonexa.example.net          example.net/phonexa
 example.net                  example.net/mjolnir
 separate origins             ONE origin
```
hub's and builder's session cookie is set `HttpOnly; SameSite=Strict; Path=/`
(`hub/src/auth.js:85`, `builder/src/auth.js:84`). `HttpOnly` means phonexa-origin
JavaScript cannot *read* it, but the browser still *sends* it on same-origin
requests, so a stored-content XSS in phonexa (an unescaped sample `text`, say)
could drive authenticated requests at `/mjolnir/…`. Bounded: an attacker must
already be past `basic_auth` to reach phonexa at all. Stated by the operator as
acceptable (2026-11-12); recorded here so it is a decision and not a discovery.

Related observation, pre-existing and out of scope: `serve_static`'s
`/<path:path>` serves any file present in the application directory. The
`basic_auth` gate is what keeps that from being internet-reachable, under either
routing scheme — another reason the gate stays in front of *everything*,
including static assets and `/ping`.

### 6. The trailing-slash redirect becomes load-bearing
At `https://host/phonexa` (no trailing slash) the browser resolves relative
assets against `/`, so `css/index.css` becomes `/css/index.css` and hits
mjolnir's catch-all 404 — the whole page breaks for anyone who types the bare
path. The Caddyfile already carries `redir /stabbur /stabbur/ 308` for exactly
this, with a comment explaining it; phonexa needs the same. It matters more here,
because phonexa's entire asset layer depends on relative resolution.

### 7. Deployment ordering
The backend change is backward compatible on its own: with no `X-Forwarded-Prefix`
header the prefix is `""` and every URL is byte-identical to today's. The Caddy
change is *not* independently safe — a `handle_path /phonexa/*` block in front of
a backend that still emits root-absolute URLs serves a broken page. So: land
phonexa's change first (harmless), then mjolnir's. Both are reversible by
reverting the Caddy block alone.

## Risks / Trade-offs

- **74 literals is a wide, shallow edit.** The risk is a missed call site, which
  fails only at runtime and only under the prefix. Mitigation: the verification
  task greps for surviving absolute literals rather than relying on review, and
  the standalone mode exercises nothing (empty prefix) — so a missed site is
  invisible in dev. This is the main reason to test behind a real prefix.
- **Flat pages become a documented constraint** rather than an accident, even
  with the `API_BASE` helper: relative *asset* paths in the HTML still depend on
  it. Noted in `README.md`.
- **Two origins' worth of browser credential caching changes.** The basic-auth
  prompt now appears on the main hostname, and credentials are cached for the
  whole origin rather than a dedicated one.
- **`phonexa-site-block` is four hours old.** Superseding it immediately is
  cheap in code and slightly expensive in ADR hygiene — hence superseding rather
  than reverting, so its verified `basic_auth`/WebSocket findings survive.

## Open Questions

- Does a browser re-send cached basic-auth credentials on a WebSocket handshake?
  Inherited unresolved from `phonexa-site-block` task 3.7 — unchanged by this
  change (the gate is still `basic_auth`, only its block type differs), and still
  answerable only on a real deploy.
