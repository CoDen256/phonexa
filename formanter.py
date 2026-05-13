"""
analyze_server.py — Phase 2b: dual-ceiling analysis.

For each chunk, Praat runs twice:
  A: ceiling=4200Hz, n=3  → front/mid vowels (good when F2 > 1000Hz)
  B: ceiling=1800Hz, n=2  → back vowels (good when F1+F2 both below ~1000Hz)

Selection rule: prefer B if it returns valid formants AND F2_B < 1100Hz,
  because low-F2 results from the narrow window are almost always right.
  Otherwise prefer A.

HTTP :5050  /ping  /analyze
WS   :5051         (streaming)

pip install flask flask-cors parselmouth numpy websockets
"""
import math, json, struct, asyncio, threading
import numpy as np
import parselmouth
from flask import Flask, request, jsonify
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

# Two Praat configs — run both each time
CFG_FRONT = dict(time_step=0.010, max_number_of_formants=3,
                 maximum_formant=4200.0, window_length=0.025, pre_emphasis_from=50.0)
CFG_BACK  = dict(time_step=0.010, max_number_of_formants=2,
                 maximum_formant=1800.0, window_length=0.025, pre_emphasis_from=50.0)

F1_RANGE = (150, 1100)
F2_RANGE = (400, 3200)
EMA_ALPHA = 0.35


class ConnState:
    def __init__(self):
        self.reset()
    def reset(self):
        self.p1 = self.p2 = self.e1 = self.e2 = None
    def process(self, f1, f2):
        if self.p1 is not None:
            if (abs(f2-self.p1)+abs(f1-self.p2)) < (abs(f1-self.p1)+abs(f2-self.p2)):
                f1, f2 = f2, f1
        self.p1, self.p2 = f1, f2
        self.e1 = f1 if self.e1 is None else EMA_ALPHA*f1+(1-EMA_ALPHA)*self.e1
        self.e2 = f2 if self.e2 is None else EMA_ALPHA*f2+(1-EMA_ALPHA)*self.e2
        return round(self.e1), round(self.e2)


def _praat_get(snd, cfg):
    """Run Praat with given config, return (f1, f2) at midpoint or (None, None)."""
    try:
        fmts = snd.to_formant_burg(**cfg)
        t  = snd.duration / 2
        f1 = fmts.get_value_at_time(1, t)
        f2 = fmts.get_value_at_time(2, t)
        if (math.isnan(f1) or math.isnan(f2)
                or not F1_RANGE[0]<=f1<=F1_RANGE[1]
                or not F2_RANGE[0]<=f2<=F2_RANGE[1]):
            return None, None
        return f1, f2
    except Exception:
        return None, None


def analyze_dual(snd, state=None):
    """
    Dual-ceiling analysis.  Returns one dict {f1, f2, voiced, t}.
    Selection: if back-vowel config gives valid F2 < 1100 Hz → use it.
    Otherwise fall back to front-vowel config.
    """
    t_ms = round(snd.duration / 2 * 1000)
    if snd.duration < 0.025:
        return {'voiced': False, 'f1': None, 'f2': None, 't': t_ms}

    f1_b, f2_b = _praat_get(snd, CFG_BACK)
    f1_f, f2_f = _praat_get(snd, CFG_FRONT)

    # Choose which result to use
    if f1_b is not None and f2_b is not None and f2_b < 1100:
        f1_raw, f2_raw = f1_b, f2_b   # back vowel config wins
    elif f1_f is not None and f2_f is not None:
        f1_raw, f2_raw = f1_f, f2_f   # front vowel config
    elif f1_b is not None and f2_b is not None:
        f1_raw, f2_raw = f1_b, f2_b   # back as last resort
    else:
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
    if not data: return jsonify({'error':'No audio data'}), 400
    if data[:4]==b'RIFF':
        sr = struct.unpack_from('<I',data,24)[0]
        s  = np.frombuffer(data[44:],dtype=np.int16).astype(np.float64)/32768.0
    else:
        sr, s = 16000, np.frombuffer(data,dtype=np.int16).astype(np.float64)/32768.0
    dur = len(s)/sr*1000
    if dur<50: return jsonify({'error':'Duration < 50ms'}), 400
    ws,we = float(request.headers.get('X-Window-Start',0)), float(request.headers.get('X-Window-End',1))
    s = s[int(ws*len(s)):int(we*len(s))]
    try:
        snd = parselmouth.Sound(s, sampling_frequency=float(sr))
        r   = analyze_dual(snd)
        if not r['voiced']: return jsonify({'error':'No voiced speech detected'}), 400
        return jsonify({'f1':r['f1'], 'f2':r['f2'], 'duration_ms':round(dur)})
    except Exception as ex: return jsonify({'error':str(ex)}), 500

@app.route('/ping')
def ping(): return jsonify({'ok':True})


# ── WebSocket streaming on :5051 ──────────────────────────────────────────────
async def ws_handler(ws):
    sr, state = 44100, ConnState()
    try:
        async for msg in ws:
            if isinstance(msg, str):
                try:
                    c = json.loads(msg)
                    if c.get('type')=='init':
                        sr=int(c.get('sample_rate',44100)); state.reset()
                except Exception: pass
                continue
            if len(msg)<800: continue
            s = np.frombuffer(msg,dtype=np.int16).astype(np.float64)/32768.0
            try:
                snd = parselmouth.Sound(s, sampling_frequency=float(sr))
                r   = analyze_dual(snd, state=state)
                # Wrap single frame in frames array (client expects this)
                await ws.send(json.dumps({'frames':[r]}))
            except Exception as ex:
                await ws.send(json.dumps({'frames':[],'error':str(ex)}))
    except Exception: pass

def _run_ws():
    import websockets as _ws
    async def serve():
        async with _ws.serve(ws_handler,'localhost',5051):
            await asyncio.Future()
    asyncio.run(serve())

threading.Thread(target=_run_ws, daemon=True).start()

if __name__=='__main__':
    print('HTTP :5050   WS :5051')
    app.run(host='localhost', port=5050, threaded=True, debug=False)