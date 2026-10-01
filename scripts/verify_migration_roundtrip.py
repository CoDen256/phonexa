#!/usr/bin/env python3
"""
scripts/verify_migration_roundtrip.py — validates the Phase 0 round-trip:
original lang/*.json  --(migrate_legacy_to_db.py)-->  DB
                      --(export_db_to_json.py)-->  db-export/*.json

The exported shape intentionally differs from the original (audio becomes
{soundId:N} instead of a bare path/URL, derived token values aren't
exported) — so this is a semantic equivalence check, not a byte diff.
Reuses discover_language_dirs/schema-conversion from the migration script
so both sides apply the exact same rules for what counts as real data.

Usage: python scripts/verify_migration_roundtrip.py [--lang-dir lang] [--export-dir db-export]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))      # for migrate_legacy_to_db
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # for db.*, imported transitively

from migrate_legacy_to_db import discover_language_dirs  # noqa: E402

errors: list[str] = []


def check(condition: bool, message: str) -> None:
    if not condition:
        errors.append(message)


def resolve_sound_ref(ref: dict | None, sounds_by_id: dict) -> dict | None:
    if ref is None:
        return None
    return sounds_by_id.get(ref["soundId"])


def audio_matches(original_audio, sound: dict | None, where: str) -> None:
    if not original_audio:
        check(sound is None, f"{where}: expected no audio, exported sound is {sound!r}")
        return
    check(sound is not None, f"{where}: original had audio {original_audio!r} but no sound was exported")
    if sound is None:
        return
    if sound.get("sourceUrl") is not None:
        check(sound["sourceUrl"] == original_audio, f"{where}: sourceUrl {sound['sourceUrl']!r} != original {original_audio!r}")
    else:
        check(sound.get("storageKey") == original_audio, f"{where}: storageKey {sound.get('storageKey')!r} != original {original_audio!r}")


def verify(lang_root: Path, export_dir: Path) -> None:
    original_dirs = discover_language_dirs(lang_root)  # [(key, enabled, lang_data)]
    original_by_key = {key: (enabled, data) for key, enabled, data in original_dirs}

    exported_index = json.loads((export_dir / "index.json").read_text())
    exported_sounds = json.loads((export_dir / "sounds.json").read_text())
    sounds_by_id = {s["id"]: s for s in exported_sounds}

    check(
        [e["key"] for e in exported_index] == list(original_by_key.keys()),
        f"language order/set mismatch: exported {[e['key'] for e in exported_index]!r} vs original {list(original_by_key.keys())!r}",
    )

    for entry in exported_index:
        key = entry["key"]
        if key not in original_by_key:
            errors.append(f"exported language {key!r} has no original counterpart")
            continue
        orig_enabled, orig_data = original_by_key[key]
        check(entry["enabled"] == orig_enabled, f"[{key}] enabled mismatch: {entry['enabled']} != {orig_enabled}")

        exp_lang = json.loads((export_dir / key / "lang.json").read_text())
        check(exp_lang["label"] == orig_data.get("label", key), f"[{key}] label mismatch")
        check(exp_lang["color"] == orig_data.get("color"), f"[{key}] color mismatch")

        orig_vowels = orig_data.get("vowels", [])
        exp_vowels = exp_lang["vowels"]
        check(len(exp_vowels) == len(orig_vowels), f"[{key}] vowel count mismatch: {len(exp_vowels)} != {len(orig_vowels)}")
        for i, (ov, ev) in enumerate(zip(orig_vowels, exp_vowels)):
            where = f"[{key}] vowel[{i}] ({ov.get('symbols')})"
            check(ev["symbols"] == ov.get("symbols"), f"{where}: symbols mismatch")
            check(ev["heightBackness"] == ov.get("heightBackness"), f"{where}: heightBackness mismatch")
            check(ev["type"] == ov.get("type", "short"), f"{where}: type mismatch")
            check(ev["rounded"] == bool(ov.get("rounded")), f"{where}: rounded mismatch")
            check(ev["f1"] == ov.get("f1") and ev["f2"] == ov.get("f2"), f"{where}: f1/f2 mismatch")
            audio_matches(ov.get("audio"), resolve_sound_ref(ev["audio"], sounds_by_id), where)
            orig_target = ov.get("target")
            if orig_target:
                check(ev["target"] is not None, f"{where}: target missing in export")
                if ev["target"]:
                    check(ev["target"]["heightBackness"] == orig_target["heightBackness"], f"{where}: target.heightBackness mismatch")
                    check(ev["target"]["f1"] == orig_target.get("f1") and ev["target"]["f2"] == orig_target.get("f2"), f"{where}: target f1/f2 mismatch")
            else:
                check(ev["target"] is None, f"{where}: unexpected target in export")

        samples_path = lang_root / key / "samples.json"
        exp_samples_path = export_dir / key / "samples.json"
        if not samples_path.exists():
            check(not exp_samples_path.exists(), f"[{key}] unexpected exported samples.json with no original")
            continue
        orig_samples = json.loads(samples_path.read_text())
        exp_samples = json.loads(exp_samples_path.read_text())
        check(len(exp_samples) == len(orig_samples), f"[{key}] sample count mismatch: {len(exp_samples)} != {len(orig_samples)}")
        for i, (os_, es) in enumerate(zip(orig_samples, exp_samples)):
            where = f"[{key}] sample[{i}] ({os_.get('text')!r})"
            check(es["text"] == os_.get("text"), f"{where}: text mismatch")
            check(es["phonemic"] == os_.get("phonemic"), f"{where}: phonemic mismatch")
            check(es["representative"] == os_.get("representative"), f"{where}: representative mismatch")
            audio_matches(os_.get("audio"), resolve_sound_ref(es["audio"], sounds_by_id), where)

            orig_tokens = os_.get("tokens") or []
            exp_tokens = es["tokens"]
            check(len(exp_tokens) == len(orig_tokens), f"{where}: token count mismatch")
            for j, (ot, et) in enumerate(zip(orig_tokens, exp_tokens)):
                twhere = f"{where} token[{j}] ({ot.get('symbol')!r})"
                check(et["symbol"] == ot.get("symbol"), f"{twhere}: symbol mismatch")
                check(et["position"] == list(ot.get("position", [0, 0])), f"{twhere}: position mismatch")
                check(et["legacyAnalysis"] == ot.get("analysis"), f"{twhere}: legacyAnalysis mismatch")
                orig_slice = (ot.get("analysis") or {}).get("slice")
                if orig_slice:
                    check(
                        [et["timeStartMs"], et["timeEndMs"]] == orig_slice,
                        f"{twhere}: time range {[et['timeStartMs'], et['timeEndMs']]} != original slice {orig_slice}",
                    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lang-dir", default="lang")
    parser.add_argument("--export-dir", default="db-export")
    args = parser.parse_args()

    verify(Path(args.lang_dir).resolve(), Path(args.export_dir).resolve())

    if errors:
        print(f"FAILED — {len(errors)} mismatch(es):")
        for e in errors[:50]:
            print(f"  - {e}")
        if len(errors) > 50:
            print(f"  ... and {len(errors) - 50} more")
        sys.exit(1)
    print("Round-trip verified: original lang/*.json content matches db-export/*.json exactly (modulo the intentional shape changes).")
