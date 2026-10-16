#!/usr/bin/env python3
"""
test/test_consonants_api.py — request-level checks for GET /api/v1/consonants.

Uses Flask's test client directly (no pytest — matches this repo's
script-style test convention, see test/server_tests.py) against a live DB, so
languages/consonants seeded by scripts/seed_consonants.py are visible.

Usage:
  docker compose up -d postgres
  DATABASE_URL=postgresql+psycopg2://phonexa:phonexa@localhost:5432/phonexa \
  python test/test_consonants_api.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from db.session import get_sessionmaker  # noqa: E402
from db.models import Language  # noqa: E402
from formanter import app  # noqa: E402

failures = 0


def check(label, condition):
    global failures
    status = "OK  " if condition else "FAIL"
    if not condition:
        failures += 1
    print(f"{status} {label}")


def main():
    client = app.test_client()

    # Unknown language -> empty result, not an error.
    resp = client.get('/api/v1/consonants?languageId=999999')
    check("unknown languageId returns 200", resp.status_code == 200)
    check("unknown languageId returns empty list", resp.get_json() == [])

    with get_sessionmaker()() as db:
        ru = db.query(Language).filter_by(key='ru').one_or_none()
    if ru is None:
        print("SKIP: 'ru' language not seeded — run scripts/seed_consonants.py first")
        sys.exit(1)

    resp = client.get(f'/api/v1/consonants?languageId={ru.id}')
    check("known language returns 200", resp.status_code == 200)
    body = resp.get_json()
    check("known language returns full inventory (34 Russian phones)", len(body) == 34)
    check(
        "payload includes secondary_articulation arrays",
        any(row.get('secondaryArticulation') for row in body),
    )
    hard_l = next((row for row in body if row['symbols'] == ['l'] and 'velarized' in row['secondaryArticulation']), None)
    check("Russian hard л row present with velarized+pharyngealized", hard_l is not None and 'pharyngealized' in hard_l['secondaryArticulation'])

    sys.exit(1 if failures else 0)


if __name__ == '__main__':
    main()
