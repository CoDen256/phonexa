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


# ─── Config ────────────────────────────────────────────────────────────────────

SAMPLE_RATE  = 16000
WINDOW_MS    = 100      # analysis window length in ms
STEP_MS      = 10      # result emitted every N ms
N_FORMANTS   = 45      # 
MAX_F        = 4000    # Hz ceiling for formant search 4000 - 5000
PRE_EMPHASIS = 25      # Hz — lower = less boost of high freqs (better for u/o)
ENERGY_FLOOR = 0.005   # RMS below this → skip (silence / noise gate)
PITCH_MIN    = 75      # Hz
PITCH_MAX    = 600     # Hz

window_samples = int(SAMPLE_RATE * WINDOW_MS / 1000)
step_samples   = int(SAMPLE_RATE * STEP_MS   / 1000)


# ─── App ───────────────────────────────────────────────────────────────────────

app  = Flask(__name__)
sock = Sock(app)


# ─── CORS (needed when frontend is served on a different port) ─────────────────

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


def check_voiced(snd: parselmouth.Sound) -> bool:
    pitch = call(snd, "To Pitch", 0, PITCH_MIN, PITCH_MAX)
    return call(pitch, "Count voiced frames") > 0


def get_formants(snd: parselmouth.Sound) -> tuple:
    """Return (F1, F2) in Hz, or None for each if unavailable."""
    fm = call(snd, "To Formant (burg)",
              0, N_FORMANTS, MAX_F, WINDOW_MS / 1000, PRE_EMPHASIS)
    t  = snd.duration / 2
    f1 = call(fm, "Get value at time", 1, t, "hertz", "Linear")
    f2 = call(fm, "Get value at time", 2, t, "hertz", "Linear")
    return (None if np.isnan(f1) else round(f1),
            None if np.isnan(f2) else round(f2))


# ─── Real-time window analysis ─────────────────────────────────────────────────

def analyze_window(samples: np.ndarray) -> dict:
    """
    Analyze one sliding window of PCM samples.
    Returns {"f1": int|None, "f2": int|None, "rms": float}.
    """
    rms_val = compute_rms(samples)

    if rms_val < ENERGY_FLOOR:
        return {"f1": None, "f2": None, "rms": rms_val}

    snd = make_sound(samples)

    if not check_voiced(snd):
        return {"f1": None, "f2": None, "rms": rms_val}

    f1, f2 = get_formants(snd)
    return {"f1": f1, "f2": f2, "rms": rms_val}


# ─── Whole-file analysis ───────────────────────────────────────────────────────

def analyze_frame(formants, pitch_obj, samples, sr, win_n, frame_idx) -> dict:
    """Extract one frame from pre-computed formant and pitch objects."""
    t      = call(formants, "Get time from frame number", frame_idx)
    f1     = call(formants, "Get value at time", 1, t, "hertz", "Linear")
    f2     = call(formants, "Get value at time", 2, t, "hertz", "Linear")
    voiced = call(pitch_obj, "Get value at time", t, "Hertz", "Linear")

    ci      = int(t * sr)
    chunk   = samples[max(0, ci - win_n // 2) : ci + win_n // 2]
    rms_val = compute_rms(chunk) if len(chunk) else 0.0

    is_voiced = not np.isnan(voiced)
    is_loud   = rms_val >= ENERGY_FLOOR

    f1 = None if (np.isnan(f1) or not is_voiced or not is_loud) else round(f1)
    f2 = None if (np.isnan(f2) or not is_voiced or not is_loud) else round(f2)

    return {"t": round(t, 3), "f1": f1, "f2": f2, "rms": round(rms_val, 6)}


def analyze_file(path: str) -> tuple:
    """
    Analyze an entire audio file.
    Returns (frames, duration_seconds).
    """
    snd      = parselmouth.Sound(path)
    samples  = snd.values[0]
    sr       = snd.sampling_frequency
    win_n    = int(WINDOW_MS / 1000 * sr)

    formants  = call(snd, "To Formant (burg)",
                     STEP_MS / 1000, N_FORMANTS, MAX_F, WINDOW_MS / 1000, PRE_EMPHASIS)
    pitch_obj = call(snd, "To Pitch", 0, PITCH_MIN, PITCH_MAX)
    n_frames  = call(formants, "Get number of frames")

    frames = [
        analyze_frame(formants, pitch_obj, samples, sr, win_n, i)
        for i in range(1, n_frames + 1)
    ]

    return frames, round(snd.duration, 3)


# ─── HTTP route: POST /analyze ─────────────────────────────────────────────────

@app.route("/analyze", methods=["POST"])
def route_analyze():
    file = request.files.get("file")
    if not file:
        return jsonify({"error": "no file"}), 400

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        file.save(f.name)
        tmp = f.name

    try:
        frames, duration = analyze_file(tmp)
        return jsonify({"frames": frames, "duration": duration})
    finally:
        os.unlink(tmp)


# ─── WebSocket route: /ws ──────────────────────────────────────────────────────

@sock.route("/ws")
def route_ws(ws):
    ring  = deque(maxlen=window_samples)
    since = 0

    while True:
        data = ws.receive()          # blocks until a message arrives
        if data is None:
            break

        chunk = np.frombuffer(data, dtype=np.float32)
        ring.extend(chunk)
        since += len(chunk)

        if since < step_samples:
            continue

        since  = 0
        result = analyze_window(np.array(ring))
        ws.send(json.dumps(result))


# ─── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print("Formant server → http://localhost:8000")
    app.run(port=8000, threaded=True)   # threaded=True required for WebSocket