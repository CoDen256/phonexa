#!/usr/bin/env python3
"""
server_tests.py
===============
Regression tests for analyze_server.py.

Layers  (ongoing — run after any code change)
----------------------------------------------
  python tests/server_tests.py                   all 6 layers
  python tests/server_tests.py analyze           Layer 1 — raw F1/F2 per file
  python tests/server_tests.py frames             Layer 2 — /frames rich frames
  python tests/server_tests.py analyze_debug     Layer 3 — raw Praat per config
  python tests/server_tests.py stream                Layer 4 — per-frame WS raw values
  python tests/server_tests.py stream_median_stability  Layer 5 — stable vowel dot position

One-time checks  (see TESTING.md for the full order)
------------------------------------------------------
  python tests/server_tests.py --js-check        Are JS and Python median identical?
  python tests/server_tests.py --smooth-check    Does server median == Python median?
  python tests/server_tests.py stream --compare      What would --update change?
                                                   (also works with old-format refs:
                                                    skips new fields, compares shared ones)

Reference management
---------------------
  python tests/server_tests.py stream --update       Regenerate Layer 4 references
  python tests/server_tests.py --update          Regenerate all layer references

Reference file formats
-----------------------
  test/references/stream/{id}.json
    Layer 4: {response: {frames: [{voiced, f1, f2, f1_median, rms, ...}]}}

  tests/references/ws_median/{id}.json
    Layer 5: smooth verification record

  tests/references/ws_stability/{id}.json
    Layer 6: stable vowel position (measured vs expected)

  test/references/js_smoothing/{id}.json
    Created manually from browser verifyAllSmoothing() output.
    Format: {trail: [{f1, f2}, ...], median_n, stats, ...}
    Used by --js-check only.
"""

from __future__ import annotations

import argparse
import asyncio
import io
import json
import math
import os
import sys
import tempfile
import wave
from dataclasses import dataclass, field
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
# Settings
# ══════════════════════════════════════════════════════════════════════════════

HTTP_BASE           = 'http://localhost:5050'
WS_URL              = 'ws://localhost:5051'
TESTS_DIR           = Path(__file__).parent
REFERENCES_DIR      = TESTS_DIR.parent / 'test' / 'references'
TOLERANCE_HZ        = 0      # 0 = exact (Praat is deterministic per machine)
STABILITY_TOL_HZ    = 50     # Hz — generous tolerance for vowel stability tests
WS_RECV_TIMEOUT     = 0.5
RING_BUFFER_SAMPLES = 4096   # must match analyze_server.py
MIN_STREAM_SAMPLES  = RING_BUFFER_SAMPLES * 3

DEFAULT_CONN_CONFIG = {
    'max_f': 5000, 'n_formants': 5, 'window_ms': 25, 'pre_emphasis': 50,
    'back_ceiling': 1800, 'back_ceiling_ratio': 0.95, 'back_front_ratio': 0.75,
    'rms_floor': 0.005, 'median_n': 5,
}

# WS tests disable the RMS gate so results depend only on the analysis algorithm,
# not on recording volume. rms_floor=0 means every ring-buffer window is analysed.
TEST_STREAM_CONFIG = {**DEFAULT_CONN_CONFIG, 'rms_floor': 0}


# ══════════════════════════════════════════════════════════════════════════════
# Result model
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class Diff:
    field:    str
    current:  Any
    reference: Any
    passed:   bool
    delta_hz: float | None = None


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
# Median — mirrors server _js_median and browser Math.round()
# ══════════════════════════════════════════════════════════════════════════════

def _js_median(values: list[int]) -> int:
    """
    Sliding median matching JavaScript Math.round() rounding:
    0.5 always rounds up, unlike Python's banker's rounding.
    274.5 → 275 in JS and here; Python round(274.5) → 274.
    """
    s = sorted(values)
    m = len(s) // 2
    return s[m] if len(s) % 2 else int((s[m - 1] + s[m]) / 2 + 0.5)


def compute_smooth_reference(frames: list[dict], median_n: int = 5) -> list[dict]:
    """
    Given per-frame WS output, compute expected f1_median/f2_median.
    Only voiced frames (voiced=True, f1 not None) contribute to the window.
    Matches server StreamingSession.add_voiced_frame() + _js_median() exactly.
    """
    f1_window: list[int] = []
    f2_window: list[int] = []
    result = []

    for frame in frames:
        if not frame.get('voiced') or frame.get('f1') is None:
            result.append({**frame, 'f1_median': None, 'f2_median': None})
            continue

        f1_window.append(frame['f1'])
        f2_window.append(frame['f2'])
        if len(f1_window) > median_n:
            f1_window.pop(0)
        if len(f2_window) > median_n:
            f2_window.pop(0)

        result.append({
            **frame,
            'f1_median': _js_median(f1_window),
            'f2_median': _js_median(f2_window),
        })

    return result


# ══════════════════════════════════════════════════════════════════════════════
# Audio helpers
# ══════════════════════════════════════════════════════════════════════════════

def load_audio_as_int16(path: Path) -> tuple[np.ndarray, int]:
    if path.suffix.lower() == '.wav':
        return _load_wav(path)
    if _HAS_PARSELMOUTH:
        return _load_via_parselmouth(path)
    raise RuntimeError(f'Non-WAV requires parselmouth: {path.name}')


def _load_wav(path: Path) -> tuple[np.ndarray, int]:
    with wave.open(str(path), 'rb') as wf:
        sr, n_ch = wf.getframerate(), wf.getnchannels()
        raw = wf.readframes(wf.getnframes())
    samples = np.frombuffer(raw, dtype=np.int16)
    if n_ch == 2:
        samples = ((samples[0::2].astype(np.int32) + samples[1::2].astype(np.int32)) // 2
                   ).astype(np.int16)
    return samples, sr


def _load_via_parselmouth(path: Path) -> tuple[np.ndarray, int]:
    sound = parselmouth.Sound(str(path))
    sr    = int(sound.sampling_frequency)
    i16   = np.clip(sound.values[0] * 32768, -32768, 32767).astype(np.int16)
    return i16, sr


def load_as_wav_bytes(path: Path) -> bytes:
    if path.suffix.lower() == '.wav':
        return path.read_bytes()
    if not _HAS_PARSELMOUTH:
        raise RuntimeError(f'Non-WAV conversion requires parselmouth: {path.name}')
    sound = parselmouth.Sound(str(path))
    with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as tmp:
        sound.save(tmp.name, 'WAV')
        data = Path(tmp.name).read_bytes()
    os.unlink(tmp.name)
    return data


def get_audio_duration_ms(path: Path) -> float:
    try:
        samples, sr = load_audio_as_int16(path)
        return len(samples) / sr * 1000
    except Exception:
        return 0.0


def loop_samples_to_minimum(samples: np.ndarray, min_samples: int) -> tuple[np.ndarray, int]:
    if len(samples) >= min_samples:
        return samples, 1
    n = math.ceil(min_samples / len(samples))
    return np.tile(samples, n)[:n * len(samples)], n


def encode_int16_as_wav(samples: np.ndarray, sr: int) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as wf:
        wf.setnchannels(1); wf.setsampwidth(2)
        wf.setframerate(sr); wf.writeframes(samples.tobytes())
    return buf.getvalue()


def split_into_int16_chunks(samples: np.ndarray, chunk_size: int) -> list[bytes]:
    return [samples[s:s + chunk_size].tobytes()
            for s in range(0, len(samples), chunk_size)]


# ══════════════════════════════════════════════════════════════════════════════
# Reference files
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


def build_record(case: dict, endpoint: str, response: dict,
                 extra_meta: dict | None = None) -> dict:
    # Use effective_config from the response if present (WS tests include it).
    # Falls back to DEFAULT_CONN_CONFIG + case overrides for HTTP endpoints.
    effective = (response.get('effective_config')
                 or {**DEFAULT_CONN_CONFIG, **case.get('config', {})})
    meta = {
        'endpoint': endpoint,
        'case_id':  case['id'],
        'audio':    case.get('audio', ''),
        'config':   effective,
        'recorded': datetime.now(timezone.utc).isoformat(),
    }
    if extra_meta:
        meta.update(extra_meta)
    return {'meta': meta, 'response': response}


# ══════════════════════════════════════════════════════════════════════════════
# Diff helpers
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


def _diff_bool(name: str, cur: bool | None, ref: bool | None) -> Diff:
    return Diff(name, cur, ref, passed=(cur == ref))


# ══════════════════════════════════════════════════════════════════════════════
# Frame predicates and aggregation
# ══════════════════════════════════════════════════════════════════════════════

def _is_voiced_stream(frame: dict) -> bool:
    return bool(frame.get('voiced'))


def _is_voiced_file(frame: dict) -> bool:
    return frame.get('f1') is not None


def _aggregate(frames: list[dict], voiced_pred,
               f1_field: str = 'f1', f2_field: str = 'f2') -> dict:
    voiced = [f for f in frames
              if voiced_pred(f) and f.get(f1_field) is not None]
    return {
        'total':  len(frames),
        'voiced': len(voiced),
        'mean_f1': round(sum(f[f1_field] for f in voiced) / len(voiced), 1) if voiced else None,
        'mean_f2': round(sum(f[f2_field] for f in voiced) / len(voiced), 1) if voiced else None,
    }


def _diff_frame_lists(cur: list[dict], ref: list[dict],
                      voiced_pred, extra_fields: list[str] | None = None) -> list[Diff]:
    """
    Compare frame lists element-by-element; return only failures.

    Only compares fields that are actually present in the reference frame.
    This allows comparing new-format server output against old-format references:
    new fields (f1_median, is_above_rms, etc.) are silently ignored when the
    reference doesn't have them, so the test only checks what the reference
    was actually asserting.
    """
    if len(cur) != len(ref):
        return [_diff_count('frame_count', len(cur), len(ref))]
    failures: list[Diff] = []
    for i, (c, r) in enumerate(zip(cur, ref)):
        cv, rv = voiced_pred(c), voiced_pred(r)
        if cv != rv:
            failures.append(Diff(f'frame[{i}].voiced', cv, rv, passed=False))
        if cv and rv:
            for field in ['f1', 'f2'] + (extra_fields or []):
                # Skip fields absent in the reference — old-format compatibility
                if field not in r:
                    continue
                d = _diff_formant(f'frame[{i}].{field}', c.get(field), r.get(field))
                if not d.passed:
                    failures.append(d)
    return failures


# ══════════════════════════════════════════════════════════════════════════════
# /analyze  (Layer 1)
# ══════════════════════════════════════════════════════════════════════════════

def run_analyze_case(case: dict, update_refs: bool) -> TestResult:
    """POST audio to /analyze; compare F1, F2."""
    endpoint     = 'analyze'
    audio_path   = Path(case['audio'])
    if not audio_path.exists():
        return TestResult(case['id'], endpoint, False, error=f'File not found: {audio_path}')

    ws, we       = case.get('window_start', 0.0), case.get('window_end', 1.0)
    duration_ms  = get_audio_duration_ms(audio_path)
    extra        = {'duration_ms': round(duration_ms), 'window_start': ws, 'window_end': we,
                    'from_ms': round(duration_ms * ws), 'to_ms': round(duration_ms * we)}
    try:
        resp = requests.post(f'{HTTP_BASE}/analyze', data=load_as_wav_bytes(audio_path),
                             headers={'Content-Type': 'audio/wav',
                                      'X-Window-Start': str(ws), 'X-Window-End': str(we)},
                             timeout=10)
        if not resp.ok:
            return TestResult(case['id'], endpoint, False,
                              error=f'HTTP {resp.status_code}: {resp.json().get("error")}')
        server_resp = resp.json()
    except Exception as exc:
        return TestResult(case['id'], endpoint, False, error=str(exc))

    record    = build_record(case, endpoint, server_resp, extra)
    reference = load_reference(endpoint, case['id'])
    if reference is None or update_refs:
        save_reference(endpoint, case['id'], record)
        return TestResult(case['id'], endpoint, True, is_new_ref=True,
                          payload={**server_resp, **extra})

    ref = reference['response']
    diffs = [_diff_formant('f1', server_resp.get('f1'), ref.get('f1')),
             _diff_formant('f2', server_resp.get('f2'), ref.get('f2'))]
    return TestResult(case['id'], endpoint, all(d.passed for d in diffs),
                      diffs=diffs, payload={**server_resp, **extra})


# ══════════════════════════════════════════════════════════════════════════════
# /frames  (Layer 2)
# ══════════════════════════════════════════════════════════════════════════════

def run_frames_case(case: dict, update_refs: bool) -> TestResult:
    """
    POST audio to /frames; compare rich frames (same structure as /stream).

    Supports optional window_start/window_end slice (0.0–1.0, default full file).
    Uses DEFAULT_CONN_CONFIG + case overrides so the server gate and median
    settings are explicit and reproducible.

    Case keys: id, audio, config ({}), window_start (0.0), window_end (1.0)
    """
    endpoint   = 'frames'
    audio_path = Path(case['audio'])
    if not audio_path.exists():
        return TestResult(case['id'], endpoint, False, error=f'File not found: {audio_path}')

    wav_bytes = load_as_wav_bytes(audio_path)

    try:
        resp = requests.post(
            f'{HTTP_BASE}/frames',
            files={'file': (audio_path.name, wav_bytes, 'audio/wav')},
            data={
                'config':       json.dumps({**DEFAULT_CONN_CONFIG, **case.get('config', {})}),
                'window_start': str(case.get('window_start', 0.0)),
                'window_end':   str(case.get('window_end',   1.0)),
            },
            timeout=60,
        )
        if not resp.ok:
            return TestResult(case['id'], endpoint, False,
                              error=f'HTTP {resp.status_code}: {resp.json().get("error")}')
        server_resp = resp.json()
    except Exception as exc:
        return TestResult(case['id'], endpoint, False, error=str(exc))

    record    = build_record(case, endpoint, server_resp)
    reference = load_reference(endpoint, case['id'])
    if reference is None or update_refs:
        save_reference(endpoint, case['id'], record)
        return TestResult(case['id'], endpoint, True, is_new_ref=True, payload=server_resp)

    cur_f = server_resp.get('frames', [])
    ref_f = reference['response'].get('frames', [])
    # /frames returns rich frames (voiced bool) — same predicate as /stream
    cs    = _aggregate(cur_f, _is_voiced_stream)
    rs    = _aggregate(ref_f, _is_voiced_stream)
    extra = ['f1_raw', 'f2_raw', 'f1_median', 'f2_median', 'is_above_rms']

    diffs = [
        _diff_count('total_frames',  cs['total'],  rs['total']),
        _diff_count('voiced_frames', cs['voiced'], rs['voiced']),
        _diff_float('mean_f1',       cs['mean_f1'] or 0, rs['mean_f1'] or 0, TOLERANCE_HZ),
        _diff_float('mean_f2',       cs['mean_f2'] or 0, rs['mean_f2'] or 0, TOLERANCE_HZ),
    ]
    diffs.extend(_diff_frame_lists(cur_f, ref_f, _is_voiced_stream, extra))
    return TestResult(case['id'], endpoint, all(d.passed for d in diffs),
                      diffs=diffs, payload=server_resp)


# ══════════════════════════════════════════════════════════════════════════════
# /analyze-debug  (Layer 3)
# ══════════════════════════════════════════════════════════════════════════════

def run_analyze_debug_case(case: dict, update_refs: bool) -> TestResult:
    """POST audio to /analyze-debug; compare raw Praat values per config."""
    endpoint   = 'analyze_debug'
    audio_path = Path(case['audio'])
    if not audio_path.exists():
        return TestResult(case['id'], endpoint, False, error=f'File not found: {audio_path}')

    ws, we      = case.get('window_start', 0.15), case.get('window_end', 0.85)
    duration_ms = get_audio_duration_ms(audio_path)
    extra       = {'duration_ms': round(duration_ms), 'window_start': ws, 'window_end': we,
                   'from_ms': round(duration_ms * ws), 'to_ms': round(duration_ms * we)}
    try:
        resp = requests.post(f'{HTTP_BASE}/analyze-debug', data=load_as_wav_bytes(audio_path),
                             headers={'Content-Type': 'audio/wav',
                                      'X-Window-Start': str(ws), 'X-Window-End': str(we)},
                             timeout=10)
        if not resp.ok:
            return TestResult(case['id'], endpoint, False,
                              error=f'HTTP {resp.status_code}: {resp.json().get("error")}')
        server_resp = resp.json()
    except Exception as exc:
        return TestResult(case['id'], endpoint, False, error=str(exc))

    record    = build_record(case, endpoint, server_resp, extra)
    reference = load_reference(endpoint, case['id'])
    if reference is None or update_refs:
        save_reference(endpoint, case['id'], record)
        return TestResult(case['id'], endpoint, True, is_new_ref=True,
                          payload={**server_resp, **extra})

    diffs: list[Diff] = []
    for cfg_name, ref_data in reference['response'].get('configs', {}).items():
        cur_fmt = server_resp.get('configs', {}).get(cfg_name, {}).get('formants', {})
        for key, ref_val in ref_data.get('formants', {}).items():
            if key.startswith('F') and not key.startswith('BW'):
                diffs.append(_diff_formant(f'{cfg_name}.{key}', cur_fmt.get(key), ref_val))
    return TestResult(case['id'], endpoint, all(d.passed for d in diffs),
                      diffs=diffs, payload={**server_resp, **extra})


# ══════════════════════════════════════════════════════════════════════════════
# /stream streaming helper
# ══════════════════════════════════════════════════════════════════════════════

async def _stream_and_collect(audio_path: Path, chunk_samples: int,
                              config: dict) -> dict:
    """
    Stream audio to /stream exactly as a browser would (no gate, raw chunks).
    Concurrent send + receive avoids TCP deadlock.
    Short files are looped to fill the ring buffer.
    """
    samples, sr   = load_audio_as_int16(audio_path)
    looped, n_loops = loop_samples_to_minimum(samples, MIN_STREAM_SAMPLES)
    chunks        = split_into_int16_chunks(looped, chunk_samples)
    received: list[dict] = []
    sending_done  = asyncio.Event()

    async with websockets.connect(WS_URL) as ws:
        await ws.send(json.dumps({'type': 'init', 'sample_rate': sr}))
        # Send full config including rms_floor and median_n
        # TEST_STREAM_CONFIG disables the RMS gate for regression tests.
        # Stability cases override rms_floor via their own 'config' dict.
        merged_config = {**TEST_STREAM_CONFIG, **config}
        await ws.send(json.dumps({'type': 'config', **merged_config}))
        effective_config = merged_config   # stored in result so build_record is accurate

        async def send_all():
            for chunk in chunks:
                await ws.send(chunk)
            sending_done.set()

        async def recv_all():
            while True:
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=WS_RECV_TIMEOUT)
                    for frame in json.loads(raw).get('frames', []):
                        received.append(frame)
                except asyncio.TimeoutError:
                    if sending_done.is_set():
                        break

        await asyncio.gather(send_all(), recv_all())

    voiced    = [f for f in received if _is_voiced_stream(f)]
    # voiced with smoothed values
    smoothed  = [f for f in voiced if f.get('f1_median') is not None]

    def safe_mean(vals):
        return round(sum(vals) / len(vals), 1) if vals else None

    return {
        'chunks_sent':      len(chunks),
        'samples_sent':     len(looped),
        'original_samples': len(samples),
        'loops_applied':    n_loops,
        'sample_rate':      sr,
        'chunk_samples':    chunk_samples,
        'effective_config': effective_config,   # actual config sent to server
        'frames_received':  len(received),
        'voiced_count':     len(voiced),
        'mean_f1':         safe_mean([f['f1'] for f in voiced if f.get('f1') is not None]),
        'mean_f2':         safe_mean([f['f2'] for f in voiced if f.get('f2') is not None]),
        'mean_f1_median':  safe_mean([f['f1_median'] for f in smoothed]),
        'mean_f2_median':  safe_mean([f['f2_median'] for f in smoothed]),
        'frames':           received,
    }


# ══════════════════════════════════════════════════════════════════════════════
# /stream  Layer 4 — raw analysis fields
# ══════════════════════════════════════════════════════════════════════════════

def run_stream_case(case: dict, update_refs: bool) -> TestResult:
    """
    Stream audio to /stream; compare raw analysis fields per frame.
    Compares: voiced, f1, f2, f1_raw, f2_raw, is_above_rms,
              used_back_config, phantom_fix_applied,
              is_valid_f1_range, is_valid_f2_range.
    """
    if not _HAS_WEBSOCKETS:
        return TestResult(case['id'], 'stream', False, error='pip install websockets')
    endpoint   = 'stream'
    audio_path = Path(case['audio'])
    if not audio_path.exists():
        return TestResult(case['id'], endpoint, False, error=f'File not found: {audio_path}')

    try:
        result = asyncio.run(_stream_and_collect(
            audio_path, case.get('chunk_samples', 128), case.get('config', {})))
    except Exception as exc:
        return TestResult(case['id'], endpoint, False, error=str(exc))

    record    = build_record(case, endpoint, result)
    reference = load_reference(endpoint, case['id'])
    if reference is None or update_refs:
        save_reference(endpoint, case['id'], record)
        return TestResult(case['id'], endpoint, True, is_new_ref=True, payload=result)

    ref       = reference['response']
    cur_frames = result['frames']
    ref_frames = ref.get('frames', [])
    cs  = _aggregate(cur_frames, _is_voiced_stream)
    rs  = _aggregate(ref_frames, _is_voiced_stream)

    # Compare voiced frame sequences regardless of total count.
    # Old gate dropped silent frames → fewer total in ref.
    # Same audio + deterministic Praat → voiced sequences must match.
    cur_voiced = [f for f in cur_frames if _is_voiced_stream(f)]
    ref_voiced = [f for f in ref_frames if _is_voiced_stream(f)]

    extra_fields = ['f1_raw', 'f2_raw',
                    'f1_median', 'f2_median',          # smoothed output (what is drawn)
                    'is_above_rms',
                    'used_back_config', 'phantom_fix_applied',
                    'is_valid_f1_range', 'is_valid_f2_range']

    diffs: list[Diff] = [
        _diff_count('voiced_count', len(cur_voiced), len(ref_voiced)),
        _diff_float('mean_f1', cs['mean_f1'] or 0, rs['mean_f1'] or 0, TOLERANCE_HZ),
        _diff_float('mean_f2', cs['mean_f2'] or 0, rs['mean_f2'] or 0, TOLERANCE_HZ),
    ]
    diffs.extend(_diff_frame_lists(cur_voiced, ref_voiced, _is_voiced_stream, extra_fields))

    return TestResult(case['id'], endpoint, all(d.passed for d in diffs),
                      diffs=diffs, payload=result)


# ══════════════════════════════════════════════════════════════════════════════
# /stream  Layer 5 — stream_median_stability (edian)
# ══════════════════════════════════════════════════════════════════════════════

def run_stream_median_stability_case(case: dict, update_refs: bool) -> TestResult:
    """
    Layer 6: stream a vowel file, take frames [stable_start:stable_end]
    where voiced=True, average f1_median/f2_median, compare to expected
    values from lang.json within STABILITY_TOL_HZ.

    This is the highest-level regression: 'does the dot land at the right
    position on the vowel chart when I say this vowel?'
    """
    if not _HAS_WEBSOCKETS:
        return TestResult(case['id'], 'stream_median_stability', False, error='pip install websockets')
    endpoint   = 'stream_median_stability'
    audio_path = Path(case['audio'])
    if not audio_path.exists():
        return TestResult(case['id'], endpoint, False, error=f'File not found: {audio_path}')

    try:
        result = asyncio.run(_stream_and_collect(
            audio_path, case.get('chunk_samples', 128), case.get('config', {})))
    except Exception as exc:
        return TestResult(case['id'], endpoint, False, error=str(exc))

    # Extract voiced frames with smoothed values
    voiced_smooth = [
        f for f in result['frames']
        if _is_voiced_stream(f) and f.get('f1_median') is not None
    ]

    start_frac = float(case.get('stable_start', 0.0))
    end_frac   = float(case.get('stable_end',   1.0))
    n          = len(voiced_smooth)
    sl         = round(n * start_frac)
    se         = n if end_frac >= 1.0 else round(n * end_frac)
    stable     = voiced_smooth[sl:se]

    if not stable:
        return TestResult(case['id'], endpoint, False,
                          error=f'No stable voiced frames in window '
                                f'{start_frac:.0%}–{end_frac:.0%} '
                                f'(frames [{sl}:{se}] of {len(voiced_smooth)} voiced)')

    measured_f1 = round(sum(f['f1_median'] for f in stable) / len(stable))
    measured_f2 = round(sum(f['f2_median'] for f in stable) / len(stable))

    cases_exp_f1 = case.get('expected_f1')   # filled in CASES dict → absolute target
    cases_exp_f2 = case.get('expected_f2')   # None              → use saved measurement

    # Always save the measurement so the reference stays up to date.
    # Also persist expected_f1/f2 from the CASES dict so the reference is self-documenting.
    record    = build_record(case, endpoint,
                             {'measured_f1':   measured_f1,
                              'measured_f2':   measured_f2,
                              'expected_f1':   cases_exp_f1,   # None if not set in CASES
                              'expected_f2':   cases_exp_f2,
                              'tolerance_hz':  STABILITY_TOL_HZ,
                              'stable_frames': len(stable),
                              'voiced_smooth': len(voiced_smooth),
                              'stable_fraction': [start_frac, end_frac]})
    reference = load_reference(endpoint, case['id'])
    if update_refs:
        save_reference(endpoint, case['id'], record)

    # Resolve expected values
    if reference:
        # Prefer cases dict value; fall back to previously saved expected; then measured
        ref_expected_f1 = reference['response'].get('expected_f1')
        ref_expected_f2 = reference['response'].get('expected_f2')
        ref_measured_f1 = reference['response'].get('measured_f1')
        ref_measured_f2 = reference['response'].get('measured_f2')
        exp_f1 = cases_exp_f1 or ref_expected_f1 or ref_measured_f1
        exp_f2 = cases_exp_f2 or ref_expected_f2 or ref_measured_f2
    else:
        exp_f1 = cases_exp_f1
        exp_f2 = cases_exp_f2

    # No expected at all → first run with no cases value: save and report as new ref
    if exp_f1 is None or exp_f2 is None:
        save_reference(endpoint, case['id'], record)
        return TestResult(case['id'], endpoint, True, is_new_ref=True, payload={
            'measured_f1': measured_f1, 'measured_f2': measured_f2,
            'expected_f1': measured_f1, 'expected_f2': measured_f2,
            'expected_from': 'first run (saved as reference — add expected_f1/f2 to CASES to pin)',
            'tolerance_hz': STABILITY_TOL_HZ, 'stable_frames': len(stable),
        })

    # Save reference on first run (when cases_exp_f1 is set, reference may not exist yet)
    if reference is None:
        save_reference(endpoint, case['id'], record)

    expected_from = 'cases dict' if cases_exp_f1 else 'first run (saved reference)'

    payload = {
        'measured_f1':   measured_f1, 'measured_f2':   measured_f2,
        'expected_f1':   exp_f1,      'expected_f2':   exp_f2,
        'expected_from': expected_from,
        'tolerance_hz':  STABILITY_TOL_HZ, 'stable_frames': len(stable),
        'voiced_smooth': len(voiced_smooth), 'stable_fraction': [start_frac, end_frac],
    }

    if exp_f1 is None or exp_f2 is None:
        return TestResult(case['id'], endpoint, False,
                          error='No expected values in reference. '
                                'Delete the reference file and run again to re-measure.')

    diffs = [
        _diff_float('f1_median_stable', measured_f1, exp_f1, STABILITY_TOL_HZ),
        _diff_float('f2_median_stable', measured_f2, exp_f2, STABILITY_TOL_HZ),
    ]
    return TestResult(case['id'], endpoint, all(d.passed for d in diffs),
                      diffs=diffs, payload=payload)


# ══════════════════════════════════════════════════════════════════════════════
# Smooth cross-check (--smooth-check flag, one-time validation)
# ══════════════════════════════════════════════════════════════════════════════

def run_js_median_check() -> None:
    """
    --js-check
    Compare saved browser trail (from verifyAllSmoothing) against
    Python compute_smooth_reference() on the same Layer 4 raw f1/f2 values.

    What this proves
    ~~~~~~~~~~~~~~~~
    Python _js_median() is identical to the browser Math.round()-median.
    If all pass, Python can generate trusted reference values for future
    server-side median verification.

    Files required
    ~~~~~~~~~~~~~~
    test/references/stream/{id}.json
      Layer 4 reference with raw per-frame f1/f2.  Run 'ws --update' first.

    test/references/js_smoothing/{id}.json
      Output of browser verifyAllSmoothing() — format: {trail:[{f1,f2},...], ...}
      Create with:
        In browser console: await verifyAllSmoothing()
        Copy each case's trail to test/references/js_smoothing/{id}.json
    """
    js_dir = REFERENCES_DIR / 'js_smoothing'
    stream_dir = REFERENCES_DIR / 'stream'

    if not js_dir.exists() or not any(js_dir.glob('*.json')):
        print('No js_smoothing files found.')
        print('  1. Start server:  python analyze_server.py')
        print('  2. Open browser on any page that loads realtime.js')
        print('  3. In console:    await verifyAllSmoothing()')
        print('  4. Save each result to test/references/js_smoothing/{id}.json')
        return

    print('\nJS ↔ Python median check')
    print('  browser trail  vs  Python compute_smooth_reference()')
    print('─' * 64)
    total = passed = skipped = 0

    for js_file in sorted(js_dir.glob('*.json')):
        case_id = js_file.stem
        ws_file = stream_dir / f'{case_id}.json'

        if not ws_file.exists():
            print(f'  ⚠  {case_id}  — no Layer 4 reference (run: ws --update)')
            skipped += 1
            continue

        js_data    = json.loads(js_file.read_text())
        ws_data    = json.loads(ws_file.read_text())

        js_trail   = js_data.get('trail', [])
        raw_frames = ws_data.get('response', {}).get('frames', [])
        median_n   = int(js_data.get('median_n', 5))

        if not js_trail:
            print(f'  ⚠  {case_id}  — js_smoothing file has no "trail" field')
            skipped += 1
            continue

        # If Layer 4 reference already has f1_median (new format):
        #   use the server's values directly — smooth-check already verified them
        # If not (old format before migration):
        #   compute Python median from raw f1/f2
        has_server_median = any(
            f.get('f1_median') is not None
            for f in raw_frames if f.get('voiced')
        )

        if has_server_median:
            # New format: trust server's f1_median, just check JS trail matches it
            python_trail = [
                {'f1': f['f1_median'], 'f2': f['f2_median']}
                for f in raw_frames
                if f.get('voiced') and f.get('f1_median') is not None
            ]
        else:
            # Old format: compute median the Python way from raw f1/f2 values
            enriched     = compute_smooth_reference(raw_frames, median_n)
            python_trail = [
                {'f1': f['f1_median'], 'f2': f['f2_median']}
                for f in enriched if f.get('f1_median') is not None
            ]

        failures = []
        if len(js_trail) != len(python_trail):
            failures.append(
                f'trail length: js={len(js_trail)}  python={len(python_trail)}'
            )

        for i in range(min(len(js_trail), len(python_trail))):
            js_f1, js_f2 = js_trail[i].get('f1'), js_trail[i].get('f2')
            py_f1, py_f2 = python_trail[i].get('f1'), python_trail[i].get('f2')
            if abs((js_f1 or 0) - (py_f1 or 0)) > 1:
                failures.append(f'trail[{i}].f1: js={js_f1}  python={py_f1}')
            if abs((js_f2 or 0) - (py_f2 or 0)) > 1:
                failures.append(f'trail[{i}].f2: js={js_f2}  python={py_f2}')

        total += 1
        if not failures:
            passed += 1
            print(f'  ✓  {case_id}  ({len(js_trail)} trail points)')
        else:
            print(f'  ✗  {case_id}  ({len(failures)} mismatches)')
            for msg in failures[:5]:
                print(f'      {msg}')
            if len(failures) > 5:
                print(f'      … and {len(failures)-5} more')

    print(f'\n{passed}/{total} passed' +
          (f'  {skipped} skipped' if skipped else ''))


def run_smooth_cross_check() -> None:
    """
    For each WS reference file, verify that the server's f1_median/f2_median
    matches compute_smooth_reference() applied to the server's own f1/f2.

    This confirms:
      - Server _js_median() matches Python _js_median()
      - The median window resets correctly on unvoiced frames
      - The rounding edge case (274.5 → 275) matches JS Math.round()

    Run once after migration.  If all pass, the server median is correct.
    """
    ref_dir = REFERENCES_DIR / 'stream'
    if not ref_dir.exists():
        print('No WS references found — run tests first.')
        return

    print('\nSmooth cross-check — server f1_median vs Python compute_smooth_reference()')
    print('─' * 64)
    total = passed = 0

    for ref_file in sorted(ref_dir.glob('*.json')):
        ref = json.loads(ref_file.read_text())
        frames   = ref['response'].get('frames', [])
        median_n = ref.get('meta', {}).get('config', {}).get('median_n', 5)

        expected = compute_smooth_reference(frames, median_n)
        failures = []

        # Skip if this reference was saved before migration (no f1_median)
        has_server_median = any(f.get('f1_median') is not None for f in frames)
        if not has_server_median:
            print(f'  ⚠  {ref_file.stem}  (old format — no f1_median, run ws --update first)')
            continue

        for i, (srv, exp) in enumerate(zip(frames, expected)):
            if not _is_voiced_stream(srv):
                continue
            if srv.get('f1') is None:
                continue  # State A frame (rms_floor gate) — median not computed
            for field, exp_val in [('f1_median', exp.get('f1_median')),
                                   ('f2_median', exp.get('f2_median'))]:
                srv_val = srv.get(field)
                if srv_val is None and exp_val is None:
                    continue
                if srv_val != exp_val:
                    # Allow ±1 Hz for the JS Math.round() rounding edge case
                    if abs((srv_val or 0) - (exp_val or 0)) <= 1:
                        continue
                    failures.append(f'frame[{i}].{field}: server={srv_val} expected={exp_val}')

        total += 1
        if not failures:
            passed += 1
            print(f'  ✓ {ref_file.stem}')
        else:
            print(f'  ✗ {ref_file.stem}  ({len(failures)} mismatches)')
            for msg in failures[:5]:
                print(f'      {msg}')
            if len(failures) > 5:
                print(f'      … and {len(failures)-5} more')

    print(f'\n{passed}/{total} passed')


# ══════════════════════════════════════════════════════════════════════════════
# Output formatting
# ══════════════════════════════════════════════════════════════════════════════

def _fv(v: Any) -> str:
    if v is None:    return 'null'
    if isinstance(v, float): return f'{v:.1f}'
    return str(v)


def _loop_tag(payload: dict) -> str:
    n = payload.get('loops_applied', 1)
    return f'  ×{n} loop' if n > 1 else ''


def _window_tag(payload: dict) -> str:
    if 'from_ms' not in payload:
        return ''
    return (f"  window {payload['from_ms']}–{payload['to_ms']} ms"
            f" ({payload.get('window_start')}–{payload.get('window_end')})")


def _print_summary(endpoint: str, payload: dict) -> None:
    if endpoint == 'analyze':
        print(f'    F1={payload.get("f1")} Hz  F2={payload.get("f2")} Hz'
              + _window_tag(payload))

    elif endpoint == 'frames':
        stats = _aggregate(payload.get('frames', []), _is_voiced_stream)
        dur   = payload.get('duration_ms', '?')
        print(f'    {stats["voiced"]}/{stats["total"]} voiced  '
              f'mean F1={_fv(stats["mean_f1"])}  mean F2={_fv(stats["mean_f2"])}'
              f'  dur={_fv(dur)} ms')

    elif endpoint == 'analyze_debug':
        print(_window_tag(payload))
        for name, data in payload.get('configs', {}).items():
            fm = data.get('formants', {})
            print(f'    {name}: F1={_fv(fm.get("F1"))}  F2={_fv(fm.get("F2"))}'
                  f'  BW1={_fv(fm.get("BW1"))}  BW2={_fv(fm.get("BW2"))}')

    elif endpoint == 'stream':
        print(f'    {payload.get("voiced_count")}/{payload.get("frames_received")} voiced  '
              f'mean F1={_fv(payload.get("mean_f1"))}  F2={_fv(payload.get("mean_f2"))}'
              f'  median F1={_fv(payload.get("mean_f1_median"))}'
              f'  F2={_fv(payload.get("mean_f2_median"))}'
              + _loop_tag(payload))

    elif endpoint == 'ws_median':
        print(f'    {payload.get("voiced_count")} voiced  '
              f'mean_f1_median={_fv(payload.get("mean_f1_median"))}'
              f'  mean_f2_median={_fv(payload.get("mean_f2_median"))}'
              f'  median_n={payload.get("median_n")}')

    elif endpoint == 'stream_median_stability':
        ef = payload.get('expected_from', '')
        print(f'    measured  F1={payload.get("measured_f1")} Hz  F2={payload.get("measured_f2")} Hz')
        print(f'    expected  F1={payload.get("expected_f1")} Hz  F2={payload.get("expected_f2")} Hz'
              f'  ±{payload.get("tolerance_hz")} Hz  [{ef}]')
        frac    = payload.get('stable_fraction', [0.0, 1.0])
        n_voiced = payload.get('voiced_smooth', '?')
        print(f'    stable window: {payload.get("stable_frames")} frames'
              f'  ({frac[0]:.0%}–{frac[1]:.0%} of {n_voiced} voiced)')


def print_result(result: TestResult) -> None:
    ep = result.endpoint.replace('_', '-')

    if result.error:
        print(f'  [{ep}] {result.case_id}')
        print(f'    ✗ ERROR: {result.error}')
        return

    if result.is_new_ref:
        print(f'  [{ep}] {result.case_id}  ★ SAVED AS REFERENCE')
        _print_summary(result.endpoint, result.payload)
        return

    icon   = '✓' if result.passed else '✗'
    status = 'PASS' if result.passed else 'FAIL'
    print(f'  [{ep}] {result.case_id}  {icon} {status}')

    if result.passed:
        _print_summary(result.endpoint, result.payload)
    else:
        for d in result.diffs:
            if not d.passed:
                delta = f'  Δ={d.delta_hz:.1f} Hz' if d.delta_hz is not None else ''
                print(f'    ✗ {d.field}: {_fv(d.current)}  '
                      f'(ref: {_fv(d.reference)}){delta}')


# ══════════════════════════════════════════════════════════════════════════════
# Test cases
# ══════════════════════════════════════════════════════════════════════════════

CASES: dict[str, list[dict]] = {

    'analyze': [
        {'id': 'i',      'audio': 'lang/me/audio/i.wav',      'window_start': 0.15, 'window_end': 0.85},
        {'id': 'i_bar',  'audio': 'lang/me/audio/i_bar.wav',  'window_start': 0.15, 'window_end': 0.85},
        {'id': 'u',      'audio': 'lang/me/audio/u.wav',      'window_start': 0.15, 'window_end': 0.85},
        {'id': 'o',      'audio': 'lang/me/audio/o.wav',      'window_start': 0.15, 'window_end': 0.85},
        {'id': 'e_open', 'audio': 'lang/me/audio/e_open.wav', 'window_start': 0.15, 'window_end': 0.85},
        {'id': 'a',      'audio': 'lang/me/audio/a.wav',      'window_start': 0.15, 'window_end': 0.85},
    ],

    'frames': [
        # window_start/end slice the file (0.0–1.0 = full file)
        {'id': 'i', 'audio': 'lang/me/audio/i.wav', 'config': {},
         'window_start': 0.0, 'window_end': 1.0},
        {'id': 'u', 'audio': 'lang/me/audio/u.wav', 'config': {},
         'window_start': 0.0, 'window_end': 1.0},
        {'id': 'a', 'audio': 'lang/me/audio/a.wav', 'config': {},
         'window_start': 0.0, 'window_end': 1.0},
    ],

    'analyze_debug': [
        {'id': 'i', 'audio': 'lang/me/audio/i.wav', 'window_start': 0.15, 'window_end': 0.85,
         'description': '/i/ — FRONT skips F1, SCAN finds it'},
        {'id': 'u', 'audio': 'lang/me/audio/u.wav', 'window_start': 0.15, 'window_end': 0.85,
         'description': '/u/ — BACK disambiguates low F2'},
    ],

    'stream': [
        # config: {} → merged with TEST_STREAM_CONFIG in _stream_and_collect → rms_floor=0
        {'id': 'i_128',       'audio': 'lang/me/audio/i.wav',       'chunk_samples': 128, 'config': {}},
        {'id': 'u_128',       'audio': 'lang/me/audio/u.wav',       'chunk_samples': 128, 'config': {}},
        {'id': 'i_512',       'audio': 'lang/me/audio/i.wav',       'chunk_samples': 512, 'config': {}},
        # Extended live-speech recording: tests real-word vowel sequence
        {'id': 'live_speech', 'audio': 'test/live_speech.wav',     'chunk_samples': 128, 'config': {}},
    ],


    # Layer 6 — 'does the dot land at the right place?'
    # expected_f1/expected_f2 come from lang/me/lang.json measurements.
    # stable_start/stable_end index into the voiced+smoothed frame list.
    # Leave expected_* as None on first run — the measured value is saved as reference.
    'stream_median_stability': [
        # stable_start/stable_end are fractions of voiced+smooth frames (0.0–1.0).
        # 0.0–1.0 = use all voiced frames (the vowel recordings are steady throughout).
        # Fill expected_f1/expected_f2 from lang/me/lang.json for absolute targets,
        # or leave None to self-calibrate: first run saves the measurement as the target.
        {'id': 'i', 'audio': 'lang/me/audio/i.wav', 'chunk_samples': 128, 'config': {'rms_floor': 0.005},
         'stable_start': 0.0, 'stable_end': 0.1,         "expected_f1": 271.48, "expected_f2": 2380.40},
        {'id': 'u', 'audio': 'lang/me/audio/u.wav', 'chunk_samples': 128,'config': {'rms_floor': 0.005},
         'stable_start': 0.0, 'stable_end': 1.0,         "expected_f1": 317.03, "expected_f2": 565.81},
        {'id': 'a', 'audio': 'lang/me/audio/a.wav', 'chunk_samples': 128,'config': {'rms_floor': 0.005},
         'stable_start': 0.0, 'stable_end': 1.0,        "expected_f1": 853.77, "expected_f2": 1309.47,},
    ],
}



# ══════════════════════════════════════════════════════════════════════════════
# Layer 4 reference comparison  (--compare flag, no writes)
# ══════════════════════════════════════════════════════════════════════════════

def _frame_delta(cur: dict, ref: dict, fields: list[str]) -> dict:
    """
    Return changed fields between two frames.
    Skips any field not present in ref so old-format references compare cleanly.
    """
    changes = {}
    for field in fields:
        if field not in ref:
            continue   # absent in reference — old format, skip silently
        cv, rv = cur.get(field), ref.get(field)
        if cv == rv:
            continue
        if isinstance(cv, (int, float)) and isinstance(rv, (int, float)):
            changes[field] = {'cur': cv, 'ref': rv, 'delta': round(cv - rv, 1)}
        else:
            changes[field] = {'cur': cv, 'ref': rv}
    return changes


def compare_stream_references(case: dict) -> dict:
    """
    Run the current server for *case* and diff against the saved WS reference.
    Returns a structured report.  Does NOT save anything.

    Use this before --update to review what would change.
    """
    audio_path = Path(case['audio'])
    if not audio_path.exists():
        return {'error': f'Audio file not found: {audio_path}'}

    try:
        result = asyncio.run(_stream_and_collect(
            audio_path, case.get('chunk_samples', 128), case.get('config', {})))
    except Exception as exc:
        return {'error': str(exc)}

    reference = load_reference('stream', case['id'])
    if reference is None:
        return {'error': 'No saved reference — run: python tests/server_tests.py ws --update'}

    cur_frames = result['frames']
    ref_frames = reference['response'].get('frames', [])

    cur_stats = _aggregate(cur_frames, _is_voiced_stream)
    ref_stats = _aggregate(ref_frames, _is_voiced_stream)

    def smooth_mean(frames, field):
        vals = [f[field] for f in frames if f.get(field) is not None]
        return round(sum(vals) / len(vals), 1) if vals else None

    compare_fields = ['voiced', 'f1', 'f2', 'f1_raw', 'f2_raw',
                      'is_above_rms', 'f1_median', 'f2_median']

    # Old server dropped silent frames (no frame sent when below energy_floor).
    # New server always emits a frame, including State A (below rms_floor).
    # When frame counts differ significantly, per-frame comparison is meaningless
    # because the indices no longer correspond to the same audio positions.
    # Old server: silent frames were dropped (no send). New server: all windows emit.
    # Total counts differ, but VOICED sequences must match: same audio, same Praat.
    # Extra voiced in new = borderline-quiet frames the old gate was filtering out.
    counts_compatible = abs(len(cur_frames) - len(ref_frames)) <= max(5, len(ref_frames) * 0.05)
    cur_voiced = [f for f in cur_frames if _is_voiced_stream(f)]
    ref_voiced = [f for f in ref_frames if _is_voiced_stream(f)]
    n_compared = min(len(cur_voiced), len(ref_voiced))

    frame_changes = []
    for i in range(n_compared):
        delta = _frame_delta(cur_voiced[i], ref_voiced[i], compare_fields)
        if delta:
            frame_changes.append({'frame': i, 'changes': delta})

    ref_keys   = set(ref_frames[0].keys()) if ref_frames else set()
    cur_keys   = set(cur_frames[0].keys()) if cur_frames else set()
    new_fields = sorted(cur_keys - ref_keys)

    return {
        'case_id':           case['id'],
        'audio':             str(audio_path),
        'counts_compatible': counts_compatible,
        'total_frames':  {'cur': len(cur_frames), 'ref': len(ref_frames)},
        'voiced_frames':   {'cur': len(cur_voiced), 'ref': len(ref_voiced)},
        'voiced_compared': n_compared,
        'mean_f1':       {'cur': cur_stats['mean_f1'],        'ref': ref_stats['mean_f1']},
        'mean_f2':       {'cur': cur_stats['mean_f2'],        'ref': ref_stats['mean_f2']},
        'mean_f1_median':{'cur': smooth_mean(cur_frames,'f1_median'),
                          'ref': smooth_mean(ref_frames,'f1_median')},
        'mean_f2_median':{'cur': smooth_mean(cur_frames,'f2_median'),
                          'ref': smooth_mean(ref_frames,'f2_median')},
        'changed_frames':len(frame_changes),
        'frame_changes': frame_changes[:30],
        'new_fields':    new_fields,    # fields added since reference was saved
    }


def print_compare_report(report: dict) -> None:
    if 'error' in report:
        print(f"  ERROR: {report['error']}")
        return

    cid = report['case_id']

    def diff_line(label, d, unit='Hz'):
        """unit='Hz' for formants, '' for counts."""
        cur, ref = d.get('cur'), d.get('ref')
        arrow    = '→' if cur != ref else '='
        delta    = ''
        if isinstance(cur, float) and isinstance(ref, float):
            delta = f'  (Δ {cur - ref:+.1f}{" " + unit if unit else ""})'
        elif isinstance(cur, int) and isinstance(ref, int):
            delta = f'  (Δ {cur - ref:+d}{" " + unit if unit else ""})'
        print(f'    {label:20} ref={_fv(ref):>8}  cur={_fv(cur):>8}  {arrow}{delta}')

    print(f'  [ws] {cid}')
    diff_line('total frames',   report['total_frames'],   unit='')
    diff_line('voiced frames',  report['voiced_frames'],  unit='')
    diff_line('mean F1',        report['mean_f1'],        unit='Hz')
    diff_line('mean F2',        report['mean_f2'],        unit='Hz')
    diff_line('mean F1 median', report['mean_f1_median'], unit='Hz')
    diff_line('mean F2 median', report['mean_f2_median'], unit='Hz')

    new_fields = report.get('new_fields', [])
    if new_fields:
        print(f'    (skipped {len(new_fields)} new fields not in reference: '
              f'{", ".join(new_fields[:6])}{"…" if len(new_fields) > 6 else ""})')

    if not report.get('counts_compatible', True):
        ref_t = report['total_frames']['ref']
        cur_t = report['total_frames']['cur']
        print(f'    (total frames differ: ref={ref_t} gated  cur={cur_t} all-windows)')
        print(f'     Comparing voiced sequences instead — same audio, same Praat.')

    n     = report['changed_frames']
    cmp   = report.get('voiced_compared', report['voiced_frames']['ref'])
    ref_v = report['voiced_frames']['ref']
    cur_v = report['voiced_frames']['cur']
    extra = ''
    if cur_v != ref_v:
        extra = f'  ({abs(cur_v - ref_v)} extra voiced — borderline gate frames)'
    if n == 0:
        print(f'    All {cmp} voiced frames identical ✓  (on fields present in reference){extra}')
    else:
        print(f'    {n}/{cmp} voiced frames differ:{extra}')
        for fc in report['frame_changes'][:10]:
            changes_str = '  '.join(
                f"{k}: {_fv(v.get('ref'))}→{_fv(v.get('cur'))}"
                + (f" (Δ{v['delta']:+.0f})" if 'delta' in v else '')
                for k, v in fc['changes'].items()
            )
            print(f'      frame[{fc["frame"]}]: {changes_str}')
        if n > 10:
            print(f'      … and {n-10} more changed frames')


def run_stream_compare(endpoints_to_compare: list[str]) -> None:
    """
    Show detailed diff of current server output vs saved Layer 4 references.
    Does NOT modify any reference file.  Run before --update to review changes.
    """
    print('\nLayer 4 reference comparison  (read-only, no files changed)')
    print('─' * 64)
    for ep in endpoints_to_compare:
        cases = CASES.get(ep, [])
        if not cases:
            continue
        print(f'\n/{ep.replace("_","-")}')
        for case in cases:
            report = compare_stream_references(case)
            print_compare_report(report)

# ══════════════════════════════════════════════════════════════════════════════
# Main
# ══════════════════════════════════════════════════════════════════════════════

RUNNERS = {
    'analyze':       run_analyze_case,
    'frames':         run_frames_case,
    'analyze_debug': run_analyze_debug_case,
    'stream':         run_stream_case,
    'stream_median_stability': run_stream_median_stability_case,
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
    parser.add_argument('--update',       action='store_true', help='Overwrite all references')
    parser.add_argument('--list',         action='store_true', help='List test IDs and exit')
    parser.add_argument('--js-check', action='store_true',
                        help='Compare saved browser trail (js_smoothing/) '
                             'against Python compute_smooth_reference(). '
                             'No server needed.')
    parser.add_argument('--smooth-check', action='store_true',
                        help='Cross-check server median vs Python compute_smooth_reference()')
    parser.add_argument('--compare', action='store_true',
                        help='Show detailed diff of current server vs saved Layer 4 references'
                             ' (no files changed). Run before --update to review what changes.')
    args = parser.parse_args()

    if args.list:
        for ep, cases in CASES.items():
            print(f'\n{ep}:')
            for c in cases:
                desc = c.get('description', '')
                print(f'  {c["id"]:25}  {desc}')
        return 0

    if getattr(args, 'js_check', False):
        run_js_median_check()    # reads local files only — no server needed
        return 0

    if args.smooth_check:
        if not server_is_running():
            print(f'ERROR: server not running at {HTTP_BASE}')
            return 1
        run_smooth_cross_check()
        return 0

    if args.compare:
        if not server_is_running():
            print(f'ERROR: server not running at {HTTP_BASE}')
            return 1
        run_stream_compare(args.endpoints or ['stream'])
        return 0

    if not server_is_running():
        print(f'ERROR: server not running at {HTTP_BASE}')
        print('       python analyze_server.py')
        return 1

    endpoints  = args.endpoints or list(RUNNERS.keys())
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
            if result.error:        failed += 1
            elif result.is_new_ref: new_refs += 1
            elif result.passed:     passed += 1
            else:                   failed += 1

    print('\n' + '─' * 64)
    print(f'{passed} passed  {failed} failed  {new_refs} new references  ({total} total)')
    if new_refs:
        print('Inspect tests/references/ and commit.')
    return 0 if failed == 0 else 1


if __name__ == '__main__':
    sys.exit(main())