#!/usr/bin/env python3
"""
scripts/export_db_to_json.py — DB -> db-export/*.json.

Human-readable, git-diff-able snapshot of the database: a backup/recovery
artifact, meant to be committed "from time to time" (manually — not a CI
job, see the plan doc). The companion import tool (a later phase) rebuilds
a database from exactly this shape.

Shape stays close to today's lang.json/samples.json, with one deliberate
change: `audio` is now `{"soundId": N}` instead of a bare path/URL string —
the actual location/analysis of that audio lives in sounds.json, addressed
by id. Derived per-token F1/F2/F0 values are NOT exported (a later phase
computes them from each sound's analysis track on read) — only time ranges
and (for not-yet-migrated tokens) the legacy analysis blob are.

Usage:
  DATABASE_URL=... python scripts/export_db_to_json.py [--out db-export]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from db.models import Language, Sound  # noqa: E402
from db.session import get_sessionmaker  # noqa: E402


def sound_ref(sound_id: int | None) -> dict | None:
    return {"soundId": sound_id} if sound_id is not None else None


def export_sound(s: Sound) -> dict:
    row = {
        "id": s.id,
        "storageKey": s.storage_key,
        "sourceUrl": s.source_url,
        "originalFilename": s.original_filename,
        "contentType": s.content_type,
        "durationMs": s.duration_ms,
        "sampleRateHz": s.sample_rate_hz,
        "channels": s.channels,
        "provenance": s.provenance,
        "trimmed": s.trimmed,
        "leadingSilenceMs": s.leading_silence_ms,
        "analysisVersion": s.analysis_version,
        "analysisConfig": s.analysis_config,
        "manualF1": s.manual_f1, "manualF2": s.manual_f2, "manualF0": s.manual_f0,
    }
    if s.analysis_frames is not None:
        row["formants"] = s.analysis_frames.formants
        row["pitch"] = s.analysis_frames.pitch
    return row


def export_vowel(v) -> dict:
    out = {
        "symbols": v.symbols, "heightBackness": [v.height, v.backness], "type": v.type,
        "rounded": v.rounded, "desc": v.desc, "f1": v.f1, "f2": v.f2,
        "audio": sound_ref(v.audio_sound_id), "wikiUrl": v.wiki_url, "target": None,
    }
    if v.target_height is not None or v.target_backness is not None:
        out["target"] = {
            "heightBackness": [v.target_height, v.target_backness],
            "rounded": v.target_rounded, "f1": v.target_f1, "f2": v.target_f2,
        }
    return out


def export_token(t) -> dict:
    return {
        "symbol": t.symbol, "position": [t.char_start, t.char_end],
        "timeStartMs": t.time_start_ms, "timeEndMs": t.time_end_ms,
        "legacyAnalysis": t.legacy_analysis,
    }


def export_sample(s) -> dict:
    return {
        "text": s.text, "phonemic": s.phonemic, "representative": s.representative_symbol,
        "audio": sound_ref(s.sound_id),
        "tokens": [export_token(t) for t in s.tokens],
    }


def export_all(out_dir: Path) -> None:
    Session = get_sessionmaker()
    with Session() as db:
        languages = db.query(Language).order_by(Language.sort_order).all()
        sounds = db.query(Sound).order_by(Sound.id).all()

        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "index.json").write_text(json.dumps(
            [{"key": l.key, "enabled": l.enabled, "sortOrder": l.sort_order} for l in languages],
            indent=2, ensure_ascii=False,
        ) + "\n")
        (out_dir / "sounds.json").write_text(json.dumps(
            [export_sound(s) for s in sounds], indent=2, ensure_ascii=False,
        ) + "\n")

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

        print(f"Exported {len(languages)} language(s) and {len(sounds)} sound(s) to {out_dir}/")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default="db-export", help="output directory (default: ./db-export)")
    args = parser.parse_args()
    export_all(Path(args.out).resolve())
