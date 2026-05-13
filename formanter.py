"""
analyze_server.py — Local formant analysis server.

Endpoints:
  GET  /ping          → {"ok": true}
  POST /analyze       → {"f1": N, "f2": N, "duration_ms": N}   (existing, unchanged)
  WS   /stream        → receives Int16 PCM chunks, streams JSON formant frames

Dependencies:
  pip install flask flask-cors flask-sock parselmouth numpy

Run:
  python analyze_server.py

Phase 1 notes (robustness improvements tracked inline):
  - PHASE1: naive single-estimate per chunk, existing Praat parameters
  - PHASE2 (next): per-frame trajectory, lower ceiling, continuity tracking
  - PHASE3: EMA smoothing, confidence scoring, adaptive ceiling
"""

import math, json, struct
import numpy as np
import parselmouth
from flask import Flask, request, jsonify
from flask_cors import CORS
from flask_sock import Sock

app = Flask(__name__)
CORS(app)
sock = Sock(app)

# ─── Shared analysis parameters (tune these as we verify) ─────────────────────
# PHASE1: These match the old /analyze endpoint. We will tighten them in PHASE2.
FORMANT_CONFIG = {
    'time_step': 0.010,           # 10ms frame step
    'max_number_of_formants': 5,  # PHASE2: reduce to 3
    'maximum_formant': 5500.0,    # PHASE2: reduce to 4200 for robustness
    'window_length': 0.025,       # 25ms analysis window
    'pre_emphasis_from': 50.0,
}

# Sanity bounds — estimates outside these are almost certainly errors
F1_RANGE = (150, 1100)
F2_RANGE = (400, 3500)


# ─── Core analysis function (used by both /analyze and /stream) ───────────────
def analyze_sound(snd, n_frames=1):
    """
    Analyze a parselmouth.Sound object.

    n_frames=1  → return single mid-chunk estimate (Phase 1)
    n_frames>1  → return list of per-frame estimates (Phase 2+)

    Returns: list of dicts [{f1, f2, t, voiced}, ...]
    """
    duration = snd.duration
    if duration < 0.020:
        return []

    formants = snd.to_formant_burg(**FORMANT_CONFIG)

    if n_frames == 1:
        times = [duration / 2]
    else:
        # Spread frames across the middle 80% of the chunk (avoid edge artifacts)
        t0, t1 = duration * 0.10, duration * 0.90
        times = np.linspace(t0, t1, n_frames).tolist()

    results = []
    for t in times:
        f1 = formants.get_value_at_time(1, t)
        f2 = formants.get_value_at_time(2, t)

        voiced = (
            not math.isnan(f1) and not math.isnan(f2)
            and F1_RANGE[0] <= f1 <= F1_RANGE[1]
            and F2_RANGE[0] <= f2 <= F2_RANGE[1]
        )
        results.append({
            'f1': round(f1) if voiced else None,
            'f2': round(f2) if voiced else None,
            't': round(t * 1000),   # ms offset within chunk
            'voiced': voiced,
        })

    return results


# ─── Existing POST /analyze endpoint (unchanged for backwards compat) ──────────
@app.route('/analyze', methods=['POST'])
def analyze():
    data = request.data
    if not data:
        return jsonify({'error': 'No audio data'}), 400

    # Strip WAV header (44 bytes) if present
    if data[:4] == b'RIFF':
        sample_rate = struct.unpack_from('<I', data, 24)[0]
        samples = np.frombuffer(data[44:], dtype=np.int16).astype(np.float64) / 32768.0
    else:
        sample_rate = 16000
        samples = np.frombuffer(data, dtype=np.int16).astype(np.float64) / 32768.0

    duration_ms = len(samples) / sample_rate * 1000
    if duration_ms < 50:
        return jsonify({'error': 'Duration < 50ms'}), 400

    window_start = float(request.headers.get('X-Window-Start', 0))
    window_end   = float(request.headers.get('X-Window-End', 1))
    if window_start >= window_end:
        return jsonify({'error': 'Window start >= end'}), 400

    s = int(window_start * len(samples))
    e = int(window_end   * len(samples))
    samples = samples[s:e]

    try:
        snd = parselmouth.Sound(samples, sampling_frequency=float(sample_rate))
        frames = analyze_sound(snd, n_frames=1)
        if not frames or not frames[0]['voiced']:
            return jsonify({'error': 'No voiced speech detected'}), 400
        f = frames[0]
        return jsonify({'f1': f['f1'], 'f2': f['f2'], 'duration_ms': round(duration_ms)})
    except Exception as ex:
        return jsonify({'error': str(ex)}), 500


# ─── WebSocket /stream endpoint ────────────────────────────────────────────────
@sock.route('/stream')
def stream(ws):
    """
    Protocol:
      1. Client sends text JSON: {"type":"init","sample_rate":44100}
      2. Client sends binary: Int16 PCM chunks (no header)
      3. Server sends text JSON per chunk:
           {"voiced":true,"f1":450,"f2":1800}          ← Phase 1
           {"voiced":true,"frames":[{f1,f2,t},...]}     ← Phase 2+

    The server returns one estimate per chunk in Phase 1.
    In Phase 2 we will return n_frames=5 to get a trajectory.
    """
    sample_rate = 44100  # default; overridden by init message

    # PHASE2: add continuity tracker here
    # prev_f1, prev_f2 = None, None

    while True:
        try:
            msg = ws.receive()
        except Exception:
            break
        if msg is None:
            break

        # ── Config message ──────────────────────────────────────────────────────
        if isinstance(msg, str):
            try:
                cfg = json.loads(msg)
                if cfg.get('type') == 'init':
                    sample_rate = int(cfg.get('sample_rate', 44100))
            except Exception:
                pass
            continue

        # ── Audio chunk (binary Int16 PCM) ──────────────────────────────────────
        if len(msg) < 400:  # too short to be useful
            continue

        samples = np.frombuffer(msg, dtype=np.int16).astype(np.float64) / 32768.0

        try:
            snd = parselmouth.Sound(samples, sampling_frequency=float(sample_rate))

            # PHASE1: single estimate per chunk
            # PHASE2: change to n_frames=5 for trajectory
            frames = analyze_sound(snd, n_frames=1)

            if not frames:
                ws.send(json.dumps({'voiced': False}))
                continue

            f = frames[0]

            # PHASE2: apply continuity check here
            # PHASE2: apply EMA smoothing here

            ws.send(json.dumps(f))

        except Exception as ex:
            ws.send(json.dumps({'voiced': False, 'error': str(ex)}))


# ─── Ping ─────────────────────────────────────────────────────────────────────
@app.route('/ping')
def ping():
    return jsonify({'ok': True})


if __name__ == '__main__':
    # threaded=True is required for flask-sock with multiple connections
    app.run(host='localhost', port=5050, threaded=True, debug=False)