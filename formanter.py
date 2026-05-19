"""
analyze_server.py
=================
Dual-ceiling Praat formant tracker.

HTTP :5050  —  /ping  /frames  /analyze-debug
Stream :5051  —  streaming PCM → rich diagnostic frames

Algorithm (see ``_run_praat_analysis`` for the full pipeline)
--------------------------------------------------------------
1. Run Burg LPC with two ceiling configs:
     SCAN (wide ceiling, many poles)  — primary, handles all vowels
     BACK (narrow ceiling, 2 poles)   — back-vowel disambiguation
2. Prefer BACK when its F2 is well below ceiling AND substantially lower
   than SCAN's F2 (F3-as-F2 confusion fix).
3. Phantom-resonance fix: close front vowels (/i/, /y/) sometimes produce
   a spurious LPC pole between F1 and the real F2; re-scan to skip it.
4. Continuity: un-swap F1/F2 if tracks cross between frames.
5. WS only: server-side sliding median (JS-style rounding to match browser).

WS frame states
---------------
A  below rms_floor  — Praat skipped; only {t_ms, voiced, rms, is_above_rms}
B  above rms_floor, no valid formants — all Praat outputs included for diagnostics
C  voiced — all fields populated including f1_median / f2_median

Install:  pip install flask flask-cors parselmouth numpy websockets
"""

from __future__ import annotations

import asyncio
import json
import math
import os
import struct
import tempfile
import threading
from collections import deque
from dataclasses import dataclass, field

import numpy as np
import parselmouth
from parselmouth.praat import call

from flask import Flask, jsonify, request
from flask_cors import CORS

app = Flask(__name__)
CORS(app)


# ══════════════════════════════════════════════════════════════════════════════
# Constants
# ══════════════════════════════════════════════════════════════════════════════

F1_VALID_RANGE      = (150, 1100)   # Hz — accepted range after Praat
F2_VALID_RANGE      = (400, 3200)   # Hz
SEGMENT_STEP_MS  = 10    # ms — step between segment analyses
SEGMENT_SAMPLES  = 4096  # samples per segment — ~93 ms at 44 100 Hz

# Legacy FRONT config shown in /analyze-debug for comparison only
_DEBUG_LEGACY_FRONT_CFG = dict(
    time_step=0.010, max_number_of_formants=3,
    maximum_formant=4200.0, window_length=0.025, pre_emphasis_from=50.0,
)


# ══════════════════════════════════════════════════════════════════════════════
# Configuration
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class ConnConfig:
    """
    All tunable analysis parameters for one connection or request.

    HTTP endpoints use defaults.  The debug page sends ``{type:'config', …}``
    WebSocket messages to change parameters live.

    Field groups
    ~~~~~~~~~~~~
    SCAN / BACK     → Praat ``to_formant_burg()`` kwargs
    back_*          → dual-ceiling selection criterion
    rms_floor       → energy gate (0 = disabled)
    median_n        → sliding-median window size (WS only)
    """
    # ── SCAN (primary analysis) ───────────────────────────────────────────────
    max_f:        float = 5000
    n_formants:   int   = 5
    window_ms:    float = 25
    pre_emphasis: float = 50

    # ── BACK (back-vowel disambiguation) ─────────────────────────────────────
    back_ceiling:       float = 1800
    back_ceiling_ratio: float = 0.95
    back_front_ratio:   float = 0.75

    # ── Energy gate ──────────────────────────────────────────────────────────
    rms_floor: float = 0.005   # RMS threshold; 0 = gate disabled

    # ── Smoothing ────────────────────────────────────────────────────────────
    median_n: int = 5

    # ── Segment layout (/frames only) ────────────────────────────────────────
    single_segment:  bool = True   # True = whole slice → one frame
    segment_samples: int  = 4096   # window size when single_segment=False
    segment_step_ms: int  = 10     # step in ms when single_segment=False

    def update_from_dict(self, updates: dict) -> None:
        """Apply *updates*, coercing each value to the field's declared type."""
        for name, value in updates.items():
            if hasattr(self, name):
                try:
                    current = getattr(self, name)
                    if isinstance(current, bool):
                        setattr(self, name, bool(value))
                    else:
                        setattr(self, name, type(current)(value))
                except (TypeError, ValueError):
                    pass

    def _shared_burg_kwargs(self) -> dict:
        return dict(time_step=0.010, window_length=self.window_ms / 1000,
                    pre_emphasis_from=self.pre_emphasis)

    def scan_burg_kwargs(self) -> dict:
        return dict(**self._shared_burg_kwargs(),
                    max_number_of_formants=self.n_formants,
                    maximum_formant=self.max_f)

    def back_burg_kwargs(self) -> dict:
        return dict(**self._shared_burg_kwargs(),
                    max_number_of_formants=2,
                    maximum_formant=self.back_ceiling)

    def phantom_scan_kwargs(self) -> dict:
        return dict(**self._shared_burg_kwargs(),
                    max_number_of_formants=max(5, self.n_formants),
                    maximum_formant=self.max_f)


# ══════════════════════════════════════════════════════════════════════════════
# Per-frame continuity state
# ══════════════════════════════════════════════════════════════════════════════

class ConnState:
    """
    Prevents F1/F2 track swaps between consecutive frames.
    If swapping the current values reduces distance to the previous frame,
    they are swapped before returning.
    No EMA — smoothing is done separately via sliding median.
    """

    def __init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        self.previous_f1: float | None = None
        self.previous_f2: float | None = None

    def apply_continuity(self, f1: float, f2: float) -> tuple[int, int]:
        if self.previous_f1 is not None:
            dist_as_is   = abs(f1 - self.previous_f1) + abs(f2 - self.previous_f2)
            dist_swapped = abs(f2 - self.previous_f1) + abs(f1 - self.previous_f2)
            if dist_swapped < dist_as_is:
                f1, f2 = f2, f1
        self.previous_f1, self.previous_f2 = f1, f2
        return round(f1), round(f2)


# ══════════════════════════════════════════════════════════════════════════════
# Analysis result — all intermediate values from one window
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class FormantAnalysis:
    """
    Full diagnostic record of one analysis window.
    Produced by ``_run_praat_analysis``; continuity and median are applied
    separately so callers (WS vs HTTP) can handle them differently.
    """
    sound_duration_ms:       float
    is_valid_sound_duration: bool

    # Raw Praat outputs from each config
    f1_back:             float | None = None
    f2_back:             float | None = None
    f1_scan:             float | None = None
    f2_scan:             float | None = None

    # Dual-ceiling selection
    used_back_config:    bool | None  = None

    # After selection + phantom fix (pre-continuity)
    f1_raw:              float | None = None
    f2_raw:              float | None = None
    phantom_fix_applied: bool | None  = None

    # Range validity
    is_valid_f1_range:   bool | None  = None
    is_valid_f2_range:   bool | None  = None

    # Final summary (continuity and median applied by callers)
    voiced: bool = False


@dataclass
class SegmentInfo:
    """Positional and size metadata for one analysis segment."""
    at_ms:       int
    at:          int
    index:       int
    samples:     int
    duration_ms: float
    step_ms:     int


# ══════════════════════════════════════════════════════════════════════════════
# Analysis state — shared by /frames and /stream
# ══════════════════════════════════════════════════════════════════════════════

# ══════════════════════════════════════════════════════════════════════════════
# Analysis state — shared by /frames and /stream
# ══════════════════════════════════════════════════════════════════════════════

class AnalysisState:
    """
    Continuity correction + median windows for one analysis session.
    Used by both /frames (one instance per request) and StreamingSession
    (one instance per WebSocket connection).
    apply_voiced() is the single call that advances both state machines.
    """

    def __init__(self, median_n: int = 5) -> None:
        self.continuity = ConnState()
        self.median_f1  = deque(maxlen=median_n)
        self.median_f2  = deque(maxlen=median_n)

    def apply_voiced(self, f1_raw: float, f2_raw: float) -> tuple[int, int, int, int]:
        """
        Apply continuity correction then update the median window.
        Returns (f1, f2, f1_median, f2_median).
        """
        f1, f2 = self.continuity.apply_continuity(f1_raw, f2_raw)
        self.median_f1.append(f1)
        self.median_f2.append(f2)
        return f1, f2, _js_median(self.median_f1), _js_median(self.median_f2)

    def resize_median(self, new_n: int) -> None:
        if self.median_f1.maxlen != new_n:
            self.median_f1 = deque(self.median_f1, maxlen=new_n)
            self.median_f2 = deque(self.median_f2, maxlen=new_n)

    def reset(self) -> None:
        self.continuity.reset()
        self.median_f1.clear()
        self.median_f2.clear()


# ══════════════════════════════════════════════════════════════════════════════
# Per-connection streaming session (/stream WebSocket)
# ══════════════════════════════════════════════════════════════════════════════

class StreamingSession:
    """
    All mutable state for one WebSocket connection.
    The ring buffer accumulates incoming chunks; every SEGMENT_STEP_MS of new
    audio, analyse_segment_to_frame() is called with the ring content and the
    session's AnalysisState.
    """

    def __init__(self) -> None:
        self.config      = ConnConfig()
        self.sample_rate = 44_100
        self._init_state()

    def _init_state(self) -> None:
        self.ring                   = deque(maxlen=SEGMENT_SAMPLES)
        self.total_samples_received = 0
        self.segment_index          = 0
        self.analysis_state         = AnalysisState(self.config.median_n)

    def reinit_stream(self, sample_rate: int) -> None:
        self.sample_rate = sample_rate
        self._init_state()

    def reset_stream(self) -> None:
        self.ring.clear()
        self.total_samples_received = 0
        self.segment_index          = 0
        self.analysis_state.reset()

    def update_config(self, updates: dict) -> None:
        old_n = self.config.median_n
        self.config.update_from_dict(updates)
        new_n = self.config.median_n
        if new_n != old_n:
            self.analysis_state.resize_median(new_n)
        self.analysis_state.continuity.reset()

    def accept_chunk(self, samples: np.ndarray) -> None:
        self.ring.extend(samples)
        self.total_samples_received += len(samples)

    @property
    def segment_at_ms(self) -> int:
        """End position of the latest segment in ms (from stream start)."""
        return round(self.total_samples_received / self.sample_rate * 1000)

    @property
    def segment_step(self) -> int:
        return max(1, int(self.sample_rate * SEGMENT_STEP_MS / 1000))

    @property
    def ring_is_full(self) -> bool:
        return len(self.ring) >= SEGMENT_SAMPLES



# ══════════════════════════════════════════════════════════════════════════════
# Audio helpers
# ══════════════════════════════════════════════════════════════════════════════

def decode_int16_pcm(raw_bytes: bytes) -> np.ndarray:
    """Int16 PCM bytes → float64 samples in [-1, 1]."""
    return np.frombuffer(raw_bytes, dtype=np.int16).astype(np.float64) / 32768.0


# Magic-byte prefixes for audio container formats
_AUDIO_FILE_MAGIC = {b'RIFF': '.wav', b'FORM': '.aiff', b'fLaC': '.flac', b'OggS': '.ogg'}


def decode_audio(
        audio_data,
        sample_rate_hint: int = 44_100,
) -> tuple[np.ndarray, int]:
    """
    Decode audio to (float64 samples, sample_rate).

    audio_data — bytes OR a Flask upload object (has a .read() method).

    Detection by magic bytes:
      RIFF/FORM/fLaC/OggS/ID3/\xff\xfb  →  audio file format
        Written to a temp file, decoded by parselmouth (supports WAV,
        AIFF, FLAC, MP3, OGG and other formats parselmouth can read).
      Anything else  →  raw int16 PCM
        Decoded directly; sample_rate = sample_rate_hint (from config).
    """
    raw: bytes = audio_data.read() if hasattr(audio_data, 'read') else bytes(audio_data)
    magic  = raw[:4]
    suffix = _AUDIO_FILE_MAGIC.get(magic)
    if suffix is None and (magic[:3] == b'ID3'
                           or magic[:2] in (b'\xff\xfb', b'\xff\xfa', b'\xff\xf3')):
        suffix = '.mp3'

    if suffix:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp.write(raw)
            tmp_path = tmp.name
        try:
            snd = parselmouth.Sound(tmp_path)
            return snd.values[0].astype(np.float64), int(snd.sampling_frequency)
        finally:
            os.unlink(tmp_path)

    # Raw int16 PCM — sample_rate must be known by the caller
    return decode_int16_pcm(raw).astype(np.float64), sample_rate_hint


def parse_wav_or_pcm(raw_bytes: bytes) -> tuple[np.ndarray, int]:
    """Legacy alias — used by /analyze-debug."""
    return decode_audio(raw_bytes, sample_rate_hint=44_100)


def trim_to_slice_fraction(samples: np.ndarray, start: float, end: float) -> np.ndarray:
    n = len(samples)
    return samples[int(start * n):int(end * n)]


def read_slice_fraction_headers(http_request) -> tuple[float, float]:
    start = float(http_request.headers.get('X-Slice-Start', 0))
    end   = float(http_request.headers.get('X-Window-End',   1))
    return start, end


def compute_rms(samples: np.ndarray) -> float:
    return float(np.sqrt(np.mean(samples ** 2)))


def make_praat_sound(samples: np.ndarray, sample_rate: float) -> parselmouth.Sound:
    return parselmouth.Sound(samples, sampling_frequency=float(sample_rate))


# ══════════════════════════════════════════════════════════════════════════════
# Praat interface
# ══════════════════════════════════════════════════════════════════════════════

def extract_formants_at_midpoint(
        sound: parselmouth.Sound,
        burg_kwargs: dict,
) -> tuple[float | None, float | None]:
    """
    Run Burg LPC; return (F1, F2) at the sound midpoint.
    F1 is range-checked; F2 is left unchecked here so phantom values
    can reach ``fix_phantom_resonance`` intact.
    Returns (None, None) on NaN or F1 out of range.
    """
    try:
        track       = sound.to_formant_burg(**burg_kwargs)
        midpoint    = sound.duration / 2
        f1          = track.get_value_at_time(1, midpoint)
        f2          = track.get_value_at_time(2, midpoint)
        if math.isnan(f1) or math.isnan(f2):
            return None, None
        if not (F1_VALID_RANGE[0] <= f1 <= F1_VALID_RANGE[1]):
            return None, None
        return f1, f2
    except Exception:
        return None, None


# ══════════════════════════════════════════════════════════════════════════════
# Algorithm
# ══════════════════════════════════════════════════════════════════════════════

def select_best_formants(
        f1_back: float | None, f2_back: float | None,
        f1_scan: float | None, f2_scan: float | None,
        config:  ConnConfig,
) -> tuple[float | None, float | None, bool | None]:
    """
    Dual-ceiling selection.  Returns (f1, f2, used_back_config).
    ``used_back_config`` is None when both configs failed.

    NOTE: the comparisons must stay inside the ``and`` chain so Python's
    short-circuit evaluation skips them when ``f2_back`` is None.
    Extracting them into named variables would cause a TypeError.
    """
    back_has_result = f1_back is not None and f2_back is not None
    scan_has_result = f1_scan is not None and f2_scan is not None

    prefer_back = (
            back_has_result and scan_has_result
            and f2_back < config.back_ceiling * config.back_ceiling_ratio
            and f2_back < f2_scan * config.back_front_ratio
    )

    if prefer_back:
        return f1_back, f2_back, True
    elif scan_has_result:
        return f1_scan, f2_scan, False
    elif back_has_result:
        return f1_back, f2_back, True   # last-resort fallback
    else:
        return None, None, None


def fix_phantom_resonance(
        f1: float, f2: float,
        sound: parselmouth.Sound,
        config: ConnConfig,
) -> tuple[float, float]:
    """
    Correct a phantom LPC pole for close front vowels.
    Signature: F1 < 350 Hz AND F2/F1 < 1.7.
    Re-scans with more poles and returns the first candidate > F1×2
    within F2_VALID_RANGE.  Returns (f1, f2) unchanged on failure.
    """
    if not (f1 < 350 and (f2 / f1) < 1.7):
        return f1, f2
    try:
        track    = sound.to_formant_burg(**config.phantom_scan_kwargs())
        midpoint = sound.duration / 2
        for pole in range(2, config.phantom_scan_kwargs()['max_number_of_formants'] + 2):
            candidate = track.get_value_at_time(pole, midpoint)
            if (not math.isnan(candidate)
                    and candidate > f1 * 2.0
                    and F2_VALID_RANGE[0] <= candidate <= F2_VALID_RANGE[1]):
                return f1, candidate
    except Exception:
        pass
    return f1, f2


def _run_praat_analysis(snd: parselmouth.Sound, cfg: ConnConfig) -> FormantAnalysis:
    """
    Full Praat pipeline for one analysis window.  Returns all intermediate
    values as a ``FormantAnalysis``.  Does NOT apply continuity or median —
    those are applied separately by the caller.
    """
    duration_ms    = round(snd.duration * 1000, 1)
    valid_duration = snd.duration >= cfg.window_ms / 1000

    if not valid_duration:
        return FormantAnalysis(sound_duration_ms=duration_ms,
                               is_valid_sound_duration=False)

    f1_back, f2_back = extract_formants_at_midpoint(snd, cfg.back_burg_kwargs())
    f1_scan, f2_scan = extract_formants_at_midpoint(snd, cfg.scan_burg_kwargs())

    f1_raw, f2_raw, used_back = select_best_formants(
        f1_back, f2_back, f1_scan, f2_scan, cfg
    )

    if f1_raw is None:
        # Both configs failed — return State-B base (raw Praat values exposed)
        return FormantAnalysis(
            sound_duration_ms=duration_ms, is_valid_sound_duration=True,
            f1_back=f1_back, f2_back=f2_back,
            f1_scan=f1_scan, f2_scan=f2_scan,
            used_back_config=used_back,
        )

    f1_before, f2_before = f1_raw, f2_raw
    f1_raw, f2_raw       = fix_phantom_resonance(f1_raw, f2_raw, snd, cfg)
    phantom_applied      = (f1_raw != f1_before or f2_raw != f2_before)

    is_valid_f1 = F1_VALID_RANGE[0] <= f1_raw <= F1_VALID_RANGE[1]
    is_valid_f2 = F2_VALID_RANGE[0] <= f2_raw <= F2_VALID_RANGE[1]

    return FormantAnalysis(
        sound_duration_ms=duration_ms, is_valid_sound_duration=True,
        f1_back=f1_back, f2_back=f2_back,
        f1_scan=f1_scan, f2_scan=f2_scan,
        used_back_config=used_back,
        f1_raw=f1_raw,   f2_raw=f2_raw,
        phantom_fix_applied=phantom_applied,
        is_valid_f1_range=is_valid_f1,
        is_valid_f2_range=is_valid_f2,
        voiced=(is_valid_f1 and is_valid_f2),
    )



def _js_median(values: deque) -> int:
    """
    Sliding median matching JavaScript ``Math.round()`` rounding:
    halfway values always round up (0.5 → 1), unlike Python's banker's rounding.
    """
    s = sorted(values)
    m = len(s) // 2
    return s[m] if len(s) % 2 else int((s[m - 1] + s[m]) / 2 + 0.5)


def _nullable_round(value: float | None, ndigits: int = 1) -> float | None:
    return None if value is None else round(value, ndigits)


def _build_silent_frame(seg: SegmentInfo, rms: float) -> dict:
    """State A: below rms_floor — Praat not called."""
    return {
        'segment': {
            'at_ms':       seg.at_ms,
            'at':          seg.at,
            'index':       seg.index,
            'samples':     seg.samples,
            'duration_ms': seg.duration_ms,
            'step_ms':     seg.step_ms,
        },
        'voiced':       False,
        'rms':          rms,
        'is_above_rms': False,
    }


def _build_analysis_frame(
        seg: SegmentInfo, rms: float, analysis: FormantAnalysis,
        f1: int | None, f2: int | None, f1_median: int | None,
        f2_median: int | None, median_n: int,
) -> dict:
    """State B (unvoiced) or State C (voiced): Praat was called."""
    return {
        'segment': {
            'at_ms':            seg.at_ms,
            'at':               seg.at,
            'index':            seg.index,
            'samples':          seg.samples,
            'duration_ms':      seg.duration_ms,
            'step_ms':          seg.step_ms,
            'is_valid_duration': analysis.is_valid_sound_duration,
        },
        'voiced':               analysis.voiced,
        'rms':                  rms,
        'is_above_rms':         True,
        'f1_back':              _nullable_round(analysis.f1_back),
        'f2_back':              _nullable_round(analysis.f2_back),
        'f1_scan':              _nullable_round(analysis.f1_scan),
        'f2_scan':              _nullable_round(analysis.f2_scan),
        'used_back_config':     analysis.used_back_config,
        'phantom_fix_applied':  analysis.phantom_fix_applied,
        'f1_raw':               _nullable_round(analysis.f1_raw),
        'f2_raw':               _nullable_round(analysis.f2_raw),
        'is_valid_f1_range':    analysis.is_valid_f1_range,
        'is_valid_f2_range':    analysis.is_valid_f2_range,
        'f1': f1, 'f2': f2, 'f1_median': f1_median,
        'f2_median': f2_median, 'median_n': median_n,
    }


# ══════════════════════════════════════════════════════════════════════════════
# Shared analysis pipeline — used by /frames and /stream
# ══════════════════════════════════════════════════════════════════════════════

def analyse_segment_to_frame(
        segment: np.ndarray, sample_rate: float,
        seg: SegmentInfo, config: ConnConfig, state: AnalysisState,
) -> dict:
    """Full analysis pipeline: audio segment → rich frame dict."""
    rms = round(compute_rms(segment), 6)
    if config.rms_floor > 0 and rms < config.rms_floor:
        return _build_silent_frame(seg, rms)
    sound    = make_praat_sound(segment, sample_rate)
    analysis = _run_praat_analysis(sound, config)
    f1 = f2 = f1_median = f2_median = None
    if analysis.voiced:
        f1, f2, f1_median, f2_median = state.apply_voiced(
            analysis.f1_raw, analysis.f2_raw
        )
    return _build_analysis_frame(
        seg=seg, rms=rms, analysis=analysis,
        f1=f1, f2=f2, f1_median=f1_median, f2_median=f2_median,
        median_n=config.median_n,
    )


# ══════════════════════════════════════════════════════════════════════════════
# HTTP endpoints
# ══════════════════════════════════════════════════════════════════════════════

@app.route('/ping')
def ping():
    return jsonify({'ok': True})


@app.route('/frames', methods=['POST'])
def http_frames():
    """
    Whole-file rich frame analysis — the file-equivalent of /stream.

    Slides a SEGMENT_SAMPLES window over the audio (or a slice of it)
    and returns a rich frame per step.  Each frame has the same structure as
    a /stream frame, enabling shared client-side rendering.

    Request  (multipart/form-data)
    --------------------------------
    file          — audio file (any format supported by parselmouth)
    config        — JSON ConnConfig overrides  (optional)
    window_start  — slice start, 0.0–1.0       (optional, default 0.0)
    window_end    — slice end,   0.0–1.0       (optional, default 1.0)

    Response
    --------
    {
      frames:          [{t_ms, voiced, rms, is_above_rms, f1, f2,
                         f1_median, f2_median, f1_raw, f2_raw, ...}],
      duration_ms:     float,   full audio duration in ms
      sliced_from_ms:  float,   slice start position in the full audio
      sliced_to_ms:    float,   slice end   position in the full audio
      window_start:    float,
      window_end:      float,
    }

    The t_ms field in each frame is milliseconds from the slice start (0 at
    the first analysed window), consistent with t_ms in /stream frames.
    """
    uploaded_file = request.files.get('file')
    if not uploaded_file:
        return jsonify({'error': 'No file uploaded'}), 400

    # Extract /frames-specific params before building ConnConfig
    # (segment_samples / segment_step_ms are not ConnConfig fields)
    try:
        config_dict = json.loads(request.form.get('config', '{}'))
    except Exception:
        config_dict = {}
    sample_rate_hint    = int(config_dict.pop('sample_rate',    44_100))
    config = ConnConfig()
    config.update_from_dict(config_dict)

    slice_start = float(request.form.get('slice_start', 0.0))
    slice_end   = float(request.form.get('slice_end',   1.0))

    try:
        all_samples, sample_rate = decode_audio(uploaded_file, sample_rate_hint)
        audio_duration_ms = round(len(all_samples) / sample_rate * 1000, 1)

        # Apply optional slice
        n_total         = len(all_samples)
        slice_start_idx = int(n_total * slice_start)
        slice_end_idx   = int(n_total * slice_end)
        sliced          = all_samples[slice_start_idx:slice_end_idx]
        slice_start_ms  = round(slice_start * audio_duration_ms, 1)
        slice_end_ms    = round(slice_end   * audio_duration_ms, 1)
        slice_samples   = len(sliced)

        # single_segment=True: whole slice → one frame. False: sliding window
        if config.single_segment:
            seg_n = slice_samples; seg_step = slice_samples
            step_ms = round(slice_samples / sample_rate * 1000)
        else:
            seg_n = config.segment_samples
            seg_step = max(1, round(sample_rate * config.segment_step_ms / 1000))
            step_ms  = config.segment_step_ms
        state = AnalysisState(config.median_n)
        frames: list[dict] = []
        segment_idx = 0
        for cursor in range(seg_n, slice_samples + 1, seg_step):
            audio_seg = sliced[cursor - seg_n: cursor]
            seg_info  = SegmentInfo(
                at_ms=round(cursor / sample_rate * 1000), at=cursor,
                index=segment_idx, samples=seg_n,
                duration_ms=round(seg_n / sample_rate * 1000, 1),
                step_ms=step_ms,
            )
            try:
                frame = analyse_segment_to_frame(
                    segment=audio_seg, sample_rate=sample_rate,
                    seg=seg_info, config=config, state=state,
                )
            except Exception:
                frame = _build_silent_frame(seg_info, 0.0)
            frames.append(frame)
            segment_idx += 1

        return jsonify({
            'audio_duration_ms': audio_duration_ms,
            'slice': {
                'start':       slice_start,
                'end':         slice_end,
                'start_ms':    slice_start_ms,
                'end_ms':      slice_end_ms,
                'duration_ms': round(slice_end_ms - slice_start_ms, 1),
                'samples':     slice_samples,
            },
            'frames': frames,
        })
    except Exception as error:
        return jsonify({'error': str(error)}), 500


@app.route('/analyze-debug', methods=['POST'])
def http_analyze_debug():
    """Diagnostic endpoint — raw Praat output from FRONT, BACK, SCAN configs."""
    if not request.data:
        return jsonify({'error': 'No audio data'}), 400

    audio_samples, sample_rate = parse_wav_or_pcm(request.data)
    slice_start, slice_end     = read_slice_fraction_headers(request)
    analysis_samples           = trim_to_slice_fraction(audio_samples, slice_start, slice_end)

    try:
        sound       = make_praat_sound(analysis_samples, sample_rate)
        midpoint    = sound.duration / 2
        default_cfg = ConnConfig()
        configs_out = {}

        for name, burg_kwargs in [
            ('FRONT', _DEBUG_LEGACY_FRONT_CFG),
            ('BACK',  default_cfg.back_burg_kwargs()),
            ('SCAN',  default_cfg.scan_burg_kwargs()),
        ]:
            try:
                track  = sound.to_formant_burg(**burg_kwargs)
                max_n  = burg_kwargs['max_number_of_formants'] + 1
                values = {}
                for pole in range(1, max_n + 1):
                    freq = track.get_value_at_time(pole, midpoint)
                    try:
                        bw = track.get_bandwidth_at_time(pole, midpoint)
                        bw_val = None if math.isnan(bw) else round(bw, 1)
                    except Exception:
                        bw_val = None
                    values[f'F{pole}']  = None if math.isnan(freq) else round(freq, 1)
                    values[f'BW{pole}'] = bw_val
                configs_out[name] = {
                    'ceiling': burg_kwargs['maximum_formant'],
                    'n':       burg_kwargs['max_number_of_formants'],
                    'formants': values,
                }
            except Exception as error:
                configs_out[name] = {'error': str(error)}

        return jsonify({
            'sample_rate':   sample_rate,
            'duration_ms':   round(len(analysis_samples) / sample_rate * 1000),
            'analysis_t_ms': round(midpoint * 1000),
            'configs':       configs_out,
        })
    except Exception as error:
        return jsonify({'error': str(error)}), 500


# ══════════════════════════════════════════════════════════════════════════════
# WebSocket streaming
# ══════════════════════════════════════════════════════════════════════════════

async def stream_handler(websocket) -> None:
    """
    Handle one stream connection end-to-end.

    Audio flow
    ~~~~~~~~~~
    Client sends 128-sample Int16 binary frames continuously (no gate filtering).
    Server accumulates samples in the ring buffer and analyses every
    SEGMENT_STEP_MS of new audio.

    Three frame states per analysis window:
      A  rms < rms_floor  → skip Praat; send silent frame
      B  Praat ran, no valid F1/F2 → send diagnostic frame (voiced=false)
      C  voiced → send full frame with continuity + median applied

    Control messages
    ~~~~~~~~~~~~~~~~
      {type:'init',   sample_rate}  → full restart
      {type:'reset'}                → flush analysis state, keep config
      {type:'config', <fields>}     → update ConnConfig live
    """
    session                    = StreamingSession()
    samples_since_last_analysis = 0

    try:
        async for message in websocket:

            # ── Text: control message ──────────────────────────────────────
            if isinstance(message, str):
                try:
                    payload = json.loads(message)
                    msg_type = payload.get('type', '')

                    if msg_type == 'init':
                        session.reinit_stream(int(payload.get('sample_rate', 44_100)))
                        samples_since_last_analysis = 0

                    elif msg_type == 'reset':
                        session.reset_stream()
                        samples_since_last_analysis = 0

                    elif msg_type == 'config':
                        session.update_config(payload)

                except Exception:
                    pass
                continue

            # ── Binary: PCM audio chunk ────────────────────────────────────
            if len(message) < 64:
                continue

            chunk = decode_int16_pcm(message)
            session.accept_chunk(chunk)
            samples_since_last_analysis += len(chunk)

            if not session.ring_is_full:
                continue
            if samples_since_last_analysis < session.segment_step:
                continue
            samples_since_last_analysis = 0

            audio_seg = np.array(session.ring)
            n         = len(audio_seg)
            seg_info  = SegmentInfo(
                at_ms=session.segment_at_ms, at=session.total_samples_received,
                index=session.segment_index, samples=n,
                duration_ms=round(n / session.sample_rate * 1000, 1),
                step_ms=SEGMENT_STEP_MS,
            )
            try:
                frame = analyse_segment_to_frame(
                    segment=audio_seg, sample_rate=session.sample_rate,
                    seg=seg_info, config=session.config, state=session.analysis_state,
                )
                session.segment_index += 1
                await websocket.send(json.dumps({'frames': [frame]}))
            except Exception as error:
                await websocket.send(json.dumps({'frames': [], 'error': str(error)}))

    except Exception:
        pass

# ══════════════════════════════════════════════════════════════════════════════
# WebSocket server thread
# ══════════════════════════════════════════════════════════════════════════════

def _start_stream_server() -> None:
    import websockets as _websockets

    async def _serve_forever():
        async with _websockets.serve(stream_handler, 'localhost', 5051):
            await asyncio.Future()

    asyncio.run(_serve_forever())


threading.Thread(target=_start_stream_server, daemon=True).start()

if __name__ == '__main__':
    print('HTTP :5050   Stream :5051')
    app.run(host='localhost', port=5050, threaded=True, debug=False)