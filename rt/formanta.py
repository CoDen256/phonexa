# server.py
import asyncio, websockets, json, numpy as np
from collections import deque
import parselmouth
from parselmouth.praat import call

SAMPLE_RATE    = 16000
WINDOW_MS      = 50
STEP_MS        = 10
MAX_F          = 5000     # ← lowered
N_FORMANTS     = 5
PRE_EMPHASIS   = 25       # ← lowered
MAX_F2_JUMP    = 350
MAX_F1_JUMP    = 250
ENERGY_FLOOR   = 0.008    # skip silent frames entirely

window_samples = int(SAMPLE_RATE * WINDOW_MS / 1000)
step_samples   = int(SAMPLE_RATE * STEP_MS   / 1000)

F1_BUF = deque(maxlen=5)
F2_BUF = deque(maxlen=5)
prev_f1, prev_f2 = None, None


def rms(samples):
    return np.sqrt(np.mean(samples ** 2))


def extract_formants(samples):
    rm =       rms(samples)
    print(rm)
    if rm < ENERGY_FLOOR:
        return None, None

    snd = parselmouth.Sound(samples.astype(np.float64), SAMPLE_RATE)

    # Check voicing first — cheap gate before expensive formant analysis
    pitch = call(snd, "To Pitch", 0, 75, 600)   # 75–600 Hz range covers all voices
    voiced_frames = call(pitch, "Count voiced frames")

    #if voiced_frames == 0:
    #    return None, None   # noise, breath, unvoiced consonant — skip

    # Now safe to extract formants
    formants = call(snd, "To Formant (burg)",
                    0, N_FORMANTS, MAX_F, WINDOW_MS / 1000, PRE_EMPHASIS)
    t  = snd.duration / 2
    f1 = call(formants, "Get value at time", 1, t, "hertz", "Linear")
    f2 = call(formants, "Get value at time", 2, t, "hertz", "Linear")

    f1 = None if np.isnan(f1) else round(f1)
    f2 = None if np.isnan(f2) else round(f2)
    return f1, f2

def reject_jumps(f1, f2):
    global prev_f1, prev_f2
    if f2 is not None and prev_f2 is not None:
        if abs(f2 - prev_f2) > MAX_F2_JUMP:
            f2 = None
    if f1 is not None and prev_f1 is not None:
        if abs(f1 - prev_f1) > MAX_F1_JUMP:
            f1 = None
    if f2 is not None: prev_f2 = f2
    if f1 is not None: prev_f1 = f1
    return f1, f2

def median_smooth(f1, f2):
    if f1 is not None: F1_BUF.append(f1)
    if f2 is not None: F2_BUF.append(f2)
    f1_out = int(np.median(F1_BUF)) if F1_BUF else None
    f2_out = int(np.median(F2_BUF)) if F2_BUF else None
    return f1_out, f2_out

async def handler(ws):
    ring = deque(maxlen=window_samples)
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
            #f1, f2 = reject_jumps(f1, f2)
            #f1, f2 = median_smooth(f1, f2)

            await ws.send(json.dumps({"f1": f1, "f2": f2}))


async def main():
    async with websockets.serve(handler, "localhost", 8765):
        await asyncio.Future()

asyncio.run(main())