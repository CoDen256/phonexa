"""
analyze_server.py — Phase 4: sliding-window server + bandwidth filter.

Key changes from Phase 3:
  - Server maintains ring buffer; analyzes every STEP_MS of new audio.
    Client sends raw 128-sample AudioWorklet chunks → ~87 analyses/sec instead of ~30.
  - Bandwidth filter: rejects formants with bandwidth > MAX_BW Hz.
    Wide bandwidth = broad spectral peak = noise/tracking error. Copied from reference.
  - Accepts float32 or int16 PCM from client.

HTTP :5050   /ping  /analyze  /analyze-debug
WS   :5051          streaming
"""
import math, json, struct, asyncio, threading
from collections import deque

import numpy as np
import parselmouth
from parselmouth.praat import call
from flask import Flask, request, jsonify
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

# ── Praat configs ─────────────────────────────────────────────────────────────
CFG_BACK = dict(time_step=0.010, max_number_of_formants=2,
                maximum_formant=1800.0, window_length=0.025, pre_emphasis_from=50.0)
CFG_SCAN = dict(time_step=0.010, max_number_of_formants=5,
                maximum_formant=5000.0, window_length=0.025, pre_emphasis_from=50.0)
CFG_FRONT = dict(time_step=0.010, max_number_of_formants=3,
                 maximum_formant=4200.0, window_length=0.025, pre_emphasis_from=50.0)  # kept for debug endpoint

F1_RANGE  = (150, 1100)
F2_RANGE  = (400, 3200)
MAX_BW    = 400      # Hz — formants with wider bandwidth are rejected (reference default)

# ── Sliding window params ─────────────────────────────────────────────────────
STEP_MS      = 10                  # analyse every N ms of NEW audio received
WINDOW_SAMP  = 4096                # ring buffer size (93ms at 44100Hz)


# ── ConnState — continuity tracking only ──────────────────────────────────────
class ConnState:
    """Un-swap F1/F2 if tracks cross. No EMA — client does median smoothing."""
    def __init__(self): self.reset()
    def reset(self): self.p1 = self.p2 = None
    def process(self, f1, f2):
        if self.p1 is not None:
            if abs(f2-self.p1)+abs(f1-self.p2) < abs(f1-self.p1)+abs(f2-self.p2):
                f1, f2 = f2, f1
        self.p1, self.p2 = f1, f2
        return round(f1), round(f2)


# ── Praat helpers ─────────────────────────────────────────────────────────────
def _praat_get(snd, cfg):
    """Run Burg LPC. F2 range NOT checked here — phantoms must reach _fix_phantom."""
    try:
        fmts = snd.to_formant_burg(**cfg)
        t    = snd.duration / 2
        f1   = fmts.get_value_at_time(1, t)
        f2   = fmts.get_value_at_time(2, t)
        if math.isnan(f1) or math.isnan(f2) or not F1_RANGE[0] <= f1 <= F1_RANGE[1]:
            return None, None, None
        # ── Bandwidth filter (from reference) ─────────────────────────────────
        bw1 = call(fmts, "Get bandwidth at time", 1, t, "hertz", "Linear")
        bw2 = call(fmts, "Get bandwidth at time", 2, t, "hertz", "Linear")
        if math.isnan(bw1) or bw1 > MAX_BW:
            return None, None, None   # F1 bandwidth too wide → noisy frame
        return f1, f2, fmts           # return fmts for phantom fix
    except Exception:
        return None, None, None


def _fix_phantom(f1, f2, snd):
    """
    For close front vowels (F1<350Hz, F2/F1<1.7): the LPC places a phantom
    pole between F1 and the real F2. Re-scan with n=5 to find the real F2.
    """
    if f1 is None or f2 is None or f1 >= 350 or (f2 / f1) >= 1.7:
        return f1, f2
    try:
        fmts = snd.to_formant_burg(**CFG_SCAN)
        t    = snd.duration / 2
        for n in range(2, 6):
            candidate = fmts.get_value_at_time(n, t)
            if (not math.isnan(candidate)
                    and candidate > f1 * 2.0
                    and F2_RANGE[0] <= candidate <= F2_RANGE[1]):
                return f1, candidate
    except Exception:
        pass
    return f1, f2


def analyze_best(snd, state=None):
    """
    Dual-ceiling + bandwidth filter + phantom fix.
    Primary: CFG_SCAN (n=5, 5000Hz) — robust for all vowels including /i/.
    Disambiguation: CFG_BACK (n=2, 1800Hz) for back vowels (/u/ /o/).
    """
    t_ms = round(snd.duration / 2 * 1000)
    if snd.duration < 0.025:
        return {'voiced': False, 'f1': None, 'f2': None, 't': t_ms}

    f1_b, f2_b, _ = _praat_get(snd, CFG_BACK)
    f1_f, f2_f, _ = _praat_get(snd, CFG_SCAN)

    BACK_VALID  = f1_b is not None and f2_b is not None
    FRONT_VALID = f1_f is not None and f2_f is not None
    BACK_CEILING_THRESHOLD = CFG_BACK['maximum_formant'] * 0.95  # 1710Hz

    use_back = (
            BACK_VALID and FRONT_VALID
            and f2_b < BACK_CEILING_THRESHOLD
            and f2_b < f2_f * 0.75
    )

    if use_back:
        f1_raw, f2_raw = f1_b, f2_b
    elif FRONT_VALID:
        f1_raw, f2_raw = f1_f, f2_f
    elif BACK_VALID:
        f1_raw, f2_raw = f1_b, f2_b
    else:
        return {'voiced': False, 'f1': None, 'f2': None, 't': t_ms}

    f1_raw, f2_raw = _fix_phantom(f1_raw, f2_raw, snd)

    if not F2_RANGE[0] <= f2_raw <= F2_RANGE[1]:
        return {'voiced': False, 'f1': None, 'f2': None, 't': t_ms}

    if state:
        f1, f2 = state.process(f1_raw, f2_raw)
    else:
        f1, f2 = round(f1_raw), round(f2_raw)

    return {'voiced': True, 'f1': f1, 'f2': f2, 't': t_ms}


def _decode_pcm(msg, sr):
    """Decode Int16 PCM from client. Client always sends Int16 (see realtime.js _accumulate).
    Note: float32 detection was removed — Int16 bytes often pass abs<=1.0 float32 check
    (small values give denormal float32 representations), causing near-zero audio → no formants."""
    return np.frombuffer(msg, dtype=np.int16).astype(np.float64) / 32768.0


# ── HTTP endpoints ─────────────────────────────────────────────────────────────
@app.route('/ping')
def ping():
    return jsonify({'ok': True})


@app.route('/analyze', methods=['POST'])
def analyze():
    data = request.data
    if not data: return jsonify({'error': 'No audio data'}), 400
    if data[:4] == b'RIFF':
        sr = struct.unpack_from('<I', data, 24)[0]
        s  = np.frombuffer(data[44:], dtype=np.int16).astype(np.float64) / 32768.0
    else:
        sr, s = 16000, np.frombuffer(data, dtype=np.int16).astype(np.float64) / 32768.0
    dur = len(s) / sr * 1000
    if dur < 50: return jsonify({'error': 'Duration < 50ms'}), 400
    ws_start = float(request.headers.get('X-Window-Start', 0))
    ws_end   = float(request.headers.get('X-Window-End', 1))
    s = s[int(ws_start * len(s)):int(ws_end * len(s))]
    try:
        snd = parselmouth.Sound(s, sampling_frequency=float(sr))
        r   = analyze_best(snd)
        if not r['voiced']: return jsonify({'error': 'No voiced speech detected'}), 400
        return jsonify({'f1': r['f1'], 'f2': r['f2'], 'duration_ms': round(dur)})
    except Exception as ex:
        return jsonify({'error': str(ex)}), 500


@app.route('/analyze-debug', methods=['POST'])
def analyze_debug():
    """Raw Praat values with no filtering — for diagnosing rejections."""
    data = request.data
    if not data: return jsonify({'error': 'No audio data'}), 400
    if data[:4] == b'RIFF':
        sr = struct.unpack_from('<I', data, 24)[0]
        s  = np.frombuffer(data[44:], dtype=np.int16).astype(np.float64) / 32768.0
    else:
        sr, s = 16000, np.frombuffer(data, dtype=np.int16).astype(np.float64) / 32768.0
    ws_s = float(request.headers.get('X-Window-Start', 0))
    ws_e = float(request.headers.get('X-Window-End', 1))
    s    = s[int(ws_s * len(s)):int(ws_e * len(s))]
    try:
        snd = parselmouth.Sound(s, sampling_frequency=float(sr))
        t   = snd.duration / 2
        out = {'sample_rate': sr, 'duration_ms': round(len(s)/sr*1000),
               'analysis_t_ms': round(t*1000), 'configs': {}}
        for name, cfg in [('FRONT', CFG_FRONT), ('BACK', CFG_BACK), ('SCAN', CFG_SCAN)]:
            try:
                fmts = snd.to_formant_burg(**cfg)
                vals = {}
                for n in range(1, cfg['max_number_of_formants'] + 2):
                    v  = fmts.get_value_at_time(n, t)
                    bw = call(fmts, "Get bandwidth at time", n, t, "hertz", "Linear")
                    vals[f'F{n}'] = None if math.isnan(v) else round(v, 1)
                    vals[f'BW{n}'] = None if math.isnan(bw) else round(bw, 1)
                out['configs'][name] = {'ceiling': cfg['maximum_formant'],
                                        'n': cfg['max_number_of_formants'], 'formants': vals}
            except Exception as ex:
                out['configs'][name] = {'error': str(ex)}
        return jsonify(out)
    except Exception as ex:
        return jsonify({'error': str(ex)}), 500


# ── WebSocket streaming — sliding window ──────────────────────────────────────
async def ws_handler(ws):
    sr    = 44100
    state = ConnState()
    ring  = deque(maxlen=WINDOW_SAMP)
    since = 0   # samples received since last analysis

    try:
        async for msg in ws:
            # ── Text: control messages ─────────────────────────────────────
            if isinstance(msg, str):
                try:
                    c = json.loads(msg)
                    if c.get('type') == 'init':
                        sr = int(c.get('sample_rate', 44100))
                        state.reset(); ring.clear(); since = 0
                    elif c.get('type') == 'reset':
                        state.reset(); ring.clear(); since = 0
                except Exception:
                    pass
                continue

            if len(msg) < 64:
                continue

            # ── Binary: PCM audio chunk ────────────────────────────────────
            chunk = _decode_pcm(msg, sr)
            ring.extend(chunk)
            since += len(chunk)

            step = int(sr * STEP_MS / 1000)   # 441 at 44100Hz = 10ms
            if since < step or len(ring) < WINDOW_SAMP:
                continue    # not enough new audio yet

            since = 0
            try:
                snd = parselmouth.Sound(np.array(ring), float(sr))
                r   = analyze_best(snd, state=state)
                await ws.send(json.dumps({'frames': [r]}))
            except Exception as ex:
                await ws.send(json.dumps({'frames': [], 'error': str(ex)}))
    except Exception:
        pass


def _run_ws():
    import websockets as _ws
    async def serve():
        async with _ws.serve(ws_handler, 'localhost', 5051):
            await asyncio.Future()
    asyncio.run(serve())


threading.Thread(target=_run_ws, daemon=True).start()

if __name__ == '__main__':
    print('HTTP :5050   WS :5051')
    app.run(host='localhost', port=5050, threaded=True, debug=False)