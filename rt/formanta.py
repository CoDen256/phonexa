# server.py
import asyncio, websockets, json, numpy as np
from collections import deque
import parselmouth
from parselmouth.praat import call

SAMPLE_RATE    = 16000
WINDOW_MS      = 50          # analysis window (parselmouth needs ≥25 ms)
STEP_MS        = 10          # how often we push a result → 100 fps max
MAX_F          = 5500        # Hz ceiling (use 5000 for male voices)
N_FORMANTS     = 5
PRE_EMPHASIS   = 50          # Hz, Praat default

window_samples = int(SAMPLE_RATE * WINDOW_MS / 1000)
step_samples   = int(SAMPLE_RATE * STEP_MS   / 1000)

def extract_formants(samples: np.ndarray):
    """Run Praat burg formant tracker on a short float32 array."""
    if len(samples) < window_samples:
        return None, None
    snd = parselmouth.Sound(samples.astype(np.float64), SAMPLE_RATE)
    formants = call(snd, "To Formant (burg)",
                    0,           # time step  (0 = auto ≈ 0.25×window)
                    N_FORMANTS,
                    MAX_F,
                    WINDOW_MS / 1000,
                    PRE_EMPHASIS)
    t   = snd.duration / 2          # mid-point of the window
    f1  = call(formants, "Get value at time", 1, t, "hertz", "Linear")
    f2  = call(formants, "Get value at time", 2, t, "hertz", "Linear")
    return (None if np.isnan(f1) else round(f1),
            None if np.isnan(f2) else round(f2))

async def handler(ws):
    ring = deque(maxlen=window_samples)   # keeps last 50 ms of PCM
    samples_since_last = 0

    async for message in ws:
        # Frontend sends raw little-endian float32 PCM
        chunk = np.frombuffer(message, dtype=np.float32)
        ring.extend(chunk)
        samples_since_last += len(chunk)

        if samples_since_last >= step_samples:
            samples_since_last = 0
            window = np.array(ring)
            f1, f2 = extract_formants(window)
            await ws.send(json.dumps({"f1": f1, "f2": f2}))

async def main():
    async with websockets.serve(handler, "localhost", 8765):
        await asyncio.Future()

asyncio.run(main())