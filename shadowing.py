"""
shadowing.py — Shadowing feature's server-side persistence: per-user media
identity (recognizing a re-uploaded file by its client-computed fingerprint,
NOT by storing audio), a chapter/sentence segment tree, manual split/merge
editing, and per-segment progress tracking. Split out from formanter.py
given its size; registered there as a Blueprint.

Audio is NEVER stored or decoded here. An earlier version of this file did
exactly that (streamed upload + server-side Praat decode for segmentation
and playback) and was reverted: a multi-hour upload meant a multi-GB decode
on upload, again on split, and again on every single chapter-audio request
since nothing was cached between requests — unbounded, repeated cost for a
long book. Segmentation (sentence AND chapter tier — see js/vad.js) now
runs entirely client-side, in the browser that already has the file open;
this module only ever receives and stores the resulting {kind, startMs,
endMs} boundaries, never samples. Recognizing "this is the same file you
uploaded before" is done via a `fingerprint` the client computes cheaply
(file size + a few small sampled byte ranges — see js/shadow.js's
computeFingerprint — never the whole file) and sends on open; this module
just looks it up.
"""

from __future__ import annotations

from flask import Blueprint, jsonify, request

from db.models import ShadowingMedia, ShadowingSegment, User
from db.session import get_sessionmaker

shadowing_bp = Blueprint('shadowing', __name__)


# ── JSON shapes ──────────────────────────────────────────────────────────

def _media_json(m: ShadowingMedia) -> dict:
    sentences = [s for s in m.segments if s.kind == 'sentence']
    return {
        'id': m.id, 'originalFilename': m.original_filename, 'fileSizeBytes': m.file_size_bytes,
        'durationMs': m.duration_ms, 'sampleRateHz': m.sample_rate_hz, 'channels': m.channels,
        'sentenceSilenceMs': m.sentence_silence_ms, 'chapterSilenceMs': m.chapter_silence_ms,
        'createdAt': m.created_at.isoformat() if m.created_at else None,
        'segmentCount': len(m.segments),
        'chapterCount': sum(1 for s in m.segments if s.kind == 'chapter'),
        'sentenceCount': len(sentences),
        'doneCount': sum(1 for s in sentences if s.done),
    }


def _segment_json(s: ShadowingSegment) -> dict:
    return {
        'id': s.id, 'kind': s.kind, 'parentId': s.parent_segment_id, 'orderIndex': s.order_index,
        'startMs': s.start_ms, 'endMs': s.end_ms, 'text': s.text, 'done': s.done,
    }


def _media_detail_json(m: ShadowingMedia) -> dict:
    result = _media_json(m)
    result['segments'] = [_segment_json(s) for s in m.segments]
    return result


# ── Media identity (fingerprint) / list / detail / delete ──────────────

@shadowing_bp.route('/api/v1/shadowing/media/find-or-create', methods=['POST'])
def find_or_create_shadowing_media():
    """Looks up (userId, fingerprint) — returns the existing row (with its
    segment tree, so a resumed file needs no re-split) if found, otherwise
    creates a new, empty one. Serves both "fresh file" and "resume" through
    identical client code; audio bytes never appear in this request."""
    data = request.get_json(silent=True) or {}
    user_id = data.get('userId')
    fingerprint = (data.get('fingerprint') or '').strip()
    if not user_id or not fingerprint:
        return jsonify({'error': 'userId and fingerprint are required'}), 400

    with get_sessionmaker()() as db:
        if db.get(User, user_id) is None:
            return jsonify({'error': 'no such user'}), 404
        media = db.query(ShadowingMedia).filter_by(user_id=user_id, fingerprint=fingerprint).first()
        if media is not None:
            return jsonify(_media_detail_json(media))

        media = ShadowingMedia(
            user_id=user_id, fingerprint=fingerprint,
            original_filename=data.get('originalFilename'), file_size_bytes=data.get('fileSizeBytes'),
            duration_ms=data.get('durationMs'), sample_rate_hz=data.get('sampleRateHz'), channels=data.get('channels'),
        )
        db.add(media)
        db.commit()
        db.refresh(media)
        return jsonify(_media_detail_json(media)), 201


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
        return jsonify(_media_detail_json(media))


@shadowing_bp.route('/api/v1/shadowing/media/<int:media_id>', methods=['DELETE'])
def delete_shadowing_media(media_id):
    with get_sessionmaker()() as db:
        media = db.get(ShadowingMedia, media_id)
        if media is None:
            return jsonify({'error': 'not found'}), 404
        db.delete(media)
        db.commit()
    return jsonify({'ok': True})


# ── Segmentation (client-computed — this just persists it) ─────────────

@shadowing_bp.route('/api/v1/shadowing/media/<int:media_id>/segment', methods=['POST'])
def segment_shadowing_media(media_id):
    """Replaces ALL existing segments for this media with a client-computed
    tree — destructive to any manual edits/progress, the client must
    confirm before calling this. Body: {sentenceSilenceMs, chapterSilenceMs,
    segments: [{localId, kind, parentLocalId, orderIndex, startMs, endMs}]}
    — `localId`/`parentLocalId` are the CLIENT's own temporary ids (chapters
    computed before their child sentences), resolved to real DB ids here,
    the same local-id pattern already used by
    scripts/export_db_to_json.py's export_shadowing_segment."""
    data = request.get_json(silent=True) or {}
    segments_in = data.get('segments') or []

    with get_sessionmaker()() as db:
        media = db.get(ShadowingMedia, media_id)
        if media is None:
            return jsonify({'error': 'not found'}), 404

        db.query(ShadowingSegment).filter_by(media_id=media_id).delete()
        media.sentence_silence_ms = data.get('sentenceSilenceMs')
        media.chapter_silence_ms = data.get('chapterSilenceMs')

        local_to_db_id = {}
        # Chapters (parentLocalId is null) before their child sentences, so
        # parent_segment_id always points at an already-inserted row.
        for sd in sorted(segments_in, key=lambda s: s.get('parentLocalId') is not None):
            row = ShadowingSegment(
                media_id=media_id, kind=sd.get('kind', 'sentence'),
                parent_segment_id=local_to_db_id.get(sd.get('parentLocalId')) if sd.get('parentLocalId') is not None else None,
                order_index=sd.get('orderIndex', 0), start_ms=sd.get('startMs', 0), end_ms=sd.get('endMs', 0),
            )
            db.add(row)
            db.flush()
            if sd.get('localId') is not None:
                local_to_db_id[sd['localId']] = row.id

        db.commit()
        media = db.get(ShadowingMedia, media_id)
        return jsonify(_media_detail_json(media))


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
