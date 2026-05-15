"""
analyze_server.py
=================
Dual-ceiling Praat formant tracker — Flask HTTP + websockets WS.

Architecture
------------
  HTTP :5050
    GET  /ping          — health check
    POST /analyze       — single-window analysis (practice tool & verifier)
    POST /analyze-file  — whole-file frame-by-frame analysis (debug page)
    POST /analyze-debug — raw Praat output from all three configs, unfiltered

  WS :5051
    Binary frames : Int16 PCM audio chunks from the client.
    Text frames   : JSON control messages
                     {type:'init',  sample_rate:<int>}   — (re)start, set SR
                     {type:'reset'}                      — flush continuity state
                     {type:'config', <ConnConfig fields>} — update analysis params

Algorithm summary
-----------------
  1. Run Burg LPC with two ceiling configs:
       SCAN (n_formants, max_f)   — primary; works for all vowel types
       BACK (2 formants, back_ceiling) — back-vowel disambiguation
  2. Dual-ceiling selection: prefer BACK when its F2 is well below the ceiling
     AND substantially lower than SCAN's F2 (indicating F3-as-F2 confusion).
  3. Phantom fix: for close front vowels (F1<350Hz, F2/F1<1.7), re-scan with
     more poles to find the real F2 above the phantom LPC resonance.
  4. ConnState: un-swap F1/F2 if tracks cross frame-to-frame.

Install
-------
  pip install flask flask-cors parselmouth numpy websockets
"""

from __future__ import annotations

import asyncio
import json
import math
import os
import struct
import tempfile
import threading
from collections import deque
from dataclasses import dataclass

import numpy as np
import parselmouth
from parselmouth.praat import call

from flask import Flask, jsonify, request
from flask_cors import CORS

# ── Flask app ─────────────────────────────────────────────────────────────────
app = Flask(__name__)
CORS(app)

# ── Global constants ──────────────────────────────────────────────────────────

# Accepted formant frequency ranges used as sanity gates.
F1_RANGE = (150, 1100)   # Hz  — F1 outside this range → reject frame
F2_RANGE = (400, 3200)   # Hz  — F2 outside this range → reject frame (after phantom fix)

# Ring buffer for WebSocket sliding-window analysis.
STEP_MS     = 10     # ms — analyse every N ms of new audio received
WINDOW_SAMP = 4096   # samples — ring buffer length (~93 ms at 44 100 Hz)

# Debug endpoint: fixed config for the "FRONT" column.
# This is intentionally NOT derived from ConnConfig — it exists only
# to show what the old n=3 / 4200 Hz config returns for comparison.
_DEBUG_FRONT_CFG = dict(
    time_step=0.010, max_number_of_formants=3,
    maximum_formant=4200.0, window_length=0.025, pre_emphasis_from=50.0,
)


# ── Per-connection configuration ──────────────────────────────────────────────

@dataclass
class ConnConfig:
    """
    All tunable parameters for one WebSocket connection (or one HTTP request).

    The debug page exposes every field as a slider and sends updates as
    ``{type: 'config', <field>: <value>, ...}`` WebSocket messages.
    The practice app never sends config messages and therefore runs on the
    defaults, with ``energy_floor=0`` (server gate disabled — the client
    gates instead).

    Field naming
    ~~~~~~~~~~~~
    * Fields that feed directly into ``to_formant_burg()`` match Praat's
      parameter names as closely as possible.
    * Fields controlling the dual-ceiling selection criterion are prefixed
      ``back_``.
    """

    # ── Primary Burg LPC analysis ─────────────────────────────────────────
    max_f:        float = 5000   # maximum_formant  (Hz)
    n_formants:   int   = 5      # max_number_of_formants
    window_ms:    float = 25     # window_length (converted to seconds internally)
    pre_emphasis: float = 50     # pre_emphasis_from (Hz)

    # ── Back-vowel disambiguation ─────────────────────────────────────────
    back_ceiling:       float = 1800   # maximum_formant for BACK config (Hz)
    back_ceiling_ratio: float = 0.95   # use BACK when f2_back < back_ceiling × ratio
    back_front_ratio:   float = 0.75   # use BACK when f2_back < f2_scan × ratio

    # ── Server-side energy gate ───────────────────────────────────────────
    energy_floor: float = 0.0   # RMS threshold; 0 = disabled (client gates instead)

    # ── Config update ─────────────────────────────────────────────────────

    def update(self, d: dict) -> None:
        """Overwrite fields present in *d*, coercing to the declared type."""
        for key, value in d.items():
            if hasattr(self, key):
                try:
                    setattr(self, key, type(getattr(self, key))(value))
                except (TypeError, ValueError):
                    pass

    # ── Praat kwargs builders ─────────────────────────────────────────────

    def _base_praat_kwargs(self) -> dict:
        """Shared keyword arguments for every ``to_formant_burg()`` call."""
        return {
            'time_step':        0.010,
            'window_length':    self.window_ms / 1000,
            'pre_emphasis_from': self.pre_emphasis,
        }

    def scan_cfg(self) -> dict:
        """Kwargs for the primary (SCAN) Burg analysis."""
        return {
            **self._base_praat_kwargs(),
            'max_number_of_formants': self.n_formants,
            'maximum_formant':        self.max_f,
        }

    def back_cfg(self) -> dict:
        """Kwargs for the back-vowel disambiguation (BACK) Burg analysis."""
        return {
            **self._base_praat_kwargs(),
            'max_number_of_formants': 2,
            'maximum_formant':        self.back_ceiling,
        }

    def phantom_scan_cfg(self) -> dict:
        """
        Kwargs for the phantom-resonance re-scan.
        Uses at least 5 formants so the pole above the phantom is reachable.
        """
        return {
            **self._base_praat_kwargs(),
            'max_number_of_formants': max(5, self.n_formants),
            'maximum_formant':        self.max_f,
        }


# ── Continuity state ──────────────────────────────────────────────────────────

class ConnState:
    """
    Per-connection frame-to-frame continuity tracker.

    Prevents F1/F2 track swaps: if swapping the current frame's values
    reduces the total distance to the previous frame, we swap them back.
    No EMA — smoothing is done client-side with a median window.
    """

    def __init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        self.p1: float | None = None
        self.p2: float | None = None

    def process(self, f1: float, f2: float) -> tuple[int, int]:
        """Return (f1, f2) after applying continuity correction."""
        if self.p1 is not None:
            if (abs(f2 - self.p1) + abs(f1 - self.p2) <
                    abs(f1 - self.p1) + abs(f2 - self.p2)):
                f1, f2 = f2, f1
        self.p1, self.p2 = f1, f2
        return round(f1), round(f2)


# ── Audio helpers ─────────────────────────────────────────────────────────────

def _decode_pcm(data: bytes) -> np.ndarray:
    """Int16 PCM bytes → float64 array in [-1, 1].  Clients always send Int16."""
    return np.frombuffer(data, dtype=np.int16).astype(np.float64) / 32768.0


def _parse_wav_body(data: bytes) -> tuple[np.ndarray, int]:
    """
    Parse an HTTP request body that is either a WAV file or raw Int16 PCM.
    Returns (samples_float64, sample_rate_hz).
    """
    if data[:4] == b'RIFF':
        sr      = struct.unpack_from('<I', data, 24)[0]
        samples = _decode_pcm(data[44:])
    else:
        sr, samples = 16000, _decode_pcm(data)
    return samples, sr


def _window_samples(samples: np.ndarray, start: float, end: float) -> np.ndarray:
    """Slice *samples* to the [start, end] fraction (from X-Window-* headers)."""
    n = len(samples)
    return samples[int(start * n):int(end * n)]


def _get_window_fraction(req) -> tuple[float, float]:
    """Read X-Window-Start / X-Window-End headers (default 0 / 1)."""
    return (float(req.headers.get('X-Window-Start', 0)),
            float(req.headers.get('X-Window-End',   1)))


def _rms(samples: np.ndarray) -> float:
    return float(np.sqrt(np.mean(samples ** 2)))


# ── Praat analysis ────────────────────────────────────────────────────────────

def _praat_get(snd: parselmouth.Sound, cfg_kwargs: dict) -> tuple[float | None, float | None]:
    """
    Run Burg LPC with *cfg_kwargs* and read F1/F2 at the midpoint.

    Only F1 is range-checked here.  F2 is intentionally left unchecked so that
    phantom resonances (very low F2 values) can reach ``_fix_phantom`` intact —
    range-checking F2 before the phantom fix would silently drop frames where
    F2 is a sub-400 Hz artifact rather than the real formant.
    """
    try:
        fmts = snd.to_formant_burg(**cfg_kwargs)
        t    = snd.duration / 2
        f1   = fmts.get_value_at_time(1, t)
        f2   = fmts.get_value_at_time(2, t)
        if math.isnan(f1) or math.isnan(f2) or not F1_RANGE[0] <= f1 <= F1_RANGE[1]:
            return None, None
        return f1, f2
    except Exception:
        return None, None


def _fix_phantom(
        f1: float, f2: float,
        snd: parselmouth.Sound,
        cfg: ConnConfig,
) -> tuple[float, float]:
    """
    Correct phantom LPC resonances for close front vowels.

    For vowels where F1 < 350 Hz and F2/F1 < 1.7 the LPC algorithm often
    places a spurious pole between F1 and the real F2 (a subglottal resonance
    or LPC artefact).  We detect this signature and re-scan with more poles to
    find the first valid formant that is above F1 × 2 and within F2_RANGE.
    """
    if f1 is None or f2 is None or f1 >= 350 or (f2 / f1) >= 1.7:
        return f1, f2
    try:
        fmts = snd.to_formant_burg(**cfg.phantom_scan_cfg())
        t    = snd.duration / 2
        for n in range(2, cfg.phantom_scan_cfg()['max_number_of_formants'] + 2):
            candidate = fmts.get_value_at_time(n, t)
            if (not math.isnan(candidate)
                    and candidate > f1 * 2.0
                    and F2_RANGE[0] <= candidate <= F2_RANGE[1]):
                return f1, candidate
    except Exception:
        pass
    return f1, f2


def analyze_best(
        snd: parselmouth.Sound,
        state: ConnState | None = None,
        cfg: ConnConfig | None = None,
) -> dict:
    """
    Main analysis entry point — dual-ceiling selection + phantom fix.

    Returns a dict with keys: ``voiced`` (bool), ``f1`` (int|None),
    ``f2`` (int|None), ``t`` (int, midpoint ms).

    Selection logic
    ~~~~~~~~~~~~~~~
    1. Run SCAN (n_formants, max_f) — primary config, robust for all vowels.
    2. Run BACK (2 formants, back_ceiling) — back-vowel disambiguation.
    3. Prefer BACK when *both* conditions hold:
         a. f2_back < back_ceiling × back_ceiling_ratio  (not pressing the ceiling)
         b. f2_back < f2_scan   × back_front_ratio       (F3-as-F2 avoidance)
    4. Apply phantom fix to the chosen (f1, f2) pair.
    5. Validate final F2 against F2_RANGE.
    6. Apply ConnState continuity correction (un-swap if tracks crossed).
    """
    if cfg is None:
        cfg = ConnConfig()

    t_ms = round(snd.duration / 2 * 1000)
    if snd.duration < 0.025:
        return {'voiced': False, 'f1': None, 'f2': None, 't': t_ms}

    f1_b, f2_b = _praat_get(snd, cfg.back_cfg())
    f1_f, f2_f = _praat_get(snd, cfg.scan_cfg())

    back_valid  = f1_b is not None and f2_b is not None
    front_valid = f1_f is not None and f2_f is not None

    use_back = (
            back_valid and front_valid
            and f2_b < cfg.back_ceiling * cfg.back_ceiling_ratio
            and f2_b < f2_f * cfg.back_front_ratio
    )

    if use_back:
        f1_raw, f2_raw = f1_b, f2_b
    elif front_valid:
        f1_raw, f2_raw = f1_f, f2_f
    elif back_valid:
        f1_raw, f2_raw = f1_b, f2_b
    else:
        return {'voiced': False, 'f1': None, 'f2': None, 't': t_ms}

    f1_raw, f2_raw = _fix_phantom(f1_raw, f2_raw, snd, cfg)

    if not F2_RANGE[0] <= f2_raw <= F2_RANGE[1]:
        return {'voiced': False, 'f1': None, 'f2': None, 't': t_ms}

    f1, f2 = state.process(f1_raw, f2_raw) if state else (round(f1_raw), round(f2_raw))
    return {'voiced': True, 'f1': f1, 'f2': f2, 't': t_ms}


# ── Whole-file frame extraction ───────────────────────────────────────────────

def _analyze_file_frames(path: str, cfg: ConnConfig) -> tuple[list[dict], float]:
    """
    Slide a WINDOW_SAMP-sample window across an audio file in STEP_MS steps,
    returning per-frame analysis results for the debug page.

    Each frame dict has keys: ``t`` (float, seconds), ``f1``, ``f2``
    (int|None), ``rms`` (float).  Frames below ``cfg.energy_floor`` are
    returned with f1=None, f2=None (displayed as gaps in the time plot).
    """
    snd     = parselmouth.Sound(path)
    sr      = snd.sampling_frequency
    samples = snd.values[0].astype(np.float64)
    dur     = snd.duration

    step_n = max(1, int(sr * STEP_MS / 1000))
    win_n  = WINDOW_SAMP
    state  = ConnState()
    frames: list[dict] = []

    for pos in range(win_n, len(samples) + 1, step_n):
        win   = samples[pos - win_n:pos]
        frame_rms = round(_rms(win), 6)
        t     = round(pos / sr, 3)

        # Energy gate — matches the server-side gate in ws_handler
        if cfg.energy_floor > 0 and frame_rms < cfg.energy_floor:
            frames.append({'t': t, 'f1': None, 'f2': None, 'rms': frame_rms})
            continue

        try:
            w_snd = parselmouth.Sound(win, sampling_frequency=float(sr))
            r     = analyze_best(w_snd, state=state, cfg=cfg)
            frames.append({
                't':   t,
                'f1':  r['f1'] if r['voiced'] else None,
                'f2':  r['f2'] if r['voiced'] else None,
                'rms': frame_rms,
            })
        except Exception:
            frames.append({'t': t, 'f1': None, 'f2': None, 'rms': frame_rms})

    return frames, round(dur, 3)


# ── HTTP endpoints ─────────────────────────────────────────────────────────────

@app.route('/ping')
def ping():
    return jsonify({'ok': True})


@app.route('/analyze', methods=['POST'])
def analyze():
    """
    Single-window formant analysis.

    Used by:
      * Practice tool (record + analyse a sustained vowel)
      * verifyFromIpaAudio() in realtime.js

    Accepts raw WAV or Int16 PCM in the request body.
    Optional headers:
      X-Window-Start  — start of analysis window as fraction of total (default 0)
      X-Window-End    — end   of analysis window as fraction of total (default 1)
    """
    if not request.data:
        return jsonify({'error': 'No audio data'}), 400

    samples, sr = _parse_wav_body(request.data)
    dur_ms      = len(samples) / sr * 1000

    # Minimum duration = one analysis window (default 25 ms).
    min_dur_ms = ConnConfig().window_ms
    if dur_ms < min_dur_ms:
        return jsonify({'error': f'Duration {dur_ms:.0f} ms < minimum {min_dur_ms:.0f} ms'}), 400

    ws_start, ws_end = _get_window_fraction(request)
    samples = _window_samples(samples, ws_start, ws_end)

    try:
        snd = parselmouth.Sound(samples, sampling_frequency=float(sr))
        r   = analyze_best(snd)
        if not r['voiced']:
            return jsonify({'error': 'No voiced speech detected'}), 400
        return jsonify({'f1': r['f1'], 'f2': r['f2'], 'duration_ms': round(dur_ms)})
    except Exception as ex:
        return jsonify({'error': str(ex)}), 500


@app.route('/analyze-file', methods=['POST'])
def analyze_file():
    """
    Whole-file frame-by-frame analysis for the debug page's reference audio.

    Accepts multipart/form-data:
      file   — audio file (any format Praat can read)
      config — JSON string with ConnConfig field overrides (optional)

    Returns: {frames: [{t, f1, f2, rms}, ...], duration}
    """
    file = request.files.get('file')
    if not file:
        return jsonify({'error': 'no file'}), 400

    cfg = ConnConfig()
    try:
        cfg.update(json.loads(request.form.get('config', '{}')))
    except Exception:
        pass

    with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as f:
        file.save(f.name)
        tmp = f.name

    try:
        frames, duration = _analyze_file_frames(tmp, cfg)
        return jsonify({'frames': frames, 'duration': duration})
    except Exception as ex:
        return jsonify({'error': str(ex)}), 500
    finally:
        os.unlink(tmp)


@app.route('/analyze-debug', methods=['POST'])
def analyze_debug():
    """
    Diagnostic endpoint — returns raw Praat formant values from all three
    configs (FRONT, BACK, SCAN) with no range-checking or phantom fix.

    Useful for diagnosing why a particular recording is being rejected
    or why a specific vowel produces unexpected results.
    """
    if not request.data:
        return jsonify({'error': 'No audio data'}), 400

    samples, sr  = _parse_wav_body(request.data)
    ws_start, ws_end = _get_window_fraction(request)
    samples      = _window_samples(samples, ws_start, ws_end)

    try:
        snd   = parselmouth.Sound(samples, sampling_frequency=float(sr))
        t     = snd.duration / 2
        cfg   = ConnConfig()   # default params for SCAN/BACK columns
        named = [
            ('FRONT', _DEBUG_FRONT_CFG),
            ('BACK',  cfg.back_cfg()),
            ('SCAN',  cfg.scan_cfg()),
        ]
        configs_out = {}
        for name, kwargs in named:
            try:
                fmts = snd.to_formant_burg(**kwargs)
                n_max = kwargs['max_number_of_formants'] + 1
                formants = {}
                for n in range(1, n_max + 1):
                    v  = fmts.get_value_at_time(n, t)
                    bw = call(fmts, 'Get bandwidth at time', n, t, 'hertz', 'Linear')
                    formants[f'F{n}']  = None if math.isnan(v)  else round(v,  1)
                    formants[f'BW{n}'] = None if math.isnan(bw) else round(bw, 1)
                configs_out[name] = {
                    'ceiling':  kwargs['maximum_formant'],
                    'n':        kwargs['max_number_of_formants'],
                    'formants': formants,
                }
            except Exception as ex:
                configs_out[name] = {'error': str(ex)}

        return jsonify({
            'sample_rate':    sr,
            'duration_ms':    round(len(samples) / sr * 1000),
            'analysis_t_ms':  round(t * 1000),
            'configs':        configs_out,
        })
    except Exception as ex:
        return jsonify({'error': str(ex)}), 500


# ── WebSocket streaming ────────────────────────────────────────────────────────

async def ws_handler(ws) -> None:
    """
    Handle one WebSocket connection.

    Audio flow
    ~~~~~~~~~~
    Client sends 128-sample Int16 chunks (2.9 ms at 44 100 Hz).
    Server accumulates them in a ring buffer (WINDOW_SAMP samples).
    Every STEP_MS of new audio, the ring is analysed and a result is sent.

    Control messages (text frames)
    ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    {type: 'init',   sample_rate: <int>}  — reset state, update SR
    {type: 'reset'}                       — flush continuity, clear ring
    {type: 'config', <ConnConfig fields>} — update analysis params
    """
    sr    = 44100
    state = ConnState()
    ring  = deque(maxlen=WINDOW_SAMP)
    since = 0          # samples received since the last analysis trigger
    cfg   = ConnConfig()

    try:
        async for msg in ws:
            # ── Text: control message ──────────────────────────────────
            if isinstance(msg, str):
                try:
                    c    = json.loads(msg)
                    kind = c.get('type', '')
                    if kind == 'init':
                        sr = int(c.get('sample_rate', 44100))
                        state.reset(); ring.clear(); since = 0
                    elif kind == 'reset':
                        state.reset(); ring.clear(); since = 0
                    elif kind == 'config':
                        cfg.update(c)
                        state.reset()   # reset continuity after param change
                except Exception:
                    pass
                continue

            # ── Binary: PCM audio chunk ────────────────────────────────
            if len(msg) < 64:
                continue

            chunk = _decode_pcm(msg)
            ring.extend(chunk)
            since += len(chunk)

            step = int(sr * STEP_MS / 1000)   # samples per analysis step
            if since < step or len(ring) < WINDOW_SAMP:
                continue
            since = 0

            buf       = np.array(ring)
            frame_rms = round(_rms(buf), 6)

            # ── Energy gate ────────────────────────────────────────────
            # Disabled (energy_floor=0) for the practice app, which gates
            # client-side.  Enabled for the debug page via config message.
            if cfg.energy_floor > 0 and frame_rms < cfg.energy_floor:
                await ws.send(json.dumps({'frames': [
                    {'voiced': False, 'f1': None, 'f2': None, 'rms': frame_rms}
                ]}))
                continue

            try:
                snd = parselmouth.Sound(buf, float(sr))
                r   = analyze_best(snd, state=state, cfg=cfg)
                r['rms'] = frame_rms
                await ws.send(json.dumps({'frames': [r]}))
            except Exception as ex:
                await ws.send(json.dumps({'frames': [], 'error': str(ex)}))

    except Exception:
        pass


# ── WebSocket server thread ───────────────────────────────────────────────────

def _run_ws() -> None:
    """Run the websockets server on port 5051 in its own event loop."""
    import websockets as _ws

    async def _serve():
        async with _ws.serve(ws_handler, 'localhost', 5051):
            await asyncio.Future()   # run forever

    asyncio.run(_serve())


threading.Thread(target=_run_ws, daemon=True).start()


if __name__ == '__main__':
    print('HTTP :5050   WS :5051')
    app.run(host='localhost', port=5050, threaded=True, debug=False)