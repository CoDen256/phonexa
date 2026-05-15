"""
analyze_server.py  — dual-ceiling formant tracker
HTTP :5050   /ping  /analyze  /analyze-file  /analyze-debug
WS   :5051          streaming with per-connection config

pip install flask flask-cors parselmouth numpy websockets
"""
import json, math, os, struct, asyncio, threading, tempfile
from collections import deque

import numpy as np
import parselmouth
from parselmouth.praat import call
from flask import Flask, request, jsonify
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

# ── Base Praat configs (overridden per-connection via conn_cfg) ───────────────
CFG_SCAN = dict(time_step=0.010, max_number_of_formants=5,
                maximum_formant=5000.0, window_length=0.025, pre_emphasis_from=50.0)
CFG_BACK = dict(time_step=0.010, max_number_of_formants=2,
                maximum_formant=1800.0, window_length=0.025, pre_emphasis_from=50.0)
CFG_FRONT = dict(time_step=0.010, max_number_of_formants=3,  # debug endpoint only
                 maximum_formant=4200.0, window_length=0.025, pre_emphasis_from=50.0)

F1_RANGE = (150, 1100)
F2_RANGE = (400, 3200)

STEP_MS     = 10
WINDOW_SAMP = 4096   # ring buffer samples (~93ms at 44100Hz)

# ── Per-connection config defaults (sent by debug.html sliders) ───────────────
DEFAULT_CONN_CFG = {
    'max_f':               5000,   # CFG_SCAN maximum_formant
    'n_formants':          5,      # CFG_SCAN max_number_of_formants
    'window_ms':           25,     # analysis window length in ms
    'pre_emphasis':        50,     # pre-emphasis from (Hz)
    'back_ceiling':        1800,   # CFG_BACK maximum_formant
    'back_ceiling_ratio':  0.95,   # prefer BACK when f2_b < back_ceiling × ratio
    'back_front_ratio':    0.75,   # prefer BACK when f2_b < f2_scan × ratio
}


def _make_cfgs(conn_cfg):
    """Build parselmouth kwargs from per-connection config."""
    wl = float(conn_cfg.get('window_ms', 25)) / 1000
    pe = float(conn_cfg.get('pre_emphasis', 50))
    scan = {**CFG_SCAN,
            'maximum_formant':       float(conn_cfg.get('max_f', 5000)),
            'max_number_of_formants': int(conn_cfg.get('n_formants', 5)),
            'window_length':          wl,
            'pre_emphasis_from':      pe}
    back = {**CFG_BACK,
            'maximum_formant':  float(conn_cfg.get('back_ceiling', 1800)),
            'window_length':    wl,
            'pre_emphasis_from': pe}
    return scan, back


# ── ConnState ─────────────────────────────────────────────────────────────────
class ConnState:
    """Continuity tracking only — no EMA (client does median smoothing)."""
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
    """Run Burg LPC; validate F1 range only (F2 phantoms pass through to _fix_phantom)."""
    try:
        fmts = snd.to_formant_burg(**cfg)
        t    = snd.duration / 2
        f1   = fmts.get_value_at_time(1, t)
        f2   = fmts.get_value_at_time(2, t)
        if math.isnan(f1) or math.isnan(f2) or not F1_RANGE[0] <= f1 <= F1_RANGE[1]:
            return None, None
        return f1, f2
    except Exception:
        return None, None


def _fix_phantom(f1, f2, snd, cfg_scan):
    """
    Close front vowels (F1<350Hz, F2/F1<1.7) often have a phantom LPC pole
    between F1 and the real F2. Re-scan with more formants to find the real F2.
    """
    if f1 is None or f2 is None or f1 >= 350 or (f2 / f1) >= 1.7:
        return f1, f2
    try:
        # Use at least 5 formants for phantom scan
        scan_cfg = {**cfg_scan, 'max_number_of_formants': max(5, cfg_scan['max_number_of_formants'])}
        fmts = snd.to_formant_burg(**scan_cfg)
        t    = snd.duration / 2
        for n in range(2, scan_cfg['max_number_of_formants'] + 2):
            candidate = fmts.get_value_at_time(n, t)
            if (not math.isnan(candidate)
                    and candidate > f1 * 2.0
                    and F2_RANGE[0] <= candidate <= F2_RANGE[1]):
                return f1, candidate
    except Exception:
        pass
    return f1, f2


def analyze_best(snd, state=None, conn_cfg=None):
    """
    Dual-ceiling formant analysis + phantom fix.
    conn_cfg overrides the default algorithm parameters per-connection.
    """
    if conn_cfg is None:
        conn_cfg = DEFAULT_CONN_CFG

    t_ms = round(snd.duration / 2 * 1000)
    if snd.duration < 0.025:
        return {'voiced': False, 'f1': None, 'f2': None, 't': t_ms}

    cfg_scan, cfg_back = _make_cfgs(conn_cfg)

    f1_b, f2_b = _praat_get(snd, cfg_back)
    f1_f, f2_f = _praat_get(snd, cfg_scan)

    BACK_VALID  = f1_b is not None and f2_b is not None
    FRONT_VALID = f1_f is not None and f2_f is not None
    back_ceil_thresh = float(conn_cfg.get('back_ceiling', 1800)) * float(conn_cfg.get('back_ceiling_ratio', 0.95))
    back_front_ratio = float(conn_cfg.get('back_front_ratio', 0.75))

    use_back = (
            BACK_VALID and FRONT_VALID
            and f2_b < back_ceil_thresh
            and f2_b < f2_f * back_front_ratio
    )

    if use_back:
        f1_raw, f2_raw = f1_b, f2_b
    elif FRONT_VALID:
        f1_raw, f2_raw = f1_f, f2_f
    elif BACK_VALID:
        f1_raw, f2_raw = f1_b, f2_b
    else:
        return {'voiced': False, 'f1': None, 'f2': None, 't': t_ms}

    f1_raw, f2_raw = _fix_phantom(f1_raw, f2_raw, snd, cfg_scan)

    if not F2_RANGE[0] <= f2_raw <= F2_RANGE[1]:
        return {'voiced': False, 'f1': None, 'f2': None, 't': t_ms}

    if state:
        f1, f2 = state.process(f1_raw, f2_raw)
    else:
        f1, f2 = round(f1_raw), round(f2_raw)

    return {'voiced': True, 'f1': f1, 'f2': f2, 't': t_ms}


def _decode_pcm(msg):
    """Always decode as Int16 — that's what our clients send."""
    return np.frombuffer(msg, dtype=np.int16).astype(np.float64) / 32768.0


# ── HTTP endpoints ─────────────────────────────────────────────────────────────
@app.route('/ping')
def ping():
    return jsonify({'ok': True})


@app.route('/analyze', methods=['POST'])
def analyze():
    """Single-window analysis for the practice tool."""
    data = request.data
    if not data: return jsonify({'error': 'No audio data'}), 400
    if data[:4] == b'RIFF':
        sr = struct.unpack_from('<I', data, 24)[0]
        s  = np.frombuffer(data[44:], dtype=np.int16).astype(np.float64) / 32768.0
    else:
        sr, s = 16000, np.frombuffer(data, dtype=np.int16).astype(np.float64) / 32768.0
    dur = len(s) / sr * 1000
    if dur < 50: return jsonify({'error': 'Duration < 50ms'}), 400
    ws_s = float(request.headers.get('X-Window-Start', 0))
    ws_e = float(request.headers.get('X-Window-End', 1))
    s = s[int(ws_s * len(s)):int(ws_e * len(s))]
    try:
        snd = parselmouth.Sound(s, sampling_frequency=float(sr))
        r   = analyze_best(snd)
        if not r['voiced']: return jsonify({'error': 'No voiced speech detected'}), 400
        return jsonify({'f1': r['f1'], 'f2': r['f2'], 'duration_ms': round(dur)})
    except Exception as ex:
        return jsonify({'error': str(ex)}), 500


@app.route('/analyze-file', methods=['POST'])
def analyze_file():
    """
    Whole-file frame-by-frame analysis — used by debug.html for reference audio.
    Accepts multipart form: file=<audio>, config=<json string with conn_cfg keys>.
    Returns {frames: [{t, f1, f2, rms}], duration}.
    """
    file = request.files.get('file')
    if not file: return jsonify({'error': 'no file'}), 400

    conn_cfg = dict(DEFAULT_CONN_CFG)
    try:
        cfg_update = json.loads(request.form.get('config', '{}'))
        for k in DEFAULT_CONN_CFG:
            if k in cfg_update:
                conn_cfg[k] = cfg_update[k]
    except Exception:
        pass

    with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as f:
        file.save(f.name); tmp = f.name

    try:
        snd      = parselmouth.Sound(tmp)
        sr       = snd.sampling_frequency
        samples  = snd.values[0].astype(np.float64)
        dur      = snd.duration

        step_n   = max(1, int(sr * STEP_MS / 1000))
        win_n    = WINDOW_SAMP
        state    = ConnState()
        frames   = []

        pos = win_n
        while pos <= len(samples):
            win = samples[pos - win_n:pos]
            rms = float(np.sqrt(np.mean(win ** 2)))
            t   = round(pos / sr, 3)
            try:
                w_snd = parselmouth.Sound(win, sampling_frequency=float(sr))
                r     = analyze_best(w_snd, state=state, conn_cfg=conn_cfg)
                frames.append({'t': t,
                               'f1': r['f1'] if r['voiced'] else None,
                               'f2': r['f2'] if r['voiced'] else None,
                               'rms': round(rms, 6)})
            except Exception:
                frames.append({'t': t, 'f1': None, 'f2': None, 'rms': round(rms, 6)})
            pos += step_n

        return jsonify({'frames': frames, 'duration': round(dur, 3)})
    except Exception as ex:
        return jsonify({'error': str(ex)}), 500
    finally:
        os.unlink(tmp)


@app.route('/analyze-debug', methods=['POST'])
def analyze_debug():
    """Raw Praat formant values — for diagnosing rejections."""
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
                    vals[f'F{n}']  = None if math.isnan(v)  else round(v, 1)
                    vals[f'BW{n}'] = None if math.isnan(bw) else round(bw, 1)
                out['configs'][name] = {'ceiling': cfg['maximum_formant'],
                                        'n': cfg['max_number_of_formants'], 'formants': vals}
            except Exception as ex:
                out['configs'][name] = {'error': str(ex)}
        return jsonify(out)
    except Exception as ex:
        return jsonify({'error': str(ex)}), 500


# ── WebSocket streaming ────────────────────────────────────────────────────────
async def ws_handler(ws):
    sr       = 44100
    state    = ConnState()
    ring     = deque(maxlen=WINDOW_SAMP)
    since    = 0
    conn_cfg = dict(DEFAULT_CONN_CFG)

    try:
        async for msg in ws:
            if isinstance(msg, str):
                try:
                    c = json.loads(msg)
                    t = c.get('type', '')
                    if t == 'init':
                        sr = int(c.get('sample_rate', 44100))
                        state.reset(); ring.clear(); since = 0
                    elif t == 'reset':
                        state.reset(); ring.clear(); since = 0
                    elif t == 'config':
                        for k in DEFAULT_CONN_CFG:
                            if k in c:
                                conn_cfg[k] = c[k]
                        state.reset()  # reset continuity when params change
                except Exception:
                    pass
                continue

            if len(msg) < 64: continue

            chunk = _decode_pcm(msg)
            rms   = float(np.sqrt(np.mean(chunk ** 2)))
            ring.extend(chunk)
            since += len(chunk)

            step = int(sr * STEP_MS / 1000)
            if since < step or len(ring) < WINDOW_SAMP:
                continue
            since = 0

            try:
                snd = parselmouth.Sound(np.array(ring), float(sr))
                r   = analyze_best(snd, state=state, conn_cfg=conn_cfg)
                r['rms'] = round(rms, 6)
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