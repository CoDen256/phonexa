#!/usr/bin/env python3
"""
scripts/verify_migration_roundtrip.py — validates the Phase 0 round-trip:
original lang/*.json  --(migrate_legacy_to_db.py)-->  DB
                      --(export_db_to_json.py)-->  db-export/*.json

The exported shape deliberately differs from the original in ways beyond a
simple rename, now that Sound is merged into Sample (see db/models.py):
  - every vowel with its own `audio` gets a newly-created representative
    sample that has NO counterpart in the original samples.json at all
  - two original sample entries that happened to share the same audio
    (found in real data: "Mieter" in lang/de, split across two JSON entries
    purely to attach two different tokens) collapse into ONE exported
    sample carrying both tokens — fewer rows, not a 1:1 count match
So this walks each ORIGINAL entity and confirms it is faithfully
represented somewhere in the export, rather than zipping two same-length
lists — len(original) and len(exported) are expected to differ and are
reported, not asserted equal.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))      # for migrate_legacy_to_db
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # for db.*, imported transitively

from migrate_legacy_to_db import discover_language_dirs  # noqa: E402
from db.storage import url_from_storage_key  # noqa: E402

errors: list[str] = []
notes: list[str] = []


def check(condition: bool, message: str) -> None:
    if not condition:
        errors.append(message)


def expected_url(original_audio: str) -> str:
    if original_audio.startswith(("http://", "https://")):
        return original_audio
    return url_from_storage_key(original_audio.lstrip("/"))  # mirrors migrate_legacy_to_db's normalization


def audio_matches(original_audio, exp_sample: dict | None, where: str) -> None:
    if not original_audio:
        return  # nothing to check — a sample with no audio in the original is fine either way
    check(exp_sample is not None, f"{where}: original had audio {original_audio!r} but no exported sample was found")
    if exp_sample is None:
        return
    want = expected_url(original_audio)
    check(exp_sample.get("url") == want, f"{where}: url {exp_sample.get('url')!r} != expected {want!r}")


def verify(lang_root: Path, export_dir: Path) -> None:
    original_dirs = discover_language_dirs(lang_root)  # [(key, enabled, lang_data)]
    original_by_key = {key: (enabled, data) for key, enabled, data in original_dirs}

    exported_index = json.loads((export_dir / "index.json").read_text())
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

        samples_path = export_dir / key / "samples.json"
        exp_samples = json.loads(samples_path.read_text()) if samples_path.exists() else []
        exp_sample_by_id = {s["id"]: s for s in exp_samples}
        by_audio_key: dict[str, list[dict]] = {}
        by_text: dict[str | None, list[dict]] = {}
        for es in exp_samples:
            if es.get("url"):
                by_audio_key.setdefault(es["url"], []).append(es)
            by_text.setdefault(es.get("text"), []).append(es)

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
            if ov.get("audio"):
                rep = exp_sample_by_id.get(ev["representativeSampleId"])
                check(rep is not None, f"{where}: had audio {ov['audio']!r} but no representativeSampleId resolved")
                if rep:
                    audio_matches(ov["audio"], rep, where)
            orig_target = ov.get("target")
            if orig_target:
                check(ev["target"] is not None, f"{where}: target missing in export")
                if ev["target"]:
                    check(ev["target"]["heightBackness"] == orig_target["heightBackness"], f"{where}: target.heightBackness mismatch")
                    check(ev["target"]["f1"] == orig_target.get("f1") and ev["target"]["f2"] == orig_target.get("f2"), f"{where}: target f1/f2 mismatch")
            else:
                check(ev["target"] is None, f"{where}: unexpected target in export")

        samples_json_path = lang_root / key / "samples.json"
        if not samples_json_path.exists():
            # No samples.json — every exported sample here must be a vowel-representative stub,
            # i.e. referenced by exactly the vowels whose own `audio` field created it.
            rep_ids = {ev["representativeSampleId"] for ev in exp_vowels if ev["representativeSampleId"]}
            for es in exp_samples:
                check(es["id"] in rep_ids, f"[{key}] exported sample {es['id']} ({es.get('text')!r}) has no samples.json but isn't any vowel's representative either")
            continue
        orig_samples = json.loads(samples_json_path.read_text())
        notes.append(f"[{key}] {len(orig_samples)} original sample entries -> {len(exp_samples)} exported samples "
                     f"(expected to differ: dedup of shared-audio entries, plus new vowel-representative samples)")

        # The original data can itself be ambiguous (two different samples both declaring
        # `representative` for the same symbol — observed in real data, e.g. ru's "i" symbol
        # claimed by both the bare vowel sample and the word "мир"). There's no "correct" winner
        # in that case, so collect every valid candidate per symbol rather than asserting one.
        rep_candidates: dict[str, set[int]] = {}
        for os_ in orig_samples:
            rep_symbol = os_.get("representative")
            if not rep_symbol:
                continue
            audio = os_.get("audio")
            candidates = by_audio_key.get(expected_url(audio), []) if audio else by_text.get(os_.get("text"), [])
            if candidates:
                rep_candidates.setdefault(rep_symbol, set()).add(candidates[0]["id"])

        for i, os_ in enumerate(orig_samples):
            where = f"[{key}] original sample[{i}] ({os_.get('text')!r})"
            audio = os_.get("audio")
            candidates = by_audio_key.get(expected_url(audio), []) if audio else by_text.get(os_.get("text"), [])
            check(bool(candidates), f"{where}: no exported sample found (audio={audio!r})")
            if not candidates:
                continue
            es = candidates[0]
            check(es["text"] == os_.get("text"), f"{where}: text mismatch in matched export")
            check(es["phonemic"] == os_.get("phonemic"), f"{where}: phonemic mismatch in matched export")
            audio_matches(audio, es, where)

            exp_tokens_by_key = {(t["symbol"], tuple(t["position"])): t for t in es["tokens"]}
            for j, ot in enumerate(os_.get("tokens") or []):
                twhere = f"{where} token[{j}] ({ot.get('symbol')!r})"
                tk = (ot.get("symbol"), tuple(ot.get("position", [0, 0])))
                et = exp_tokens_by_key.get(tk)
                check(et is not None, f"{twhere}: not found in matched exported sample's token list")
                if et is None:
                    continue
                orig_analysis = ot.get("analysis") or {}
                check(et["manualF1"] == orig_analysis.get("f1"), f"{twhere}: manualF1 mismatch")
                check(et["manualF2"] == orig_analysis.get("f2"), f"{twhere}: manualF2 mismatch")
                orig_slice = orig_analysis.get("slice")
                if orig_slice:
                    check(
                        [et["timeStartMs"], et["timeEndMs"]] == orig_slice,
                        f"{twhere}: time range {[et['timeStartMs'], et['timeEndMs']]} != original slice {orig_slice}",
                    )

            rep_symbol = os_.get("representative")
            if rep_symbol:
                matching = [ev for ev in exp_vowels if rep_symbol in ev["symbols"]]
                check(bool(matching), f"{where}: representative symbol {rep_symbol!r} matches no exported vowel")
                valid_ids = rep_candidates.get(rep_symbol, set())
                for ev in matching:
                    check(
                        ev["representativeSampleId"] in valid_ids,
                        f"{where}: vowel {ev['symbols']} representativeSampleId {ev['representativeSampleId']} "
                        f"not among the original data's own candidates {valid_ids} for symbol {rep_symbol!r}",
                    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lang-dir", default="lang")
    parser.add_argument("--export-dir", default="db-export")
    args = parser.parse_args()

    verify(Path(args.lang_dir).resolve(), Path(args.export_dir).resolve())

    for n in notes:
        print(n)
    if errors:
        print(f"FAILED — {len(errors)} mismatch(es):")
        for e in errors[:50]:
            print(f"  - {e}")
        if len(errors) > 50:
            print(f"  ... and {len(errors) - 50} more")
        sys.exit(1)
    print("Round-trip verified: every original entity is faithfully represented in db-export/*.json.")
