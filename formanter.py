"""
analyze_server.py
=================
Dual-ceiling Praat formant tracker.

HTTP :5050  —  /ping  /frames  /debug
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
Optional (for /transcribe):  pip install faster-whisper
"""

from __future__ import annotations

import json
import math
import os
import tempfile
from collections import deque
from dataclasses import dataclass, field

import numpy as np
import parselmouth
from parselmouth.praat import call

from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS
from flask_sock import Sock

app = Flask(__name__)
CORS(app)
sock = Sock(app)


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
    print(config_dict)
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


@app.route('/debug', methods=['POST'])
def http_debug():
    """
    Diagnostic endpoint — raw Praat output from FRONT, BACK, SCAN configs.

    Accepts the same multipart input as /frames:
      file        — audio file or raw int16 PCM
      config      — JSON with optional slice_start (default 0.15)
                    and slice_end (default 0.85) as extra keys

    Intentionally does NOT use the shared analysis pipeline — all Praat calls
    are explicit so the raw diagnostic output is always visible.
    """
    uploaded_file = request.files.get('file')
    if not uploaded_file:
        return jsonify({'error': 'No file uploaded'}), 400

    try:
        config_dict = json.loads(request.form.get('config', '{}'))
    except Exception:
        config_dict = {}
    sample_rate_hint = int(config_dict.pop('sample_rate', 44_100))
    slice_start      = float(config_dict.pop('slice_start', 0.15))
    slice_end        = float(config_dict.pop('slice_end',   0.85))

    try:
        audio_samples, sample_rate = decode_audio(uploaded_file, sample_rate_hint)
        analysis_samples           = trim_to_slice_fraction(audio_samples, slice_start, slice_end)
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
                    'ceiling':  burg_kwargs['maximum_formant'],
                    'n':        burg_kwargs['max_number_of_formants'],
                    'formants': values,
                }
            except Exception as error:
                configs_out[name] = {'error': str(error)}

        return jsonify({
            'sample_rate':   sample_rate,
            'duration_ms':   round(len(analysis_samples) / sample_rate * 1000),
            'analysis_t_ms': round(midpoint * 1000),
            'slice_start':   slice_start,
            'slice_end':     slice_end,
            'configs':       configs_out,
        })
    except Exception as error:
        return jsonify({'error': str(error)}), 500


# ══════════════════════════════════════════════════════════════════════════════
# Praat-faithful static analysis (editor token audio — NOT the live practice
# pipeline above). Deliberately bypasses dual-ceiling selection, continuity
# correction, phantom-resonance fixing and median smoothing entirely: those
# exist to stabilise a noisy real-time microphone stream, and were fighting
# the editor's own parameter fields in confusing ways on clean, static
# recordings. This calls parselmouth's bare to_formant_burg / to_pitch /
# to_spectrogram — the exact same defaults Praat itself ships with — and
# returns every native analysis frame verbatim, the way Praat's own Formant
# listing / Pitch listing / spectrogram would.
# ══════════════════════════════════════════════════════════════════════════════

@app.route('/analyze-praat', methods=['POST'])
def http_analyze_praat():
    """
    Request (multipart/form-data)
    ------------------------------
    file    — audio file
    config  — JSON, all optional (Praat's own dialog defaults otherwise):
              max_number_of_formants (5), maximum_formant (5500),
              window_length (0.025 s), pre_emphasis_from (50 Hz),
              formant_time_step (0 = auto, i.e. window_length / 4),
              pitch_floor (75), pitch_ceiling (600),
              pitch_time_step (0 = auto)

    Response
    --------
    {
      duration_ms,
      formants:    [{t_ms, f1..f5, b1..b5}],   // null where Praat has no value
      pitch:       [{t_ms, f0}],                // f0 null where unvoiced
      spectrogram: {times_ms, freqs_hz, power_db},  // power_db[time][freq]
    }
    """
    uploaded_file = request.files.get('file')
    if not uploaded_file:
        return jsonify({'error': 'No file uploaded'}), 400

    try:
        config = json.loads(request.form.get('config', '{}'))
    except Exception:
        config = {}

    max_number_of_formants = float(config.get('max_number_of_formants', 5))
    maximum_formant         = float(config.get('maximum_formant', 5500))
    window_length           = float(config.get('window_length', 0.025))
    pre_emphasis_from       = float(config.get('pre_emphasis_from', 50))
    formant_time_step       = float(config.get('formant_time_step', 0)) or None
    pitch_floor             = float(config.get('pitch_floor', 75))
    pitch_ceiling           = float(config.get('pitch_ceiling', 600))
    pitch_time_step         = float(config.get('pitch_time_step', 0)) or None

    try:
        samples, sample_rate = decode_audio(uploaded_file)
        sound = make_praat_sound(samples, sample_rate)

        formant = sound.to_formant_burg(
            time_step=formant_time_step,
            max_number_of_formants=max_number_of_formants,
            maximum_formant=maximum_formant,
            window_length=window_length,
            pre_emphasis_from=pre_emphasis_from,
        )
        formants_out = []
        for t in formant.xs():
            row = {'t_ms': round(t * 1000, 1)}
            for i in range(1, 6):
                f = formant.get_value_at_time(i, t)
                b = formant.get_bandwidth_at_time(i, t)
                row[f'f{i}'] = None if math.isnan(f) else round(f, 1)
                row[f'b{i}'] = None if math.isnan(b) else round(b, 1)
            formants_out.append(row)

        pitch = sound.to_pitch(time_step=pitch_time_step, pitch_floor=pitch_floor, pitch_ceiling=pitch_ceiling)
        pitch_out = [
            {'t_ms': round(t * 1000, 1), 'f0': None if freq <= 0 else round(float(freq), 1)}
            for t, freq in zip(pitch.xs(), pitch.selected_array['frequency'])
        ]

        spectrogram = sound.to_spectrogram()
        power_db = 10 * np.log10(np.maximum(spectrogram.values, 1e-20) / 4e-10)   # Praat's own dB reference (2e-5 Pa)²
        spectrogram_out = {
            'times_ms': [round(t * 1000, 1) for t in spectrogram.xs()],
            'freqs_hz': [round(f, 1) for f in spectrogram.ys()],
            'power_db': [[round(v, 1) for v in column] for column in power_db.T],   # → [time][freq]
        }

        return jsonify({
            'duration_ms': round(sound.duration * 1000, 1),
            'formants': formants_out,
            'pitch': pitch_out,
            'spectrogram': spectrogram_out,
        })
    except Exception as error:
        return jsonify({'error': str(error)}), 500


# ══════════════════════════════════════════════════════════════════════════════
# Transcription (faster-whisper, local — no audio ever leaves this machine,
# no API key, no rate limit). Optional: only loaded on first /transcribe call
# so the rest of the server still runs fine without it installed.
# ══════════════════════════════════════════════════════════════════════════════

_whisper_model = None
_whisper_error: str | None = None


def _get_whisper_model():
    global _whisper_model, _whisper_error
    if _whisper_model is not None or _whisper_error is not None:
        return _whisper_model
    try:
        from faster_whisper import WhisperModel
        size = os.environ.get('WHISPER_MODEL', 'base')
        _whisper_model = WhisperModel(size, device='cpu', compute_type='int8')
    except Exception as error:
        _whisper_error = str(error)
    return _whisper_model


@app.route('/transcribe', methods=['POST'])
def http_transcribe():
    """
    Local speech-to-text. Requires ``pip install faster-whisper`` (not a
    default dependency — see requirements-transcribe.txt). Model size is
    picked via the WHISPER_MODEL env var (tiny/base/small/medium/large-v3),
    default 'base'.

    Decoding deliberately reuses ``decode_audio`` (parselmouth) instead of
    handing the raw file to faster-whisper directly: faster-whisper's own
    file decoding goes through PyAV, whose container API has changed across
    versions in backwards-incompatible ways (e.g. ``av.open()`` dropping the
    ``metadata_errors`` kwarg some faster-whisper releases pass) — installing
    whatever `av` version pip resolves can break that path. Passing an
    already-decoded numpy array to ``model.transcribe()`` skips PyAV
    entirely and reuses the same decoder every other endpoint here depends on.

    Called once per sentence slice by the shadowing page, but also supports
    transcribing a much longer (or the whole) audio range in one call — a
    multi-second clip gives Whisper far more context to condition on than an
    isolated 1-3s sentence fragment, which usually transcribes noticeably
    more accurately. The caller can realign the returned segment timestamps
    back onto its own shorter sentence boundaries afterwards.
    ``vad_filter=True`` skips silence gaps (e.g. the pauses between
    sentences in a long slice) to avoid hallucinated segments there.

    Request (multipart/form-data)
    ------------------------------
    file      — audio file (magic-byte sniffed the same way as /frames)
    language  — optional ISO 639-1 hint (e.g. 'en'); auto-detected if omitted

    Response
    --------
    { text, language, segments: [{start_ms, end_ms, text}] }
    """
    uploaded_file = request.files.get('file')
    if not uploaded_file:
        return jsonify({'error': 'No file uploaded'}), 400

    model = _get_whisper_model()
    if model is None:
        return jsonify({
            'error': 'Transcription unavailable — faster-whisper is not installed. '
                     'Run: pip install -r requirements-transcribe.txt',
            'detail': _whisper_error,
        }), 501

    language = request.form.get('language') or None
    try:
        samples, sample_rate = decode_audio(uploaded_file)
        if sample_rate != 16000:
            samples = make_praat_sound(samples, sample_rate).resample(16000).values[0]
        audio = samples.astype(np.float32)

        segments_iter, info = model.transcribe(audio, language=language, vad_filter=True)
        segments = [
            {'start_ms': round(s.start * 1000), 'end_ms': round(s.end * 1000), 'text': s.text.strip()}
            for s in segments_iter
        ]
        text = ' '.join(s['text'] for s in segments).strip()
        return jsonify({'text': text, 'language': info.language, 'segments': segments})
    except Exception as error:
        return jsonify({'error': str(error)}), 500


# ══════════════════════════════════════════════════════════════════════════════
# Phase 0 DB browsing (read-only) — lets you actually listen to what the
# migration loaded instead of just reading storage_key strings off a table.
# Expect this to be superseded by a real ingestion/library API in Phase 1+.
# ══════════════════════════════════════════════════════════════════════════════

import re  # noqa: E402

from db.session import get_sessionmaker  # noqa: E402
from db.models import Language, Sample  # noqa: E402
from db.storage import get_audio_store, is_local_url, storage_key_from_url, url_from_storage_key  # noqa: E402
from flask import send_file, abort  # noqa: E402


@app.route('/api/v1/languages')
def list_languages():
    """Read-only — just enough for an ingestion UI's language picker. Full
    CRUD (add/reorder/disable) is a later phase; languages themselves are
    still edited via editor.html's File System Access flow for now."""
    with get_sessionmaker()() as db:
        langs = db.query(Language).order_by(Language.sort_order).all()
        return jsonify([{
            'id': lang.id, 'key': lang.key, 'label': lang.label,
            'color': lang.color, 'enabled': lang.enabled,
        } for lang in langs])


@app.route('/api/v1/samples', methods=['POST'])
def ingest_sample():
    """
    Phase 1 of the ingestion redesign: the one place new audio enters the
    library from here on. Always a SLICE — the caller (Formant Lab's
    ingestion mode, Shadowing's "save to library") already decoded the
    source file client-side and extracted exactly the range it wants kept,
    so there's no separate "trim on save" step here: the uploaded bytes ARE
    the sample, start to finish.

    Request (multipart/form-data)
    ------------------------------
    file        — audio bytes (any format decode_audio() can read; the
                  ingestion UIs always send WAV from encodeWavBlob())
    languageId  — required int — which Language this sample belongs to
    text        — required str — what's being said; also becomes part of
                  the storage filename, so it's mandatory up front rather
                  than something you can leave blank and fill in later
    phonemic    — optional str

    Response: the created Sample's library-browser shape (same fields
    /api/v1/sounds returns per row) plus 201.
    """
    uploaded_file = request.files.get('file')
    if not uploaded_file:
        return jsonify({'error': 'No file uploaded'}), 400
    language_id = request.form.get('languageId')
    text = (request.form.get('text') or '').strip()
    if not language_id:
        return jsonify({'error': 'languageId is required'}), 400
    if not text:
        return jsonify({'error': 'text is required'}), 400

    try:
        raw = uploaded_file.read()
        samples, sample_rate = decode_audio(raw)
        duration_ms = round(len(samples) / sample_rate * 1000)

        store = get_audio_store()
        with get_sessionmaker()() as db:
            language = db.get(Language, int(language_id))
            if language is None:
                return jsonify({'error': f'No language with id {language_id}'}), 400

            # lang/<lang-key>/ingested/<slugified-text>.wav — auto-suffixed (-2, -3, ...)
            # if that language+text combination is already taken, so a save never
            # silently overwrites or blocks on a duplicate recording of the same word.
            slug = re.sub(r'[/\\\x00-\x1f]', '_', text) or 'untitled'
            suffix, storage_key = 0, None
            while True:
                suffix += 1
                candidate = f'lang/{language.key}/ingested/{slug}{"" if suffix == 1 else f"-{suffix}"}.wav'
                if db.query(Sample).filter_by(url=url_from_storage_key(candidate)).first() is None:
                    storage_key = candidate
                    break
            store.put_bytes(raw, storage_key)

            sample = Sample(
                url=url_from_storage_key(storage_key),
                original_filename=uploaded_file.filename,
                content_type=uploaded_file.content_type,
                duration_ms=duration_ms,
                sample_rate_hz=sample_rate,
                channels=1,
                language_id=int(language_id),
                text=text,
                phonemic=request.form.get('phonemic') or None,
            )
            db.add(sample)
            db.commit()
            db.refresh(sample)
            return jsonify({
                'id': sample.id,
                'url': sample.url,
                'audioUrl': f'/audio/{storage_key}',
                'durationMs': sample.duration_ms,
                'text': sample.text,
                'phonemic': sample.phonemic,
            }), 201
    except Exception as error:
        return jsonify({'error': str(error)}), 500


@app.route('/api/v1/sounds')
def list_sounds():
    """Named /sounds rather than /samples: every sample row is "a sound" in
    the sense this browser cares about (has it got audio, does the file
    exist) — whether or not it's been assigned a language/text/tokens yet."""
    try:
        store = get_audio_store()
        with get_sessionmaker()() as db:
            samples = db.query(Sample).order_by(Sample.id).all()
            rows = []
            for s in samples:
                local = bool(s.url) and is_local_url(s.url)
                storage_key = storage_key_from_url(s.url) if local else None
                rows.append({
                    'id': s.id,
                    'storageKey': storage_key,
                    'sourceUrl': None if local else s.url,
                    'originalFilename': s.original_filename,
                    'durationMs': s.duration_ms,
                    'text': s.text,
                    'hasFile': bool(storage_key) and store.exists(storage_key),
                    'audioUrl': f'/audio/{storage_key}' if storage_key else s.url,
                    'createdAt': s.created_at.isoformat() if s.created_at else None,
                    'updatedAt': s.updated_at.isoformat() if s.updated_at else None,
                })
            return jsonify(rows)
    except Exception as error:
        return jsonify({'error': str(error)}), 500


@app.route('/audio/<path:storage_key>')
def serve_audio(storage_key):
    store = get_audio_store()
    if not store.exists(storage_key):
        abort(404)
    return send_file(store.get_path(storage_key), conditional=True)


# ══════════════════════════════════════════════════════════════════════════════
# Static frontend
# ══════════════════════════════════════════════════════════════════════════════

@app.route('/')
def serve_index():
    return send_from_directory('.', 'index.html')


@app.route('/<path:path>')
def serve_static(path):
    return send_from_directory('.', path)


# ══════════════════════════════════════════════════════════════════════════════
# WebSocket streaming
# ══════════════════════════════════════════════════════════════════════════════

@sock.route('/stream')
def stream_ws(ws) -> None:
    """
    WebSocket streaming endpoint (flask-sock, same port as HTTP).

    Audio flow
    ~~~~~~~~~~
    Client sends 128-sample Int16 binary frames continuously.
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
    session                     = StreamingSession()
    samples_since_last_analysis = 0

    try:
        while True:
            message = ws.receive()

            # ── Text: control message ──────────────────────────────────────
            if isinstance(message, str):
                try:
                    payload  = json.loads(message)
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
                ws.send(json.dumps({'frames': [frame]}))
            except Exception as error:
                ws.send(json.dumps({'frames': [], 'error': str(error)}))

    except Exception:
        pass


if __name__ == '__main__':
    print('HTTP + WebSocket :5050')
    app.run(host='0.0.0.0', port=5050, threaded=True, debug=False)