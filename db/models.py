"""
db/models.py — SQLAlchemy ORM models for the Phase 0 schema.

See the architecture plan (db-export/ round-trip, Sound-owns-analysis model)
for the reasoning behind each design choice referenced in comments below.

Core principle: a `Sound` is analyzed once (full-clip formant+pitch track in
`SoundAnalysisFrames`); `Vowel.audio` and `Sample.audio` are references to a
Sound instead of bare path/URL strings; a `Token` only stores a time range
into its Sample's Sound — its F1/F2/F0 are DERIVED on read (see
db/queries.py, added in a later phase) rather than cached, so there is no
stale-value invalidation problem to get wrong.
"""

from __future__ import annotations

import datetime

from sqlalchemy import (
    ARRAY,
    Boolean,
    CheckConstraint,
    ForeignKey,
    Integer,
    SmallInteger,
    String,
    Text,
    UniqueConstraint,
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


class Sound(Base):
    """
    Raw audio + its own full-clip analysis. Exists independently of any
    Vowel/Sample that happens to reference it — deleting a language does NOT
    delete the Sounds its vowels/samples pointed to (see Language cascade: it
    only cascades to vowels/samples, never to sounds).
    """
    __tablename__ = "sounds"
    __table_args__ = (
        CheckConstraint("storage_key IS NOT NULL OR source_url IS NOT NULL", name="sound_has_a_location"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
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
    analysis_version: Mapped[str | None] = mapped_column(Text)
    analysis_config: Mapped[dict | None] = mapped_column(JSONB)
    manual_f1: Mapped[float | None] = mapped_column()
    manual_f2: Mapped[float | None] = mapped_column()
    manual_f0: Mapped[float | None] = mapped_column()
    created_at: Mapped[datetime.datetime] = mapped_column(server_default=func.now())
    updated_at: Mapped[datetime.datetime] = mapped_column(server_default=func.now(), onupdate=func.now())

    analysis_frames: Mapped["SoundAnalysisFrames | None"] = relationship(back_populates="sound", cascade="all, delete-orphan", uselist=False)


class SoundAnalysisFrames(Base):
    """1:1 with Sound — split out so the frequently-queried `sounds` row stays small."""
    __tablename__ = "sound_analysis_frames"

    sound_id: Mapped[int] = mapped_column(ForeignKey("sounds.id", ondelete="CASCADE"), primary_key=True)
    formants: Mapped[list] = mapped_column(JSONB, nullable=False)  # [{t_ms, f1..f5, b1..b5}, ...]
    pitch: Mapped[list] = mapped_column(JSONB, nullable=False)     # [{t_ms, f0}, ...]

    sound: Mapped["Sound"] = relationship(back_populates="analysis_frames")


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
    audio_sound_id: Mapped[int | None] = mapped_column(ForeignKey("sounds.id"))
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
    audio_sound: Mapped["Sound | None"] = relationship()


class Sample(Base):
    __tablename__ = "samples"

    id: Mapped[int] = mapped_column(primary_key=True)
    language_id: Mapped[int] = mapped_column(ForeignKey("languages.id", ondelete="CASCADE"), nullable=False)
    sound_id: Mapped[int | None] = mapped_column(ForeignKey("sounds.id"))
    text: Mapped[str] = mapped_column(Text, nullable=False)
    phonemic: Mapped[str | None] = mapped_column(Text)
    # Kept as symbol text, not an FK to one vowel row, since one symbol can span
    # multiple vowel rows' `symbols` arrays — matches today's semantics exactly.
    representative_symbol: Mapped[str | None] = mapped_column(Text)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime.datetime] = mapped_column(server_default=func.now())
    updated_at: Mapped[datetime.datetime] = mapped_column(server_default=func.now(), onupdate=func.now())

    language: Mapped["Language"] = relationship(back_populates="samples")
    sound: Mapped["Sound | None"] = relationship()
    tokens: Mapped[list["Token"]] = relationship(back_populates="sample", cascade="all, delete-orphan", order_by="Token.sort_order")


class Token(Base):
    __tablename__ = "tokens"

    id: Mapped[int] = mapped_column(primary_key=True)
    sample_id: Mapped[int] = mapped_column(ForeignKey("samples.id", ondelete="CASCADE"), nullable=False)
    symbol: Mapped[str] = mapped_column(Text, nullable=False)
    char_start: Mapped[int] = mapped_column(Integer, nullable=False)
    char_end: Mapped[int] = mapped_column(Integer, nullable=False)
    # A range INTO THE SAMPLE'S SOUND — not a separate clip. Null for tokens whose
    # sample has no sound, or whose range hasn't been set yet.
    time_start_ms: Mapped[int | None] = mapped_column(Integer)
    time_end_ms: Mapped[int | None] = mapped_column(Integer)
    # Escape hatch: verbatim old dual-ceiling analysis blob (max_f, n_formants,
    # window_ms, pre_emphasis, back_ceiling, back_ceiling_ratio, back_front_ratio,
    # rms_floor, median_n, slice, f1, f2) for tokens migrated from legacy data.
    # Never written to by new code — new/re-analyzed tokens are sound-backed instead.
    legacy_analysis: Mapped[dict | None] = mapped_column(JSONB)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime.datetime] = mapped_column(server_default=func.now())
    updated_at: Mapped[datetime.datetime] = mapped_column(server_default=func.now(), onupdate=func.now())

    sample: Mapped["Sample"] = relationship(back_populates="tokens")
