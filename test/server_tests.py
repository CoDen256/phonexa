#!/usr/bin/env python3
"""
server_tests.py
===============
Regression tests for analyze_server.py.

First run  → results saved as reference files in tests/references/.
Later runs → results compared against those references.

Usage (run from project root, server must be running)
-----------------------------------------------------
  python tests/server_tests.py                 # all endpoints
  python tests/server_tests.py analyze         # one endpoint
  python tests/server_tests.py analyze_file
  python tests/server_tests.py analyze_debug
  python tests/server_tests.py ws
  python tests/server_tests.py --update        # regenerate all references
  python tests/server_tests.py --list          # list test IDs and exit

Notes on known behaviours
--------------------------
- /ws  "t" field in every frame is always the ring-buffer midpoint
  (~46 ms = RING_BUFFER_SAMPLES/2/sample_rate×1000 = 4096/2/44100×1000).
  It is NOT an absolute stream position.  Frames are compared on
  voiced/F1/F2 only, not on t.

- Short audio files (< 4096 samples ≈ 93 ms) are automatically looped
  to fill the ring buffer and produce at least a few analysis frames.
  The reference files record how many loops were applied so comparisons
  stay consistent across runs.
"""

from __future__ import annotations

import argparse
import asyncio
import io
import json
import math
import os
import struct
import sys
import tempfile
import wave
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
import requests

try:
    import websockets
    _HAS_WEBSOCKETS = True
except ImportError:
    _HAS_WEBSOCKETS = False

try:
    import parselmouth
    _HAS_PARSELMOUTH = True
except ImportError:
    _HAS_PARSELMOUTH = False


# ══════════════════════════════════════════════════════════════════════════════
# Settings  — keep RING_BUFFER_SAMPLES in sync with analyze_server.py
# ══════════════════════════════════════════════════════════════════════════════

HTTP_BASE           = 'http://localhost:5050'
WS_URL              = 'ws://localhost:5051'
TESTS_DIR           = Path(__file__).parent
REFERENCES_DIR      = TESTS_DIR / 'references'
TOLERANCE_HZ        = 0        # 0 = exact (Praat is deterministic per machine)
WS_RECV_TIMEOUT     = 0.5      # seconds — per recv() call in the drain loop
RING_BUFFER_SAMPLES = 4096     # must match analyze_server.py RING_BUFFER_SAMPLES
MIN_WS_SAMPLES      = RING_BUFFER_SAMPLES * 3   # enough for several analysis frames

# Default ConnConfig — must stay in sync with analyze_server.py ConnConfig defaults
DEFAULT_CONN_CONFIG = {
    'max_f':              5000,
    'n_formants':         5,
    'window_ms':          25,
    'pre_emphasis':       50,
    'back_ceiling':       1800,
    'back_ceiling_ratio': 0.95,
    'back_front_ratio':   0.75,
    'energy_floor':       0.0,
}


# ══════════════════════════════════════════════════════════════════════════════
# Test result
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class Diff:
    field:     str
    current:   Any
    reference: Any
    passed:    bool
    delta_hz:  float | None = None


@dataclass
class TestResult:
    case_id:    str
    endpoint:   str
    passed:     bool
    is_new_ref: bool = False
    error:      str | None = None
    diffs:      list[Diff] = field(default_factory=list)
    payload:    dict = field(default_factory=dict)


# ══════════════════════════════════════════════════════════════════════════════
# Audio loading  — WAV directly; other formats via parselmouth
# ══════════════════════════════════════════════════════════════════════════════

def load_audio_as_int16(audio_path: Path) -> tuple[np.ndarray, int]:
    """
    Load any audio file as (int16_samples, sample_rate).
    .wav  → Python wave module (no extra deps).
    Other → parselmouth (handles MP3, AIFF, FLAC, …).
    """
    if audio_path.suffix.lower() == '.wav':
        return _load_wav(audio_path)
    if _HAS_PARSELMOUTH:
        return _load_via_parselmouth(audio_path)
    raise RuntimeError(
        f'Cannot load {audio_path.name}: non-WAV requires parselmouth '
        '(pip install praat-parselmouth)'
    )


def _load_wav(path: Path) -> tuple[np.ndarray, int]:
    with wave.open(str(path), 'rb') as wf:
        sr        = wf.getframerate()
        n_ch      = wf.getnchannels()
        raw_bytes = wf.readframes(wf.getnframes())
    samples = np.frombuffer(raw_bytes, dtype=np.int16)
    if n_ch == 2:                                          # stereo → mono
        samples = ((samples[0::2].astype(np.int32) + samples[1::2].astype(np.int32)) // 2
                   ).astype(np.int16)
    return samples, sr


def _load_via_parselmouth(path: Path) -> tuple[np.ndarray, int]:
    sound  = parselmouth.Sound(str(path))
    sr     = int(sound.sampling_frequency)
    floats = sound.values[0]                               # first channel, float64 [-1,1]
    i16    = np.clip(floats * 32768, -32768, 32767).astype(np.int16)
    return i16, sr


def load_as_wav_bytes(audio_path: Path) -> bytes:
    """Return WAV bytes for HTTP upload.  Converts non-WAV via parselmouth."""
    if audio_path.suffix.lower() == '.wav':
        return audio_path.read_bytes()
    if not _HAS_PARSELMOUTH:
        raise RuntimeError(f'Cannot convert {audio_path.name} to WAV without parselmouth.')
    sound = parselmouth.Sound(str(audio_path))
    with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as tmp:
        tmp_path = tmp.name
    try:
        sound.save(tmp_path, 'WAV')
        return Path(tmp_path).read_bytes()
    finally:
        os.unlink(tmp_path)


def get_audio_duration_ms(audio_path: Path) -> float:
    """Return total audio duration in milliseconds."""
    try:
        samples, sr = load_audio_as_int16(audio_path)
        return len(samples) / sr * 1000
    except Exception:
        return 0.0


def loop_samples_to_minimum(samples: np.ndarray, min_samples: int) -> tuple[np.ndarray, int]:
    """
    Repeat *samples* until the array is at least *min_samples* long.
    Returns (looped_samples, loop_count).
    A loop_count of 1 means the original was already long enough.
    """
    if len(samples) >= min_samples:
        return samples, 1
    n_loops = math.ceil(min_samples / len(samples))
    return np.tile(samples, n_loops)[:n_loops * len(samples)], n_loops


def encode_int16_as_wav(samples: np.ndarray, sample_rate: int) -> bytes:
    """Encode a 1-channel int16 array as in-memory WAV bytes."""
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(samples.tobytes())
    return buf.getvalue()


def split_into_int16_chunks(samples: np.ndarray, chunk_samples: int) -> list[bytes]:
    return [
        samples[s:s + chunk_samples].tobytes()
        for s in range(0, len(samples), chunk_samples)
    ]


# ══════════════════════════════════════════════════════════════════════════════
# Reference file management
# ══════════════════════════════════════════════════════════════════════════════

def _ref_path(endpoint: str, case_id: str) -> Path:
    return REFERENCES_DIR / endpoint / f'{case_id}.json'


def load_reference(endpoint: str, case_id: str) -> dict | None:
    p = _ref_path(endpoint, case_id)
    return json.loads(p.read_text()) if p.exists() else None


def save_reference(endpoint: str, case_id: str, record: dict) -> None:
    p = _ref_path(endpoint, case_id)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(record, indent=2))


def build_record(case: dict, endpoint: str, server_response: dict,
                 extra_meta: dict | None = None) -> dict:
    """
    Wrap a server response in a record that stores the test parameters.
    Includes the full effective config (case overrides merged on defaults).
    """
    effective_config = {**DEFAULT_CONN_CONFIG, **case.get('config', {})}
    meta = {
        'endpoint':  endpoint,
        'case_id':   case['id'],
        'audio':     case.get('audio', ''),
        'config':    effective_config,
        'recorded':  datetime.now(timezone.utc).isoformat(),
    }
    if extra_meta:
        meta.update(extra_meta)
    return {'meta': meta, 'response': server_response}


# ══════════════════════════════════════════════════════════════════════════════
# Comparison helpers
# ══════════════════════════════════════════════════════════════════════════════

def _diff_formant(name: str, cur: int | None, ref: int | None) -> Diff:
    if cur is None and ref is None:
        return Diff(name, cur, ref, passed=True, delta_hz=0)
    if cur is None or ref is None:
        return Diff(name, cur, ref, passed=False)
    delta = abs(cur - ref)
    return Diff(name, cur, ref, passed=(delta <= TOLERANCE_HZ), delta_hz=float(delta))


def _diff_count(name: str, cur: int, ref: int) -> Diff:
    return Diff(name, cur, ref, passed=(cur == ref))


def _diff_float(name: str, cur: float, ref: float, tol: float) -> Diff:
    delta = abs(cur - ref)
    return Diff(name, cur, ref, passed=(delta <= tol), delta_hz=delta)


def _is_voiced_ws(frame: dict) -> bool:
    """WS frames carry an explicit 'voiced' boolean."""
    return bool(frame.get('voiced'))


def _is_voiced_file(frame: dict) -> bool:
    """/analyze-file frames have no 'voiced' key; f1 not None means voiced."""
    return frame.get('f1') is not None


def _aggregate(frames: list[dict], voiced_pred) -> dict:
    voiced = [f for f in frames if voiced_pred(f) and f.get('f1') is not None]
    return {
        'total':  len(frames),
        'voiced': len(voiced),
        'mean_f1': round(sum(f['f1'] for f in voiced) / len(voiced), 1) if voiced else None,
        'mean_f2': round(sum(f['f2'] for f in voiced) / len(voiced), 1) if voiced else None,
    }


def _diff_frame_lists(cur: list[dict], ref: list[dict], voiced_pred) -> list[Diff]:
    """Compare two frame lists; return only failing diffs."""
    if len(cur) != len(ref):
        return [_diff_count('frame_count', len(cur), len(ref))]
    failures: list[Diff] = []
    for i, (c, r) in enumerate(zip(cur, ref)):
        cv, rv = voiced_pred(c), voiced_pred(r)
        if cv != rv:
            failures.append(Diff(f'frame[{i}].voiced', cv, rv, passed=False))
        if cv and rv:
            d1 = _diff_formant(f'frame[{i}].f1', c.get('f1'), r.get('f1'))
            d2 = _diff_formant(f'frame[{i}].f2', c.get('f2'), r.get('f2'))
            if not d1.passed: failures.append(d1)
            if not d2.passed: failures.append(d2)
    return failures


# ══════════════════════════════════════════════════════════════════════════════
# /analyze
# ══════════════════════════════════════════════════════════════════════════════

def run_analyze_case(case: dict, update_refs: bool) -> TestResult:
    """
    POST audio to /analyze with X-Window-* headers.
    Compares F1 and F2.

    Case keys: id, audio, window_start (0.0), window_end (1.0), description
    """
    endpoint   = 'analyze'
    audio_path = Path(case['audio'])
    if not audio_path.exists():
        return TestResult(case['id'], endpoint, False, error=f'File not found: {audio_path}')

    window_start = case.get('window_start', 0.0)
    window_end   = case.get('window_end',   1.0)
    duration_ms  = get_audio_duration_ms(audio_path)
    from_ms      = round(duration_ms * window_start)
    to_ms        = round(duration_ms * window_end)

    try:
        response = requests.post(
            f'{HTTP_BASE}/analyze',
            data=load_as_wav_bytes(audio_path),
            headers={
                'Content-Type':   'audio/wav',
                'X-Window-Start': str(window_start),
                'X-Window-End':   str(window_end),
            },
            timeout=10,
        )
        if not response.ok:
            return TestResult(case['id'], endpoint, False,
                              error=f'HTTP {response.status_code}: {response.json().get("error")}')
        server_resp = response.json()
    except Exception as exc:
        return TestResult(case['id'], endpoint, False, error=str(exc))

    extra = {
        'duration_ms':  round(duration_ms),
        'window_start': window_start,
        'window_end':   window_end,
        'from_ms':      from_ms,
        'to_ms':        to_ms,
    }
    record    = build_record(case, endpoint, server_resp, extra_meta=extra)
    reference = load_reference(endpoint, case['id'])
    if reference is None or update_refs:
        save_reference(endpoint, case['id'], record)
        return TestResult(case['id'], endpoint, True, is_new_ref=True,
                          payload={**server_resp, **extra})

    ref_resp = reference['response']
    diffs    = [
        _diff_formant('f1', server_resp.get('f1'), ref_resp.get('f1')),
        _diff_formant('f2', server_resp.get('f2'), ref_resp.get('f2')),
    ]
    return TestResult(case['id'], endpoint, all(d.passed for d in diffs),
                      diffs=diffs, payload={**server_resp, **extra})


# ══════════════════════════════════════════════════════════════════════════════
# /analyze-file
# ══════════════════════════════════════════════════════════════════════════════

def run_analyze_file_case(case: dict, update_refs: bool) -> TestResult:
    """
    POST audio to /analyze-file and compare all frames.

    Short files (< RING_BUFFER_SAMPLES samples) are looped automatically
    so the server can produce at least a few analysis windows.

    /analyze-file frames: {t, f1, f2, rms}  — no 'voiced' key.
    A frame is voiced when f1 is not None.

    Case keys: id, audio, config ({}), description
    """
    endpoint   = 'analyze_file'
    audio_path = Path(case['audio'])
    if not audio_path.exists():
        return TestResult(case['id'], endpoint, False, error=f'File not found: {audio_path}')

    samples, sr = load_audio_as_int16(audio_path)
    looped_samples, n_loops = loop_samples_to_minimum(samples, RING_BUFFER_SAMPLES + 1)
    wav_bytes = encode_int16_as_wav(looped_samples, sr) if n_loops > 1 \
        else load_as_wav_bytes(audio_path)

    try:
        response = requests.post(
            f'{HTTP_BASE}/analyze-file',
            files={'file': ('audio.wav', wav_bytes, 'audio/wav')},
            data={'config': json.dumps(case.get('config', {}))},
            timeout=60,
        )
        if not response.ok:
            return TestResult(case['id'], endpoint, False,
                              error=f'HTTP {response.status_code}: {response.json().get("error")}')
        server_resp = response.json()
    except Exception as exc:
        return TestResult(case['id'], endpoint, False, error=str(exc))

    extra  = {'loops_applied': n_loops, 'original_samples': len(samples)}
    record = build_record(case, endpoint, server_resp, extra_meta=extra)
    reference = load_reference(endpoint, case['id'])
    if reference is None or update_refs:
        save_reference(endpoint, case['id'], record)
        return TestResult(case['id'], endpoint, True, is_new_ref=True, payload=server_resp)

    cur_frames = server_resp.get('frames', [])
    ref_frames = reference['response'].get('frames', [])
    cur_stats  = _aggregate(cur_frames, _is_voiced_file)
    ref_stats  = _aggregate(ref_frames, _is_voiced_file)

    diffs: list[Diff] = [
        _diff_count('total_frames',  cur_stats['total'],  ref_stats['total']),
        _diff_count('voiced_frames', cur_stats['voiced'], ref_stats['voiced']),
        _diff_float('mean_f1', cur_stats['mean_f1'] or 0, ref_stats['mean_f1'] or 0, TOLERANCE_HZ),
        _diff_float('mean_f2', cur_stats['mean_f2'] or 0, ref_stats['mean_f2'] or 0, TOLERANCE_HZ),
    ]
    diffs.extend(_diff_frame_lists(cur_frames, ref_frames, _is_voiced_file))
    return TestResult(case['id'], endpoint, all(d.passed for d in diffs),
                      diffs=diffs, payload=server_resp)


# ══════════════════════════════════════════════════════════════════════════════
# /analyze-debug
# ══════════════════════════════════════════════════════════════════════════════

def run_analyze_debug_case(case: dict, update_refs: bool) -> TestResult:
    """
    POST audio to /analyze-debug and compare raw Praat output per config.

    Case keys: id, audio, window_start (0.15), window_end (0.85), description
    """
    endpoint   = 'analyze_debug'
    audio_path = Path(case['audio'])
    if not audio_path.exists():
        return TestResult(case['id'], endpoint, False, error=f'File not found: {audio_path}')

    window_start = case.get('window_start', 0.15)
    window_end   = case.get('window_end',   0.85)
    duration_ms  = get_audio_duration_ms(audio_path)
    from_ms      = round(duration_ms * window_start)
    to_ms        = round(duration_ms * window_end)

    try:
        response = requests.post(
            f'{HTTP_BASE}/analyze-debug',
            data=load_as_wav_bytes(audio_path),
            headers={
                'Content-Type':   'audio/wav',
                'X-Window-Start': str(window_start),
                'X-Window-End':   str(window_end),
            },
            timeout=10,
        )
        if not response.ok:
            return TestResult(case['id'], endpoint, False,
                              error=f'HTTP {response.status_code}: {response.json().get("error")}')
        server_resp = response.json()
    except Exception as exc:
        return TestResult(case['id'], endpoint, False, error=str(exc))

    extra  = {
        'duration_ms':  round(duration_ms),
        'window_start': window_start,
        'window_end':   window_end,
        'from_ms':      from_ms,
        'to_ms':        to_ms,
    }
    record    = build_record(case, endpoint, server_resp, extra_meta=extra)
    reference = load_reference(endpoint, case['id'])
    if reference is None or update_refs:
        save_reference(endpoint, case['id'], record)
        return TestResult(case['id'], endpoint, True, is_new_ref=True,
                          payload={**server_resp, **extra})

    diffs: list[Diff] = []
    for cfg_name, ref_data in reference['response'].get('configs', {}).items():
        cur_fmt = server_resp.get('configs', {}).get(cfg_name, {}).get('formants', {})
        ref_fmt = ref_data.get('formants', {})
        for key, ref_val in ref_fmt.items():
            if key.startswith('F') and not key.startswith('BW'):
                diffs.append(_diff_formant(f'{cfg_name}.{key}', cur_fmt.get(key), ref_val))

    return TestResult(case['id'], endpoint, all(d.passed for d in diffs),
                      diffs=diffs, payload={**server_resp, **extra})


# ══════════════════════════════════════════════════════════════════════════════
# /ws — concurrent send + receive
# ══════════════════════════════════════════════════════════════════════════════

async def _stream_and_collect(
        audio_path:    Path,
        chunk_samples: int,
        config:        dict,
) -> dict:
    """
    Reproduce what realtime.js _accumulate() does exactly:
      1. Connect.
      2. Send {type:'init', sample_rate}.
      3. Send optional {type:'config'}.
      4. Send each Int16 chunk as a binary frame — CONCURRENTLY with receiving.

    Why concurrent? Sending all chunks then receiving causes a TCP deadlock:
    client send buffer fills → server can't send responses (client recv buffer
    full) → both sides block forever.  asyncio.gather() runs send and receive
    as two concurrent coroutines, matching the browser WebSocket model.

    Short files are looped before splitting into chunks so the ring buffer
    always fills and the server produces at least a few analysis frames.

    Note on the 't' field in frames
    --------------------------------
    The server sets t = round(RING_BUFFER_SAMPLES / 2 / sample_rate * 1000)
    which is always ~46 ms regardless of where we are in the stream.
    It is the midpoint of the 4096-sample analysis ring buffer, not an
    absolute stream position.  Frame comparisons skip the 't' field.
    """
    samples_int16, sample_rate = load_audio_as_int16(audio_path)
    looped, n_loops = loop_samples_to_minimum(samples_int16, MIN_WS_SAMPLES)
    audio_chunks    = split_into_int16_chunks(looped, chunk_samples)

    received_frames: list[dict] = []
    sending_done = asyncio.Event()

    async with websockets.connect(WS_URL) as ws:
        await ws.send(json.dumps({'type': 'init', 'sample_rate': sample_rate}))
        if config:
            await ws.send(json.dumps({'type': 'config', **config}))

        async def send_all_chunks() -> None:
            for chunk_bytes in audio_chunks:
                await ws.send(chunk_bytes)
            sending_done.set()

        async def receive_all_frames() -> None:
            while True:
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=WS_RECV_TIMEOUT)
                    for frame in json.loads(raw).get('frames', []):
                        received_frames.append(frame)
                except asyncio.TimeoutError:
                    if sending_done.is_set():
                        break   # done sending AND server went quiet → stop

        await asyncio.gather(send_all_chunks(), receive_all_frames())

    voiced      = [f for f in received_frames if _is_voiced_ws(f)]
    voiced_f1   = [f['f1'] for f in voiced if f.get('f1') is not None]
    voiced_f2   = [f['f2'] for f in voiced if f.get('f2') is not None]

    return {
        'chunks_sent':     len(audio_chunks),
        'samples_sent':    len(looped),
        'original_samples': len(samples_int16),
        'loops_applied':   n_loops,
        'sample_rate':     sample_rate,
        'chunk_samples':   chunk_samples,
        'frames_received': len(received_frames),
        'voiced_count':    len(voiced),
        'mean_f1':         round(sum(voiced_f1) / len(voiced_f1), 1) if voiced_f1 else None,
        'mean_f2':         round(sum(voiced_f2) / len(voiced_f2), 1) if voiced_f2 else None,
        'frames':          received_frames,
    }


def run_ws_case(case: dict, update_refs: bool) -> TestResult:
    """
    Stream audio to /ws and compare aggregate + per-frame results.
    /ws frames: {voiced, f1, f2, rms, t}  — 't' is always ~46 ms (ring midpoint).

    Case keys: id, audio, chunk_samples (128), config ({}), description
    """
    if not _HAS_WEBSOCKETS:
        return TestResult(case['id'], 'ws', False,
                          error='websockets not installed — pip install websockets')
    endpoint   = 'ws'
    audio_path = Path(case['audio'])
    if not audio_path.exists():
        return TestResult(case['id'], endpoint, False, error=f'File not found: {audio_path}')
    try:
        result = asyncio.run(_stream_and_collect(
            audio_path    = audio_path,
            chunk_samples = case.get('chunk_samples', 128),
            config        = case.get('config', {}),
        ))
    except Exception as exc:
        return TestResult(case['id'], endpoint, False, error=str(exc))

    record    = build_record(case, endpoint, result)
    reference = load_reference(endpoint, case['id'])
    if reference is None or update_refs:
        save_reference(endpoint, case['id'], record)
        return TestResult(case['id'], endpoint, True, is_new_ref=True, payload=result)

    ref = reference['response']
    diffs: list[Diff] = [
        _diff_count('chunks_sent',     result['chunks_sent'],     ref['chunks_sent']),
        _diff_count('frames_received', result['frames_received'], ref['frames_received']),
        _diff_count('voiced_count',    result['voiced_count'],    ref['voiced_count']),
        _diff_float('mean_f1', result['mean_f1'] or 0, ref['mean_f1'] or 0, TOLERANCE_HZ),
        _diff_float('mean_f2', result['mean_f2'] or 0, ref['mean_f2'] or 0, TOLERANCE_HZ),
    ]
    diffs.extend(_diff_frame_lists(result['frames'], ref['frames'], _is_voiced_ws))
    return TestResult(case['id'], endpoint, all(d.passed for d in diffs),
                      diffs=diffs, payload=result)

def compute_smooth_reference(frames: list[dict], median_n: int = 5) -> list[dict]:
    """
    Apply sliding median to voiced f1/f2 values.
    Uses JS Math.round() rounding (always round 0.5 up) to match browser behaviour.
    """
    f1w, f2w = [], []
    result = []
    for frame in frames:
        if not frame.get('voiced') or frame.get('f1') is None:
            result.append({**frame, 'f1_median': None, 'f2_median': None})
            continue
        f1w.append(frame['f1']); f2w.append(frame['f2'])
        if len(f1w) > median_n: f1w.pop(0)
        if len(f2w) > median_n: f2w.pop(0)
        result.append({**frame,
                       'f1_raw': frame['f1'],
                       'f2_raw': frame['f2'],
                       'f1': _js_median(f1w),
                       'f2': _js_median(f2w)})
    return result

def _js_median(w: list[int]) -> int:
    s = sorted(w); m = len(s) // 2
    return s[m] if len(s) % 2 else int((s[m-1] + s[m]) / 2 + 0.5)


def run_median_case(case: dict, update_refs: bool):
    audio_path = Path(case['audio'])
    with open(audio_path, 'r', encoding='utf-8') as f:
        data = json.load(f)
    frames = data["response"]["frames"]
    trail = compute_smooth_reference(frames)
    result = {
        "reference": case['audio'],
        "n_input": len(frames),
        "trail": trail
    }
    endpoint = "median"
    record    = build_record(case, endpoint, result)
    reference = load_reference(endpoint, case['id'])
    if reference is None or update_refs:
        save_reference(endpoint, case['id'], record)
        return TestResult(case['id'], endpoint, True, is_new_ref=True, payload=result)

    diffs: list[Diff] = []
    diffs.extend(_diff_frame_lists(result['trail'], reference['trail'], lambda x: True))
    return TestResult(case['id'], endpoint,
                      passed=all(d.passed for d in diffs),
                      diffs=diffs,
                      payload=result,
                      )


# ══════════════════════════════════════════════════════════════════════════════
# Output formatting
# ══════════════════════════════════════════════════════════════════════════════

def _fv(v: Any) -> str:
    if v is None:    return 'null'
    if isinstance(v, float): return f'{v:.1f}'
    return str(v)


def _window_str(payload: dict) -> str:
    """Format the window range as '150-350 ms (0.15–0.85)' if available."""
    if 'from_ms' not in payload:
        return ''
    return (f"  window {payload['from_ms']}–{payload['to_ms']} ms "
            f"({payload.get('window_start', '?')}–{payload.get('window_end', '?')})")


def _loop_str(payload: dict) -> str:
    n = payload.get('loops_applied', 1)
    return f'  ×{n} loop' if n > 1 else ''


def _print_payload_summary(endpoint: str, payload: dict) -> None:
    if endpoint == 'analyze':
        print(f'    F1={payload.get("f1")} Hz  F2={payload.get("f2")} Hz'
              + _window_str(payload))

    elif endpoint == 'analyze_file':
        stats = _aggregate(payload.get('frames', []), _is_voiced_file)
        print(f'    {stats["voiced"]}/{stats["total"]} voiced  '
              f'mean F1={_fv(stats["mean_f1"])}  mean F2={_fv(stats["mean_f2"])}'
              + _loop_str(payload))

    elif endpoint == 'analyze_debug':
        print(_window_str(payload))
        for name, data in payload.get('configs', {}).items():
            fm = data.get('formants', {})
            print(f'    {name}: F1={_fv(fm.get("F1"))}  F2={_fv(fm.get("F2"))}  '
                  f'BW1={_fv(fm.get("BW1"))}  BW2={_fv(fm.get("BW2"))}')

    elif endpoint == 'ws':
        print(f'    {payload.get("voiced_count")}/{payload.get("frames_received")} voiced  '
              f'mean F1={_fv(payload.get("mean_f1"))}  mean F2={_fv(payload.get("mean_f2"))}  '
              f'chunks={payload.get("chunks_sent")}'
              + _loop_str(payload))


def print_result(result: TestResult) -> None:
    ep = result.endpoint.replace('_', '-')

    if result.error:
        print(f'  [{ep}] {result.case_id}')
        print(f'    ✗ ERROR: {result.error}')
        return

    if result.is_new_ref:
        print(f'  [{ep}] {result.case_id}  ★ SAVED AS REFERENCE')
        _print_payload_summary(result.endpoint, result.payload)
        return

    status = 'PASS' if result.passed else 'FAIL'
    icon   = '✓' if result.passed else '✗'
    print(f'  [{ep}] {result.case_id}  {icon} {status}')

    if result.passed:
        _print_payload_summary(result.endpoint, result.payload)
    else:
        for d in result.diffs:
            if not d.passed:
                delta = f'  Δ={d.delta_hz:.1f} Hz' if d.delta_hz is not None else ''
                print(f'    ✗ {d.field}: {_fv(d.current)}  (ref: {_fv(d.reference)}){delta}')


# ══════════════════════════════════════════════════════════════════════════════
# Test cases
# ══════════════════════════════════════════════════════════════════════════════

CASES: dict[str, list[dict]] = {

    'analyze': [
        {'id': 'i',      'audio': 'lang/me/audio/i.wav',      'window_start': 0.15, 'window_end': 0.85, 'description': '/i/'},
        {'id': 'i_bar',  'audio': 'lang/me/audio/i_bar.wav',  'window_start': 0.15, 'window_end': 0.85, 'description': '/ɨ/'},
        {'id': 'u',      'audio': 'lang/me/audio/u.wav',      'window_start': 0.15, 'window_end': 0.85, 'description': '/u/'},
        {'id': 'o',      'audio': 'lang/me/audio/o.wav',      'window_start': 0.15, 'window_end': 0.85, 'description': '/o/'},
        {'id': 'e_open', 'audio': 'lang/me/audio/e_open.wav', 'window_start': 0.15, 'window_end': 0.85, 'description': '/ɛ/'},
        {'id': 'a',      'audio': 'lang/me/audio/a.wav',      'window_start': 0.15, 'window_end': 0.85, 'description': '/a/'},
    ],

    'analyze_file': [
        {'id': 'i', 'audio': 'lang/me/audio/i.wav', 'config': {}, 'description': '/i/ all frames'},
        {'id': 'u', 'audio': 'lang/me/audio/u.wav', 'config': {}, 'description': '/u/ back vowel'},
        {'id': 'a', 'audio': 'lang/me/audio/a.wav', 'config': {}, 'description': '/a/ open'},
    ],

    'analyze_debug': [
        {'id': 'i', 'audio': 'lang/me/audio/i.wav', 'window_start': 0.15, 'window_end': 0.85,
         'description': '/i/ — FRONT skips F1, SCAN finds it'},
        {'id': 'u', 'audio': 'lang/me/audio/u.wav', 'window_start': 0.15, 'window_end': 0.85,
         'description': '/u/ — BACK disambiguates low F2'},
    ],

    'ws': [
        {'id': 'i_128', 'audio': 'lang/me/audio/i.wav', 'chunk_samples': 128, 'config': {},
         'description': '/i/ in 128-sample chunks (AudioWorklet)'},
        {'id': 'u_128', 'audio': 'lang/me/audio/u.wav', 'chunk_samples': 128, 'config': {},
         'description': '/u/ back vowel via WebSocket'},
        {'id': 'live_speech', 'audio': 'test/live_speech_short.wav', 'chunk_samples': 512, 'config': {},
         'description': '/i/ in 512-sample chunks (ScriptProcessor fallback)'},
    ],

    'median': [
        {'id': 'i_128', 'audio': 'test/references/ws/i_128.json',
         'description': '/i/ frame smoothness'},
        {'id': 'u_128', 'audio': 'test/references/ws/u_128.json' ,
         'description': '/u/ frame smoothness'},
        {'id': 'live_speech_short', 'audio': 'test/references/ws/live_speech.json',
         'description': '/i/ frame smoothness' },
    ],
}


# ══════════════════════════════════════════════════════════════════════════════
# Main
# ══════════════════════════════════════════════════════════════════════════════

RUNNERS = {
    'analyze':       run_analyze_case,
    'analyze_file':  run_analyze_file_case,
    'analyze_debug': run_analyze_debug_case,
    'ws':            run_ws_case,
    # "median": run_median_case
}


def server_is_running() -> bool:
    try:
        return requests.get(f'{HTTP_BASE}/ping', timeout=3).ok
    except Exception:
        return False


def main() -> int:
    parser = argparse.ArgumentParser(description='Formant server regression tests')
    parser.add_argument('endpoints', nargs='*', default=[],
                        choices=list(RUNNERS.keys()) + [[]])
    parser.add_argument('--update', action='store_true', help='Overwrite all references')
    parser.add_argument('--list',   action='store_true', help='List test IDs and exit')
    args = parser.parse_args()

    if args.list:
        for ep, cases in CASES.items():
            print(f'\n{ep}:')
            for c in cases:
                print(f'  {c["id"]:20}  {c["description"]}')
        return 0

    if not server_is_running():
        print(f'ERROR: server not running at {HTTP_BASE}')
        print('       python analyze_server.py')
        return 1

    endpoints = args.endpoints or list(RUNNERS.keys())
    total = passed = new_refs = failed = 0

    print(f'\nFormant server tests  tolerance={TOLERANCE_HZ} Hz'
          + ('  [UPDATE MODE]' if args.update else ''))
    print('─' * 64)

    for ep in endpoints:
        cases = CASES.get(ep, [])
        if not cases:
            continue
        print(f'\n/{ep.replace("_", "-")}')
        for case in cases:
            result = RUNNERS[ep](case, update_refs=args.update)
            print_result(result)
            total += 1
            if result.error:          failed += 1
            elif result.is_new_ref:   new_refs += 1
            elif result.passed:       passed += 1
            else:                     failed += 1

    print('\n' + '─' * 64)
    print(f'{passed} passed  {failed} failed  {new_refs} new references  ({total} total)')
    if new_refs:
        print('Inspect tests/references/ and commit.')
    return 0 if failed == 0 else 1


if __name__ == '__main__':
    sys.exit(main())