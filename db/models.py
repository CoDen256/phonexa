"""
db/models.py — SQLAlchemy ORM models.

Revised from the original Phase 0 draft after discussion: Sound and Sample
turned out not to be a real distinction (confirmed against the actual
migrated data — Sample:Sound is "almost always" 1:1, and the rare
exceptions — audio with no text, text with no audio — are exactly the
nullable-field states the ingestion workflow needs anyway). They're merged
into one `Sample` table: a row progresses from "just uploaded audio" to
"fully tokenized sample" by having more of its nullable fields filled in
over time, not by moving between tables.

Core principle, preserved from the original design: a Sample's own audio is
analyzed once per analysis attempt (`SampleAnalysis` — kept as *history*,
not overwritten, so re-analyzing with different settings never destroys a
previous result; exactly one row per sample is flagged `is_active` for
whichever one derivation should use). A `Token` only stores a time range
into its sample's audio — no F1/F2/F0 of its own; those are DERIVED on read
from the active analysis's frame track restricted to that range, so there
is no stale-cached-value problem to get wrong.

F0/pitch: real signal (e.g. Norwegian tonemes are a pitch-contour pattern,
not a vowel-quality feature) — kept as the raw curve inside a Praat-sourced
SampleAnalysis row, but deliberately NOT promoted to a per-vowel or
per-token "value" the way F1/F2 are. A sample-level contour/toneme
descriptor is a plausible future feature, not built now.

legacy_analysis on Token is a deliberate, temporary escape hatch: the old
dual-ceiling pipeline's blob is kept verbatim for tokens migrated from the
pre-DB JSON files, until a later pass re-analyzes them through the real
Praat pipeline and attaches a proper SampleAnalysis-derived range instead.
"""

from __future__ import annotations

import datetime

from sqlalchemy import (
    ARRAY,
    Boolean,
    ForeignKey,
    Integer,
    SmallInteger,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


class Language(Base):
    __tablename__ = "languages"

    id: Mapped[int] = mapped_column(SmallInteger, primary_key=True)
    key: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    label: Mapped[str] = mapped_column(Text, nullable=False)
    color: Mapped[str] = mapped_column(Text, nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime.datetime] = mapped_column(server_default=func.now())
    updated_at: Mapped[datetime.datetime] = mapped_column(server_default=func.now(), onupdate=func.now())

    vowels: Mapped[list["Vowel"]] = relationship(back_populates="language", cascade="all, delete-orphan", order_by="Vowel.sort_order")
    samples: Mapped[list["Sample"]] = relationship(back_populates="language", cascade="all, delete-orphan", order_by="Sample.sort_order")


class Sample(Base):
    """
    A single piece of audio plus whatever is known about it so far — file
    facts, which language/text it belongs to (if assigned yet), and its
    tokens. `language_id`/`text`/`storage_key` are all nullable because a
    freshly-ingested recording legitimately exists before any of those are
    decided (see the module docstring) — this one table covers the whole
    lifecycle from "just uploaded" to "fully tokenized library entry."
    """
    __tablename__ = "samples"

    id: Mapped[int] = mapped_column(primary_key=True)
    language_id: Mapped[int | None] = mapped_column(ForeignKey("languages.id", ondelete="CASCADE"))

    # File facts
    storage_key: Mapped[str | None] = mapped_column(Text, unique=True)
    source_url: Mapped[str | None] = mapped_column(Text)
    original_filename: Mapped[str | None] = mapped_column(Text)
    content_type: Mapped[str | None] = mapped_column(Text)
    duration_ms: Mapped[int | None] = mapped_column(Integer)
    sample_rate_hz: Mapped[int | None] = mapped_column(Integer)
    channels: Mapped[int | None] = mapped_column(SmallInteger)
    provenance: Mapped[str] = mapped_column(Text, nullable=False)  # 'uploaded'|'shadowing-segment'|'legacy-migrated'|'external-link'
    leading_silence_ms: Mapped[int | None] = mapped_column(Integer)
    trimmed: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    # What's being said
    text: Mapped[str | None] = mapped_column(Text)
    phonemic: Mapped[str | None] = mapped_column(Text)

    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime.datetime] = mapped_column(server_default=func.now())
    updated_at: Mapped[datetime.datetime] = mapped_column(server_default=func.now(), onupdate=func.now())

    language: Mapped["Language | None"] = relationship(back_populates="samples")
    tokens: Mapped[list["Token"]] = relationship(back_populates="sample", cascade="all, delete-orphan", order_by="Token.sort_order")
    analyses: Mapped[list["SampleAnalysis"]] = relationship(back_populates="sample", cascade="all, delete-orphan", order_by="SampleAnalysis.created_at")


class SampleAnalysis(Base):
    """
    One analysis ATTEMPT over a sample's full audio — kept as history (not
    overwritten) so re-analyzing with different settings never destroys a
    previous result. Exactly one row per sample should be `is_active` at a
    time; that's the one token-value derivation (a later phase) reads from.
    """
    __tablename__ = "sample_analyses"

    id: Mapped[int] = mapped_column(primary_key=True)
    sample_id: Mapped[int] = mapped_column(ForeignKey("samples.id", ondelete="CASCADE"), nullable=False)
    source: Mapped[str] = mapped_column(Text, nullable=False)  # 'praat' | 'manual'
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    # Praat-sourced fields
    version: Mapped[str | None] = mapped_column(Text)   # e.g. 'praat-default-v1'
    config: Mapped[dict | None] = mapped_column(JSONB)  # {max_number_of_formants, maximum_formant, window_length, ...}
    formants: Mapped[list | None] = mapped_column(JSONB)  # [{t_ms, f1..f5, b1..b5}, ...]
    pitch: Mapped[list | None] = mapped_column(JSONB)     # [{t_ms, f0}, ...] — real signal (e.g. tonemes), not a per-vowel value

    # Manual-override fields (only meaningful when source='manual', e.g. values measured in desktop Praat)
    manual_f1: Mapped[float | None] = mapped_column()
    manual_f2: Mapped[float | None] = mapped_column()

    created_at: Mapped[datetime.datetime] = mapped_column(server_default=func.now())

    sample: Mapped["Sample"] = relationship(back_populates="analyses")


class Vowel(Base):
    __tablename__ = "vowels"

    id: Mapped[int] = mapped_column(primary_key=True)
    language_id: Mapped[int] = mapped_column(ForeignKey("languages.id", ondelete="CASCADE"), nullable=False)
    symbols: Mapped[list[str]] = mapped_column(ARRAY(Text), nullable=False)
    height: Mapped[float] = mapped_column(nullable=False)
    backness: Mapped[float] = mapped_column(nullable=False)
    type: Mapped[str] = mapped_column(Text, nullable=False)  # 'short'|'long'|'variable'|'diphthong'
    rounded: Mapped[bool] = mapped_column(Boolean, nullable=False)
    desc: Mapped[str | None] = mapped_column(Text)
    f1: Mapped[float | None] = mapped_column()
    f2: Mapped[float | None] = mapped_column()
    wiki_url: Mapped[str | None] = mapped_column(Text)
    # The vowel's own representative recording — a direct FK (not the old
    # string-based `representative_symbol` on Sample), so there's no
    # ambiguity when one symbol string spans multiple vowel rows.
    representative_sample_id: Mapped[int | None] = mapped_column(ForeignKey("samples.id"))
    # Diphthong target — denormalized inline (1:1 with the vowel row, never queried independently)
    target_height: Mapped[float | None] = mapped_column()
    target_backness: Mapped[float | None] = mapped_column()
    target_rounded: Mapped[bool | None] = mapped_column(Boolean)
    target_f1: Mapped[float | None] = mapped_column()
    target_f2: Mapped[float | None] = mapped_column()
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime.datetime] = mapped_column(server_default=func.now())
    updated_at: Mapped[datetime.datetime] = mapped_column(server_default=func.now(), onupdate=func.now())

    language: Mapped["Language"] = relationship(back_populates="vowels")
    representative_sample: Mapped["Sample | None"] = relationship()


class Token(Base):
    __tablename__ = "tokens"

    id: Mapped[int] = mapped_column(primary_key=True)
    sample_id: Mapped[int] = mapped_column(ForeignKey("samples.id", ondelete="CASCADE"), nullable=False)
    symbol: Mapped[str] = mapped_column(Text, nullable=False)
    char_start: Mapped[int] = mapped_column(Integer, nullable=False)
    char_end: Mapped[int] = mapped_column(Integer, nullable=False)
    # A range INTO THE SAMPLE'S OWN AUDIO. Null until someone draws it.
    time_start_ms: Mapped[int | None] = mapped_column(Integer)
    time_end_ms: Mapped[int | None] = mapped_column(Integer)
    # TEMPORARY escape hatch — see module docstring. Never written to by new
    # code; only ever set by the legacy migration script.
    legacy_analysis: Mapped[dict | None] = mapped_column(JSONB)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime.datetime] = mapped_column(server_default=func.now())
    updated_at: Mapped[datetime.datetime] = mapped_column(server_default=func.now(), onupdate=func.now())

    sample: Mapped["Sample"] = relationship(back_populates="tokens")
