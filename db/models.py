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

Core principle, preserved from the original design: a Sample's own audio can
be analyzed more than once (`SampleAnalysis` — kept as *history*, not
overwritten, so re-analyzing with different settings never destroys a
previous result). What changed after further discussion: "one active
analysis per sample" turned out to be the wrong granularity — a Token (a
slice of the sample) is what actually needs to point at a specific analysis
run, not the sample as a whole. So `Token.active_analysis_id` picks, per
token, which of its sample's `SampleAnalysis` rows to derive mean F1/F2 from
over its own [time_start_ms, time_end_ms] range (computed on read — a later
phase — never cached on the token, so there's no stale-value problem).
Re-analyzing just one token with different Praat settings means: add a new
SampleAnalysis row for the sample, then repoint only that token's
active_analysis_id at it; every other token keeps using whatever analysis
it was already pointing at.

`Token.manual_f1/f2` is a direct override — someone measured this exact
slice in their own (e.g. desktop) Praat session and typed the numbers in.
When present, it wins over the active-analysis-derived mean; this is a
per-token value because manual measurement is inherently about one slice,
never "the whole sample" (hence manual_f1/f2 live on Token, not
SampleAnalysis, unlike an earlier draft of this schema).

F0/pitch: real signal (e.g. Norwegian tonemes are a pitch-contour pattern,
not a vowel-quality feature) — kept as the raw curve inside a Praat-sourced
SampleAnalysis row, but deliberately NOT promoted to a per-vowel or
per-token "value" the way F1/F2 are. A sample-level contour/toneme
descriptor is a plausible future feature, not built now.

Sample.url is a single column, not a storage_key/source_url pair: a local
file is "file://<storage_key>" (see db/storage.py's is_local_url/
storage_key_from_url), anything else (http/https) is an unmirrored external
link. Leading-silence trimming is NOT modeled as sample-level metadata
(leading_silence_ms/trimmed fields existed in an earlier draft) — ingestion
trims the audio bytes themselves at save time instead, so there's nothing
left to describe afterwards. `provenance` was dropped too: it was tracking
"how did this row come to exist," which nothing yet reads.
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
    tokens. `language_id`/`text`/`url` are all nullable because a
    freshly-ingested recording legitimately exists before any of those are
    decided (see the module docstring) — this one table covers the whole
    lifecycle from "just uploaded" to "fully tokenized library entry."
    """
    __tablename__ = "samples"

    id: Mapped[int] = mapped_column(primary_key=True)
    language_id: Mapped[int | None] = mapped_column(ForeignKey("languages.id", ondelete="CASCADE"))

    # File facts
    url: Mapped[str | None] = mapped_column(Text, unique=True)  # "file://<storage_key>" or an external http(s) URL
    original_filename: Mapped[str | None] = mapped_column(Text)
    content_type: Mapped[str | None] = mapped_column(Text)
    duration_ms: Mapped[int | None] = mapped_column(Integer)
    sample_rate_hz: Mapped[int | None] = mapped_column(Integer)
    channels: Mapped[int | None] = mapped_column(SmallInteger)

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
    One Praat analysis ATTEMPT over a sample's full audio for a given config
    — kept as history (not overwritten), so re-analyzing with different
    settings never destroys a previous result. Which analysis a given token
    should derive its mean F1/F2 from is decided per-token (see
    Token.active_analysis_id), not by one global flag here.
    """
    __tablename__ = "sample_analyses"

    id: Mapped[int] = mapped_column(primary_key=True)
    sample_id: Mapped[int] = mapped_column(ForeignKey("samples.id", ondelete="CASCADE"), nullable=False)

    version: Mapped[str | None] = mapped_column(Text)   # e.g. 'praat-default-v1'
    config: Mapped[dict | None] = mapped_column(JSONB)  # {max_number_of_formants, maximum_formant, window_length, ...}
    formants: Mapped[list | None] = mapped_column(JSONB)  # [{t_ms, f1..f5, b1..b5}, ...]
    pitch: Mapped[list | None] = mapped_column(JSONB)     # [{t_ms, f0}, ...] — real signal (e.g. tonemes), not a per-vowel value

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
    # The explicit sample<->vowel relationship — NOT derived from matching
    # `symbol` text, which real data already proved ambiguous (two different
    # `ru` samples both claiming the vowel "i"). Nullable: a token can exist
    # before anyone's tagged which vowel it's an instance of.
    vowel_id: Mapped[int | None] = mapped_column(ForeignKey("vowels.id", ondelete="SET NULL"))
    char_start: Mapped[int] = mapped_column(Integer, nullable=False)
    char_end: Mapped[int] = mapped_column(Integer, nullable=False)
    # A range INTO THE SAMPLE'S OWN AUDIO. Null until someone draws it — still
    # needed even for a manual-only token, so the slice remains playable.
    time_start_ms: Mapped[int | None] = mapped_column(Integer)
    time_end_ms: Mapped[int | None] = mapped_column(Integer)
    # Which of the sample's SampleAnalysis rows this token's mean F1/F2 is
    # derived from on read (a later phase) — restricted to [time_start_ms,
    # time_end_ms]. Null if nothing's been analyzed for this token yet.
    active_analysis_id: Mapped[int | None] = mapped_column(ForeignKey("sample_analyses.id", ondelete="SET NULL"))
    # Direct override — wins over the active-analysis-derived mean when set.
    manual_f1: Mapped[float | None] = mapped_column()
    manual_f2: Mapped[float | None] = mapped_column()
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime.datetime] = mapped_column(server_default=func.now())
    updated_at: Mapped[datetime.datetime] = mapped_column(server_default=func.now(), onupdate=func.now())

    sample: Mapped["Sample"] = relationship(back_populates="tokens")
    active_analysis: Mapped["SampleAnalysis | None"] = relationship()
    vowel: Mapped["Vowel | None"] = relationship()
