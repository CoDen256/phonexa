"""
Formant tracker server — Flask + flask-sock

Toggleable features (via DEFAULT_CONFIG / frontend sliders):
  use_bandwidth  — reject formants with bandwidth > max_bandwidth Hz
  use_tracking   — Praat Viterbi tracker (whole-file analysis only)
  use_fasttrack  — try multiple LPC ceilings, keep the smoothest

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

DEFAULT_CONFIG = {
    # Burg LPC params
    "max_f":          5000,
    "n_formants":     5,
    "window_ms":      50,
    "pre_emphasis":   25,
    "energy_floor":   0.005,
    "pitch_min":      75,
    "pitch_max":      600,

    # ── Feature flags ──────────────────────────────────────────────────────────
    "use_bandwidth":  True,   # filter formants whose bandwidth > max_bandwidth
    "use_tracking":   True,   # Praat Viterbi tracker  (whole-file only)
    "use_fasttrack":  False,  # try multiple ceilings, keep smoothest result

    # Bandwidth filter
    "max_bandwidth":  400,    # Hz

    # FastTrack ceiling sweep
    "ft_min":         4000,   # Hz  — lowest ceiling to try
    "ft_max":         7000,   # Hz  — highest ceiling to try
    "ft_step":        500,    # Hz  — step between candidates
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


# ─── Basic audio helpers ───────────────────────────────────────────────────────

def compute_rms(samples: np.ndarray) -> float:
    return float(np.sqrt(np.mean(samples ** 2)))


def make_sound(samples: np.ndarray) -> parselmouth.Sound:
    return parselmouth.Sound(samples.astype(np.float64), SAMPLE_RATE)


def check_voiced(snd: parselmouth.Sound, cfg: dict) -> bool:
    pitch = call(snd, "To Pitch", 0, cfg["pitch_min"], cfg["pitch_max"])
    return call(pitch, "Count voiced frames") > 0


def read_f1_f2(fm, t: float):
    """Read raw F1/F2 from a Formant object at time t."""
    f1 = call(fm, "Get value at time", 1, t, "hertz", "Linear")
    f2 = call(fm, "Get value at time", 2, t, "hertz", "Linear")
    return f1, f2


def read_bw1_bw2(fm, t: float):
    """Read F1/F2 bandwidths from a Formant object at time t."""
    bw1 = call(fm, "Get bandwidth at time", 1, t, "hertz", "Linear")
    bw2 = call(fm, "Get bandwidth at time", 2, t, "hertz", "Linear")
    return bw1, bw2


# ─── Feature: bandwidth filter ─────────────────────────────────────────────────

def bandwidth_filter(f1, f2, bw1, bw2, max_bw: float):
    """
    Return None for any formant whose bandwidth is above max_bw.
    Wide bandwidth = broad spectral peak = noise or tracking error.
    """
    if np.isnan(bw1) or bw1 > max_bw:
        f1 = None
    if np.isnan(bw2) or bw2 > max_bw:
        f2 = None
    return f1, f2


# ─── Feature: Praat Track (whole-file Viterbi) ─────────────────────────────────

def apply_tracking(formants, cfg: dict):
    """
    Viterbi formant tracker: finds the globally optimal F1/F2/F3 path
    across all frames simultaneously, heavily penalising large jumps.
    Only useful on whole-file Formant objects (needs multiple frames).
    """
    n_frames = call(formants, "Get number of frames")

    # find the minimum number of formants found in any single frame
    # — Track will error if n_track exceeds this
    min_found = cfg["n_formants"]
    for i in range(1, n_frames + 1):
        n = call(formants, "Get number of formants", i)
        if n < min_found:
            min_found = n

    n_track = min(3, min_found)
    if n_track < 1:
        return formants   # nothing to track, return as-is

    return call(formants, "Track",
                n_track,
                550,  1650, 2750, 3850, 4950,  # reference Hz for F1-F5
                1.0,                            # frequency cost
                1.0,                            # bandwidth cost
                1.0)                            # delta (frame-to-frame jump) cost


# ─── Feature: FastTrack (multiple ceiling candidates) ──────────────────────────

def _smoothness(values) -> float:
    """
    Variance of frame-to-frame differences. Lower = smoother trajectory.
    Used by whole-file FastTrack to score each ceiling candidate.
    """
    vals = [v for v in values if v is not None and not np.isnan(v)]
    if len(vals) < 3:
        return float("inf")
    return float(np.var(np.diff(vals)))


def _burg(snd, ceiling: float, cfg: dict):
    """Run Burg at one ceiling, return the Formant object."""
    return call(snd, "To Formant (burg)",
                STEP_MS / 1000,
                cfg["n_formants"],
                ceiling,
                cfg["window_ms"] / 1000,
                cfg["pre_emphasis"])


def fasttrack_file(snd: parselmouth.Sound, cfg: dict):
    """
    Whole-file FastTrack: score each ceiling by F1+F2 trajectory smoothness,
    return the Formant object from the winning ceiling.
    """
    ceilings = range(int(cfg["ft_min"]), int(cfg["ft_max"]) + 1, int(cfg["ft_step"]))
    best_score    = float("inf")
    best_formants = None

    for ceiling in ceilings:
        fm      = _burg(snd, ceiling, cfg)
        n       = call(fm, "Get number of frames")
        times   = [call(fm, "Get time from frame number", i) for i in range(1, n + 1)]
        f1s     = [call(fm, "Get value at time", 1, t, "hertz", "Linear") for t in times]
        f2s     = [call(fm, "Get value at time", 2, t, "hertz", "Linear") for t in times]
        score   = _smoothness(f1s) + _smoothness(f2s)

        if score < best_score:
            best_score    = score
            best_formants = fm

    return best_formants


def fasttrack_realtime(snd: parselmouth.Sound, cfg: dict):
    """
    Single-window FastTrack: score each ceiling by total F1+F2 bandwidth.
    Narrower bandwidth = sharper spectral peaks = better-defined formants.
    Returns (f1, f2) from the winning ceiling.
    """
    ceilings   = range(int(cfg["ft_min"]), int(cfg["ft_max"]) + 1, int(cfg["ft_step"]))
    t          = snd.duration / 2
    best_score = float("inf")
    best_f1 = best_f2 = None

    for ceiling in ceilings:
        fm         = call(snd, "To Formant (burg)",
                          0, cfg["n_formants"], ceiling,
                          cfg["window_ms"] / 1000, cfg["pre_emphasis"])
        f1, f2     = read_f1_f2(fm, t)
        bw1, bw2   = read_bw1_bw2(fm, t)

        if any(np.isnan(v) for v in (f1, f2, bw1, bw2)):
            continue

        score = bw1 + bw2          # narrowest total bandwidth wins
        if score < best_score:
            best_score   = score
            best_f1, best_f2 = f1, f2

    return (None if best_f1 is None else round(best_f1),
            None if best_f2 is None else round(best_f2))


# ─── Real-time window analysis ─────────────────────────────────────────────────

def analyze_window(samples: np.ndarray, cfg: dict) -> dict:
    """
    Pipeline for one sliding window of PCM:
      1. RMS gate       — skip silence
      2. Voicing gate   — skip unvoiced frames
      3. FastTrack      — (optional) pick best ceiling
         or plain Burg  — single ceiling
      4. Bandwidth filter — (optional) reject noisy formants
    """
    rms_val = compute_rms(samples)
    if rms_val < cfg["energy_floor"]:
        return {"f1": None, "f2": None, "rms": rms_val}

    snd = make_sound(samples)
    if not check_voiced(snd, cfg):
        return {"f1": None, "f2": None, "rms": rms_val}

    if cfg.get("use_fasttrack"):
        # FastTrack already picks by bandwidth, so additional filter is redundant
        f1, f2 = fasttrack_realtime(snd, cfg)
    else:
        t       = snd.duration / 2
        fm      = call(snd, "To Formant (burg)",
                       0, cfg["n_formants"], cfg["max_f"],
                       cfg["window_ms"] / 1000, cfg["pre_emphasis"])
        f1, f2  = read_f1_f2(fm, t)
        f1      = None if np.isnan(f1) else round(f1)
        f2      = None if np.isnan(f2) else round(f2)

        if cfg.get("use_bandwidth") and (f1 is not None or f2 is not None):
            bw1, bw2 = read_bw1_bw2(fm, t)
            f1, f2   = bandwidth_filter(f1, f2, bw1, bw2, cfg["max_bandwidth"])

    return {"f1": f1, "f2": f2, "rms": rms_val}


# ─── Whole-file frame extraction ───────────────────────────────────────────────

def analyze_frame(formants, pitch_obj, samples, sr: float, cfg: dict, frame_idx: int) -> dict:
    """Extract one analysed frame from a pre-computed Formant object."""
    t      = call(formants, "Get time from frame number", frame_idx)
    f1, f2 = read_f1_f2(formants, t)
    voiced = call(pitch_obj, "Get value at time", t, "Hertz", "Linear")

    win_n   = int(cfg["window_ms"] / 1000 * sr)
    ci      = int(t * sr)
    chunk   = samples[max(0, ci - win_n // 2): ci + win_n // 2]
    rms_val = compute_rms(chunk) if len(chunk) else 0.0

    ok = not np.isnan(voiced) and rms_val >= cfg["energy_floor"]
    f1 = None if (np.isnan(f1) or not ok) else round(f1)
    f2 = None if (np.isnan(f2) or not ok) else round(f2)

    return {"t": round(t, 3), "f1": f1, "f2": f2, "rms": round(rms_val, 6)}


def analyze_file(path: str, cfg: dict) -> tuple:
    """
    Whole-file pipeline:
      1. FastTrack (picks best ceiling) or plain Burg
      2. Praat Track / Viterbi  (optional)
      3. Per-frame extraction + voicing/energy gate
    """
    snd     = parselmouth.Sound(path)
    samples = snd.values[0]
    sr      = snd.sampling_frequency

    formants = fasttrack_file(snd, cfg) if cfg.get("use_fasttrack") \
               else _burg(snd, cfg["max_f"], cfg)

    if cfg.get("use_tracking"):
        formants = apply_tracking(formants, cfg)

    pitch_obj = call(snd, "To Pitch", 0, cfg["pitch_min"], cfg["pitch_max"])
    n_frames  = call(formants, "Get number of frames")

    frames = [
        analyze_frame(formants, pitch_obj, samples, sr, cfg, i)
        for i in range(1, n_frames + 1)
    ]

    return frames, round(snd.duration, 3)


# ─── HTTP POST /analyze ────────────────────────────────────────────────────────

@app.route("/analyze", methods=["POST"])
def route_analyze():
    file = request.files.get("file")
    if not file:
        return jsonify({"error": "no file"}), 400

    cfg = {**DEFAULT_CONFIG, **json.loads(request.form.get("config", "{}"))}

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        file.save(f.name)
        tmp = f.name

    try:
        frames, duration = analyze_file(tmp, cfg)
        return jsonify({"frames": frames, "duration": duration})
    finally:
        os.unlink(tmp)


# ─── WebSocket /ws ─────────────────────────────────────────────────────────────

@sock.route("/ws")
def route_ws(ws):
    cfg   = dict(DEFAULT_CONFIG)
    ring  = deque(maxlen=int(SAMPLE_RATE * cfg["window_ms"] / 1000))
    since = 0

    while True:
        data = ws.receive()
        if data is None:
            break

        # text frame = config update from the settings panel
        if isinstance(data, str):
            try:
                cfg.update(json.loads(data))
                new_max = int(SAMPLE_RATE * cfg["window_ms"] / 1000)
                if ring.maxlen != new_max:
                    ring = deque(ring, maxlen=new_max)
            except Exception:
                pass
            continue

        # binary frame = raw float32 PCM from the mic
        if isinstance(data, str):
            data = data.encode("latin-1")
        if not isinstance(data, (bytes, bytearray)):
            continue

        chunk = np.frombuffer(data, dtype=np.float32)
        ring.extend(chunk)
        since += len(chunk)

        if since < step_samples:
            continue

        since  = 0
        result = analyze_window(np.array(ring), cfg)
        ws.send(json.dumps(result))


# ─── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print("Formant server → http://localhost:8000")
    app.run(port=8000, threaded=True)