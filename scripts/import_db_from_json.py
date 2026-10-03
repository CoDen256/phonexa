#!/usr/bin/env python3
"""
scripts/import_db_from_json.py — db-export/*.json -> DB (destructive rebuild).

The JSON *is* the next state of the world: truncates every table this tool
owns (languages/samples/sample_analyses/vowels/tokens — cascades handle any
FK regardless of nullability) inside one transaction, then re-inserts
everything in dependency order, remapping ids as it goes since
RESTART IDENTITY means every row gets a fresh id. Any failure rolls back the
whole transaction — old state untouched.

Audio bytes are never touched here — a storageKey with no corresponding
file in AUDIO_STORAGE_ROOT just 404s on playback until provisioned
(non-fatal); this is a metadata-only operation, consistent with the audio
volume being backed up/restored separately from this JSON snapshot.

Upsert-based restore was rejected (see the original design doc): it has to
answer an irreducibly ambiguous question (is a DB row absent from the JSON
"deleted on purpose" or "not yet exported") that destructive rebuild
sidesteps by definition.

Usage:
  docker compose up -d postgres
  DATABASE_URL=postgresql+psycopg2://phonexa:phonexa@localhost:5432/phonexa \
  python scripts/import_db_from_json.py
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import text  # noqa: E402

from db.models import Language, Sample, SampleAnalysis, Token, Vowel  # noqa: E402
from db.session import get_sessionmaker  # noqa: E402


def import_sample(db, sd: dict, language_id: int | None, analyses_dir: Path) -> tuple[int, dict[int, int]]:
    """Inserts one sample + its analyses (metadata from samples.json, the
    heavy formants/pitch arrays joined back in from analyses/<id>.json);
    returns (new_sample_id, {old_analysis_id: new_analysis_id})."""
    sample = Sample(
        url=sd.get("url"), original_filename=sd.get("originalFilename"), content_type=sd.get("contentType"),
        duration_ms=sd.get("durationMs"), sample_rate_hz=sd.get("sampleRateHz"), channels=sd.get("channels"),
        text=sd.get("text"), phonemic=sd.get("phonemic"), language_id=language_id,
    )
    db.add(sample)
    db.flush()

    analysis_id_map: dict[int, int] = {}
    for ad in sd.get("analyses") or []:
        data_path = analyses_dir / f"{ad['id']}.json"
        data = json.loads(data_path.read_text()) if data_path.exists() else {}
        analysis = SampleAnalysis(
            sample_id=sample.id, version=ad.get("version"), config=ad.get("config"),
            formants=data.get("formants"), pitch=data.get("pitch"),
        )
        db.add(analysis)
        db.flush()
        if ad.get("id") is not None:
            analysis_id_map[ad["id"]] = analysis.id

    return sample.id, analysis_id_map


def import_all(export_dir: Path) -> dict:
    Session = get_sessionmaker()
    with Session() as db:
        db.execute(text("TRUNCATE languages, samples, sample_analyses, vowels, tokens RESTART IDENTITY CASCADE"))

        index = json.loads((export_dir / "index.json").read_text()) if (export_dir / "index.json").exists() else []
        sample_id_map: dict[int, int] = {}        # exported sample id -> new DB id
        analysis_id_map: dict[int, int] = {}       # exported analysis id -> new DB id
        vowel_id_map: dict[tuple[str, tuple], int] = {}  # (language_key, symbols tuple) -> new DB vowel id
        pending_tokens: list[tuple[dict, int, str]] = []  # (token_dict, new_sample_id, language_key)
        analyses_dir = export_dir / "analyses"

        total_samples = 0
        for entry in index:
            key = entry["key"]
            lang_dir = export_dir / key
            lang_data = json.loads((lang_dir / "lang.json").read_text())
            language = Language(
                key=key, label=lang_data.get("label", key), color=lang_data.get("color", "#7eb8f7"),
                sort_order=entry.get("sortOrder", 0), enabled=entry.get("enabled", True),
            )
            db.add(language)
            db.flush()

            samples_path = lang_dir / "samples.json"
            samples = json.loads(samples_path.read_text()) if samples_path.exists() else []
            for sd in samples:
                new_id, a_map = import_sample(db, sd, language.id, analyses_dir)
                if sd.get("id") is not None:
                    sample_id_map[sd["id"]] = new_id
                analysis_id_map.update(a_map)
                for td in sd.get("tokens") or []:
                    pending_tokens.append((td, new_id, key))
            total_samples += len(samples)

            # Vowels — needs samples to already exist for representativeSampleId.
            for v_order, vd in enumerate(lang_data.get("vowels") or []):
                target = vd.get("target")
                rep_old_id = vd.get("representativeSampleId")
                vowel = Vowel(
                    language_id=language.id, symbols=vd.get("symbols") or [],
                    height=(vd.get("heightBackness") or [0, 0])[0], backness=(vd.get("heightBackness") or [0, 0])[1],
                    type=vd.get("type", "short"), rounded=bool(vd.get("rounded")), desc=vd.get("desc"),
                    f1=vd.get("f1"), f2=vd.get("f2"), wiki_url=vd.get("wikiUrl"),
                    representative_sample_id=sample_id_map.get(rep_old_id) if rep_old_id is not None else None,
                    sort_order=v_order,
                )
                if target:
                    vowel.target_height, vowel.target_backness = target["heightBackness"][0], target["heightBackness"][1]
                    vowel.target_rounded = target.get("rounded")
                    vowel.target_f1, vowel.target_f2 = target.get("f1"), target.get("f2")
                db.add(vowel)
                db.flush()
                vowel_id_map[(key, tuple(vd.get("symbols") or []))] = vowel.id

        unassigned_path = export_dir / "unassigned-samples.json"
        if unassigned_path.exists():
            for sd in json.loads(unassigned_path.read_text()):
                new_id, a_map = import_sample(db, sd, None, analyses_dir)
                if sd.get("id") is not None:
                    sample_id_map[sd["id"]] = new_id
                analysis_id_map.update(a_map)
                for td in sd.get("tokens") or []:
                    pending_tokens.append((td, new_id, None))  # unassigned samples have no language -> no vowel possible
                total_samples += 1

        # Tokens last — need sample, vowel, and analysis ids all resolved.
        # vowel_id_map is keyed by (language_key, symbols) rather than the
        # exported DB id, since RESTART IDENTITY means old vowel ids are
        # meaningless here — see export_token's vowelSymbols field.
        total_tokens = 0
        for td, new_sample_id, lang_key in pending_tokens:
            vowel_symbols = td.get("vowelSymbols")
            db.add(Token(
                sample_id=new_sample_id, symbol=td.get("symbol", ""),
                vowel_id=vowel_id_map.get((lang_key, tuple(vowel_symbols))) if vowel_symbols and lang_key else None,
                char_start=(td.get("position") or [0, 0])[0], char_end=(td.get("position") or [0, 0])[1],
                time_start_ms=td.get("timeStartMs"), time_end_ms=td.get("timeEndMs"),
                active_analysis_id=analysis_id_map.get(td.get("activeAnalysisId")) if td.get("activeAnalysisId") is not None else None,
                manual_f1=td.get("manualF1"), manual_f2=td.get("manualF2"),
            ))
            total_tokens += 1

        db.commit()
        counts = {"languages": len(index), "samples": total_samples, "tokens": total_tokens}
        print(f"Imported {counts['languages']} language(s), {counts['samples']} sample(s), {counts['tokens']} token(s)")
        return counts


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--from", dest="from_dir", default="db-export", help="input directory (default: ./db-export)")
    args = parser.parse_args()
    import_all(Path(args.from_dir).resolve())
