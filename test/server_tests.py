#!/usr/bin/env python3
"""
server_tests.py
===============
Regression tests for analyze_server.py.

On first run, responses are saved as reference files.
On subsequent runs, results are compared against those references.

Usage (from project root, server must be running)
--------------------------------------------------
  python tests/server_tests.py                 # run all tests
  python tests/server_tests.py analyze         # /analyze only
  python tests/server_tests.py analyze_file
  python tests/server_tests.py analyze_debug
  python tests/server_tests.py ws
  python tests/server_tests.py --update        # overwrite all references
  python tests/server_tests.py --list          # list test IDs and exit

Reference files
---------------
  tests/references/{endpoint}/{case_id}.json
  After first run, inspect and commit these files.

Adding test cases
-----------------
  Edit CASES at the bottom of this file.
  First run saves the reference; subsequent runs compare against it.

Audio formats
-------------
  .wav — loaded directly.
  Other formats (.mp3, .aiff, .flac …) — converted via parselmouth if available.
  The server's /analyze-file endpoint accepts any format natively.
"""

from __future__ import annotations

import argparse
import asyncio
import io
import json
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
# Settings
# ══════════════════════════════════════════════════════════════════════════════

HTTP_BASE       = 'http://localhost:5050'
WS_URL          = 'ws://localhost:5051'
TESTS_DIR       = Path(__file__).parent
REFERENCES_DIR  = TESTS_DIR / 'references'
TOLERANCE_HZ    = 0       # Hz — 0 = exact match (Praat is deterministic)
WS_RECV_TIMEOUT = 0.5     # seconds — recv timeout inside the concurrent loop


# Default ConnConfig values — must stay in sync with analyze_server.py
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
# Test result model
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class Diff:
    """One field that differs between current and reference."""
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
# Audio loading — supports WAV and other formats via parselmouth
# ══════════════════════════════════════════════════════════════════════════════

def load_audio_as_int16(audio_path: Path) -> tuple[np.ndarray, int]:
    """
    Load any audio file as int16 samples + sample rate.
    Uses Python's wave module for .wav files.
    Falls back to parselmouth for other formats (.mp3, .aiff, .flac …).
    """
    suffix = audio_path.suffix.lower()

    if suffix == '.wav':
        return _load_wav_as_int16(audio_path)

    if _HAS_PARSELMOUTH:
        return _load_via_parselmouth_as_int16(audio_path)

    raise RuntimeError(
        f'Cannot load {audio_path.name}: only .wav is supported without parselmouth. '
        'Install it with:  pip install praat-parselmouth'
    )


def _load_wav_as_int16(path: Path) -> tuple[np.ndarray, int]:
    with wave.open(str(path), 'rb') as wf:
        sample_rate = wf.getframerate()
        n_channels  = wf.getnchannels()
        raw_bytes   = wf.readframes(wf.getnframes())
    samples = np.frombuffer(raw_bytes, dtype=np.int16)
    if n_channels == 2:
        samples = ((samples[0::2].astype(np.int32) + samples[1::2].astype(np.int32)) // 2
                   ).astype(np.int16)
    return samples, sample_rate


def _load_via_parselmouth_as_int16(path: Path) -> tuple[np.ndarray, int]:
    sound       = parselmouth.Sound(str(path))
    sample_rate = int(sound.sampling_frequency)
    float_data  = sound.values[0]                           # first channel, float64 in [-1, 1]
    int16_data  = np.clip(float_data * 32768, -32768, 32767).astype(np.int16)
    return int16_data, sample_rate


def load_as_wav_bytes(audio_path: Path) -> bytes:
    """
    Return the file's bytes for HTTP upload.
    .wav files are read directly; other formats are converted to WAV via parselmouth.
    """
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


def split_into_int16_chunks(samples: np.ndarray, chunk_samples: int) -> list[bytes]:
    """Split a sample array into fixed-size Int16 chunks as raw bytes."""
    return [
        samples[start: start + chunk_samples].tobytes()
        for start in range(0, len(samples), chunk_samples)
    ]


# ══════════════════════════════════════════════════════════════════════════════
# Reference file management
# ══════════════════════════════════════════════════════════════════════════════

def _ref_path(endpoint: str, case_id: str) -> Path:
    return REFERENCES_DIR / endpoint / f'{case_id}.json'


def load_reference(endpoint: str, case_id: str) -> dict | None:
    path = _ref_path(endpoint, case_id)
    return json.loads(path.read_text()) if path.exists() else None


def save_reference(endpoint: str, case_id: str, record: dict) -> None:
    path = _ref_path(endpoint, case_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(record, indent=2))


def build_record(case: dict, endpoint: str, response_payload: dict) -> dict:
    """
    Wrap the server response in a record that also stores the full effective
    config (case overrides merged onto the defaults).
    """
    effective_config = {**DEFAULT_CONN_CONFIG, **case.get('config', {})}
    return {
        'meta': {
            'endpoint':  endpoint,
            'case_id':   case['id'],
            'audio':     case.get('audio', ''),
            'config':    effective_config,
            'recorded':  datetime.now(timezone.utc).isoformat(),
        },
        'response': response_payload,
    }


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


def _is_voiced_ws_frame(frame: dict) -> bool:
    """WS frames carry an explicit 'voiced' boolean."""
    return bool(frame.get('voiced'))


def _is_voiced_file_frame(frame: dict) -> bool:
    """/analyze-file frames don't have 'voiced'; f1 not None means voiced."""
    return frame.get('f1') is not None


def _aggregate(frames: list[dict], voiced_predicate) -> dict:
    voiced = [f for f in frames if voiced_predicate(f) and f.get('f1') is not None]
    return {
        'total':    len(frames),
        'voiced':   len(voiced),
        'mean_f1':  round(sum(f['f1'] for f in voiced) / len(voiced), 1) if voiced else None,
        'mean_f2':  round(sum(f['f2'] for f in voiced) / len(voiced), 1) if voiced else None,
    }


def _diff_frame_lists(cur_frames: list[dict],
                      ref_frames: list[dict],
                      voiced_predicate) -> list[Diff]:
    """Compare two frame lists element-by-element; return only failures."""
    if len(cur_frames) != len(ref_frames):
        return [_diff_count('frame_count', len(cur_frames), len(ref_frames))]

    failures: list[Diff] = []
    for idx, (cur, ref) in enumerate(zip(cur_frames, ref_frames)):
        cur_voiced = voiced_predicate(cur)
        ref_voiced = voiced_predicate(ref)
        if cur_voiced != ref_voiced:
            failures.append(Diff(f'frame[{idx}].voiced', cur_voiced, ref_voiced, passed=False))
        if cur_voiced and ref_voiced:
            d1 = _diff_formant(f'frame[{idx}].f1', cur.get('f1'), ref.get('f1'))
            d2 = _diff_formant(f'frame[{idx}].f2', cur.get('f2'), ref.get('f2'))
            if not d1.passed:
                failures.append(d1)
            if not d2.passed:
                failures.append(d2)

    return failures


# ══════════════════════════════════════════════════════════════════════════════
# /analyze
# ══════════════════════════════════════════════════════════════════════════════

def run_analyze_case(case: dict, update_refs: bool) -> TestResult:
    """
    POST the audio to /analyze with window fraction headers.
    Compares F1 and F2 against the reference.

    Case keys: id, audio, window_start (0.0), window_end (1.0), description
    """
    endpoint   = 'analyze'
    audio_path = Path(case['audio'])
    if not audio_path.exists():
        return TestResult(case['id'], endpoint, passed=False,
                          error=f'File not found: {audio_path}')
    try:
        response = requests.post(
            f'{HTTP_BASE}/analyze',
            data=load_as_wav_bytes(audio_path),
            headers={
                'Content-Type':   'audio/wav',
                'X-Window-Start': str(case.get('window_start', 0.0)),
                'X-Window-End':   str(case.get('window_end',   1.0)),
            },
            timeout=10,
        )
        if not response.ok:
            return TestResult(case['id'], endpoint, passed=False,
                              error=f'HTTP {response.status_code}: {response.json().get("error")}')
        server_resp = response.json()
    except Exception as exc:
        return TestResult(case['id'], endpoint, passed=False, error=str(exc))

    record    = build_record(case, endpoint, server_resp)
    reference = load_reference(endpoint, case['id'])
    if reference is None or update_refs:
        save_reference(endpoint, case['id'], record)
        return TestResult(case['id'], endpoint, passed=True, is_new_ref=True, payload=server_resp)

    ref_resp = reference['response']
    diffs = [
        _diff_formant('f1', server_resp.get('f1'), ref_resp.get('f1')),
        _diff_formant('f2', server_resp.get('f2'), ref_resp.get('f2')),
    ]
    return TestResult(case['id'], endpoint, passed=all(d.passed for d in diffs),
                      diffs=diffs, payload=server_resp)


# ══════════════════════════════════════════════════════════════════════════════
# /analyze-file
# ══════════════════════════════════════════════════════════════════════════════

def run_analyze_file_case(case: dict, update_refs: bool) -> TestResult:
    """
    POST the audio to /analyze-file.
    Compares voiced frame count, mean F1/F2, and per-frame values.

    /analyze-file frames use {t, f1, f2, rms} — no 'voiced' key.
    A frame is considered voiced when f1 is not None.

    Case keys: id, audio, config ({}), description
    """
    endpoint   = 'analyze_file'
    audio_path = Path(case['audio'])
    if not audio_path.exists():
        return TestResult(case['id'], endpoint, passed=False,
                          error=f'File not found: {audio_path}')
    try:
        with audio_path.open('rb') as fh:
            response = requests.post(
                f'{HTTP_BASE}/analyze-file',
                files={'file': (audio_path.name, fh, 'audio/wav')},
                data={'config': json.dumps(case.get('config', {}))},
                timeout=60,
            )
        if not response.ok:
            return TestResult(case['id'], endpoint, passed=False,
                              error=f'HTTP {response.status_code}: {response.json().get("error")}')
        server_resp = response.json()
    except Exception as exc:
        return TestResult(case['id'], endpoint, passed=False, error=str(exc))

    record    = build_record(case, endpoint, server_resp)
    reference = load_reference(endpoint, case['id'])
    if reference is None or update_refs:
        save_reference(endpoint, case['id'], record)
        return TestResult(case['id'], endpoint, passed=True, is_new_ref=True, payload=server_resp)

    cur_frames = server_resp.get('frames', [])
    ref_frames = reference['response'].get('frames', [])
    cur_stats  = _aggregate(cur_frames, _is_voiced_file_frame)
    ref_stats  = _aggregate(ref_frames, _is_voiced_file_frame)

    diffs: list[Diff] = [
        _diff_count('total_frames',  cur_stats['total'],  ref_stats['total']),
        _diff_count('voiced_frames', cur_stats['voiced'], ref_stats['voiced']),
        _diff_float('mean_f1', cur_stats['mean_f1'] or 0,
                    ref_stats['mean_f1'] or 0, TOLERANCE_HZ),
        _diff_float('mean_f2', cur_stats['mean_f2'] or 0,
                    ref_stats['mean_f2'] or 0, TOLERANCE_HZ),
    ]
    diffs.extend(_diff_frame_lists(cur_frames, ref_frames, _is_voiced_file_frame))

    return TestResult(case['id'], endpoint, passed=all(d.passed for d in diffs),
                      diffs=diffs, payload=server_resp)


# ══════════════════════════════════════════════════════════════════════════════
# /analyze-debug
# ══════════════════════════════════════════════════════════════════════════════

def run_analyze_debug_case(case: dict, update_refs: bool) -> TestResult:
    """
    POST the audio to /analyze-debug.
    Compares raw Praat formant values for each config (FRONT, BACK, SCAN).

    Case keys: id, audio, window_start (0.15), window_end (0.85), description
    """
    endpoint   = 'analyze_debug'
    audio_path = Path(case['audio'])
    if not audio_path.exists():
        return TestResult(case['id'], endpoint, passed=False,
                          error=f'File not found: {audio_path}')
    try:
        response = requests.post(
            f'{HTTP_BASE}/analyze-debug',
            data=load_as_wav_bytes(audio_path),
            headers={
                'Content-Type':   'audio/wav',
                'X-Window-Start': str(case.get('window_start', 0.15)),
                'X-Window-End':   str(case.get('window_end',   0.85)),
            },
            timeout=10,
        )
        if not response.ok:
            return TestResult(case['id'], endpoint, passed=False,
                              error=f'HTTP {response.status_code}: {response.json().get("error")}')
        server_resp = response.json()
    except Exception as exc:
        return TestResult(case['id'], endpoint, passed=False, error=str(exc))

    record    = build_record(case, endpoint, server_resp)
    reference = load_reference(endpoint, case['id'])
    if reference is None or update_refs:
        save_reference(endpoint, case['id'], record)
        return TestResult(case['id'], endpoint, passed=True, is_new_ref=True, payload=server_resp)

    diffs: list[Diff] = []
    cur_cfgs = server_resp.get('configs', {})
    ref_cfgs = reference['response'].get('configs', {})
    for cfg_name, ref_cfg_data in ref_cfgs.items():
        cur_formants = cur_cfgs.get(cfg_name, {}).get('formants', {})
        ref_formants = ref_cfg_data.get('formants', {})
        for key, ref_val in ref_formants.items():
            if key.startswith('F') and not key.startswith('BW'):
                diffs.append(_diff_formant(
                    f'{cfg_name}.{key}', cur_formants.get(key), ref_val))

    return TestResult(case['id'], endpoint, passed=all(d.passed for d in diffs),
                      diffs=diffs, payload=server_resp)


# ══════════════════════════════════════════════════════════════════════════════
# /ws — concurrent send + receive (avoids TCP deadlock)
# ══════════════════════════════════════════════════════════════════════════════

async def _stream_and_collect(audio_path: Path, chunk_samples: int, config: dict) -> dict:
    """
    Reproduce exactly what realtime.js _accumulate does:
      1.  Connect to WS.
      2.  Send {type:'init', sample_rate} text frame.
      3.  Send optional {type:'config'} text frame.
      4.  Send each Int16 chunk as a binary frame.
      5.  Collect voiced/F1/F2/RMS frames from the server.

    CRITICAL — send and receive run concurrently.
    Sending all chunks before receiving causes a TCP deadlock: the client
    fill its send buffer, the server can't send responses (recv buffer full),
    both sides block.  asyncio.gather runs the sender and receiver as
    two concurrent coroutines, exactly as a browser's WebSocket does.
    """
    samples_int16, sample_rate = load_audio_as_int16(audio_path)
    audio_chunks               = split_into_int16_chunks(samples_int16, chunk_samples)
    received_frames: list[dict] = []
    sending_complete            = asyncio.Event()

    async with websockets.connect(WS_URL) as ws:
        # Initialise — must match what realtime.js sends in start()
        await ws.send(json.dumps({'type': 'init', 'sample_rate': sample_rate}))
        if config:
            await ws.send(json.dumps({'type': 'config', **config}))

        async def send_all_chunks() -> None:
            for chunk_bytes in audio_chunks:
                await ws.send(chunk_bytes)
            sending_complete.set()

        async def receive_all_frames() -> None:
            """
            Loop until the server goes quiet after all chunks are sent.
            Uses a short timeout so the loop stays responsive; only stops
            when both (a) we are done sending AND (b) recv times out.
            """
            while True:
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=WS_RECV_TIMEOUT)
                    for frame in json.loads(raw).get('frames', []):
                        received_frames.append(frame)
                except asyncio.TimeoutError:
                    if sending_complete.is_set():
                        break   # done sending AND server went quiet → finished
                    # Still sending — keep waiting for responses

        await asyncio.gather(send_all_chunks(), receive_all_frames())

    voiced      = [f for f in received_frames if _is_voiced_ws_frame(f)]
    voiced_f1   = [f['f1'] for f in voiced if f.get('f1') is not None]
    voiced_f2   = [f['f2'] for f in voiced if f.get('f2') is not None]

    return {
        'chunks_sent':     len(audio_chunks),
        'samples_sent':    len(samples_int16),
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
    Stream audio to /ws in browser-identical Int16 chunks.
    Compares frame count, voiced count, mean F1/F2, and per-frame values.

    /ws frames carry an explicit 'voiced' boolean (unlike /analyze-file).

    Case keys: id, audio, chunk_samples (128), config ({}), description
    """
    if not _HAS_WEBSOCKETS:
        return TestResult(case['id'], 'ws', passed=False,
                          error='websockets not installed — pip install websockets')

    endpoint   = 'ws'
    audio_path = Path(case['audio'])
    if not audio_path.exists():
        return TestResult(case['id'], endpoint, passed=False,
                          error=f'File not found: {audio_path}')
    try:
        result = asyncio.run(_stream_and_collect(
            audio_path    = audio_path,
            chunk_samples = case.get('chunk_samples', 128),
            config        = case.get('config', {}),
        ))
    except Exception as exc:
        return TestResult(case['id'], endpoint, passed=False, error=str(exc))

    record    = build_record(case, endpoint, result)
    reference = load_reference(endpoint, case['id'])
    if reference is None or update_refs:
        save_reference(endpoint, case['id'], record)
        return TestResult(case['id'], endpoint, passed=True, is_new_ref=True, payload=result)

    ref_result = reference['response']
    diffs: list[Diff] = [
        _diff_count('chunks_sent',     result['chunks_sent'],     ref_result['chunks_sent']),
        _diff_count('frames_received', result['frames_received'], ref_result['frames_received']),
        _diff_count('voiced_count',    result['voiced_count'],    ref_result['voiced_count']),
        _diff_float('mean_f1', result['mean_f1'] or 0, ref_result['mean_f1'] or 0, TOLERANCE_HZ),
        _diff_float('mean_f2', result['mean_f2'] or 0, ref_result['mean_f2'] or 0, TOLERANCE_HZ),
    ]
    diffs.extend(_diff_frame_lists(result['frames'], ref_result['frames'], _is_voiced_ws_frame))

    return TestResult(case['id'], endpoint, passed=all(d.passed for d in diffs),
                      diffs=diffs, payload=result)


# ══════════════════════════════════════════════════════════════════════════════
# Output formatting
# ══════════════════════════════════════════════════════════════════════════════

def _fv(v: Any) -> str:
    """Format a value for display."""
    if v is None:
        return 'null'
    if isinstance(v, float):
        return f'{v:.1f}'
    return str(v)


def _print_payload_summary(endpoint: str, payload: dict) -> None:
    if endpoint == 'analyze':
        print(f'      F1={payload.get("f1")} Hz  F2={payload.get("f2")} Hz  '
              f'dur={payload.get("duration_ms")} ms')
    elif endpoint == 'analyze_file':
        stats = _aggregate(payload.get('frames', []), _is_voiced_file_frame)
        print(f'      {stats["voiced"]}/{stats["total"]} voiced  '
              f'mean F1={_fv(stats["mean_f1"])}  mean F2={_fv(stats["mean_f2"])}')
    elif endpoint == 'analyze_debug':
        for name, data in payload.get('configs', {}).items():
            fm = data.get('formants', {})
            print(f'      {name}: F1={_fv(fm.get("F1"))}  F2={_fv(fm.get("F2"))}  '
                  f'BW1={_fv(fm.get("BW1"))}  BW2={_fv(fm.get("BW2"))}')
    elif endpoint == 'ws':
        print(f'      {payload.get("voiced_count")}/{payload.get("frames_received")} voiced  '
              f'mean F1={_fv(payload.get("mean_f1"))}  mean F2={_fv(payload.get("mean_f2"))}  '
              f'chunks={payload.get("chunks_sent")}')


def print_result(result: TestResult) -> None:
    ep    = result.endpoint.replace('_', '-')
    label = result.case_id

    if result.error:
        print(f'  [{ep}] {label}')
        print(f'    ✗ ERROR: {result.error}')
        return

    if result.is_new_ref:
        print(f'  [{ep}] {label}  ★ SAVED AS REFERENCE')
        _print_payload_summary(result.endpoint, result.payload)
        return

    icon   = '✓' if result.passed else '✗'
    status = 'PASS' if result.passed else 'FAIL'
    print(f'  [{ep}] {label}  {icon} {status}')

    if result.passed:
        _print_payload_summary(result.endpoint, result.payload)
    else:
        for d in result.diffs:
            if not d.passed:
                delta = f'  Δ={d.delta_hz:.1f} Hz' if d.delta_hz is not None else ''
                print(f'    ✗ {d.field}: {_fv(d.current)}  (ref: {_fv(d.reference)}){delta}')


# ══════════════════════════════════════════════════════════════════════════════
# Connectivity check
# ══════════════════════════════════════════════════════════════════════════════

def server_is_running() -> bool:
    try:
        return requests.get(f'{HTTP_BASE}/ping', timeout=3).ok
    except Exception:
        return False


# ══════════════════════════════════════════════════════════════════════════════
# Test cases — edit these to match your audio files
# ══════════════════════════════════════════════════════════════════════════════

CASES: dict[str, list[dict]] = {

    'analyze': [
        {'id': 'i',     'audio': 'lang/me/audio/i.wav',      'window_start': 0.15, 'window_end': 0.85, 'description': '/i/ close front'},
        {'id': 'i_bar', 'audio': 'lang/me/audio/i_bar.wav',  'window_start': 0.15, 'window_end': 0.85, 'description': '/ɨ/ close central'},
        {'id': 'u',     'audio': 'lang/me/audio/u.wav',      'window_start': 0.15, 'window_end': 0.85, 'description': '/u/ close back'},
        {'id': 'o',     'audio': 'lang/me/audio/o.wav',      'window_start': 0.15, 'window_end': 0.85, 'description': '/o/ mid back'},
        {'id': 'e_open','audio': 'lang/me/audio/e_open.wav', 'window_start': 0.15, 'window_end': 0.85, 'description': '/ɛ/ open-mid front'},
        {'id': 'a',     'audio': 'lang/me/audio/a.wav',      'window_start': 0.15, 'window_end': 0.85, 'description': '/a/ open front'},
    ],

    'analyze_file': [
        {'id': 'i',     'audio': 'lang/me/audio/i.wav',     'config': {}, 'description': '/i/ all frames'},
        {'id': 'u',     'audio': 'lang/me/audio/u.wav',     'config': {}, 'description': '/u/ back vowel disambiguation'},
        {'id': 'a',     'audio': 'lang/me/audio/a.wav',     'config': {}, 'description': '/a/ open vowel'},
    ],

    'analyze_debug': [
        {'id': 'i', 'audio': 'lang/me/audio/i.wav', 'window_start': 0.15, 'window_end': 0.85,
         'description': '/i/ — FRONT skips F1, SCAN finds it'},
        {'id': 'u', 'audio': 'lang/me/audio/u.wav', 'window_start': 0.15, 'window_end': 0.85,
         'description': '/u/ — BACK disambiguates low F2'},
    ],

    'ws': [
        {'id': 'i_128',  'audio': 'lang/me/audio/i.wav', 'chunk_samples': 128, 'config': {},
         'description': '/i/ streamed in 128-sample chunks (AudioWorklet size)'},
        {'id': 'u_128',  'audio': 'lang/me/audio/u.wav', 'chunk_samples': 128, 'config': {},
         'description': '/u/ streamed — back vowel via WebSocket'},
        {'id': 'live_speech',  'audio': 'test/live_speech_short.wav', 'chunk_samples': 128, 'config': {},
         'description': '/i/ streamed in 512-sample chunks (ScriptProcessor fallback)'},
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
}


def main() -> int:
    parser = argparse.ArgumentParser(description='Formant server regression tests')
    parser.add_argument('endpoints', nargs='*', default=[],
                        choices=list(RUNNERS.keys()) + [[]])
    parser.add_argument('--update', action='store_true',
                        help='Overwrite all reference files')
    parser.add_argument('--list',   action='store_true',
                        help='List all test case IDs and exit')
    args = parser.parse_args()

    if args.list:
        for ep, cases in CASES.items():
            print(f'\n{ep}:')
            for c in cases:
                print(f'  {c["id"]:25}  {c["description"]}')
        return 0

    if not server_is_running():
        print(f'ERROR: server not running at {HTTP_BASE}')
        print('       Start it with:  python analyze_server.py')
        return 1

    endpoints = args.endpoints or list(RUNNERS.keys())
    total = passed = new_refs = failed = 0

    mode = '  [UPDATE MODE]' if args.update else ''
    print(f'\nFormant server tests — tolerance={TOLERANCE_HZ} Hz{mode}')
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
            if result.error:
                failed += 1
            elif result.is_new_ref:
                new_refs += 1
            elif result.passed:
                passed += 1
            else:
                failed += 1

    print('\n' + '─' * 64)
    print(f'{passed} passed  {failed} failed  {new_refs} new references  '
          f'({total} total)')
    if new_refs:
        print('Inspect tests/references/ and commit the new files.')

    return 0 if failed == 0 else 1


if __name__ == '__main__':
    sys.exit(main())