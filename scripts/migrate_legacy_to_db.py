#!/usr/bin/env python3
"""
scripts/migrate_legacy_to_db.py — one-time migration: lang/*.json + lang/*/audio/*
                                    -> Postgres (db/models.py) + AUDIO_STORAGE_ROOT.

Phase 0 of the architecture redesign (see the plan doc): proves the DB can
faithfully hold everything the flat files hold before anything depends on it.
Meant to run once against a FRESH (empty) database — refuses to run against
one that already has data, since merging is not what this script is for (see
the plan's destructive-rebuild philosophy for the general import/export tool,
a later phase).

Sample now absorbs what used to be a separate Sound entity (see db/models.py
docstring) — a Vowel's own representative audio and a text Sample's audio are
both just Sample rows, found-or-created by `url`, with language_id/text
filled in as each is discovered. The old dual-ceiling pipeline's per-token
f1/f2 (buried in each legacy token's `analysis` blob) is copied into
Token.manual_f1/manual_f2 — not kept as a verbatim blob — since from the new
model's point of view a legacy-pipeline number behaves exactly like a manual
override: "a value from somewhere other than the current Praat-exact
analysis." The rest of that blob (ceilings, window length, etc. — all
specific to the retired pipeline) is simply not migrated.

Usage:
  docker compose up -d postgres
  DATABASE_URL=postgresql+psycopg2://phonexa:phonexa@localhost:5432/phonexa \
  AUDIO_STORAGE_ROOT=./data/audio \
  python scripts/migrate_legacy_to_db.py
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from db.models import Language, Sample, Token, Vowel  # noqa: E402
from db.session import get_sessionmaker  # noqa: E402
from db.storage import get_audio_store, url_from_storage_key  # noqa: E402


def is_external_url(audio) -> bool:
    return isinstance(audio, str) and audio.startswith(("http://", "https://"))


def is_placeholder_scaffold(data: dict) -> bool:
    """lang/template and lang/your-language are pure documentation scaffolding
    (copy-this-folder instructions), not real data — marked by a `_readme` key."""
    return "_readme" in data


def uses_old_vowel_schema(data: dict) -> bool:
    """A schema even older than language-format.md documents: ipa/h/b/ipaAudio/words
    instead of symbols/heightBackness/audio/target. Found in lang/me/lang.json (real,
    user-authored content, not a placeholder) — convert rather than skip."""
    vowels = data.get("vowels") or []
    return bool(vowels) and "ipa" in vowels[0] and "symbols" not in vowels[0]


def convert_old_vowel(v: dict) -> dict:
    if v.get("words"):
        print(f"    NOTE: old-schema vowel '{v.get('ipa')}' has non-empty 'words' — "
              f"that per-vowel word-example data has no current equivalent and is NOT migrated: {v['words']}")
    return {
        "symbols": [v["ipa"]] if v.get("ipa") else [],
        "heightBackness": [v.get("h", 0), v.get("b", 0)],
        "type": v.get("type", "short"),
        "rounded": v.get("rounded", False),
        "desc": v.get("desc"),
        "f1": v.get("f1"), "f2": v.get("f2"),
        "audio": v.get("ipaAudio"),
        "wikiUrl": v.get("wikiUrl"),
        "target": None,  # the old schema never represented diphthongs
    }


def discover_language_dirs(lang_root: Path) -> list[tuple[str, bool, dict]]:
    """Mirrors editor-storage.js's loadFromFolder: index.json order first
    (enabled), then any other subdir with a lang.json (disabled). Returns
    (key, enabled, lang_data) — lang_data already schema-converted if needed,
    so the caller never re-reads or re-converts the file."""
    index_path = lang_root / "index.json"
    enabled_keys = []
    if index_path.exists():
        enabled_keys = [k for k in json.loads(index_path.read_text()).get("languages", []) if k and not k.startswith("_")]

    ordered_keys, seen = [], set()
    for key in enabled_keys:
        if (lang_root / key / "lang.json").exists():
            ordered_keys.append(key)
            seen.add(key)
    for d in sorted(lang_root.iterdir()):
        if not d.is_dir() or d.name.startswith("_") or d.name in seen:
            continue
        if (d / "lang.json").exists():
            ordered_keys.append(d.name)
            seen.add(d.name)

    result = []
    for key in ordered_keys:
        data = json.loads((lang_root / key / "lang.json").read_text())
        if is_placeholder_scaffold(data):
            print(f"  skip {key}: lang.json is documentation scaffolding (has a _readme key), not real data")
            continue
        if uses_old_vowel_schema(data):
            print(f"  {key}: converting old vowel schema (ipa/h/b/ipaAudio) to the current one")
            data = {**data, "vowels": [convert_old_vowel(v) for v in data["vowels"]]}
        result.append((key, key in enabled_keys, data))
    return result


def find_or_create_sample_for_audio(
    db, store, audio, repo_root: Path, *, language_id: int | None, text: str | None,
) -> Sample | None:
    """audio: a path/URL string or None/empty, as found in today's JSON. Returns
    a Sample row (possibly reused from an earlier reference to the same audio —
    e.g. a vowel's representative clip that also turns out to be a full sample)."""
    if not audio:
        return None

    if is_external_url(audio):
        existing = db.query(Sample).filter_by(url=audio).one_or_none()
        if existing:
            return existing
        return Sample(url=audio, language_id=language_id, text=text)

    # A few entries in the real data have a spurious leading "/" (e.g.
    # "/lang/de/audio/schoen.ogg") despite meaning a path relative to the
    # repo root like every other entry — normalize before treating it as
    # either a filesystem path or a storage_key.
    storage_key = audio.lstrip("/")
    src_path = repo_root / storage_key
    if not src_path.exists():
        print(f"    WARNING: referenced audio file missing on disk, recording as a dangling reference: {audio}")
        return Sample(url=url_from_storage_key(storage_key), language_id=language_id, text=text)

    url = url_from_storage_key(storage_key)
    existing = db.query(Sample).filter_by(url=url).one_or_none()
    if existing:
        return existing
    store.put_path(str(src_path), storage_key)
    return Sample(url=url, original_filename=src_path.name, language_id=language_id, text=text)


def migrate(lang_root: Path) -> None:
    store = get_audio_store()
    repo_root = lang_root.parent
    Session = get_sessionmaker()

    with Session() as db:
        if db.query(Language).first() is not None:
            print(
                "Database is not empty — refusing to migrate on top of existing data. "
                "This script is for a one-time load into a fresh DB."
            )
            sys.exit(1)

        lang_dirs = discover_language_dirs(lang_root)
        print(f"Migrating {len(lang_dirs)} language(s): {[k for k, _, _ in lang_dirs]}")

        for sort_order, (key, enabled, lang_data) in enumerate(lang_dirs):
            d = lang_root / key
            print(f"[{key}] language (enabled={enabled})")

            language = Language(
                key=key, label=lang_data.get("label", key), color=lang_data.get("color", "#7eb8f7"),
                sort_order=sort_order, enabled=enabled,
            )
            db.add(language)
            db.flush()  # assign language.id

            symbol_to_vowels: dict[str, list[Vowel]] = {}

            for v_order, v in enumerate(lang_data.get("vowels", [])):
                hb = v.get("heightBackness") or [0, 0]
                target = v.get("target")
                rep_sample = find_or_create_sample_for_audio(
                    db, store, v.get("audio"), repo_root,
                    language_id=language.id, text=(v.get("symbols") or [None])[0],
                )
                if rep_sample is not None:
                    db.add(rep_sample)
                    db.flush()
                vowel = Vowel(
                    language_id=language.id, symbols=v.get("symbols") or [], height=hb[0], backness=hb[1],
                    type=v.get("type", "short"), rounded=bool(v.get("rounded")), desc=v.get("desc"),
                    f1=v.get("f1"), f2=v.get("f2"), wiki_url=v.get("wikiUrl"),
                    representative_sample_id=rep_sample.id if rep_sample else None,
                    target_height=target["heightBackness"][0] if target else None,
                    target_backness=target["heightBackness"][1] if target else None,
                    target_rounded=target.get("rounded") if target else None,
                    target_f1=target.get("f1") if target else None,
                    target_f2=target.get("f2") if target else None,
                    sort_order=v_order,
                )
                db.add(vowel)
                db.flush()
                for sym in (v.get("symbols") or []):
                    symbol_to_vowels.setdefault(sym, []).append(vowel)

            samples_path = d / "samples.json"
            if not samples_path.exists():
                continue
            samples = json.loads(samples_path.read_text())
            print(f"[{key}] {len(samples)} sample(s)")
            for s_order, s in enumerate(samples):
                sample = find_or_create_sample_for_audio(
                    db, store, s.get("audio"), repo_root,
                    language_id=language.id, text=s.get("text"),
                )
                if sample is None:
                    # e.g. "Oper"/"тупая" in the real data — text was authored but no audio was ever attached
                    sample = Sample(language_id=language.id, text=s.get("text"))
                else:
                    # may be a reused vowel-representative stub — the fuller sample record wins
                    sample.language_id = language.id
                    sample.text = s.get("text")
                sample.phonemic = s.get("phonemic")
                sample.sort_order = s_order
                db.add(sample)
                db.flush()  # assign sample.id

                rep_symbol = s.get("representative")
                if rep_symbol:
                    for vw in symbol_to_vowels.get(rep_symbol, []):
                        vw.representative_sample_id = sample.id

                for t_order, t in enumerate(s.get("tokens") or []):
                    pos = t.get("position") or [0, 0]
                    analysis = t.get("analysis") or {}
                    time_start = time_end = None
                    if analysis.get("slice"):
                        time_start, time_end = analysis["slice"]
                    db.add(Token(
                        sample_id=sample.id, symbol=t.get("symbol", ""),
                        char_start=pos[0], char_end=pos[1],
                        time_start_ms=time_start, time_end_ms=time_end,
                        manual_f1=analysis.get("f1"), manual_f2=analysis.get("f2"),
                        sort_order=t_order,
                    ))

        db.commit()
        print("Migration complete.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lang-dir", default="lang", help="path to the lang/ directory (default: ./lang)")
    args = parser.parse_args()
    migrate(Path(args.lang_dir).resolve())
