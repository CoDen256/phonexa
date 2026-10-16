## Context

`Vowel` (`db/models.py`) models a vowel as a point in continuous articulatory space (`height`, `backness`) plus a continuous acoustic target (`f1`, `f2`). Consonants have neither — manner/place/voicing/secondary-articulation are categorical, not positions on a trapezoid, and there's no single steady-state acoustic cue analogous to F1/F2 (plosives are a VOT transient, fricatives are spectral shape, etc.). Reusing `Vowel`'s columns for consonants would mean a table full of always-null fields; a new entity is the honest model.

A UI/feature-taxonomy mockup was already built and iterated with the user during design exploration (see the conversation's artifact). This design doc formalizes that mockup's decisions into a schema and component plan; it is not re-litigating the UX, which is considered settled for v1.

## Goals / Non-Goals

**Goals:**
- A `Consonant` schema that cleanly represents real cross-linguistic contrasts the user specifically called out: Russian's л having two variants (palatalized vs. velarized+pharyngealized) from one base phone, English/Russian apical-vs-laminal sibilant contrasts, co-articulated phones like /w/.
- A browsing UI (grid + per-language strip) that reuses existing app conventions (per-language color coding, Set-based filters, card-detail pattern) rather than inventing new ones.
- A symbol-rendering approach where every diacritic mark is computed from feature data, with zero hand-authored exceptions — this was a real bug class found during mockup iteration (labialized `/w/` not showing its mark; some Russian consonants double-encoding palatalization in both the symbol string and the feature field) and the schema/rendering code must structurally prevent it recurring.

**Non-Goals:**
- Any acoustic analysis, recording, or scoring of consonants.
- A consonant editor UI (`editor.html`-equivalent) — out of scope for this change; data entry is a seed script.
- Changing the `Vowel` chart, schema, or practice panel in any way.
- Modeling every IPA consonant exhaustively (clicks, ejectives, implosives) — the schema must *support* them (enums are supersets of what's seeded), but seed data covers only the four launch languages.

## Decisions

### 1. Separate `Consonant` table, not a `Vowel` extension or a shared `Phone` supertype
Considered: a unified `Phone` table with a `kind` discriminator (`vowel`/`consonant`) and nullable columns for whichever fields don't apply to a given kind.
Rejected because: it's exactly the anti-pattern `db/models.py`'s own docstring warns against — the Sample/Sound merge in this codebase's history was justified by the two concepts turning out to be *the same thing* on real data (~1:1, nullable fields naturally filled in over time). Vowel and Consonant are not that; they are structurally different (continuous position+target vs. categorical feature bundle), so a shared table would just be a wide table with two permanently-disjoint sets of always-null columns — worse than two focused tables. Keep them separate, matching `Token.vowel_id` style FK patterns if a future change ever needs tokens to reference consonants.

### 2. Feature taxonomy: passive place / active articulator / secondary articulation / voicing / syllabicity / co-articulation, as six independent columns
Considered: one flat `place` enum covering all 18 terms the user originally listed (Exo-labial, Endo-labial, Dental, Alveolar, ..., Apical, Laminal, Sub-apical, ...).
Rejected because: those 18 terms are not one dimension — 12 are *passive place* (a location) and 6 are *active articulator* (what moves). A flat enum would force a false single-choice between e.g. "Alveolar" and "Apical" for a sound that is both (apical alveolar). Splitting into two columns removes the ambiguity entirely and lets `active_articulator` stay `NULL` for the common case where it's redundant with manner+place (e.g. a plain bilabial nasal doesn't need an active-articulator value — it's definitionally labial).

`secondary_articulation` is modeled as a Postgres array/JSONB column (like `Vowel.symbols`), not a set of boolean columns, because it is open multi-valued (0, 1, or 2+ simultaneously — Russian hard л needs `{velarized, pharyngealized}` together) and a boolean-per-feature schema would need a new migration every time a new secondary articulation type is needed (e.g. nasalized, breathy-voiced later).

### 3. Symbol rendering is 100% derived, never stored
The composed IPA glyph (base letter + underscript for active articulator + tilde overlay for velarized/pharyngealized + syllabic mark + ordered superscripts) is computed by a single pure function from the feature columns, both client-side (for display) and nowhere persisted as a pre-rendered string. `Consonant.symbols` stores only the bare base letter(s) (e.g. `l`, not `l̴ˠˤ`). This mirrors `Vowel`'s own "`type` is explicit, not inferred" philosophy in the opposite direction: here the *rendering* is derived, not stored, specifically because the mockup's bugs (inconsistent/missing diacritics) were caused by baking marks into stored strings in some places and not others. One function, one source of truth, matches the already-proven mockup implementation (`buildSymbol(p)`).

### 4. Co-articulation stored as a single nullable `coarticulated_place` column, not a second place column
Considered: `place` as an array to support dual-place phones uniformly.
Rejected for v1: true double articulation (two simultaneous primary constrictions, e.g. /w/, /pf/, /ɥ/) is rare relative to single-place phones, and making `passive_place` always-array would complicate every grid-placement query for the common case. A nullable `coarticulated_place` (same enum as `passive_place`) covers the launch dataset's three co-articulated phones and keeps the common path simple. The phone is placed in the grid at its `passive_place` column (chosen as the primary/dorsal articulation by convention); `coarticulated_place` surfaces only in the inspector panel.

### 5. Filters are highlight/dim, not hide, reusing but not identical to `passesFilters`
The vowel chart's filters *hide* non-matching vowels (`passesFilters` gates rendering entirely). The consonant chart's filters (language, secondary articulation, active articulator, voicing, syllabicity) *dim* non-matching pills instead, keeping the full grid visible with matches highlighted. Chosen because the explicit goal (confirmed with the user) is cross-language comparison ("see the difference... by these features"), which requires seeing both the highlighted and the un-highlighted context at once — a hard filter would hide exactly the comparison baseline. Risk: with more than ~4 languages loaded, a crowded cell could stay visually noisy even with dimming (flagged in Risks below).

### 6. Two views (grid + strip) ship together, not grid-first-strip-later
The mockup iteration showed each view answers a different question the other can't (grid: cross-language "who has this feature", strip: single-language "what does this inventory look like") and are cheap to implement together since both read the same `Consonant` data and reuse the same pill/card feature-breakdown rendering. Shipping only one would leave a known gap on day one.

## Risks / Trade-offs

- **[Risk] Dense grid cells once more languages are added** (e.g. a 5-language Alveolar/Fricative cell could hold 8+ pills) → **Mitigation**: v1 ships with 4 languages where this is manageable; if a future language addition makes a cell unreadable, revisit hide-filtering or a cell-expansion interaction then, not preemptively.
- **[Risk] Taxonomy gaps for consonant types not in the 4-language seed** (clicks, ejectives, implosives, retroflex/radical articulations) → **Mitigation**: enums for `manner`, `passive_place`, `active_articulator` are supersets including these values even though unseeded, so adding a 5th language with e.g. Zulu clicks doesn't require a schema migration, only new rows.
- **[Risk] `coarticulated_place` being a single column undersells true triple-articulation edge cases** (vanishingly rare in practice) → **Mitigation**: accepted scope limit, documented as a non-goal; would need a schema change if ever needed.
- **[Trade-off] No editor UI means data entry is script-only** → accepted per proposal's explicit non-goals; matches the precedent already set by the original `lang/*.json` migration workflow.

## Migration Plan

1. Alembic migration: create `consonants` table (see spec for exact columns/enums).
2. Seed script `scripts/seed_consonants.py`: inserts the English/German/Russian/French dataset validated in the mockup (~70 phones), reusing existing `Language` rows (`en`/`de`/`ru`/`fr`) — create any missing `Language` rows as part of the seed if not already present.
3. New read-only route(s) under `/api/v1/consonants`.
4. New frontend page `consonants.html`, linked from the existing chart/editor header nav alongside the vowel chart link.
5. Rollback: drop the `consonants` table and route; no existing table/route is touched, so rollback has zero blast radius on vowels/Shadowing/Formant Lab/realtime.

## Open Questions

- Should the consonant chart page get its own top-level nav entry, or live as a tab within the existing vowel chart (`index.html`)? Proposal assumes a separate page (`consonants.html`) for a clean v1 cut; revisit if the user wants unified navigation.
- Should `representative_sample_id` reference audio be required at seed time, or is a silent/no-audio consonant acceptable for v1 (pills still browsable, just not playable)? Proposal assumes audio is optional, matching `Vowel.representative_sample_id`'s own nullability.
