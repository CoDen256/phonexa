"""
Formant tracker backend — FastAPI
Handles:
  WS  /ws       real-time PCM stream → F1/F2/RMS
  POST /analyze  upload audio file   → full F1/F2/RMS analysis

Run:
  pip install fastapi uvicorn python-multipart parselmouth numpy
  uvicorn server:app --port 8000
"""

import asyncio
import os
import tempfile
from collections import deque

import numpy as np
import parselmouth
from fastapi import FastAPI, File, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from parselmouth.praat import call

# ─── App ───────────────────────────────────────────────────────────────────────
app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── Shared params ─────────────────────────────────────────────────────────────
SAMPLE_RATE  = 16000
WINDOW_MS    = 50
STEP_MS      = 10
MAX_F        = 5000
N_FORMANTS   = 5
PRE_EMPHASIS = 25
ENERGY_FLOOR = 0.005
MAX_F1_JUMP  = 250
MAX_F2_JUMP  = 350

window_samples = int(SAMPLE_RATE * WINDOW_MS / 1000)
step_samples   = int(SAMPLE_RATE * STEP_MS   / 1000)


# ─── Formant helpers ───────────────────────────────────────────────────────────
def _get_formants(snd: parselmouth.Sound):
    """Return raw (f1, f2) from a Sound object, or (None, None)."""
    pitch = call(snd, "To Pitch", 0, 75, 600)
    if call(pitch, "Count voiced frames") == 0:
        return None, None

    fm = call(snd, "To Formant (burg)",
              0, N_FORMANTS, MAX_F, WINDOW_MS / 1000, PRE_EMPHASIS)
    t  = snd.duration / 2
    f1 = call(fm, "Get value at time", 1, t, "hertz", "Linear")
    f2 = call(fm, "Get value at time", 2, t, "hertz", "Linear")
    return (None if np.isnan(f1) else round(f1),
            None if np.isnan(f2) else round(f2))


def _reject(f1, f2, prev_f1, prev_f2):
    """Drop values that jump unrealistically between frames."""
    if f2 is not None and prev_f2 is not None and abs(f2 - prev_f2) > MAX_F2_JUMP:
        f2 = None
    if f1 is not None and prev_f1 is not None and abs(f1 - prev_f1) > MAX_F1_JUMP:
        f1 = None
    return f1, f2


def _median(buf_f1, buf_f2, f1, f2):
    """Append to deque buffers and return median-smoothed values."""
    if f1 is not None:
        buf_f1.append(f1)
    if f2 is not None:
        buf_f2.append(f2)
    f1_out = int(np.median(buf_f1)) if buf_f1 else None
    f2_out = int(np.median(buf_f2)) if buf_f2 else None
    return f1_out, f2_out


# ─── Whole-file analysis ───────────────────────────────────────────────────────
def _analyze_sound(snd: parselmouth.Sound) -> list[dict]:
    samples = snd.values[0]
    sr      = snd.sampling_frequency
    win_n   = int(WINDOW_MS / 1000 * sr)

    formants  = call(snd, "To Formant (burg)",
                     STEP_MS / 1000, N_FORMANTS, MAX_F, WINDOW_MS / 1000, PRE_EMPHASIS)
    pitch_obj = call(snd, "To Pitch", 0, 75, 600)
    n_frames  = call(formants, "Get number of frames")

    prev_f1 = prev_f2 = None
    results = []

    for i in range(1, n_frames + 1):
        t  = call(formants, "Get time from frame number", i)
        f1 = call(formants, "Get value at time", 1, t, "hertz", "Linear")
        f2 = call(formants, "Get value at time", 2, t, "hertz", "Linear")
        voiced = call(pitch_obj, "Get value at time", t, "Hertz", "Linear")

        # RMS for this window
        ci     = int(t * sr)
        chunk  = samples[max(0, ci - win_n // 2): ci + win_n // 2]
        rms    = float(np.sqrt(np.mean(chunk ** 2))) if len(chunk) else 0.0

        # Gate + voicing
        ok = (not np.isnan(voiced)) and (rms >= ENERGY_FLOOR)
        f1 = None if (np.isnan(f1) or not ok) else round(f1)
        f2 = None if (np.isnan(f2) or not ok) else round(f2)

        # Jump rejection
        f1, f2 = _reject(f1, f2, prev_f1, prev_f2)
        if f1 is not None: prev_f1 = f1
        if f2 is not None: prev_f2 = f2

        results.append({"t": round(t, 3), "f1": f1, "f2": f2, "rms": round(rms, 6)})

    return results


# ─── HTTP POST /analyze ────────────────────────────────────────────────────────
@app.post("/analyze")
async def analyze_endpoint(file: UploadFile = File(...)):
    data = await file.read()

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        f.write(data)
        tmp = f.name

    try:
        snd    = parselmouth.Sound(tmp)
        frames = _analyze_sound(snd)
        return {"frames": frames, "duration": round(snd.duration, 3)}
    finally:
        os.unlink(tmp)


# ─── WebSocket /ws ─────────────────────────────────────────────────────────────
@app.websocket("/ws")
async def ws_handler(ws: WebSocket):
    await ws.accept()

    ring  = deque(maxlen=window_samples)
    since = 0
    buf_f1 = deque(maxlen=5)
    buf_f2 = deque(maxlen=5)
    prev_f1 = prev_f2 = None

    try:
        while True:
            raw   = await ws.receive_bytes()
            chunk = np.frombuffer(raw, dtype=np.float32)
            ring.extend(chunk)
            since += len(chunk)

            if since < step_samples:
                continue
            since = 0

            win = np.array(ring)
            rms = float(np.sqrt(np.mean(win ** 2)))
            f1 = f2 = None

            if rms >= ENERGY_FLOOR:
                snd = parselmouth.Sound(win.astype(np.float64), SAMPLE_RATE)
                f1, f2 = _get_formants(snd)
                # f1, f2 = _reject(f1, f2, prev_f1, prev_f2)
                if f1 is not None: prev_f1 = f1
                if f2 is not None: prev_f2 = f2
                #f1, f2 = _median(buf_f1, buf_f2, f1, f2)

            await ws.send_json({"f1": f1, "f2": f2, "rms": rms})

    except WebSocketDisconnect:
        pass