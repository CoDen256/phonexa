"""
analyze_server.py
=================
Dual-ceiling Praat formant tracker.

HTTP :5050  —  /ping  /analyze  /analyze-file  /analyze-debug
WS   :5051  —  streaming PCM → voiced frames

Algorithm (see ``analyze_window`` for the full flow)
------------------------------------------------------
1. Run Burg LPC with two ceiling configs:
     SCAN (wide ceiling, many poles)  — primary, handles all vowels
     BACK (narrow ceiling, 2 poles)   — back-vowel disambiguation
2. Prefer BACK result when its F2 is well below the ceiling AND
   substantially lower than SCAN's F2 (F3-as-F2 confusion fix).
3. Phantom-resonance fix: close front vowels (/i/, /y/) sometimes
   produce a spurious LPC pole between F1 and the real F2.
   Re-scan with more poles to skip it.
4. Frame-to-frame continuity: un-swap F1/F2 if tracks cross.

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
from dataclasses import dataclass

import numpy as np
import parselmouth
from parselmouth.praat import call

from flask import Flask, jsonify, request
from flask_cors import CORS

# ── App ────────────────────────────────────────────────────────────────────────
app = Flask(__name__)
CORS(app)


# ══════════════════════════════════════════════════════════════════════════════
# Constants
# ══════════════════════════════════════════════════════════════════════════════

# Sanity ranges for accepted formant values.
F1_VALID_RANGE = (150, 1100)   # Hz
F2_VALID_RANGE = (400, 3200)   # Hz

# WebSocket sliding-window parameters.
ANALYSIS_STEP_MS       = 10     # ms  — analyse every N ms of new audio
RING_BUFFER_SAMPLES    = 4096   # samples — ~93 ms at 44 100 Hz

# Fixed Praat config used only by /analyze-debug to show the old n=3 result.
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

    The debug page sends ``{type: 'config', <field>: <value>}`` WebSocket
    messages whenever the user moves a slider.  The practice app never sends
    config messages and runs on the defaults.

    Field groups
    ~~~~~~~~~~~~
    * ``max_f / n_formants / window_ms / pre_emphasis``
          Feed directly into Praat's ``to_formant_burg()``.
    * ``back_*``
          Control the dual-ceiling selection criterion.
    * ``energy_floor``
          Server-side RMS gate.  Set to 0 (disabled) for the practice app,
          which applies its own client-side gate.
    """

    # ── Primary Burg LPC (SCAN config) ────────────────────────────────────
    max_f:        float = 5000   # maximum_formant  (Hz)
    n_formants:   int   = 5      # max_number_of_formants
    window_ms:    float = 25     # window_length  (converted → seconds)
    pre_emphasis: float = 50     # pre_emphasis_from  (Hz)

    # ── Back-vowel disambiguation (BACK config) ───────────────────────────
    back_ceiling:        float = 1800  # maximum_formant for BACK config (Hz)
    back_ceiling_ratio:  float = 0.95  # use BACK when f2_back < back_ceiling × ratio
    back_front_ratio:    float = 0.75  # use BACK when f2_back < f2_scan   × ratio

    # ── Server-side energy gate ───────────────────────────────────────────
    energy_floor: float = 0.0  # RMS threshold; 0 = gate disabled

    def update_from_dict(self, updates: dict) -> None:
        """Apply *updates*, coercing each value to the field's declared type."""
        for field_name, value in updates.items():
            if hasattr(self, field_name):
                try:
                    setattr(self, field_name, type(getattr(self, field_name))(value))
                except (TypeError, ValueError):
                    pass

    # ── Praat kwargs builders ─────────────────────────────────────────────

    def _shared_burg_kwargs(self) -> dict:
        """Parameters common to both SCAN and BACK Burg analyses."""
        return {
            'time_step':         0.010,
            'window_length':     self.window_ms / 1000,
            'pre_emphasis_from': self.pre_emphasis,
        }

    def scan_burg_kwargs(self) -> dict:
        """Praat kwargs for the primary (wide-ceiling) analysis."""
        return {
            **self._shared_burg_kwargs(),
            'max_number_of_formants': self.n_formants,
            'maximum_formant':        self.max_f,
        }

    def back_burg_kwargs(self) -> dict:
        """Praat kwargs for the back-vowel disambiguation analysis."""
        return {
            **self._shared_burg_kwargs(),
            'max_number_of_formants': 2,
            'maximum_formant':        self.back_ceiling,
        }

    def phantom_scan_kwargs(self) -> dict:
        """
        Praat kwargs for the phantom-resonance re-scan.
        Uses at least 5 poles so the real F2 above the phantom can be reached.
        """
        return {
            **self._shared_burg_kwargs(),
            'max_number_of_formants': max(5, self.n_formants),
            'maximum_formant':        self.max_f,
        }


# ══════════════════════════════════════════════════════════════════════════════
# Continuity state
# ══════════════════════════════════════════════════════════════════════════════

class ConnState:
    """
    Per-connection frame-to-frame continuity tracker.

    Prevents F1/F2 track swaps: if swapping the current frame's values
    reduces the total distance to the previous frame, the values are swapped
    back before being returned.

    No EMA smoothing — that is done client-side with a median window.
    """

    def __init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        self.previous_f1: float | None = None
        self.previous_f2: float | None = None

    def apply_continuity(self, f1: float, f2: float) -> tuple[int, int]:
        """Return (f1, f2), swapping if that reduces distance to previous frame."""
        if self.previous_f1 is not None:
            distance_as_is   = abs(f1 - self.previous_f1) + abs(f2 - self.previous_f2)
            distance_swapped = abs(f2 - self.previous_f1) + abs(f1 - self.previous_f2)
            if distance_swapped < distance_as_is:
                f1, f2 = f2, f1
        self.previous_f1, self.previous_f2 = f1, f2
        return round(f1), round(f2)


# ══════════════════════════════════════════════════════════════════════════════
# Audio helpers
# ══════════════════════════════════════════════════════════════════════════════

def decode_int16_pcm(raw_bytes: bytes) -> np.ndarray:
    """Int16 PCM bytes → float64 samples normalised to [-1, 1]."""
    return np.frombuffer(raw_bytes, dtype=np.int16).astype(np.float64) / 32768.0


def parse_wav_or_pcm(raw_bytes: bytes) -> tuple[np.ndarray, int]:
    """
    Parse audio from raw bytes.

    Accepts either a WAV file (detected by the ``RIFF`` header) or raw
    Int16 PCM at an assumed 16 000 Hz.  Returns (samples, sample_rate).
    """
    is_wav = raw_bytes[:4] == b'RIFF'
    if is_wav:
        sample_rate = struct.unpack_from('<I', raw_bytes, 24)[0]
        samples     = decode_int16_pcm(raw_bytes[44:])
    else:
        sample_rate = 16_000
        samples     = decode_int16_pcm(raw_bytes)
    return samples, sample_rate


def trim_to_window_fraction(samples: np.ndarray, start: float, end: float) -> np.ndarray:
    """Slice *samples* to the [start, end] fraction (values in [0, 1])."""
    total = len(samples)
    return samples[int(start * total):int(end * total)]


def read_window_fraction_headers(http_request) -> tuple[float, float]:
    """Read X-Window-Start / X-Window-End headers (defaults: 0 and 1)."""
    start = float(http_request.headers.get('X-Window-Start', 0))
    end   = float(http_request.headers.get('X-Window-End',   1))
    return start, end


def compute_rms(samples: np.ndarray) -> float:
    """Root-mean-square amplitude of *samples*."""
    return float(np.sqrt(np.mean(samples ** 2)))


def make_praat_sound(samples: np.ndarray, sample_rate: float) -> parselmouth.Sound:
    """Wrap a NumPy array in a ``parselmouth.Sound`` object."""
    return parselmouth.Sound(samples, sampling_frequency=float(sample_rate))


# ══════════════════════════════════════════════════════════════════════════════
# Frame construction helpers
# ══════════════════════════════════════════════════════════════════════════════

def voiced_frame(f1: int, f2: int, midpoint_ms: int) -> dict:
    """Build a voiced analysis result dict."""
    return {'voiced': True, 'f1': f1, 'f2': f2, 't_ms': midpoint_ms}


def unvoiced_frame(midpoint_ms: int) -> dict:
    """Build an unvoiced (or rejected) analysis result dict."""
    return {'voiced': False, 'f1': None, 'f2': None, 't_ms': midpoint_ms}


# ══════════════════════════════════════════════════════════════════════════════
# Praat interface
# ══════════════════════════════════════════════════════════════════════════════

def extract_formants_at_midpoint(
        sound: parselmouth.Sound,
        burg_kwargs: dict,
) -> tuple[float | None, float | None]:
    """
    Run Burg LPC and read F1 / F2 at the sound's temporal midpoint.

    F1 is range-checked against F1_VALID_RANGE.  F2 is deliberately **not**
    range-checked here — phantom values below 400 Hz must reach
    ``fix_phantom_resonance`` intact so they can be corrected.

    Returns (f1, f2) or (None, None) if Praat returns NaN or F1 is out of range.
    """
    try:
        formant_track  = sound.to_formant_burg(**burg_kwargs)
        midpoint_time  = sound.duration / 2
        f1             = formant_track.get_value_at_time(1, midpoint_time)
        f2             = formant_track.get_value_at_time(2, midpoint_time)

        any_nan        = math.isnan(f1) or math.isnan(f2)
        f1_in_range    = F1_VALID_RANGE[0] <= f1 <= F1_VALID_RANGE[1]
        if any_nan or not f1_in_range:
            return None, None

        return f1, f2
    except Exception:
        return None, None


# ══════════════════════════════════════════════════════════════════════════════
# Algorithm steps
# ══════════════════════════════════════════════════════════════════════════════

def select_best_formants(
        f1_back: float | None, f2_back: float | None,
        f1_scan: float | None, f2_scan: float | None,
        config:  ConnConfig,
) -> tuple[float | None, float | None]:
    """
    Choose between BACK and SCAN formant estimates.

    BACK is preferred when **both** conditions are met:
      a) f2_back is well below the BACK ceiling (not a ceiling artefact)
      b) f2_back is substantially lower than f2_scan (F3-as-F2 confusion)

    Otherwise SCAN is used.  Falls back to the remaining valid config if
    one failed entirely.  Returns (None, None) when both configs failed.
    """
    back_has_result = f1_back is not None and f2_back is not None
    scan_has_result = f1_scan is not None and f2_scan is not None

    # NOTE: the comparisons must be inside the 'and' chain so Python's
    # short-circuit evaluation skips them when back_has_result is False.
    # Extracting them into named variables before the chain would evaluate
    # f2_back < ... even when f2_back is None, raising a TypeError.
    prefer_back = (
            back_has_result and scan_has_result
            and f2_back < config.back_ceiling * config.back_ceiling_ratio
            and f2_back < f2_scan * config.back_front_ratio
    )

    if prefer_back:
        return f1_back, f2_back
    elif scan_has_result:
        return f1_scan, f2_scan
    elif back_has_result:
        return f1_back, f2_back   # last resort
    else:
        return None, None


def fix_phantom_resonance(
        f1:     float,
        f2:     float,
        sound:  parselmouth.Sound,
        config: ConnConfig,
) -> tuple[float, float]:
    """
    Correct a phantom LPC pole for close front vowels.

    Signature: F1 < 350 Hz **and** F2/F1 < 1.7 — the LPC placed a spurious
    pole (subglottal resonance or artefact) between F1 and the real F2.
    Re-scan with more poles and return the first candidate that satisfies
    ``candidate > F1 × 2`` and lies within F2_VALID_RANGE.

    Returns (f1, f2) unchanged when the signature is absent.
    """
    is_close_front_vowel    = f1 < 350
    f2_suspiciously_close   = (f2 / f1) < 1.7
    if not (is_close_front_vowel and f2_suspiciously_close):
        return f1, f2

    try:
        extended_formant_track = sound.to_formant_burg(**config.phantom_scan_kwargs())
        midpoint_time          = sound.duration / 2
        max_pole_index         = config.phantom_scan_kwargs()['max_number_of_formants'] + 1

        for pole_index in range(2, max_pole_index + 1):
            candidate = extended_formant_track.get_value_at_time(pole_index, midpoint_time)
            above_phantom = candidate > f1 * 2.0
            in_f2_range   = F2_VALID_RANGE[0] <= candidate <= F2_VALID_RANGE[1]
            if not math.isnan(candidate) and above_phantom and in_f2_range:
                return f1, candidate
    except Exception:
        pass

    return f1, f2  # phantom fix failed — return original values


# ══════════════════════════════════════════════════════════════════════════════
# Core analysis entry point
# ══════════════════════════════════════════════════════════════════════════════

def analyze_window(
        window_samples: np.ndarray,
        sample_rate:    float,
        config:         ConnConfig | None = None,
        state:          ConnState  | None = None,
) -> dict:
    """
    Analyse one window of audio samples and return a frame dict.

    This is the **single entry point** for all formant analysis — HTTP
    endpoints and the WebSocket handler all call this function.

    Return keys: ``voiced`` (bool), ``f1`` (int|None), ``f2`` (int|None),
    ``t_ms`` (int — midpoint of the window in milliseconds).

    Full flow
    ~~~~~~~~~
    1. Build a Praat Sound from *window_samples*.
    2. Run SCAN and BACK Burg analyses simultaneously.
    3. Select the best (f1, f2) pair via the dual-ceiling criterion.
    4. Apply the phantom-resonance fix for close front vowels.
    5. Validate the final F2 against F2_VALID_RANGE.
    6. Apply frame-to-frame continuity correction (if *state* provided).
    """
    if config is None:
        config = ConnConfig()

    sound       = make_praat_sound(window_samples, sample_rate)
    midpoint_ms = round(sound.duration / 2 * 1000)

    if sound.duration < config.window_ms / 1000:
        return unvoiced_frame(midpoint_ms)

    f1_back, f2_back = extract_formants_at_midpoint(sound, config.back_burg_kwargs())
    f1_scan, f2_scan = extract_formants_at_midpoint(sound, config.scan_burg_kwargs())

    f1_raw, f2_raw   = select_best_formants(f1_back, f2_back, f1_scan, f2_scan, config)
    if f1_raw is None:
        return unvoiced_frame(midpoint_ms)

    f1_raw, f2_raw   = fix_phantom_resonance(f1_raw, f2_raw, sound, config)

    f2_is_valid = F2_VALID_RANGE[0] <= f2_raw <= F2_VALID_RANGE[1]
    if not f2_is_valid:
        return unvoiced_frame(midpoint_ms)

    if state is not None:
        f1, f2 = state.apply_continuity(f1_raw, f2_raw)
    else:
        f1, f2 = round(f1_raw), round(f2_raw)

    return voiced_frame(f1, f2, midpoint_ms)


# ══════════════════════════════════════════════════════════════════════════════
# Whole-file analysis  (used by /analyze-file)
# ══════════════════════════════════════════════════════════════════════════════

def analyze_all_windows(file_path: str, config: ConnConfig) -> tuple[list[dict], float]:
    """
    Slide a window across an audio file and analyse each position.

    Returns (frames, duration_seconds).  Each frame dict has:
    ``t`` (float, seconds), ``f1``, ``f2`` (int|None), ``rms`` (float).

    Frames below ``config.energy_floor`` are returned as silent (f1=f2=None)
    so the debug page renders them as gaps rather than showing noise.
    """
    sound        = parselmouth.Sound(file_path)
    sample_rate  = sound.sampling_frequency
    all_samples  = sound.values[0].astype(np.float64)
    duration_sec = sound.duration

    step_samples   = max(1, int(sample_rate * ANALYSIS_STEP_MS / 1000))
    window_samples = RING_BUFFER_SAMPLES
    state          = ConnState()
    frames: list[dict] = []

    for window_end in range(window_samples, len(all_samples) + 1, step_samples):
        window      = all_samples[window_end - window_samples: window_end]
        window_rms  = round(compute_rms(window), 6)
        time_sec    = round(window_end / sample_rate, 3)

        below_energy_floor = config.energy_floor > 0 and window_rms < config.energy_floor
        if below_energy_floor:
            frames.append({'t': time_sec, 'f1': None, 'f2': None, 'rms': window_rms})
            continue

        try:
            result = analyze_window(window, sample_rate, config, state)
            frames.append({
                't':   time_sec,
                'f1':  result['f1'] if result['voiced'] else None,
                'f2':  result['f2'] if result['voiced'] else None,
                'rms': window_rms,
            })
        except Exception:
            frames.append({'t': time_sec, 'f1': None, 'f2': None, 'rms': window_rms})

    return frames, round(duration_sec, 3)


# ══════════════════════════════════════════════════════════════════════════════
# HTTP endpoints
# ══════════════════════════════════════════════════════════════════════════════

@app.route('/ping')
def ping():
    return jsonify({'ok': True})


@app.route('/analyze', methods=['POST'])
def http_analyze():
    """
    Single-window formant analysis for the practice tool and verifier.

    Flow: parse audio → validate duration → trim to window fraction →
          analyze_window (default config) → return {f1, f2, duration_ms}.
    """
    if not request.data:
        return jsonify({'error': 'No audio data'}), 400

    audio_samples, sample_rate = parse_wav_or_pcm(request.data)
    duration_ms                = len(audio_samples) / sample_rate * 1000
    minimum_duration_ms        = ConnConfig().window_ms

    if duration_ms < minimum_duration_ms:
        return jsonify({
            'error': f'Audio too short: {duration_ms:.0f} ms '
                     f'(minimum is one analysis window = {minimum_duration_ms:.0f} ms)'
        }), 400

    window_start, window_end = read_window_fraction_headers(request)
    analysis_samples         = trim_to_window_fraction(audio_samples, window_start, window_end)

    try:
        result = analyze_window(analysis_samples, sample_rate)
        if not result['voiced']:
            return jsonify({'error': 'No voiced speech detected'}), 400
        return jsonify({'f1': result['f1'], 'f2': result['f2'], 'duration_ms': round(duration_ms)})
    except Exception as error:
        return jsonify({'error': str(error)}), 500


@app.route('/analyze-file', methods=['POST'])
def http_analyze_file():
    """
    Whole-file frame-by-frame analysis for the debug page's reference audio.

    Flow: save uploaded file → parse config from form → analyze_all_windows →
          return {frames: [{t, f1, f2, rms}], duration}.

    Accepts multipart/form-data:
      file   — audio file (any format readable by Praat / libsndfile)
      config — JSON string of ConnConfig field overrides  (optional)
    """
    uploaded_file = request.files.get('file')
    if not uploaded_file:
        return jsonify({'error': 'No file uploaded'}), 400

    config = ConnConfig()
    try:
        config.update_from_dict(json.loads(request.form.get('config', '{}')))
    except Exception:
        pass   # malformed config → use defaults

    with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as tmp:
        uploaded_file.save(tmp.name)
        tmp_path = tmp.name

    try:
        frames, duration_sec = analyze_all_windows(tmp_path, config)
        return jsonify({'frames': frames, 'duration': duration_sec})
    except Exception as error:
        return jsonify({'error': str(error)}), 500
    finally:
        os.unlink(tmp_path)


@app.route('/analyze-debug', methods=['POST'])
def http_analyze_debug():
    """
    Diagnostic endpoint — raw Praat output from FRONT, BACK, and SCAN configs.

    No range-checking, no phantom fix, no continuity.  Use this to diagnose
    why a recording is being rejected or producing unexpected values.

    Returns bandwidths alongside formant frequencies so you can see whether
    a formant is a sharp resonance (narrow bandwidth) or noise (wide bandwidth).
    """
    if not request.data:
        return jsonify({'error': 'No audio data'}), 400

    audio_samples, sample_rate = parse_wav_or_pcm(request.data)
    window_start, window_end   = read_window_fraction_headers(request)
    analysis_samples           = trim_to_window_fraction(audio_samples, window_start, window_end)

    try:
        sound        = make_praat_sound(analysis_samples, sample_rate)
        midpoint_sec = sound.duration / 2
        default_cfg  = ConnConfig()

        named_configs = [
            ('FRONT', _DEBUG_LEGACY_FRONT_CFG),
            ('BACK',  default_cfg.back_burg_kwargs()),
            ('SCAN',  default_cfg.scan_burg_kwargs()),
        ]
        configs_output = {}

        for config_name, burg_kwargs in named_configs:
            try:
                formant_track  = sound.to_formant_burg(**burg_kwargs)
                max_pole_index = burg_kwargs['max_number_of_formants'] + 1
                formant_values = {}

                for pole_index in range(1, max_pole_index + 1):
                    frequency = formant_track.get_value_at_time(pole_index, midpoint_sec)
                    bandwidth = call(formant_track, 'Get bandwidth at time',
                                     pole_index, midpoint_sec, 'hertz', 'Linear')
                    formant_values[f'F{pole_index}']  = None if math.isnan(frequency) else round(frequency, 1)
                    formant_values[f'BW{pole_index}'] = None if math.isnan(bandwidth)  else round(bandwidth,  1)

                configs_output[config_name] = {
                    'ceiling':  burg_kwargs['maximum_formant'],
                    'n':        burg_kwargs['max_number_of_formants'],
                    'formants': formant_values,
                }
            except Exception as error:
                configs_output[config_name] = {'error': str(error)}

        return jsonify({
            'sample_rate':   sample_rate,
            'duration_ms':   round(len(analysis_samples) / sample_rate * 1000),
            'analysis_t_ms': round(midpoint_sec * 1000),
            'configs':       configs_output,
        })
    except Exception as error:
        return jsonify({'error': str(error)}), 500


# ══════════════════════════════════════════════════════════════════════════════
# WebSocket streaming
# ══════════════════════════════════════════════════════════════════════════════

async def ws_handler(websocket) -> None:
    """
    Handle one WebSocket connection.

    Audio flow
    ~~~~~~~~~~
    The client sends 128-sample Int16 chunks (~2.9 ms at 44 100 Hz).
    The server accumulates them in a ring buffer (RING_BUFFER_SAMPLES samples).
    Every ANALYSIS_STEP_MS of new audio it analyses the full ring and sends one
    voiced/unvoiced frame back.

    Control messages (text frames)
    ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    ``{type:'init',   sample_rate:<int>}``  — (re)start with given sample rate
    ``{type:'reset'}``                       — flush ring and continuity state
    ``{type:'config', <ConnConfig fields>}`` — update analysis parameters live
    """
    sample_rate                  = 44_100
    continuity_state             = ConnState()
    audio_ring                   = deque(maxlen=RING_BUFFER_SAMPLES)
    samples_since_last_analysis  = 0
    config                       = ConnConfig()

    try:
        async for message in websocket:

            # ── Text frame: control message ────────────────────────────────
            if isinstance(message, str):
                try:
                    payload      = json.loads(message)
                    message_type = payload.get('type', '')

                    if message_type == 'init':
                        sample_rate = int(payload.get('sample_rate', 44_100))
                        continuity_state.reset()
                        audio_ring.clear()
                        samples_since_last_analysis = 0

                    elif message_type == 'reset':
                        continuity_state.reset()
                        audio_ring.clear()
                        samples_since_last_analysis = 0

                    elif message_type == 'config':
                        config.update_from_dict(payload)
                        continuity_state.reset()   # continuity is per-vowel, not per-config

                except Exception:
                    pass
                continue

            # ── Binary frame: PCM audio ────────────────────────────────────
            too_short = len(message) < 64
            if too_short:
                continue

            incoming_chunk              = decode_int16_pcm(message)
            audio_ring.extend(incoming_chunk)
            samples_since_last_analysis += len(incoming_chunk)

            step_samples = int(sample_rate * ANALYSIS_STEP_MS / 1000)
            ring_not_full   = len(audio_ring) < RING_BUFFER_SAMPLES
            not_enough_new  = samples_since_last_analysis < step_samples
            if ring_not_full or not_enough_new:
                continue
            samples_since_last_analysis = 0

            window_samples = np.array(audio_ring)
            window_rms     = round(compute_rms(window_samples), 6)

            # ── Energy gate (disabled when energy_floor == 0) ─────────────
            below_energy_floor = config.energy_floor > 0 and window_rms < config.energy_floor
            if below_energy_floor:
                silent_result = {'voiced': False, 'f1': None, 'f2': None, 'rms': window_rms}
                await websocket.send(json.dumps({'frames': [silent_result]}))
                continue

            # ── Analyse and stream result ──────────────────────────────────
            try:
                result = analyze_window(window_samples, sample_rate, config, continuity_state)
                frame  = {'voiced': result['voiced'],
                          'f1':     result['f1'],
                          'f2':     result['f2'],
                          'rms':    window_rms,
                          't':      result['t_ms']}
                await websocket.send(json.dumps({'frames': [frame]}))
            except Exception as error:
                await websocket.send(json.dumps({'frames': [], 'error': str(error)}))

    except Exception:
        pass   # client disconnected


# ══════════════════════════════════════════════════════════════════════════════
# WebSocket server thread
# ══════════════════════════════════════════════════════════════════════════════

def _start_websocket_server() -> None:
    """Launch the websockets server on port 5051 in a background thread."""
    import websockets as _websockets

    async def _serve_forever():
        async with _websockets.serve(ws_handler, 'localhost', 5051):
            await asyncio.Future()   # run until cancelled

    asyncio.run(_serve_forever())


threading.Thread(target=_start_websocket_server, daemon=True).start()


# ══════════════════════════════════════════════════════════════════════════════
# Entry point
# ══════════════════════════════════════════════════════════════════════════════

if __name__ == '__main__':
    print('HTTP :5050   WS :5051')
    app.run(host='localhost', port=5050, threaded=True, debug=False)