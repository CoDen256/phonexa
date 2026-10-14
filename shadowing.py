"""
shadowing.py — Shadowing feature's server-side persistence: long-audio
upload/storage, two-tier (chapter + sentence) segmentation, manual
split/merge editing, and per-segment progress tracking. Split out from
formanter.py given its size; registered there as a Blueprint.

Segmentation is a direct Python port of js/vad.js's detectSentences —
ported server-side (rather than run client-side as Shadowing originally
did) specifically so a multi-hour upload never needs to be fully decoded in
a browser tab; the one-time decode cost is paid once here at upload/split
time instead. The chapter tier is the exact same algorithm run again with a
much larger min_silence_ms, sharing the sentence tier's own auto-derived
threshold (both tiers must agree on what counts as "silence" — only the
gap-merge width differs).

Note on the upload endpoint: the plan called for a "header-only" duration
probe, but there's no header-only path here without a new dependency
(soundfile/libsndfile isn't installed) — parselmouth always does a full
decode. Since this is a one-time ingest cost (paid once per uploaded file,
not per request), the upload endpoint just does one full decode, which also
directly feeds the chapter-silence suggestion sweep — no separate fast path
is worth the complexity. The raw upload bytes themselves ARE streamed
straight to disk (Werkzeug's FileStorage.save(), not .read()), so the
multipart body itself is never fully buffered in memory.
"""

from __future__ import annotations

import io
import os
import tempfile
import uuid
import wave

import numpy as np
import parselmouth
from flask import Blueprint, Response, jsonify, request

from db.models import ShadowingMedia, ShadowingSegment, User
from db.session import get_sessionmaker
from db.storage import get_audio_store

shadowing_bp = Blueprint('shadowing', __name__)

WINDOW_MS = 20
PAD_MS = 70


# ── VAD / segmentation (port of js/vad.js's detectSentences) ───────────────

def _mono_from_sound(snd: parselmouth.Sound) -> tuple[np.ndarray, int]:
    values = snd.values  # shape (channels, n_samples)
    mono = values.mean(axis=0) if values.shape[0] > 1 else values[0]
    return mono.astype(np.float64), int(snd.sampling_frequency)


def _compute_rms_windows(mono: np.ndarray, sample_rate: int, window_ms: int = WINDOW_MS) -> np.ndarray:
    win_size = max(1, round(sample_rate * window_ms / 1000))
    n_win = int(np.ceil(len(mono) / win_size)) if len(mono) else 0
    rms = np.zeros(n_win, dtype=np.float64)
    for w in range(n_win):
        start, end = w * win_size, min((w + 1) * win_size, len(mono))
        seg = mono[start:end]
        rms[w] = np.sqrt(np.mean(seg * seg)) if len(seg) else 0.0
    return rms


def _auto_threshold(rms: np.ndarray) -> float:
    if len(rms) == 0:
        return 0.0025
    sorted_rms = np.sort(rms)
    floor = sorted_rms[int(len(sorted_rms) * 0.15)]
    peak = sorted_rms[-1] or 0.0001
    return max(floor * 2.5, peak * 0.035, 0.0025)


def _detect_segments(
        mono: np.ndarray, sample_rate: int, min_silence_ms: int, min_segment_ms: int,
        pad_ms: int = PAD_MS, threshold: float | None = None, window_ms: int = WINDOW_MS,
) -> tuple[list[dict], float]:
    """Same window/threshold/merge/pad/min-duration logic as detectSentences
    — parameterized so one function serves both the sentence tier and the
    (much larger min_silence_ms) chapter tier."""
    rms = _compute_rms_windows(mono, sample_rate, window_ms)
    if threshold is None:
        threshold = _auto_threshold(rms)
    is_speech = (rms > threshold).astype(np.uint8)

    min_silence_win = max(1, round(min_silence_ms / window_ms))
    n_win = len(is_speech)
    i = 0
    while i < n_win:
        if not is_speech[i]:
            j = i
            while j < n_win and not is_speech[j]:
                j += 1
            if j - i < min_silence_win:
                is_speech[i:j] = 1
            i = j
        else:
            i += 1

    raw_segments = []
    i = 0
    while i < n_win:
        if is_speech[i]:
            j = i
            while j < n_win and is_speech[j]:
                j += 1
            raw_segments.append({'start': i * window_ms, 'end': j * window_ms})
            i = j
        else:
            i += 1

    dur_ms = len(mono) / sample_rate * 1000 if sample_rate else 0
    padded = [{'start': max(0, s['start'] - pad_ms), 'end': min(dur_ms, s['end'] + pad_ms)} for s in raw_segments]
    padded = [s for s in padded if s['end'] - s['start'] >= min_segment_ms]

    merged = []
    for s in padded:
        if merged and s['start'] <= merged[-1]['end']:
            merged[-1]['end'] = max(merged[-1]['end'], s['end'])
        else:
            merged.append(dict(s))

    segments = [{'start': round(s['start']), 'end': round(s['end'])} for s in merged]
    return segments, threshold


def _suggest_chapter_silence_ms(mono: np.ndarray, sample_rate: int, window_ms: int = WINDOW_MS) -> int:
    """~95th percentile of (pre-merge) silence-gap durations, so the chapter
    slider's pre-filled default only catches the longest ~5% of pauses."""
    rms = _compute_rms_windows(mono, sample_rate, window_ms)
    threshold = _auto_threshold(rms)
    is_speech = rms > threshold
    gaps = []
    i, n = 0, len(is_speech)
    while i < n:
        if not is_speech[i]:
            j = i
            while j < n and not is_speech[j]:
                j += 1
            gaps.append((j - i) * window_ms)
            i = j
        else:
            i += 1
    if not gaps:
        return 4000
    gaps.sort()
    idx = min(len(gaps) - 1, int(len(gaps) * 0.95))
    return int(max(1500, min(15000, gaps[idx])))


def _encode_wav_bytes(mono: np.ndarray, sample_rate: int) -> bytes:
    peak = float(np.max(np.abs(mono))) if len(mono) else 0.0
    scale = 32767.0 if peak <= 1.0 else 32767.0 / peak
    ints = np.clip(mono * scale, -32768, 32767).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(int(sample_rate))
        w.writeframes(ints.tobytes())
    return buf.getvalue()


def _extract_wav_range(storage_key: str, start_ms: int, end_ms: int) -> bytes:
    path = get_audio_store().get_path(storage_key)
    snd = parselmouth.Sound(path)
    mono, sample_rate = _mono_from_sound(snd)
    start_i = max(0, int(start_ms / 1000 * sample_rate))
    end_i = min(len(mono), int(end_ms / 1000 * sample_rate))
    return _encode_wav_bytes(mono[start_i:end_i], sample_rate)


# ── JSON shapes ──────────────────────────────────────────────────────────

def _media_json(m: ShadowingMedia) -> dict:
    return {
        'id': m.id, 'originalFilename': m.original_filename, 'fileSizeBytes': m.file_size_bytes,
        'durationMs': m.duration_ms, 'sampleRateHz': m.sample_rate_hz, 'channels': m.channels,
        'sentenceSilenceMs': m.sentence_silence_ms, 'chapterSilenceMs': m.chapter_silence_ms,
        'createdAt': m.created_at.isoformat() if m.created_at else None,
        'segmentCount': len(m.segments),
    }


def _segment_json(s: ShadowingSegment) -> dict:
    return {
        'id': s.id, 'kind': s.kind, 'parentId': s.parent_segment_id, 'orderIndex': s.order_index,
        'startMs': s.start_ms, 'endMs': s.end_ms, 'text': s.text, 'done': s.done,
    }


# ── Media upload / list / detail / delete ───────────────────────────────

@shadowing_bp.route('/api/v1/shadowing/media', methods=['POST'])
def upload_shadowing_media():
    user_id = request.form.get('userId', type=int)
    if user_id is None:
        return jsonify({'error': 'userId is required'}), 400
    f = request.files.get('file')
    if f is None or not f.filename:
        return jsonify({'error': 'file is required'}), 400

    with get_sessionmaker()() as db:
        if db.get(User, user_id) is None:
            return jsonify({'error': 'no such user'}), 404

    tmp_dir = tempfile.mkdtemp(prefix='shadowing-upload-')
    tmp_path = os.path.join(tmp_dir, 'upload')
    try:
        # Streamed to disk in chunks (FileStorage.save), not .read() into
        # memory — these are long-form originals, unlike the short
        # pre-trimmed clips /api/v1/samples (formanter.py) was built for.
        f.save(tmp_path)
        file_size = os.path.getsize(tmp_path)
        try:
            snd = parselmouth.Sound(tmp_path)
        except Exception as error:
            return jsonify({'error': f'could not decode audio: {error}'}), 400

        channels = snd.values.shape[0]
        mono, sample_rate = _mono_from_sound(snd)
        duration_ms = round(len(mono) / sample_rate * 1000) if sample_rate else 0
        suggested_chapter_ms = _suggest_chapter_silence_ms(mono, sample_rate)

        storage_key = f"shadowing/{uuid.uuid4().hex}.audio"
        get_audio_store().put_path(tmp_path, storage_key)
    finally:
        try:
            os.unlink(tmp_path)
        except FileNotFoundError:
            pass
        try:
            os.rmdir(tmp_dir)
        except OSError:
            pass

    with get_sessionmaker()() as db:
        media = ShadowingMedia(
            user_id=user_id, original_filename=f.filename, file_size_bytes=file_size,
            storage_key=storage_key, duration_ms=duration_ms, sample_rate_hz=int(sample_rate), channels=channels,
        )
        db.add(media)
        db.commit()
        db.refresh(media)
        result = _media_json(media)
    result['suggestedChapterSilenceMs'] = suggested_chapter_ms
    return jsonify(result), 201


@shadowing_bp.route('/api/v1/shadowing/media')
def list_shadowing_media():
    user_id = request.args.get('userId', type=int)
    if user_id is None:
        return jsonify({'error': 'userId query param is required'}), 400
    with get_sessionmaker()() as db:
        media = db.query(ShadowingMedia).filter_by(user_id=user_id).order_by(ShadowingMedia.created_at.desc()).all()
        return jsonify([_media_json(m) for m in media])


@shadowing_bp.route('/api/v1/shadowing/media/<int:media_id>')
def get_shadowing_media(media_id):
    with get_sessionmaker()() as db:
        media = db.get(ShadowingMedia, media_id)
        if media is None:
            return jsonify({'error': 'not found'}), 404
        result = _media_json(media)
        result['segments'] = [_segment_json(s) for s in media.segments]
        return jsonify(result)


@shadowing_bp.route('/api/v1/shadowing/media/<int:media_id>', methods=['DELETE'])
def delete_shadowing_media(media_id):
    with get_sessionmaker()() as db:
        media = db.get(ShadowingMedia, media_id)
        if media is None:
            return jsonify({'error': 'not found'}), 404
        storage_key = media.storage_key
        db.delete(media)
        db.commit()
    get_audio_store().delete(storage_key)
    return jsonify({'ok': True})


# ── Segmentation (sentence + chapter tiers) ─────────────────────────────

@shadowing_bp.route('/api/v1/shadowing/media/<int:media_id>/segment', methods=['POST'])
def segment_shadowing_media(media_id):
    """Replaces ALL existing segments for this media — destructive to any
    manual edits/progress, the client must confirm before calling this."""
    data = request.get_json(silent=True) or {}
    sentence_ms = int(data.get('sentenceSilenceMs', 300))
    chapter_ms = int(data.get('chapterSilenceMs', 4000))

    with get_sessionmaker()() as db:
        media = db.get(ShadowingMedia, media_id)
        if media is None:
            return jsonify({'error': 'not found'}), 404
        storage_key = media.storage_key

    path = get_audio_store().get_path(storage_key)
    snd = parselmouth.Sound(path)
    mono, sample_rate = _mono_from_sound(snd)

    chapters, threshold = _detect_segments(mono, sample_rate, min_silence_ms=chapter_ms, min_segment_ms=max(chapter_ms, 2000))
    sentences, _ = _detect_segments(mono, sample_rate, min_silence_ms=sentence_ms, min_segment_ms=350, threshold=threshold)

    with get_sessionmaker()() as db:
        media = db.get(ShadowingMedia, media_id)
        db.query(ShadowingSegment).filter_by(media_id=media_id).delete()
        media.sentence_silence_ms = sentence_ms
        media.chapter_silence_ms = chapter_ms

        chapter_rows = []
        for idx, ch in enumerate(chapters):
            row = ShadowingSegment(media_id=media_id, kind='chapter', parent_segment_id=None,
                                    order_index=idx, start_ms=ch['start'], end_ms=ch['end'])
            db.add(row)
            db.flush()
            chapter_rows.append(row)

        for idx, se in enumerate(sentences):
            mid = (se['start'] + se['end']) / 2
            parent = next((c for c in chapter_rows if c.start_ms <= mid <= c.end_ms), None)
            db.add(ShadowingSegment(media_id=media_id, kind='sentence',
                                     parent_segment_id=parent.id if parent else None,
                                     order_index=idx, start_ms=se['start'], end_ms=se['end']))
        db.commit()

        media = db.get(ShadowingMedia, media_id)
        result = _media_json(media)
        result['segments'] = [_segment_json(s) for s in media.segments]
        return jsonify(result)


# ── Per-segment progress + manual editing ───────────────────────────────

@shadowing_bp.route('/api/v1/shadowing/segments/<int:segment_id>', methods=['PATCH'])
def patch_shadowing_segment(segment_id):
    data = request.get_json(silent=True) or {}
    with get_sessionmaker()() as db:
        seg = db.get(ShadowingSegment, segment_id)
        if seg is None:
            return jsonify({'error': 'not found'}), 404
        if 'done' in data:
            seg.done = bool(data['done'])
        if 'text' in data:
            seg.text = data['text']
        db.commit()
        db.refresh(seg)
        return jsonify(_segment_json(seg))


@shadowing_bp.route('/api/v1/shadowing/segments/<int:segment_id>/split', methods=['POST'])
def split_shadowing_segment(segment_id):
    data = request.get_json(silent=True) or {}
    at_ms = data.get('atMs')
    if at_ms is None:
        return jsonify({'error': 'atMs is required'}), 400
    with get_sessionmaker()() as db:
        seg = db.get(ShadowingSegment, segment_id)
        if seg is None:
            return jsonify({'error': 'not found'}), 404
        if not (seg.start_ms < at_ms < seg.end_ms):
            return jsonify({'error': 'atMs must fall strictly inside the segment'}), 400
        siblings = db.query(ShadowingSegment).filter(
            ShadowingSegment.media_id == seg.media_id, ShadowingSegment.kind == seg.kind,
            ShadowingSegment.parent_segment_id == seg.parent_segment_id,
            ShadowingSegment.order_index > seg.order_index,
        ).all()
        for sib in siblings:
            sib.order_index += 1
        new_seg = ShadowingSegment(
            media_id=seg.media_id, kind=seg.kind, parent_segment_id=seg.parent_segment_id,
            order_index=seg.order_index + 1, start_ms=at_ms, end_ms=seg.end_ms, text=None, done=False,
        )
        seg.end_ms = at_ms
        db.add(new_seg)
        db.commit()
        db.refresh(seg)
        db.refresh(new_seg)
        return jsonify({'first': _segment_json(seg), 'second': _segment_json(new_seg)})


@shadowing_bp.route('/api/v1/shadowing/segments/merge', methods=['POST'])
def merge_shadowing_segments():
    data = request.get_json(silent=True) or {}
    id_a, id_b = data.get('segmentIdA'), data.get('segmentIdB')
    if not id_a or not id_b:
        return jsonify({'error': 'segmentIdA and segmentIdB are required'}), 400
    with get_sessionmaker()() as db:
        a, b = db.get(ShadowingSegment, id_a), db.get(ShadowingSegment, id_b)
        if a is None or b is None:
            return jsonify({'error': 'not found'}), 404
        if a.media_id != b.media_id or a.kind != b.kind or a.parent_segment_id != b.parent_segment_id:
            return jsonify({'error': 'segments must be the same kind and same parent within one media'}), 400
        first, second = (a, b) if a.start_ms <= b.start_ms else (b, a)
        if second.order_index != first.order_index + 1:
            return jsonify({'error': 'segments must be adjacent'}), 400

        first.end_ms = second.end_ms
        first.text = ' '.join(t for t in [first.text, second.text] if t) or None
        first.done = bool(first.done and second.done)
        # Re-parent any children of `second` (chapters have sentence children) before deleting it.
        db.query(ShadowingSegment).filter_by(parent_segment_id=second.id).update({'parent_segment_id': first.id})
        later = db.query(ShadowingSegment).filter(
            ShadowingSegment.media_id == first.media_id, ShadowingSegment.kind == first.kind,
            ShadowingSegment.parent_segment_id == first.parent_segment_id,
            ShadowingSegment.order_index > second.order_index,
        ).all()
        for sib in later:
            sib.order_index -= 1
        db.delete(second)
        db.commit()
        db.refresh(first)
        return jsonify(_segment_json(first))


# ── On-demand audio extraction ───────────────────────────────────────────

@shadowing_bp.route('/api/v1/shadowing/media/<int:media_id>/audio')
def get_shadowing_media_audio(media_id):
    start_ms = request.args.get('startMs', type=int, default=0) or 0
    with get_sessionmaker()() as db:
        media = db.get(ShadowingMedia, media_id)
        if media is None:
            return jsonify({'error': 'not found'}), 404
        storage_key = media.storage_key
        default_end = media.duration_ms or 0
    end_ms = request.args.get('endMs', type=int, default=default_end)
    return Response(_extract_wav_range(storage_key, start_ms, end_ms), mimetype='audio/wav')


@shadowing_bp.route('/api/v1/shadowing/segments/<int:segment_id>/audio')
def get_shadowing_segment_audio(segment_id):
    with get_sessionmaker()() as db:
        seg = db.get(ShadowingSegment, segment_id)
        if seg is None:
            return jsonify({'error': 'not found'}), 404
        storage_key = seg.media.storage_key
        start_ms, end_ms = seg.start_ms, seg.end_ms
    return Response(_extract_wav_range(storage_key, start_ms, end_ms), mimetype='audio/wav')
