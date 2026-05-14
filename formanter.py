"""
analyze_server.py — Phase 3: speaker-calibrated dual-ceiling + phantom fix.

Validated against real speech (Denys, 8 vowels, manually extracted F1/F2).
Predicted score: 8/8 F2 PASS.

Two fixes over Phase 2b:
  A) Dual-ceiling Condition A raised: ceiling×0.85 → ceiling×0.95 (1530→1710Hz)
     Needed for speakers whose /ɛ/ has F2 in 1530-1710Hz range.

  B) Phantom resonance fix: if F1<350Hz AND F2/F1<1.7, the reported F2 is a
     subglottal/artifact resonance. Scan higher formants (n=5) for the first
     valid F2 that is >2×F1 and in the plausible F2 range.
     Needed for close front vowels (/i/, /y/) with very low F1.

Both fixes apply to /analyze AND /stream.

HTTP :5050  /ping  /analyze
WS   :5051         streaming

pip install flask flask-cors parselmouth numpy websockets
"""
import math, json, struct, asyncio, threading
import numpy as np
import parselmouth
from flask import Flask, request, jsonify
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

CFG_FRONT = dict(time_step=0.010, max_number_of_formants=3,
                 maximum_formant=4200.0, window_length=0.025, pre_emphasis_from=50.0)
CFG_BACK  = dict(time_step=0.010, max_number_of_formants=2,
                 maximum_formant=1800.0, window_length=0.025, pre_emphasis_from=50.0)
CFG_SCAN  = dict(time_step=0.010, max_number_of_formants=5,
                 maximum_formant=5000.0, window_length=0.025, pre_emphasis_from=50.0)

F1_RANGE = (150, 1100)
F2_RANGE = (400, 3200)
# EMA moved to client (median filter). Server does continuity only.


class ConnState:
    """Continuity tracking only. EMA removed — client applies median smoothing."""
    def __init__(self):
        self.reset()
    def reset(self):
        self.p1 = self.p2 = None
    def process(self, f1, f2):
        if self.p1 is not None:
            if abs(f2-self.p1)+abs(f1-self.p2) < abs(f1-self.p1)+abs(f2-self.p2):
                f1, f2 = f2, f1
        self.p1, self.p2 = f1, f2
        return round(f1), round(f2)


def _praat_get(snd, cfg):
    """Return (f1, f2) from Praat, validating only F1 range.
    F2 is NOT range-checked here: phantom values below 400Hz must pass through
    so that _fix_phantom can detect and correct them in analyze_best."""
    try:
        fmts = snd.to_formant_burg(**cfg)
        t  = snd.duration / 2
        f1 = fmts.get_value_at_time(1, t)
        f2 = fmts.get_value_at_time(2, t)
        if (math.isnan(f1) or math.isnan(f2)
                or not F1_RANGE[0] <= f1 <= F1_RANGE[1]):
            return None, None
        return f1, f2   # f2 may be phantom — handled downstream
    except Exception:
        return None, None


def _fix_phantom(f1, f2, snd):
    """
    Fix B: close front vowel phantom resonance.

    Triggered when F1 < 350Hz AND F2/F1 < 1.7 — meaning the reported F2 is
    suspiciously close to F1 (typical of subglottal resonances for /i/, /y/).

    Re-runs Praat with 5 formants and finds the first pole that is:
      - above F1 * 2.0  (well past the phantom)
      - within the plausible F2 range
    """
    if f1 is None or f2 is None:
        return f1, f2
    if f1 >= 350 or (f2 / f1) >= 1.7:
        return f1, f2   # not a phantom case

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
    return f1, f2   # couldn't fix, return original


def analyze_best(snd, state=None):
    """
    Dual-ceiling selection + phantom fix. Returns {f1, f2, voiced, t}.

    Dual-ceiling criterion (for back/central vs front vowels):
      Prefer back-ceiling result (1800Hz, n=2) only when BOTH:
        A) F2_back < ceiling × 0.95 = 1710Hz  (not pressing the ceiling)
        B) F2_back < F2_front × 0.75           (substantially lower = F3-as-F2 avoidance)
      Otherwise use front-ceiling result (4200Hz, n=3).

    After selection, apply phantom fix if F1<350 and F2/F1<1.7.
    """
    t_ms = round(snd.duration / 2 * 1000)
    if snd.duration < 0.025:
        return {'voiced': False, 'f1': None, 'f2': None, 't': t_ms}

    f1_b, f2_b = _praat_get(snd, CFG_BACK)   # back vowel disambiguation
    f1_f, f2_f = _praat_get(snd, CFG_SCAN)   # primary: n=5 robust (replaces broken n=3 CFG_FRONT)

    BACK_VALID  = f1_b is not None and f2_b is not None
    FRONT_VALID = f1_f is not None and f2_f is not None
    BACK_CEILING_THRESHOLD = CFG_BACK['maximum_formant'] * 0.95   # 1710Hz

    use_back = (
            BACK_VALID and FRONT_VALID
            and f2_b < BACK_CEILING_THRESHOLD   # Fix A: raised from 0.85 to 0.95
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

    # Fix B: phantom resonance for close front vowels
    f1_raw, f2_raw = _fix_phantom(f1_raw, f2_raw, snd)

    # Final range check AFTER phantom correction
    if not F2_RANGE[0] <= f2_raw <= F2_RANGE[1]:
        return {'voiced': False, 'f1': None, 'f2': None, 't': t_ms}

    if state:
        f1, f2 = state.process(f1_raw, f2_raw)
    else:
        f1, f2 = round(f1_raw), round(f2_raw)

    return {'voiced': True, 'f1': f1, 'f2': f2, 't': t_ms}


# ── HTTP endpoints ────────────────────────────────────────────────────────────
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
    ws = float(request.headers.get('X-Window-Start', 0))
    we = float(request.headers.get('X-Window-End', 1))
    s  = s[int(ws * len(s)):int(we * len(s))]
    try:
        snd = parselmouth.Sound(s, sampling_frequency=float(sr))
        r   = analyze_best(snd)   # same dual-ceiling + phantom fix as streaming
        if not r['voiced']: return jsonify({'error': 'No voiced speech detected'}), 400
        return jsonify({'f1': r['f1'], 'f2': r['f2'], 'duration_ms': round(dur)})
    except Exception as ex:
        return jsonify({'error': str(ex)}), 500


@app.route('/ping')
def ping():
    return jsonify({'ok': True})


@app.route('/analyze-debug', methods=['POST'])
def analyze_debug():
    """Returns raw Praat formant values with zero filtering — for diagnosing rejections."""
    data = request.data
    if not data: return jsonify({'error': 'No audio data'}), 400
    if data[:4] == b'RIFF':
        sr = struct.unpack_from('<I', data, 24)[0]
        s  = np.frombuffer(data[44:], dtype=np.int16).astype(np.float64) / 32768.0
    else:
        sr, s = 16000, np.frombuffer(data, dtype=np.int16).astype(np.float64) / 32768.0
    ws = float(request.headers.get('X-Window-Start', 0))
    we = float(request.headers.get('X-Window-End', 1))
    s  = s[int(ws*len(s)):int(we*len(s))]
    try:
        snd = parselmouth.Sound(s, sampling_frequency=float(sr))
        t   = snd.duration / 2
        out = { 'sample_rate': sr, 'duration_ms': round(len(s)/sr*1000),
                'analysis_t_ms': round(t*1000), 'configs': {} }
        for name, cfg in [('FRONT', CFG_FRONT), ('BACK', CFG_BACK), ('SCAN', CFG_SCAN)]:
            try:
                fmts = snd.to_formant_burg(**cfg)
                vals = {}
                for n in range(1, cfg['max_number_of_formants'] + 2):
                    v = fmts.get_value_at_time(n, t)
                    vals[f'F{n}'] = None if math.isnan(v) else round(v, 1)
                out['configs'][name] = {
                    'ceiling': cfg['maximum_formant'],
                    'n': cfg['max_number_of_formants'],
                    'formants': vals
                }
            except Exception as ex:
                out['configs'][name] = {'error': str(ex)}
        return jsonify(out)
    except Exception as ex:
        return jsonify({'error': str(ex)}), 500


# ── WebSocket streaming on :5051 ──────────────────────────────────────────────
async def ws_handler(ws):
    sr, state = 44100, ConnState()
    try:
        async for msg in ws:
            if isinstance(msg, str):
                try:
                    c = json.loads(msg)
                    if c.get('type') == 'init':
                        sr = int(c.get('sample_rate', 44100))
                        state.reset()
                    elif c.get('type') == 'reset':
                        state.reset()  # gate closed — flush stale continuity
                except Exception:
                    pass
                continue
            if len(msg) < 800:
                continue
            s = np.frombuffer(msg, dtype=np.int16).astype(np.float64) / 32768.0
            try:
                snd = parselmouth.Sound(s, sampling_frequency=float(sr))
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