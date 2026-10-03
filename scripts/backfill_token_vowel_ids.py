#!/usr/bin/env python3
"""
scripts/backfill_token_vowel_ids.py — one-time: fill in Token.vowel_id for
every token migrated before that column existed (Phase 5 added it).

Matches the same way the editor used to (and Phase 0's migration already
does for `representative`): token.symbol must appear in exactly one Vowel's
`symbols` array, scoped to the token's own sample's language. Zero or
multiple matches are left NULL and reported — never guessed (see the
already-known `ru` "i" ambiguity: two different samples both claim it).
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from db.models import Language, Token, Vowel  # noqa: E402
from db.session import get_sessionmaker  # noqa: E402


def backfill() -> None:
    Session = get_sessionmaker()
    with Session() as db:
        languages = db.query(Language).all()
        updated = unmatched = ambiguous = 0

        for language in languages:
            symbol_to_vowels: dict[str, list[Vowel]] = {}
            for vowel in db.query(Vowel).filter_by(language_id=language.id).all():
                for sym in vowel.symbols or []:
                    symbol_to_vowels.setdefault(sym, []).append(vowel)

            tokens = (
                db.query(Token)
                .join(Token.sample)
                .filter(Token.vowel_id.is_(None))
                .filter_by(language_id=language.id)
                .all()
            )
            for token in tokens:
                candidates = symbol_to_vowels.get(token.symbol, [])
                if len(candidates) == 1:
                    token.vowel_id = candidates[0].id
                    updated += 1
                elif len(candidates) == 0:
                    unmatched += 1
                else:
                    ambiguous += 1
                    print(
                        f"  AMBIGUOUS [{language.key}] token {token.id} symbol {token.symbol!r} "
                        f"matches {len(candidates)} vowels ({[v.id for v in candidates]}) — left NULL"
                    )

        db.commit()
        print(f"Backfilled {updated} token(s); {unmatched} had no matching vowel; {ambiguous} were ambiguous.")


if __name__ == "__main__":
    backfill()
