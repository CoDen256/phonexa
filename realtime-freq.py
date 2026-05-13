"""
Formant tracker server — Flask + flask-sock

Install:  pip install flask flask-sock parselmouth numpy
Run:      python server.py
"""

import json
import os
import tempfile
from collections import deque

import numpy as np
import parselmouth
from flask import Flask, jsonify, request
from flask_sock import Sock
from parselmouth.praat import call


# ─── Default config (frontend can override per-connection) ─────────────────────

DEFAULT_CONFIG = {
    "max_f":        5000,   # Hz ceiling for formant search
    "n_formants":   5,      # number of formants to find
    "window_ms":    50,     # analysis window length in ms
    "pre_emphasis": 25,     # Hz — lower = better for back vowels (u/o)
    "energy_floor": 0.005,  # RMS gate — below this = silence
    "pitch_min":    75,     # Hz
    "pitch_max":    600,    # Hz
    "max_bandwidth":  400,  # ← formants wider than this are rejected
}

SAMPLE_RATE  = 16000
STEP_MS      = 10
step_samples = int(SAMPLE_RATE * STEP_MS / 1000)


# ─── App ───────────────────────────────────────────────────────────────────────

app  = Flask(__name__)
sock = Sock(app)


@app.after_request
def add_cors(response):
    response.headers["Access-Control-Allow-Origin"]  = "*"
    response.headers["Access-Control-Allow-Methods"] = "POST, GET, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "*"
    return response

@app.route("/analyze", methods=["OPTIONS"])
def options_analyze():
    return "", 204


# ─── Low-level audio helpers ───────────────────────────────────────────────────

def compute_rms(samples: np.ndarray) -> float:
    return float(np.sqrt(np.mean(samples ** 2)))


def make_sound(samples: np.ndarray) -> parselmouth.Sound:
    return parselmouth.Sound(samples.astype(np.float64), SAMPLE_RATE)


def check_voiced(snd: parselmouth.Sound, cfg: dict) -> bool:
    pitch = call(snd, "To Pitch", 0, cfg["pitch_min"], cfg["pitch_max"])
    return call(pitch, "Count voiced frames") > 0


def get_formants(snd: parselmouth.Sound, cfg: dict) -> tuple:
    """
    Burg LPC formant extraction with bandwidth filtering.
    Bandwidth is the width of the spectral peak — real voiced formants
    are narrow (<400 Hz). Wide peaks are noise or tracking errors.
    """
    fm = call(snd, "To Formant (burg)",
              0,
              cfg["n_formants"],
              cfg["max_f"],
              cfg["window_ms"] / 1000,
              cfg["pre_emphasis"])

    t   = snd.duration / 2
    f1  = call(fm, "Get value at time", 1, t, "hertz", "Linear")
    f2  = call(fm, "Get value at time", 2, t, "hertz", "Linear")
    bw1 = call(fm, "Get bandwidth at time", 1, t, "hertz", "Linear")
    bw2 = call(fm, "Get bandwidth at time", 2, t, "hertz", "Linear")

    max_bw = cfg.get("max_bandwidth", 400)

    f1 = None if (np.isnan(f1) or np.isnan(bw1) or bw1 > max_bw) else round(f1)
    f2 = None if (np.isnan(f2) or np.isnan(bw2) or bw2 > max_bw) else round(f2)

    return f1, f2
# ─── Real-time window analysis ─────────────────────────────────────────────────

def analyze_window(samples: np.ndarray, cfg: dict) -> dict:
    """
    Analyze one sliding window of PCM samples.
    Returns {"f1": int|None, "f2": int|None, "rms": float}.
    """
    rms_val = compute_rms(samples)

    if rms_val < cfg["energy_floor"]:
        return {"f1": None, "f2": None, "rms": rms_val}

    snd = make_sound(samples)

    if not check_voiced(snd, cfg):
        return {"f1": None, "f2": None, "rms": rms_val}

    f1, f2 = get_formants(snd, cfg)
    return {"f1": f1, "f2": f2, "rms": rms_val}


# ─── Whole-file analysis ───────────────────────────────────────────────────────

def analyze_frame(formants, pitch_obj, samples, sr, cfg, frame_idx) -> dict:
    """Extract one frame from pre-computed formant and pitch objects."""
    t      = call(formants, "Get time from frame number", frame_idx)
    f1     = call(formants, "Get value at time", 1, t, "hertz", "Linear")
    f2     = call(formants, "Get value at time", 2, t, "hertz", "Linear")
    voiced = call(pitch_obj, "Get value at time", t, "Hertz", "Linear")

    win_n   = int(cfg["window_ms"] / 1000 * sr)
    ci      = int(t * sr)
    chunk   = samples[max(0, ci - win_n // 2) : ci + win_n // 2]
    rms_val = compute_rms(chunk) if len(chunk) else 0.0

    ok = not np.isnan(voiced) and rms_val >= cfg["energy_floor"]
    f1 = None if (np.isnan(f1) or not ok) else round(f1)
    f2 = None if (np.isnan(f2) or not ok) else round(f2)

    return {"t": round(t, 3), "f1": f1, "f2": f2, "rms": round(rms_val, 6)}

def analyze_file(path: str, cfg: dict) -> tuple:
    snd      = parselmouth.Sound(path)
    samples  = snd.values[0]
    sr       = snd.sampling_frequency

    formants = call(snd, "To Formant (burg)",
                    STEP_MS / 1000,
                    cfg["n_formants"],
                    cfg["max_f"],
                    cfg["window_ms"] / 1000,
                    cfg["pre_emphasis"])

    # Track needs n_track <= minimum formants found across ALL frames.
    # Query the actual minimum rather than assuming n_formants is safe.
    n_frames_total = call(formants, "Get number of frames")
    min_found = cfg["n_formants"]
    for i in range(1, n_frames_total + 1):
        n = call(formants, "Get number of formants", i)
        if n < min_found:
            min_found = n

    n_track = min(3, min_found)   # track at most 3, but never more than what exists

    if n_track >= 1:
        tracked = call(formants, "Track",
                       n_track,
                       550, 1650, 2750, 3850, 4950,
                       1.0, 1.0, 1.0)
    else:
        tracked = formants   # nothing to track, use raw

    pitch_obj = call(snd, "To Pitch", 0, cfg["pitch_min"], cfg["pitch_max"])
    n_frames  = call(tracked, "Get number of frames")

    frames = [
        analyze_frame(tracked, pitch_obj, samples, sr, cfg, i)
        for i in range(1, n_frames + 1)
    ]

    return frames, round(snd.duration, 3)
# ─── HTTP route: POST /analyze ─────────────────────────────────────────────────

@app.route("/analyze", methods=["POST"])
def route_analyze():
    file = request.files.get("file")
    if not file:
        return jsonify({"error": "no file"}), 400

    # frontend sends current config alongside the file
    cfg = {**DEFAULT_CONFIG, **json.loads(request.form.get("config", "{}"))}

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        file.save(f.name)
        tmp = f.name

    try:
        frames, duration = analyze_file(tmp, cfg)
        return jsonify({"frames": frames, "duration": duration})
    finally:
        os.unlink(tmp)


# ─── WebSocket route: /ws ──────────────────────────────────────────────────────

@sock.route("/ws")
def route_ws(ws):
    cfg   = dict(DEFAULT_CONFIG)
    ring  = deque(maxlen=int(SAMPLE_RATE * cfg["window_ms"] / 1000))
    since = 0

    while True:
        data = ws.receive()
        if data is None:
            break

        # ── text frame → config update from the settings panel ────────────
        if isinstance(data, str):
            try:
                cfg.update(json.loads(data))
                new_max = int(SAMPLE_RATE * cfg["window_ms"] / 1000)
                if ring.maxlen != new_max:
                    ring = deque(ring, maxlen=new_max)
            except Exception:
                pass
            continue

        # ── binary frame → raw float32 PCM from the mic ───────────────────
        # some flask-sock versions return binary frames as str — force bytes
        if isinstance(data, str):
            data = data.encode("latin-1")

        if not isinstance(data, (bytes, bytearray)):
            continue                          # skip anything unexpected

        chunk = np.frombuffer(data, dtype=np.float32)
        ring.extend(chunk)
        since += len(chunk)

        if since < step_samples:
            continue

        since  = 0
        result = analyze_window(np.array(ring), cfg)
        ws.send(json.dumps(result))

    return ws
# ─── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print("Formant server → http://localhost:8000")
    app.run(port=8000, threaded=True)