#!/usr/bin/env python3
"""
scripts/export_db_to_json.py — DB -> db-export/*.json.

Human-readable, git-diff-able snapshot of the database: a backup/recovery
artifact, meant to be committed "from time to time" (manually — not a CI
job, see the plan doc). The companion import tool (a later phase) rebuilds
a database from exactly this shape.

Shape stays close to today's lang.json/samples.json, with the model change
agreed after reviewing the real migrated data: Sound is merged into Sample
(see db/models.py), so a sample's audio fields are inlined directly in
samples.json rather than looked up via a separate sounds.json — and each
exported sample carries its own stable "id" so lang.json's vowels can
reference one by `representativeSampleId` (replacing the old string-based
`representative` field on samples). Each exported sample also carries its
own `analyses` (the SampleAnalysis history — metadata only, see below),
and each token its `activeAnalysisId`/`vowelSymbols` — ids are stable
within one export, matching how scripts/import_db_from_json.py remaps them
per-sample. Token mean F1/F2 are NOT exported (computed on read) — only
manual_f1/f2 are, since those can't be derived from anything else.

Samples with no language assigned yet (ingested but not tagged — a real,
legitimate state) don't belong to any language directory, so they get their
own top-level `unassigned-samples.json` instead of silently being dropped.

An analysis's `formants`/`pitch` arrays are large (hundreds of frames x 5
formants+bandwidths each) and would bloat samples.json into something no
longer git-diff-friendly for no benefit (nobody hand-reads a formant
track). Split out: samples.json keeps only small analysis metadata
(id/version/config/createdAt); the actual arrays live one-per-file under
`analyses/<id>.json`, compact (no pretty-printing — this data is never
meant to be hand-read/diffed either way).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from db.models import Language, Sample, User  # noqa: E402
from db.session import get_sessionmaker  # noqa: E402


def export_vowel(v) -> dict:
    out = {
        "symbols": v.symbols, "heightBackness": [v.height, v.backness], "type": v.type,
        "rounded": v.rounded, "desc": v.desc, "f1": v.f1, "f2": v.f2,
        "wikiUrl": v.wiki_url, "representativeSampleId": v.representative_sample_id, "target": None,
    }
    if v.target_height is not None or v.target_backness is not None:
        out["target"] = {
            "heightBackness": [v.target_height, v.target_backness],
            "rounded": v.target_rounded, "f1": v.target_f1, "f2": v.target_f2,
        }
    return out


def export_analysis_meta(a) -> dict:
    return {
        "id": a.id, "version": a.version, "config": a.config,
        "createdAt": a.created_at.isoformat() if a.created_at else None,
    }


def write_analysis_data(analyses_dir: Path, a) -> None:
    (analyses_dir / f"{a.id}.json").write_text(json.dumps(
        {"formants": a.formants, "pitch": a.pitch}, separators=(",", ":"), ensure_ascii=False,
    ))


def export_token(t) -> dict:
    return {
        "symbol": t.symbol, "position": [t.char_start, t.char_end],
        # Vowels don't carry a stable exported id (see export_vowel) — a
        # restore re-resolves which vowel this is the same way the
        # /vowels/sync endpoint does, by (language, symbols), so that's what
        # gets exported here instead of the DB id, which RESTART IDENTITY
        # would invalidate on import anyway.
        "vowelSymbols": t.vowel.symbols if t.vowel else None,
        "timeStartMs": t.time_start_ms, "timeEndMs": t.time_end_ms,
        "activeAnalysisId": t.active_analysis_id,
        "manualF1": t.manual_f1, "manualF2": t.manual_f2,
        "createdAt": t.created_at.isoformat() if t.created_at else None,
    }


def export_sample(s) -> dict:
    return {
        "id": s.id,
        "url": s.url,
        "originalFilename": s.original_filename, "contentType": s.content_type,
        "durationMs": s.duration_ms, "sampleRateHz": s.sample_rate_hz, "channels": s.channels,
        "text": s.text, "phonemic": s.phonemic,
        "createdAt": s.created_at.isoformat() if s.created_at else None,
        "analyses": [export_analysis_meta(a) for a in s.analyses],
        "tokens": [export_token(t) for t in s.tokens],
    }


def export_shadowing_segment(seg, local_id_map: dict[int, int], next_id: list[int]) -> dict:
    """`id`/`parentId` here are per-export-file local sequence numbers (not
    the real DB id) — they only need to resolve parent_segment_id within the
    same media's segment list on import, never across media or tables."""
    local_id = next_id[0]
    next_id[0] += 1
    local_id_map[seg.id] = local_id
    return {
        "id": local_id, "kind": seg.kind,
        "parentId": local_id_map.get(seg.parent_segment_id) if seg.parent_segment_id is not None else None,
        "orderIndex": seg.order_index, "startMs": seg.start_ms, "endMs": seg.end_ms,
        "text": seg.text, "done": seg.done,
    }


def export_shadowing_media(m) -> dict:
    local_id_map: dict[int, int] = {}
    next_id = [1]
    # Parents (chapters) must be assigned a local id before any child
    # references them — `segments` is already ordered by order_index with
    # kind='chapter' rows first per ShadowingMedia.segments' relationship
    # order, but sort defensively by (parent is None desc, order_index) too.
    ordered = sorted(m.segments, key=lambda s: (s.parent_segment_id is not None, s.order_index))
    return {
        "originalFilename": m.original_filename, "fileSizeBytes": m.file_size_bytes,
        "fingerprint": m.fingerprint, "durationMs": m.duration_ms,
        "sampleRateHz": m.sample_rate_hz, "channels": m.channels,
        "sentenceSilenceMs": m.sentence_silence_ms, "chapterSilenceMs": m.chapter_silence_ms,
        "createdAt": m.created_at.isoformat() if m.created_at else None,
        "segments": [export_shadowing_segment(s, local_id_map, next_id) for s in ordered],
    }


def export_user(u, user_dir: Path) -> None:
    user_dir.mkdir(parents=True, exist_ok=True)
    settings = {s.key: s.value for s in u.settings}
    (user_dir / "settings.json").write_text(json.dumps(settings, indent=2, ensure_ascii=False) + "\n")
    if u.shadowing_media:
        (user_dir / "shadowing.json").write_text(json.dumps(
            [export_shadowing_media(m) for m in u.shadowing_media], indent=2, ensure_ascii=False,
        ) + "\n")
    else:
        (user_dir / "shadowing.json").unlink(missing_ok=True)


def export_all(out_dir: Path) -> dict:
    Session = get_sessionmaker()
    with Session() as db:
        languages = db.query(Language).order_by(Language.sort_order).all()

        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "index.json").write_text(json.dumps(
            [{"key": l.key, "enabled": l.enabled, "sortOrder": l.sort_order} for l in languages],
            indent=2, ensure_ascii=False,
        ) + "\n")
        analyses_dir = out_dir / "analyses"
        analyses_dir.mkdir(parents=True, exist_ok=True)

        total_samples = 0
        total_analyses = 0
        for language in languages:
            lang_dir = out_dir / language.key
            lang_dir.mkdir(parents=True, exist_ok=True)
            (lang_dir / "lang.json").write_text(json.dumps({
                "key": language.key, "label": language.label, "color": language.color,
                "vowels": [export_vowel(v) for v in language.vowels],
            }, indent=2, ensure_ascii=False) + "\n")
            if language.samples:
                (lang_dir / "samples.json").write_text(json.dumps(
                    [export_sample(s) for s in language.samples], indent=2, ensure_ascii=False,
                ) + "\n")
                total_samples += len(language.samples)
                for s in language.samples:
                    for a in s.analyses:
                        write_analysis_data(analyses_dir, a)
                        total_analyses += 1
            else:
                # Keep the export idempotent/clean: don't leave a stale samples.json
                # around from a previous export if this language no longer has any.
                (lang_dir / "samples.json").unlink(missing_ok=True)

        # Samples with no language assigned yet — don't belong to any language
        # directory, but are real rows that must not silently vanish from the backup.
        unassigned = db.query(Sample).filter(Sample.language_id.is_(None)).order_by(Sample.id).all()
        unassigned_path = out_dir / "unassigned-samples.json"
        if unassigned:
            unassigned_path.write_text(json.dumps(
                [export_sample(s) for s in unassigned], indent=2, ensure_ascii=False,
            ) + "\n")
            for s in unassigned:
                for a in s.analyses:
                    write_analysis_data(analyses_dir, a)
                    total_analyses += 1
        else:
            unassigned_path.unlink(missing_ok=True)

        users = db.query(User).order_by(User.id).all()
        users_dir = out_dir / "users"
        users_dir.mkdir(parents=True, exist_ok=True)
        (users_dir / "index.json").write_text(json.dumps(
            [{"name": u.name} for u in users], indent=2, ensure_ascii=False,
        ) + "\n")
        for u in users:
            export_user(u, users_dir / u.name)

        counts = {
            "languages": len(languages), "samples": total_samples, "unassignedSamples": len(unassigned),
            "analyses": total_analyses, "users": len(users),
        }
        print(f"Exported {counts['languages']} language(s), {counts['samples']} sample(s), "
              f"{counts['unassignedSamples']} unassigned sample(s), {counts['analyses']} analysis/analyses, "
              f"{counts['users']} user(s) to {out_dir}/")
        return counts


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default="db-export", help="output directory (default: ./db-export)")
    args = parser.parse_args()
    export_all(Path(args.out).resolve())
