#!/usr/bin/env python3
"""
scripts/seed_consonants.py — one-off seed: the validated 4-language
(en/de/ru/fr) consonant dataset from the add-consonant-chart mockup
(openspec/changes/add-consonant-chart/mockup.html) -> the new `consonants`
table (db/models.py's `Consonant`).

Mirrors scripts/migrate_legacy_to_db.py's shape (find-or-create Language rows,
one-time data load) but is NOT a destructive/refuse-if-nonempty migration —
it's safe to re-run: existing consonant rows for a seeded language are
replaced (delete-then-insert) rather than duplicated, since the dataset below
is itself the source of truth, not something derived from an existing DB.

Usage:
  docker compose up -d postgres
  DATABASE_URL=postgresql+psycopg2://phonexa:phonexa@localhost:5432/phonexa \
  python scripts/seed_consonants.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from db.models import Consonant, Language  # noqa: E402
from db.session import get_sessionmaker  # noqa: E402

# Default language metadata — only used to create a Language row that doesn't
# already exist (existing rows, e.g. en/de/ru from migrate_legacy_to_db.py,
# are left untouched).
LANGUAGE_DEFAULTS = {
    "en": {"label": "English (GA)", "color": "#93c5fd"},
    "de": {"label": "German", "color": "#fdba74"},
    "ru": {"label": "Russian", "color": "#fb7185"},
    "fr": {"label": "French", "color": "#a78bfa"},
}

# place/manner/active-articulator keys below use the mockup's own labels;
# normalized to Consonant's snake_case enum values by _norm().
PHONES = [
    # ── English ──────────────────────────────────────────────────────────
    {"l": "en", "ipa": "m", "manner": "Nasal", "place": "Labial", "voicing": "voiced"},
    {"l": "en", "ipa": "n", "manner": "Nasal", "place": "Alveolar", "voicing": "voiced"},
    {"l": "en", "ipa": "ŋ", "manner": "Nasal", "place": "Velar", "voicing": "voiced"},
    {"l": "en", "ipa": "n", "manner": "Nasal", "place": "Alveolar", "voicing": "voiced", "syllabic": True, "note": "e.g. button [ˈbʌʔn̩]"},
    {"l": "en", "ipa": "p", "manner": "Plosive", "place": "Labial", "voicing": "voiceless", "sec": ["aspirated"]},
    {"l": "en", "ipa": "b", "manner": "Plosive", "place": "Labial", "voicing": "voiced"},
    {"l": "en", "ipa": "t", "manner": "Plosive", "place": "Alveolar", "voicing": "voiceless", "sec": ["aspirated"]},
    {"l": "en", "ipa": "d", "manner": "Plosive", "place": "Alveolar", "voicing": "voiced"},
    {"l": "en", "ipa": "k", "manner": "Plosive", "place": "Velar", "voicing": "voiceless", "sec": ["aspirated"]},
    {"l": "en", "ipa": "ɡ", "manner": "Plosive", "place": "Velar", "voicing": "voiced"},
    {"l": "en", "ipa": "tʃ", "manner": "Affricate", "place": "Postalveolar", "voicing": "voiceless", "active": "Laminal"},
    {"l": "en", "ipa": "dʒ", "manner": "Affricate", "place": "Postalveolar", "voicing": "voiced", "active": "Laminal"},
    {"l": "en", "ipa": "f", "manner": "Fricative", "place": "Labial", "voicing": "voiceless"},
    {"l": "en", "ipa": "v", "manner": "Fricative", "place": "Labial", "voicing": "voiced"},
    {"l": "en", "ipa": "θ", "manner": "Fricative", "place": "Dental", "voicing": "voiceless"},
    {"l": "en", "ipa": "ð", "manner": "Fricative", "place": "Dental", "voicing": "voiced"},
    {"l": "en", "ipa": "s", "manner": "Fricative", "place": "Alveolar", "voicing": "voiceless", "active": "Laminal"},
    {"l": "en", "ipa": "z", "manner": "Fricative", "place": "Alveolar", "voicing": "voiced", "active": "Laminal"},
    {"l": "en", "ipa": "ʃ", "manner": "Fricative", "place": "Postalveolar", "voicing": "voiceless", "active": "Laminal"},
    {"l": "en", "ipa": "ʒ", "manner": "Fricative", "place": "Postalveolar", "voicing": "voiced", "active": "Laminal"},
    {"l": "en", "ipa": "h", "manner": "Fricative", "place": "Glottal", "voicing": "voiceless"},
    {"l": "en", "ipa": "ɹ", "manner": "Approximant", "place": "Postalveolar", "voicing": "voiced", "sec": ["labialized"], "note": "often slightly rounded/labialized in English"},
    {"l": "en", "ipa": "j", "manner": "Approximant", "place": "Palatal", "voicing": "voiced"},
    {"l": "en", "ipa": "w", "manner": "Approximant", "place": "Velar", "voicing": "voiced", "sec": ["labialized"], "coart": "Labial+Velar", "note": "co-articulated labial-velar — the ʷ here marks that labial component explicitly, it is not an added modifier on a plain velar"},
    {"l": "en", "ipa": "l", "manner": "Lateral Approximant", "place": "Alveolar", "voicing": "voiced", "active": "Apical", "note": "plain — contrast with Russian's two l-variants below"},
    {"l": "en", "ipa": "l", "manner": "Lateral Approximant", "place": "Alveolar", "voicing": "voiced", "active": "Apical", "syllabic": True, "note": "e.g. bottle [ˈbɒtl̩]"},
    # ── German ───────────────────────────────────────────────────────────
    {"l": "de", "ipa": "m", "manner": "Nasal", "place": "Labial", "voicing": "voiced"},
    {"l": "de", "ipa": "n", "manner": "Nasal", "place": "Alveolar", "voicing": "voiced"},
    {"l": "de", "ipa": "ŋ", "manner": "Nasal", "place": "Velar", "voicing": "voiced"},
    {"l": "de", "ipa": "p", "manner": "Plosive", "place": "Labial", "voicing": "voiceless"},
    {"l": "de", "ipa": "b", "manner": "Plosive", "place": "Labial", "voicing": "voiced"},
    {"l": "de", "ipa": "t", "manner": "Plosive", "place": "Alveolar", "voicing": "voiceless"},
    {"l": "de", "ipa": "d", "manner": "Plosive", "place": "Alveolar", "voicing": "voiced"},
    {"l": "de", "ipa": "k", "manner": "Plosive", "place": "Velar", "voicing": "voiceless"},
    {"l": "de", "ipa": "ɡ", "manner": "Plosive", "place": "Velar", "voicing": "voiced"},
    {"l": "de", "ipa": "ʔ", "manner": "Plosive", "place": "Glottal", "voicing": "voiceless", "note": "glottal stop, e.g. before vowel-initial words"},
    {"l": "de", "ipa": "pf", "manner": "Affricate", "place": "Labial", "voicing": "voiceless", "coart": "Labial+Alveolar", "note": "co-articulated, e.g. Pfeffer"},
    {"l": "de", "ipa": "ts", "manner": "Affricate", "place": "Alveolar", "voicing": "voiceless"},
    {"l": "de", "ipa": "tʃ", "manner": "Affricate", "place": "Postalveolar", "voicing": "voiceless"},
    {"l": "de", "ipa": "f", "manner": "Fricative", "place": "Labial", "voicing": "voiceless"},
    {"l": "de", "ipa": "v", "manner": "Fricative", "place": "Labial", "voicing": "voiced"},
    {"l": "de", "ipa": "s", "manner": "Fricative", "place": "Alveolar", "voicing": "voiceless"},
    {"l": "de", "ipa": "z", "manner": "Fricative", "place": "Alveolar", "voicing": "voiced"},
    {"l": "de", "ipa": "ʃ", "manner": "Fricative", "place": "Postalveolar", "voicing": "voiceless"},
    {"l": "de", "ipa": "ʒ", "manner": "Fricative", "place": "Postalveolar", "voicing": "voiced"},
    {"l": "de", "ipa": "ç", "manner": "Fricative", "place": "Palatal", "voicing": "voiceless", "note": "ich-Laut"},
    {"l": "de", "ipa": "x", "manner": "Fricative", "place": "Velar", "voicing": "voiceless", "note": "ach-Laut"},
    {"l": "de", "ipa": "ʁ", "manner": "Fricative", "place": "Uvular", "voicing": "voiced", "note": 'standard German "r"; often weakens to an approximant'},
    {"l": "de", "ipa": "h", "manner": "Fricative", "place": "Glottal", "voicing": "voiceless"},
    {"l": "de", "ipa": "j", "manner": "Approximant", "place": "Palatal", "voicing": "voiced"},
    {"l": "de", "ipa": "l", "manner": "Lateral Approximant", "place": "Alveolar", "voicing": "voiced", "active": "Apical"},
    # ── Russian ──────────────────────────────────────────────────────────
    {"l": "ru", "ipa": "m", "manner": "Nasal", "place": "Labial", "voicing": "voiced"},
    {"l": "ru", "ipa": "m", "manner": "Nasal", "place": "Labial", "voicing": "voiced", "sec": ["palatalized"]},
    {"l": "ru", "ipa": "n", "manner": "Nasal", "place": "Alveolar", "voicing": "voiced", "active": "Apical"},
    {"l": "ru", "ipa": "n", "manner": "Nasal", "place": "Alveolar", "voicing": "voiced", "active": "Apical", "sec": ["palatalized"]},
    {"l": "ru", "ipa": "p", "manner": "Plosive", "place": "Labial", "voicing": "voiceless"},
    {"l": "ru", "ipa": "p", "manner": "Plosive", "place": "Labial", "voicing": "voiceless", "sec": ["palatalized"]},
    {"l": "ru", "ipa": "b", "manner": "Plosive", "place": "Labial", "voicing": "voiced"},
    {"l": "ru", "ipa": "b", "manner": "Plosive", "place": "Labial", "voicing": "voiced", "sec": ["palatalized"]},
    {"l": "ru", "ipa": "t", "manner": "Plosive", "place": "Dental", "voicing": "voiceless", "active": "Apical"},
    {"l": "ru", "ipa": "t", "manner": "Plosive", "place": "Dental", "voicing": "voiceless", "active": "Apical", "sec": ["palatalized"]},
    {"l": "ru", "ipa": "d", "manner": "Plosive", "place": "Dental", "voicing": "voiced", "active": "Apical"},
    {"l": "ru", "ipa": "d", "manner": "Plosive", "place": "Dental", "voicing": "voiced", "active": "Apical", "sec": ["palatalized"]},
    {"l": "ru", "ipa": "k", "manner": "Plosive", "place": "Velar", "voicing": "voiceless"},
    {"l": "ru", "ipa": "ɡ", "manner": "Plosive", "place": "Velar", "voicing": "voiced"},
    {"l": "ru", "ipa": "ts", "manner": "Affricate", "place": "Alveolar", "voicing": "voiceless", "active": "Apical", "note": "ц"},
    {"l": "ru", "ipa": "tɕ", "manner": "Affricate", "place": "Alveolo-palatal", "voicing": "voiceless", "active": "Laminal", "note": "ч"},
    {"l": "ru", "ipa": "f", "manner": "Fricative", "place": "Labial", "voicing": "voiceless"},
    {"l": "ru", "ipa": "f", "manner": "Fricative", "place": "Labial", "voicing": "voiceless", "sec": ["palatalized"]},
    {"l": "ru", "ipa": "v", "manner": "Fricative", "place": "Labial", "voicing": "voiced"},
    {"l": "ru", "ipa": "v", "manner": "Fricative", "place": "Labial", "voicing": "voiced", "sec": ["palatalized"]},
    {"l": "ru", "ipa": "s", "manner": "Fricative", "place": "Alveolar", "voicing": "voiceless", "active": "Apical"},
    {"l": "ru", "ipa": "s", "manner": "Fricative", "place": "Alveolar", "voicing": "voiceless", "active": "Apical", "sec": ["palatalized"]},
    {"l": "ru", "ipa": "z", "manner": "Fricative", "place": "Alveolar", "voicing": "voiced", "active": "Apical"},
    {"l": "ru", "ipa": "z", "manner": "Fricative", "place": "Alveolar", "voicing": "voiced", "active": "Apical", "sec": ["palatalized"]},
    {"l": "ru", "ipa": "ʂ", "manner": "Fricative", "place": "Postalveolar", "voicing": "voiceless", "active": "Apical", "note": "ш — apical, retroflex-like (contrast English ʃ, laminal)"},
    {"l": "ru", "ipa": "ʐ", "manner": "Fricative", "place": "Postalveolar", "voicing": "voiced", "active": "Apical", "note": "ж — apical"},
    {"l": "ru", "ipa": "ɕː", "manner": "Fricative", "place": "Alveolo-palatal", "voicing": "voiceless", "active": "Laminal", "note": "щ — long"},
    {"l": "ru", "ipa": "x", "manner": "Fricative", "place": "Velar", "voicing": "voiceless"},
    {"l": "ru", "ipa": "x", "manner": "Fricative", "place": "Velar", "voicing": "voiceless", "sec": ["palatalized"]},
    {"l": "ru", "ipa": "r", "manner": "Trill", "place": "Alveolar", "voicing": "voiced", "active": "Apical"},
    {"l": "ru", "ipa": "r", "manner": "Trill", "place": "Alveolar", "voicing": "voiced", "active": "Apical", "sec": ["palatalized"]},
    {"l": "ru", "ipa": "j", "manner": "Approximant", "place": "Palatal", "voicing": "voiced"},
    {"l": "ru", "ipa": "l", "manner": "Lateral Approximant", "place": "Alveolar", "voicing": "voiced", "active": "Apical", "sec": ["palatalized"], "note": "soft л (ль) — e.g. голь"},
    {"l": "ru", "ipa": "l", "manner": "Lateral Approximant", "place": "Alveolar", "voicing": "voiced", "active": "Apical", "sec": ["velarized", "pharyngealized"], "note": "hard л (л) — e.g. гол. Same base phone as ль — only the secondary-articulation set differs."},
    # ── French ───────────────────────────────────────────────────────────
    {"l": "fr", "ipa": "m", "manner": "Nasal", "place": "Labial", "voicing": "voiced"},
    {"l": "fr", "ipa": "n", "manner": "Nasal", "place": "Alveolar", "voicing": "voiced"},
    {"l": "fr", "ipa": "ɲ", "manner": "Nasal", "place": "Palatal", "voicing": "voiced", "note": "agneau"},
    {"l": "fr", "ipa": "ŋ", "manner": "Nasal", "place": "Velar", "voicing": "voiced", "note": "loanwords, e.g. parking"},
    {"l": "fr", "ipa": "p", "manner": "Plosive", "place": "Labial", "voicing": "voiceless"},
    {"l": "fr", "ipa": "b", "manner": "Plosive", "place": "Labial", "voicing": "voiced"},
    {"l": "fr", "ipa": "t", "manner": "Plosive", "place": "Dental", "voicing": "voiceless", "active": "Laminal"},
    {"l": "fr", "ipa": "d", "manner": "Plosive", "place": "Dental", "voicing": "voiced", "active": "Laminal"},
    {"l": "fr", "ipa": "k", "manner": "Plosive", "place": "Velar", "voicing": "voiceless"},
    {"l": "fr", "ipa": "ɡ", "manner": "Plosive", "place": "Velar", "voicing": "voiced"},
    {"l": "fr", "ipa": "f", "manner": "Fricative", "place": "Labial", "voicing": "voiceless"},
    {"l": "fr", "ipa": "v", "manner": "Fricative", "place": "Labial", "voicing": "voiced"},
    {"l": "fr", "ipa": "s", "manner": "Fricative", "place": "Alveolar", "voicing": "voiceless", "active": "Laminal"},
    {"l": "fr", "ipa": "z", "manner": "Fricative", "place": "Alveolar", "voicing": "voiced", "active": "Laminal"},
    {"l": "fr", "ipa": "ʃ", "manner": "Fricative", "place": "Postalveolar", "voicing": "voiceless", "active": "Laminal"},
    {"l": "fr", "ipa": "ʒ", "manner": "Fricative", "place": "Postalveolar", "voicing": "voiced", "active": "Laminal"},
    {"l": "fr", "ipa": "ʁ", "manner": "Fricative", "place": "Uvular", "voicing": "voiced"},
    {"l": "fr", "ipa": "j", "manner": "Approximant", "place": "Palatal", "voicing": "voiced"},
    {"l": "fr", "ipa": "ɥ", "manner": "Approximant", "place": "Palatal", "voicing": "voiced", "sec": ["labialized"], "coart": "Labial+Palatal", "note": "huit — labial-palatal"},
    {"l": "fr", "ipa": "w", "manner": "Approximant", "place": "Velar", "voicing": "voiced", "sec": ["labialized"], "coart": "Labial+Velar"},
    {"l": "fr", "ipa": "l", "manner": "Lateral Approximant", "place": "Alveolar", "voicing": "voiced", "active": "Apical"},
]


def _norm(s: str) -> str:
    """'Alveolo-palatal' -> 'alveolo_palatal', 'Lateral Approximant' -> 'lateral_approximant'."""
    return s.lower().replace("-", "_").replace(" ", "_")


def _coarticulated_place(p: dict) -> str | None:
    coart = p.get("coart")
    if not coart:
        return None
    places = [_norm(x) for x in coart.split("+")]
    primary = _norm(p["place"])
    others = [pl for pl in places if pl != primary]
    return others[0] if others else None


def seed(db) -> None:
    languages: dict[str, Language] = {}
    for key in dict.fromkeys(p["l"] for p in PHONES):  # preserves first-seen order
        lang = db.query(Language).filter_by(key=key).one_or_none()
        if lang is None:
            defaults = LANGUAGE_DEFAULTS[key]
            max_order = db.query(Language).count()
            lang = Language(key=key, label=defaults["label"], color=defaults["color"], sort_order=max_order)
            db.add(lang)
            db.flush()
            print(f"Created language '{key}' ({defaults['label']})")
        languages[key] = lang

    seeded_language_ids = {lang.id for lang in languages.values()}
    deleted = db.query(Consonant).filter(Consonant.language_id.in_(seeded_language_ids)).delete(synchronize_session=False)
    if deleted:
        print(f"Replacing {deleted} existing consonant row(s) for seeded languages")

    counts: dict[str, int] = {}
    for sort_order, p in enumerate(PHONES):
        lang = languages[p["l"]]
        db.add(Consonant(
            language_id=lang.id,
            symbols=[p["ipa"]],
            manner=_norm(p["manner"]),
            passive_place=_norm(p["place"]),
            active_articulator=_norm(p["active"]) if p.get("active") else None,
            voicing=p["voicing"],
            secondary_articulation=p.get("sec") or [],
            syllabic=bool(p.get("syllabic")),
            coarticulated_place=_coarticulated_place(p),
            desc=p.get("note"),
            sort_order=sort_order,
        ))
        counts[p["l"]] = counts.get(p["l"], 0) + 1

    db.commit()
    print(f"Seeded {len(PHONES)} consonants: " + ", ".join(f"{k}={v}" for k, v in counts.items()))


if __name__ == "__main__":
    Session = get_sessionmaker()
    with Session() as db:
        seed(db)
