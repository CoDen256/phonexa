# Realtime WebSocket Architecture

Architecture decisions for migrating median smoothing and RMS gate from
`realtime.js` to `analyze_server.py`.

**Scope:** `/ws` endpoint only. `/analyze`, `/analyze-file`, `/analyze-debug` are untouched.

---

## Motivation

- Single source of truth: all analysis logic in Python, testable with `server_tests.py`
- Client becomes a thin renderer: capture audio → send chunks → draw received values
- Median smoothing in Python is directly testable; in JS it requires a browser

---

## Config

Sent as `{type: 'config', ...fields}` on connect and whenever the user changes a setting.
All fields are optional — missing fields keep their previous value.

### Primary analysis (SCAN config — all vowels)

| Field | Default | Description |
|-------|---------|-------------|
| `max_f` | `5000` | Maximum formant ceiling for Praat SCAN config (Hz) |
| `n_formants` | `5` | Number of LPC poles for Praat SCAN config |
| `window_ms` | `25` | LPC analysis window length (ms) |
| `pre_emphasis` | `50` | Praat pre-emphasis from frequency (Hz) |

### Back-vowel disambiguation (BACK config)

| Field | Default | Description |
|-------|---------|-------------|
| `back_ceiling` | `1800` | Maximum formant ceiling for Praat BACK config (Hz) |
| `back_ceiling_ratio` | `0.95` | Prefer BACK when `f2_back < back_ceiling × ratio` |
| `back_front_ratio` | `0.75` | Prefer BACK when `f2_back < f2_scan × ratio` |

### Energy gate

| Field | Default | Description |
|-------|---------|-------------|
| `rms_floor` | `0.005` | RMS threshold. Below this: skip Praat entirely, return only identity fields. `0` = disabled. |

No auto-calibration. Static configurable threshold configured by the client (debug page slider, persisted in `localStorage`). The server applies it and reports `is_above_rms` per frame.

### Smoothing

| Field | Default | Description |
|-------|---------|-------------|
| `median_n` | `5` | Sliding median window over the last N voiced frames |

---

## Frame response

Three states, determined in order.

### State A — below RMS floor

Praat is **not called**. Only identity fields are non-null.

```
stream_t_ms        int     ms since stream start
voiced             false
rms                float   ring buffer RMS
is_above_rms       false
everything else    null
```

### State B — above RMS, Praat found no valid formants

Praat runs. Raw config outputs included for diagnostic visibility. Post-selection fields are null.

```
stream_t_ms             int
voiced                  false
rms                     float
is_above_rms            true

sound_duration_ms       float
is_valid_sound_duration bool

f1_back                 float|null   raw Praat F1 from BACK config
f2_back                 float|null
f1_scan                 float|null   raw Praat F1 from SCAN config
f2_scan                 float|null

used_back_config        bool|null
phantom_fix_applied     bool|null

f1_raw                  null    selection or range check failed
f2_raw                  null
is_valid_f1_range       bool|null
is_valid_f2_range       bool|null

f1                      null    (post-continuity)
f2                      null
f1_median               null    (median of last median_n voiced frames)
f2_median               null
```

`f1_back`/`f2_back`/`f1_scan`/`f2_scan` may be non-null in State B — Praat found something
that the dual-ceiling selection or range checks rejected. This is the diagnostic value of
exposing raw config outputs: you can see why a frame was unvoiced.

### State C — voiced

```
stream_t_ms             int
voiced                  true
rms                     float
is_above_rms            true

sound_duration_ms       float
is_valid_sound_duration true

f1_back                 float|null
f2_back                 float|null
f1_scan                 float|null
f2_scan                 float|null

used_back_config        bool
phantom_fix_applied     bool

f1_raw                  float    after selection + phantom fix, before continuity
f2_raw                  float
is_valid_f1_range       true
is_valid_f2_range       true

f1                      int      after ConnState continuity correction
f2                      int
f1_median               int      median of last median_n voiced f1 values
f2_median               int      median of last median_n voiced f2 values
```

`voiced = is_above_rms AND is_valid_sound_duration AND is_valid_f1_range AND is_valid_f2_range`

The median window is maintained per connection on the server and resets on `{type:'reset'}`.
Only State C frames contribute to the window.

---

## Naming

| Name | Meaning |
|------|---------|
| `f1_back`, `f2_back` | Raw Praat output from BACK config (n=2, back_ceiling) |
| `f1_scan`, `f2_scan` | Raw Praat output from SCAN config (n=5, max_f) |
| `f1_raw`, `f2_raw` | After dual-ceiling selection + phantom fix, **before** continuity |
| `f1`, `f2` | After ConnState continuity correction, integer-rounded |
| `f1_median`, `f2_median` | Median of last `median_n` voiced `f1`/`f2` values |

---

## Responsibilities after migration

| Concern | Location |
|---------|----------|
| Audio capture and encoding | Client — must stay |
| RMS gate decision | **Server** (reports `is_above_rms`) |
| Praat SCAN/BACK analysis | Server (unchanged) |
| Dual-ceiling selection | Server (unchanged) |
| Phantom resonance fix | Server (unchanged) |
| Continuity correction | Server (unchanged) |
| Median smoothing | **Server** (moved from client) |
| `median_n` value | Config field, sent from client to server |
| Voiced streak tracking | Client — display preference |
| Trail buffer | Client — display state |
| Draw decision | Client — `voiced AND streak >= min` |
| RMS bar display | Client — uses `rms` from frame |
| Gate indicator | Client — uses `is_above_rms` from frame |

---

## stream_t_ms

The server maintains `total_samples_received` per connection and computes:

```python
stream_t_ms = round(total_samples_received / sample_rate * 1000)
```

Since the client now sends all chunks (no gate filtering), this is real wall-clock time
since the stream started. Monotonically increasing. Included in every frame.

---

## Server state per connection

```
ring_buffer              deque(maxlen=RING_BUFFER_SAMPLES)   existing
continuity               ConnState                            existing
total_samples_received   int                                  new — for stream_t_ms
median_f1_window         deque(maxlen=median_n)               new
median_f2_window         deque(maxlen=median_n)               new
config                   ConnConfig                           existing + new fields
```

---

## Testing

### Layers

| Layer | Endpoint | Tests | Status |
|-------|----------|-------|--------|
| 1 | `/analyze` | raw F1/F2 per file | unchanged |
| 2 | `/analyze-file` | per-frame F1/F2 | unchanged |
| 3 | `/analyze-debug` | raw Praat per config | unchanged |
| 4 | `/ws` raw | voiced, f1/f2, f1_raw/f2_raw, f1_back/f2_back, f1_scan/f2_scan, all flags | existing + extended |
| 5 | `/ws` smooth | per-frame f1_median/f2_median | **new** |
| 6 | `/ws` stability | stable vowel position (avg frames 20–40) vs lang.json ±50 Hz | **new** |

Layers 1–3 never change. Layer 4 adds new fields to existing references. Layers 5–6 test
the migrated logic.

### JS reference — using RealtimeTracker directly

Before migration, capture the current client-side trail (what would actually be drawn) by
feeding reference frames through the real `RealtimeTracker._msg()`:

```javascript
// Browser console on any page that loads realtime.js:
const result = await verifySmoothing('tests/references/ws/i_128.json');
// result.trail is [{f1, f2}, ...] — exactly what would be drawn
```

`verifySmoothing` is in `realtime.js`. It creates a `RealtimeTracker`, calls `_msg()` for
each frame in the reference file, and returns `tracker.trail`. Because `_msg()` is the
real production code, this is a 100% faithful capture.

### Python reference generator

The same smoothing logic expressed in Python, used to build Layer 5 references
and to cross-check against `verifySmoothing`:

```python
def compute_smooth_reference(frames: list[dict], median_n: int = 5) -> list[dict]:
    """
    Apply sliding median to voiced f1/f2 values.
    Uses JS Math.round() rounding (always round 0.5 up) to match browser behaviour.
    """
    f1w, f2w = [], []
    result = []
    for frame in frames:
        if not frame.get('voiced') or frame.get('f1') is None:
            result.append({**frame, 'f1_median': None, 'f2_median': None})
            continue
        f1w.append(frame['f1']); f2w.append(frame['f2'])
        if len(f1w) > median_n: f1w.pop(0)
        if len(f2w) > median_n: f2w.pop(0)
        result.append({**frame,
                       'f1_median': _js_median(f1w),
                       'f2_median': _js_median(f2w)})
    return result

def _js_median(w: list[int]) -> int:
    s = sorted(w); m = len(s) // 2
    return s[m] if len(s) % 2 else int((s[m-1] + s[m]) / 2 + 0.5)
```

### One-time cross-check (before migration)

1. Run WS tests → Layer 4 reference files saved (have per-frame `f1`, `f2`)
2. Python: `compute_smooth_reference(layer4_frames)` → expected smooth values
3. Browser: `verifySmoothing(layer4_reference_url)` → actual JS trail
4. Compare `result.trail` vs Python output
    - All values should match, OR differ by 1 Hz only at exact half-integer midpoints
      (known difference: Python `round(274.5)=274`, JS `Math.round(274.5)=275`)
5. If they match → Python generator is verified → save as Layer 5 references
6. Cross-check done — never needs to run again

### After migration

Server returns `f1_median`/`f2_median` in each WS frame. Layer 5 test compares these
to the pre-migration references. If they match, the migration is correct.

---

## Key decisions

- **No auto-calibration.** Replaced by static `rms_floor` configured by the client.
  Client adjusts once, persists in `localStorage`. No "be quiet for 1.5 seconds" UX.

- **Praat skipped when below RMS.** No `skip_praat_below_rms` config option.
  Below-RMS frames always skip Praat and return only `{voiced:false, rms, is_above_rms:false, stream_t_ms}`.

- **Rich diagnostic frame.** Every intermediate value exposed so client and tests can
  reason about *why* a frame is voiced or unvoiced, not just the final boolean.

- **Streak and trail stay on client.** These are display preferences, not analysis.
  The client decides whether to draw based on `voiced` and its own streak counter.

- **`median_n` is a config field** sent from client to server, not hardcoded.

- **`stream_t_ms` is real stream position** because all chunks are now sent (no gate
  skipping on the client). Computed as `total_samples_received / sample_rate * 1000`.

- **WS only.** `/analyze`, `/analyze-file`, `/analyze-debug` are not changed.