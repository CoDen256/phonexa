#!/usr/bin/env python3
"""
server_tests.py
===============
Regression test suite for analyze_server.py.

Each endpoint has a set of hardcoded test cases (see CASES at the bottom).
On the first run, results are saved as reference files.
On subsequent runs, results are compared against those references.

Usage
-----
  python tests/server_tests.py              # run all tests (from project root)
  python tests/server_tests.py analyze      # run /analyze tests only
  python tests/server_tests.py analyze_file # run /analyze-file tests only
  python tests/server_tests.py analyze_debug
  python tests/server_tests.py ws
  python tests/server_tests.py --update     # overwrite ALL references with fresh results
  python tests/server_tests.py --list       # print all test case IDs and exit

Reference files
---------------
  tests/references/{endpoint}/{case_id}.json
  Commit these after verifying they look correct on first run.

Adding test cases
-----------------
  Edit the CASES dict at the bottom of this file.
  Run once to generate the reference file, inspect it, then commit.

Tolerance
---------
  TOLERANCE_HZ = 0  →  exact match (Praat is deterministic on the same machine).
  Set TOLERANCE_HZ = 5 when comparing results across different OS / Praat versions.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import sys
import wave
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
import requests

# Optional: websockets is only needed for /ws tests
try:
    import websockets
    _WEBSOCKETS_AVAILABLE = True
except ImportError:
    _WEBSOCKETS_AVAILABLE = False


# ══════════════════════════════════════════════════════════════════════════════
# Global settings
# ══════════════════════════════════════════════════════════════════════════════

HTTP_BASE      = 'http://localhost:5050'
WS_URL         = 'ws://localhost:5051'
TESTS_DIR      = Path(__file__).parent
REFERENCES_DIR = TESTS_DIR / 'references'
TOLERANCE_HZ   = 0        # Hz — allowed difference for formant values
WS_DRAIN_SECS  = 1.5      # seconds to wait for final WebSocket responses after sending


# ══════════════════════════════════════════════════════════════════════════════
# Test result model
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class Comparison:
    """Difference between one value in the current result and the reference."""
    field:     str
    current:   Any
    reference: Any
    passed:    bool
    delta:     float | None = None   # Hz difference for numeric formant values


@dataclass
class TestResult:
    case_id:    str
    endpoint:   str
    passed:     bool
    is_new_ref: bool = False          # True when there was no reference to compare against
    error:      str | None = None     # non-None when the request itself failed
    comparisons: list[Comparison] = field(default_factory=list)
    payload:    dict = field(default_factory=dict)   # full server response


# ══════════════════════════════════════════════════════════════════════════════
# Audio helpers
# ══════════════════════════════════════════════════════════════════════════════

def load_wav_as_int16(audio_path: Path) -> tuple[np.ndarray, int]:
    """
    Load a WAV file and return (int16_samples, sample_rate).
    Stereo files are mixed down to mono by averaging channels.
    """
    with wave.open(str(audio_path), 'rb') as wav_file:
        sample_rate = wav_file.getframerate()
        n_channels  = wav_file.getnchannels()
        n_frames    = wav_file.getnframes()
        raw_bytes   = wav_file.readframes(n_frames)

    all_samples = np.frombuffer(raw_bytes, dtype=np.int16)

    if n_channels == 2:
        # Average left and right channels
        stereo  = all_samples.reshape(-1, 2).astype(np.float32)
        mono    = ((stereo[:, 0] + stereo[:, 1]) / 2).astype(np.int16)
        return mono, sample_rate

    return all_samples, sample_rate


def split_into_chunks(samples: np.ndarray, chunk_samples: int) -> list[bytes]:
    """Split a sample array into fixed-size Int16 chunks (as raw bytes)."""
    return [
        samples[start:start + chunk_samples].tobytes()
        for start in range(0, len(samples), chunk_samples)
    ]


def read_wav_bytes(audio_path: Path) -> bytes:
    """Read a WAV file as raw bytes for HTTP upload."""
    return audio_path.read_bytes()


# ══════════════════════════════════════════════════════════════════════════════
# Reference file management
# ══════════════════════════════════════════════════════════════════════════════

def reference_path(endpoint: str, case_id: str) -> Path:
    return REFERENCES_DIR / endpoint / f'{case_id}.json'


def load_reference(endpoint: str, case_id: str) -> dict | None:
    """Return the reference dict, or None if no reference file exists yet."""
    path = reference_path(endpoint, case_id)
    if not path.exists():
        return None
    with path.open() as f:
        return json.load(f)


def save_reference(endpoint: str, case_id: str, data: dict) -> None:
    """Write *data* as the reference file for this test case."""
    path = reference_path(endpoint, case_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('w') as f:
        json.dump(data, f, indent=2)


def build_reference_record(case: dict, endpoint: str, response_payload: dict) -> dict:
    """Wrap a server response in a record that also stores the test parameters."""
    return {
        'meta': {
            'endpoint':  endpoint,
            'case_id':   case['id'],
            'audio':     case.get('audio', ''),
            'config':    case.get('config', {}),
            'recorded':  datetime.now(timezone.utc).isoformat(),
        },
        'response': response_payload,
    }


# ══════════════════════════════════════════════════════════════════════════════
# Comparison logic
# ══════════════════════════════════════════════════════════════════════════════

def compare_formant(field_name: str, current: int | None, reference: int | None) -> Comparison:
    """Compare a single F1 or F2 value within TOLERANCE_HZ."""
    if current is None and reference is None:
        return Comparison(field_name, current, reference, passed=True, delta=0)
    if current is None or reference is None:
        return Comparison(field_name, current, reference, passed=False)
    delta = abs(current - reference)
    return Comparison(field_name, current, reference, passed=(delta <= TOLERANCE_HZ), delta=delta)


def compare_count(field_name: str, current: int, reference: int) -> Comparison:
    return Comparison(field_name, current, reference, passed=(current == reference))


def compare_float(field_name: str, current: float, reference: float, tolerance: float) -> Comparison:
    delta = abs(current - reference)
    return Comparison(field_name, current, reference, passed=(delta <= tolerance), delta=delta)


def aggregate_voiced_frames(frames: list[dict]) -> dict:
    """Compute aggregate statistics over the voiced frames in a frame list."""
    voiced = [f for f in frames if f.get('voiced') and f.get('f1') is not None]
    if not voiced:
        return {'voiced_count': 0, 'total_count': len(frames),
                'mean_f1': None, 'mean_f2': None}
    return {
        'voiced_count': len(voiced),
        'total_count':  len(frames),
        'mean_f1':      round(sum(f['f1'] for f in voiced) / len(voiced), 1),
        'mean_f2':      round(sum(f['f2'] for f in voiced) / len(voiced), 1),
    }


def compare_frame_lists(current_frames: list[dict], reference_frames: list[dict]) -> list[Comparison]:
    """
    Compare two frame lists element-by-element.
    Returns one Comparison per differing frame (voiced, f1, f2).
    """
    comparisons: list[Comparison] = []
    n = max(len(current_frames), len(reference_frames))

    if len(current_frames) != len(reference_frames):
        comparisons.append(compare_count('frame_count',
                                         len(current_frames), len(reference_frames)))
        return comparisons   # length mismatch — don't compare further

    for i, (cur, ref) in enumerate(zip(current_frames, reference_frames)):
        prefix = f'frame[{i}]'
        if cur.get('voiced') != ref.get('voiced'):
            comparisons.append(Comparison(f'{prefix}.voiced', cur.get('voiced'),
                                          ref.get('voiced'), passed=False))
        if cur.get('voiced') and ref.get('voiced'):
            comparisons.append(compare_formant(f'{prefix}.f1', cur.get('f1'), ref.get('f1')))
            comparisons.append(compare_formant(f'{prefix}.f2', cur.get('f2'), ref.get('f2')))

    return [c for c in comparisons if not c.passed]   # return only failures


# ══════════════════════════════════════════════════════════════════════════════
# /analyze tests
# ══════════════════════════════════════════════════════════════════════════════

def run_analyze_case(case: dict, update_refs: bool) -> TestResult:
    """
    POST the audio file to /analyze and compare with the reference.

    Case fields:
      id            — unique identifier for this test case
      audio         — path to the WAV file (relative to project root)
      window_start  — X-Window-Start fraction (default 0.0)
      window_end    — X-Window-End fraction   (default 1.0)
      description   — human-readable label
    """
    audio_path = Path(case['audio'])
    endpoint   = 'analyze'

    if not audio_path.exists():
        return TestResult(case['id'], endpoint, passed=False,
                          error=f'Audio file not found: {audio_path}')

    headers = {
        'Content-Type':    'audio/wav',
        'X-Window-Start':  str(case.get('window_start', 0.0)),
        'X-Window-End':    str(case.get('window_end',   1.0)),
    }

    try:
        response = requests.post(f'{HTTP_BASE}/analyze',
                                 data=read_wav_bytes(audio_path),
                                 headers=headers, timeout=10)
        if not response.ok:
            return TestResult(case['id'], endpoint, passed=False,
                              error=f'HTTP {response.status_code}: {response.json().get("error")}')
        server_response = response.json()
    except Exception as exc:
        return TestResult(case['id'], endpoint, passed=False, error=str(exc))

    record    = build_reference_record(case, endpoint, server_response)
    reference = load_reference(endpoint, case['id'])

    if reference is None or update_refs:
        save_reference(endpoint, case['id'], record)
        return TestResult(case['id'], endpoint, passed=True, is_new_ref=True,
                          payload=server_response)

    ref_response = reference['response']
    comparisons  = [
        compare_formant('f1', server_response.get('f1'), ref_response.get('f1')),
        compare_formant('f2', server_response.get('f2'), ref_response.get('f2')),
    ]
    passed = all(c.passed for c in comparisons)
    return TestResult(case['id'], endpoint, passed=passed,
                      comparisons=comparisons, payload=server_response)


# ══════════════════════════════════════════════════════════════════════════════
# /analyze-file tests
# ══════════════════════════════════════════════════════════════════════════════

def run_analyze_file_case(case: dict, update_refs: bool) -> TestResult:
    """
    POST the audio file to /analyze-file and compare with the reference.

    Case fields:
      id          — unique identifier
      audio       — path to the WAV file
      config      — ConnConfig overrides dict (default {})
      description — human-readable label
    """
    audio_path = Path(case['audio'])
    endpoint   = 'analyze_file'

    if not audio_path.exists():
        return TestResult(case['id'], endpoint, passed=False,
                          error=f'Audio file not found: {audio_path}')

    try:
        with audio_path.open('rb') as audio_file:
            response = requests.post(
                f'{HTTP_BASE}/analyze-file',
                files={'file': (audio_path.name, audio_file, 'audio/wav')},
                data={'config': json.dumps(case.get('config', {}))},
                timeout=30,
            )
        if not response.ok:
            return TestResult(case['id'], endpoint, passed=False,
                              error=f'HTTP {response.status_code}: {response.json().get("error")}')
        server_response = response.json()
    except Exception as exc:
        return TestResult(case['id'], endpoint, passed=False, error=str(exc))

    record    = build_reference_record(case, endpoint, server_response)
    reference = load_reference(endpoint, case['id'])

    if reference is None or update_refs:
        save_reference(endpoint, case['id'], record)
        return TestResult(case['id'], endpoint, passed=True, is_new_ref=True,
                          payload=server_response)

    ref_frames  = reference['response'].get('frames', [])
    cur_frames  = server_response.get('frames', [])
    cur_stats   = aggregate_voiced_frames(cur_frames)
    ref_stats   = aggregate_voiced_frames(ref_frames)

    comparisons: list[Comparison] = [
        compare_count('total_frames',  len(cur_frames),              len(ref_frames)),
        compare_count('voiced_frames', cur_stats['voiced_count'],    ref_stats['voiced_count']),
        compare_float('mean_f1', cur_stats['mean_f1'] or 0,
                      ref_stats['mean_f1'] or 0, TOLERANCE_HZ),
        compare_float('mean_f2', cur_stats['mean_f2'] or 0,
                      ref_stats['mean_f2'] or 0, TOLERANCE_HZ),
    ]
    # Per-frame comparison (only report failures to keep output concise)
    frame_failures = compare_frame_lists(cur_frames, ref_frames)
    comparisons.extend(frame_failures)

    passed = all(c.passed for c in comparisons)
    return TestResult(case['id'], endpoint, passed=passed,
                      comparisons=comparisons, payload=server_response)


# ══════════════════════════════════════════════════════════════════════════════
# /analyze-debug tests
# ══════════════════════════════════════════════════════════════════════════════

def run_analyze_debug_case(case: dict, update_refs: bool) -> TestResult:
    """
    POST the audio file to /analyze-debug and compare raw Praat output.

    Case fields:
      id            — unique identifier
      audio         — path to the WAV file
      window_start  — X-Window-Start fraction (default 0.15)
      window_end    — X-Window-End fraction   (default 0.85)
      description   — human-readable label
    """
    audio_path = Path(case['audio'])
    endpoint   = 'analyze_debug'

    if not audio_path.exists():
        return TestResult(case['id'], endpoint, passed=False,
                          error=f'Audio file not found: {audio_path}')

    headers = {
        'Content-Type':   'audio/wav',
        'X-Window-Start': str(case.get('window_start', 0.15)),
        'X-Window-End':   str(case.get('window_end',   0.85)),
    }

    try:
        response = requests.post(f'{HTTP_BASE}/analyze-debug',
                                 data=read_wav_bytes(audio_path),
                                 headers=headers, timeout=10)
        if not response.ok:
            return TestResult(case['id'], endpoint, passed=False,
                              error=f'HTTP {response.status_code}: {response.json().get("error")}')
        server_response = response.json()
    except Exception as exc:
        return TestResult(case['id'], endpoint, passed=False, error=str(exc))

    record    = build_reference_record(case, endpoint, server_response)
    reference = load_reference(endpoint, case['id'])

    if reference is None or update_refs:
        save_reference(endpoint, case['id'], record)
        return TestResult(case['id'], endpoint, passed=True, is_new_ref=True,
                          payload=server_response)

    comparisons: list[Comparison] = []
    ref_configs = reference['response'].get('configs', {})
    cur_configs = server_response.get('configs', {})

    for config_name, cur_config_result in cur_configs.items():
        ref_config_result = ref_configs.get(config_name, {})
        cur_formants = cur_config_result.get('formants', {})
        ref_formants = ref_config_result.get('formants', {})

        for key in ref_formants:
            if key.startswith('F') and not key.startswith('BW'):
                comparisons.append(compare_formant(
                    f'{config_name}.{key}',
                    cur_formants.get(key),
                    ref_formants.get(key),
                ))

    passed = all(c.passed for c in comparisons)
    return TestResult(case['id'], endpoint, passed=passed,
                      comparisons=comparisons, payload=server_response)


# ══════════════════════════════════════════════════════════════════════════════
# /ws tests
# ══════════════════════════════════════════════════════════════════════════════

async def _stream_audio_over_websocket(
        audio_path:   Path,
        chunk_samples: int,
        config:        dict,
) -> dict:
    """
    Simulate the browser's AudioWorklet streaming behaviour:
      1. Connect to the WebSocket.
      2. Send {type:'init', sample_rate} text frame.
      3. Send optional {type:'config'} text frame.
      4. Split the audio into Int16 chunks and send each as a binary frame.
      5. Drain incoming frames until the server goes quiet (WS_DRAIN_SECS).

    Returns a dict summarising what was sent and received.
    """
    samples_int16, sample_rate = load_wav_as_int16(audio_path)
    audio_chunks = split_into_chunks(samples_int16, chunk_samples)
    received_frames: list[dict] = []

    async with websockets.connect(WS_URL) as websocket:
        # Initialise session
        await websocket.send(json.dumps({'type': 'init', 'sample_rate': sample_rate}))
        if config:
            await websocket.send(json.dumps({'type': 'config', **config}))

        # Stream audio chunks
        for chunk_bytes in audio_chunks:
            await websocket.send(chunk_bytes)

        # Drain: collect responses until the server goes silent
        while True:
            try:
                raw_message = await asyncio.wait_for(websocket.recv(), timeout=WS_DRAIN_SECS)
                payload     = json.loads(raw_message)
                for frame in payload.get('frames', []):
                    received_frames.append(frame)
            except asyncio.TimeoutError:
                break

    voiced_frames  = [f for f in received_frames if f.get('voiced')]
    voiced_f1_list = [f['f1'] for f in voiced_frames if f.get('f1') is not None]
    voiced_f2_list = [f['f2'] for f in voiced_frames if f.get('f2') is not None]

    return {
        'chunks_sent':      len(audio_chunks),
        'samples_sent':     len(samples_int16),
        'sample_rate':      sample_rate,
        'chunk_samples':    chunk_samples,
        'frames_received':  len(received_frames),
        'voiced_count':     len(voiced_frames),
        'mean_f1':          round(sum(voiced_f1_list) / len(voiced_f1_list), 1) if voiced_f1_list else None,
        'mean_f2':          round(sum(voiced_f2_list) / len(voiced_f2_list), 1) if voiced_f2_list else None,
        'frames':           received_frames,
    }


def run_ws_case(case: dict, update_refs: bool) -> TestResult:
    """
    Stream audio to /ws and compare aggregate statistics and per-frame results.

    Case fields:
      id             — unique identifier
      audio          — path to the WAV file
      chunk_samples  — samples per WebSocket binary frame (default 128)
      config         — ConnConfig overrides to send as {type:'config'} (default {})
      description    — human-readable label
    """
    if not _WEBSOCKETS_AVAILABLE:
        return TestResult(case['id'], 'ws', passed=False,
                          error='websockets package not installed  (pip install websockets)')

    audio_path = Path(case['audio'])
    endpoint   = 'ws'

    if not audio_path.exists():
        return TestResult(case['id'], endpoint, passed=False,
                          error=f'Audio file not found: {audio_path}')

    try:
        streaming_result = asyncio.run(_stream_audio_over_websocket(
            audio_path    = audio_path,
            chunk_samples = case.get('chunk_samples', 128),
            config        = case.get('config', {}),
        ))
    except Exception as exc:
        return TestResult(case['id'], endpoint, passed=False, error=str(exc))

    record    = build_reference_record(case, endpoint, streaming_result)
    reference = load_reference(endpoint, case['id'])

    if reference is None or update_refs:
        save_reference(endpoint, case['id'], record)
        return TestResult(case['id'], endpoint, passed=True, is_new_ref=True,
                          payload=streaming_result)

    ref_result   = reference['response']
    comparisons: list[Comparison] = [
        compare_count('chunks_sent',     streaming_result['chunks_sent'],
                      ref_result['chunks_sent']),
        compare_count('frames_received', streaming_result['frames_received'],
                      ref_result['frames_received']),
        compare_count('voiced_count',    streaming_result['voiced_count'],
                      ref_result['voiced_count']),
        compare_float('mean_f1',         streaming_result['mean_f1'] or 0,
                      ref_result['mean_f1'] or 0, TOLERANCE_HZ),
        compare_float('mean_f2',         streaming_result['mean_f2'] or 0,
                      ref_result['mean_f2'] or 0, TOLERANCE_HZ),
    ]
    frame_failures = compare_frame_lists(streaming_result['frames'], ref_result['frames'])
    comparisons.extend(frame_failures)

    passed = all(c.passed for c in comparisons)
    return TestResult(case['id'], endpoint, passed=passed,
                      comparisons=comparisons, payload=streaming_result)


# ══════════════════════════════════════════════════════════════════════════════
# Output formatting
# ══════════════════════════════════════════════════════════════════════════════

PASS_ICON = '✓'
FAIL_ICON = '✗'
NEW_ICON  = '★'

def _fmt_val(value: Any) -> str:
    if value is None:
        return 'null'
    if isinstance(value, float):
        return f'{value:.1f}'
    return str(value)


def print_result(result: TestResult) -> None:
    endpoint_label = result.endpoint.replace('_', '-')
    case_label     = result.case_id

    if result.error:
        print(f'  [{endpoint_label}] {case_label} — ERROR')
        print(f'    {result.error}')
        return

    if result.is_new_ref:
        print(f'  [{endpoint_label}] {case_label} — {NEW_ICON} SAVED AS REFERENCE')
        _print_payload_summary(result.endpoint, result.payload)
        return

    icon   = PASS_ICON if result.passed else FAIL_ICON
    status = 'PASS' if result.passed else 'FAIL'
    print(f'  [{endpoint_label}] {case_label} — {icon} {status}')

    # For passing tests only show summary; for failing tests show each comparison
    if result.passed:
        _print_payload_summary(result.endpoint, result.payload)
    else:
        for comp in result.comparisons:
            if not comp.passed:
                delta_str = f'  Δ={comp.delta:.1f} Hz' if comp.delta is not None else ''
                print(f'    {FAIL_ICON} {comp.field}: '
                      f'{_fmt_val(comp.current)} (ref: {_fmt_val(comp.reference)}){delta_str}')


def _print_payload_summary(endpoint: str, payload: dict) -> None:
    """Print a one-line summary of the response payload."""
    if endpoint == 'analyze':
        f1 = payload.get('f1', '?')
        f2 = payload.get('f2', '?')
        print(f'    F1={f1} Hz  F2={f2} Hz')

    elif endpoint == 'analyze_file':
        frames = payload.get('frames', [])
        stats  = aggregate_voiced_frames(frames)
        print(f'    {stats["voiced_count"]}/{stats["total_count"]} voiced frames  '
              f'mean F1={stats["mean_f1"]}  mean F2={stats["mean_f2"]}')

    elif endpoint == 'analyze_debug':
        configs = payload.get('configs', {})
        for cfg_name, cfg_data in configs.items():
            formants = cfg_data.get('formants', {})
            f1 = formants.get('F1', '?')
            f2 = formants.get('F2', '?')
            print(f'    {cfg_name}: F1={f1}  F2={f2}')

    elif endpoint == 'ws':
        print(f'    {payload.get("voiced_count")}/{payload.get("frames_received")} voiced  '
              f'mean F1={payload.get("mean_f1")}  mean F2={payload.get("mean_f2")}')


# ══════════════════════════════════════════════════════════════════════════════
# Server connectivity check
# ══════════════════════════════════════════════════════════════════════════════

def check_server_is_running() -> bool:
    try:
        response = requests.get(f'{HTTP_BASE}/ping', timeout=3)
        return response.ok
    except Exception:
        return False


# ══════════════════════════════════════════════════════════════════════════════
# Test cases — edit these to match your audio files
# ══════════════════════════════════════════════════════════════════════════════

CASES = {
    'analyze': [
        {
            'id':           'i_middle_window',
            'audio':        'lang/me/audio/i.wav',
            'window_start': 0.15,
            'window_end':   0.85,
            'description':  '/i/ close front unrounded — middle 70% of recording',
        },
        {
            'id':           'i_bar_middle_window',
            'audio':        'lang/me/audio/i_bar.wav',
            'window_start': 0.15,
            'window_end':   0.85,
            'description':  '/ɨ/ close central unrounded',
        },
        {
            'id':           'u_middle_window',
            'audio':        'lang/me/audio/u.wav',
            'window_start': 0.15,
            'window_end':   0.85,
            'description':  '/u/ close back rounded',
        },
        {
            'id':           'o_middle_window',
            'audio':        'lang/me/audio/o.wav',
            'window_start': 0.15,
            'window_end':   0.85,
            'description':  '/o/ mid back rounded',
        },
        {
            'id':           'e_open_middle_window',
            'audio':        'lang/me/audio/e_open.wav',
            'window_start': 0.15,
            'window_end':   0.85,
            'description':  '/ɛ/ open-mid front unrounded',
        },
        {
            'id':           'a_middle_window',
            'audio':        'lang/me/audio/a.wav',
            'window_start': 0.15,
            'window_end':   0.85,
            'description':  '/a/ open front unrounded',
        },
    ],

    'analyze_file': [
        {
            'id':          'i_full_file',
            'audio':       'lang/me/audio/i.wav',
            'config':      {},
            'description': '/i/ whole file — all frames with default config',
        },
        {
            'id':          'u_full_file',
            'audio':       'lang/me/audio/u.wav',
            'config':      {},
            'description': '/u/ whole file — verifies back vowel disambiguation',
        },
        {
            'id':          'a_full_file',
            'audio':       'lang/me/audio/a.wav',
            'config':      {},
            'description': '/a/ whole file',
        },
    ],

    'analyze_debug': [
        {
            'id':           'i_all_configs',
            'audio':        'lang/me/audio/i.wav',
            'window_start': 0.15,
            'window_end':   0.85,
            'description':  '/i/ — shows FRONT (legacy n=3), BACK (n=2), SCAN (n=5)',
        },
        {
            'id':           'u_all_configs',
            'audio':        'lang/me/audio/u.wav',
            'window_start': 0.15,
            'window_end':   0.85,
            'description':  '/u/ — verify BACK correctly captures low F2',
        },
    ],

    'ws': [
        {
            'id':            'i_streaming_128',
            'audio':         'test/live_speech_short.wav',
            'chunk_samples': 128,    # matches AudioWorklet chunk size
            'config':        {},
            'description':   '/i/ streamed in 128-sample chunks (default browser size)',
        }
    ],
}


# ══════════════════════════════════════════════════════════════════════════════
# Main
# ══════════════════════════════════════════════════════════════════════════════

ENDPOINT_RUNNERS = {
    'analyze':       run_analyze_case,
    'analyze_file':  run_analyze_file_case,
    'analyze_debug': run_analyze_debug_case,
    'ws':            run_ws_case,
}


def main() -> int:
    parser = argparse.ArgumentParser(description='Formant server regression tests')
    parser.add_argument('endpoints', nargs='*', default=list(ENDPOINT_RUNNERS.keys()),
                        choices=list(ENDPOINT_RUNNERS.keys()) + [[]],
                        help='Endpoints to test (default: all)')
    parser.add_argument('--update',  action='store_true',
                        help='Overwrite all reference files with current server results')
    parser.add_argument('--list',    action='store_true',
                        help='List all test case IDs and exit')
    args = parser.parse_args()

    if args.list:
        for endpoint, cases in CASES.items():
            print(f'\n{endpoint}:')
            for case in cases:
                print(f'  {case["id"]:30}  {case["description"]}')
        return 0

    if not check_server_is_running():
        print('ERROR: Server is not running at', HTTP_BASE)
        print('       Start it with:  python analyze_server.py')
        return 1

    endpoints_to_run = args.endpoints or list(ENDPOINT_RUNNERS.keys())
    total, passed, new_refs, failed = 0, 0, 0, 0

    print(f'\nFormant server tests — tolerance={TOLERANCE_HZ} Hz'
          + ('  [UPDATE MODE]' if args.update else ''))
    print('─' * 60)

    for endpoint in endpoints_to_run:
        runner    = ENDPOINT_RUNNERS[endpoint]
        test_cases = CASES.get(endpoint, [])

        if not test_cases:
            continue

        print(f'\n/{endpoint.replace("_", "-")}')

        for case in test_cases:
            result = runner(case, update_refs=args.update)
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

    print('\n' + '─' * 60)
    print(f'Results: {passed} passed  {failed} failed  {new_refs} new references  ({total} total)')
    if new_refs:
        print('  Inspect the new reference files in tests/references/ and commit them.')

    return 0 if failed == 0 else 1


if __name__ == '__main__':
    sys.exit(main())