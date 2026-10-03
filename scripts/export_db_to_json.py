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
own `analyses` (the SampleAnalysis history), and each token its
`activeAnalysisId` — both ids are stable within one export, matching how a
future import tool would need to remap them per-sample. Token mean F1/F2 are
NOT exported (computed on read, a later phase) — only manual_f1/f2 are,
since those can't be derived from anything else.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from db.models import Language  # noqa: E402
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


def export_analysis(a) -> dict:
    return {
        "id": a.id, "version": a.version, "config": a.config,
        "formants": a.formants, "pitch": a.pitch,
    }


def export_token(t) -> dict:
    return {
        "symbol": t.symbol, "position": [t.char_start, t.char_end],
        "timeStartMs": t.time_start_ms, "timeEndMs": t.time_end_ms,
        "activeAnalysisId": t.active_analysis_id,
        "manualF1": t.manual_f1, "manualF2": t.manual_f2,
    }


def export_sample(s) -> dict:
    return {
        "id": s.id,
        "url": s.url,
        "originalFilename": s.original_filename, "contentType": s.content_type,
        "durationMs": s.duration_ms, "sampleRateHz": s.sample_rate_hz, "channels": s.channels,
        "text": s.text, "phonemic": s.phonemic,
        "analyses": [export_analysis(a) for a in s.analyses],
        "tokens": [export_token(t) for t in s.tokens],
    }


def export_all(out_dir: Path) -> None:
    Session = get_sessionmaker()
    with Session() as db:
        languages = db.query(Language).order_by(Language.sort_order).all()

        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "index.json").write_text(json.dumps(
            [{"key": l.key, "enabled": l.enabled, "sortOrder": l.sort_order} for l in languages],
            indent=2, ensure_ascii=False,
        ) + "\n")

        total_samples = 0
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

        print(f"Exported {len(languages)} language(s) and {total_samples} sample(s) to {out_dir}/")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default="db-export", help="output directory (default: ./db-export)")
    args = parser.parse_args()
    export_all(Path(args.out).resolve())
