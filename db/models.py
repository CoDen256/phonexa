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
    consonants: Mapped[list["Consonant"]] = relationship(back_populates="language", cascade="all, delete-orphan", order_by="Consonant.sort_order")
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


class Consonant(Base):
    """
    A consonant phone — deliberately NOT a `Vowel` extension or a shared
    `Phone` supertype (see openspec/changes/add-consonant-chart/design.md
    decision 1): consonants are a categorical feature bundle (manner/place/
    voicing/secondary-articulation), not a continuous position+acoustic-target
    pair, so reusing Vowel's columns would just be a wide table with two
    permanently-disjoint sets of always-null columns.

    `passive_place` (location) and `active_articulator` (what moves) are two
    independent columns, not one flat enum, because real contrasts need both
    at once (e.g. apical vs. laminal post-alveolar) — see design.md decision 2.
    `secondary_articulation` is multi-valued (array) because 0, 1, or 2+ can
    apply simultaneously (Russian hard л is velarized AND pharyngealized).

    `symbols` stores only the bare base letter(s) — never a pre-composed
    string with diacritics. The full displayed IPA symbol (secondary-
    articulation superscripts, velarized/pharyngealized tilde overlay,
    active-articulator underscript, syllabic mark) is always computed from
    these feature columns at render time (see js/consonant-symbol.js) — this
    was a real bug class during mockup iteration (inconsistent/missing marks
    when baked into stored strings) that a derived-only rendering structurally
    prevents from recurring (design.md decision 3).

    The enums below are supersets of what's seeded by the four launch
    languages (en/de/ru/fr) — they include manner/place/articulator values no
    current row uses (e.g. click, ejective, implosive manners; radical,
    epiglottal places) so a future language's inventory needs only new rows,
    not a schema migration.
    """
    __tablename__ = "consonants"

    MANNERS = (
        "nasal", "plosive", "affricate", "fricative", "trill", "tap_or_flap",
        "approximant", "lateral_approximant", "lateral_fricative", "lateral_flap",
        "click", "ejective", "implosive",
    )
    PASSIVE_PLACES = (
        "exo_labial", "endo_labial", "dental", "alveolar", "postalveolar",
        "alveolo_palatal", "palatal", "velar", "uvular", "pharyngeal",
        "epiglottal", "glottal", "retroflex", "labial",
    )
    ACTIVE_ARTICULATORS = (
        "labial", "apical", "laminal", "sub_apical", "antero_dorsal",
        "postero_dorsal", "radical",
    )
    SECONDARY_ARTICULATIONS = (
        "labialized", "palatalized", "velarized", "pharyngealized",
        "glottalized", "aspirated",
    )
    VOICINGS = ("voiced", "voiceless")

    id: Mapped[int] = mapped_column(primary_key=True)
    language_id: Mapped[int] = mapped_column(ForeignKey("languages.id", ondelete="CASCADE"), nullable=False)
    symbols: Mapped[list[str]] = mapped_column(ARRAY(Text), nullable=False)
    manner: Mapped[str] = mapped_column(Text, nullable=False)
    passive_place: Mapped[str] = mapped_column(Text, nullable=False)
    active_articulator: Mapped[str | None] = mapped_column(Text)
    voicing: Mapped[str] = mapped_column(Text, nullable=False)
    secondary_articulation: Mapped[list[str]] = mapped_column(ARRAY(Text), nullable=False, default=list)
    syllabic: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    coarticulated_place: Mapped[str | None] = mapped_column(Text)
    desc: Mapped[str | None] = mapped_column(Text)
    wiki_url: Mapped[str | None] = mapped_column(Text)
    representative_sample_id: Mapped[int | None] = mapped_column(ForeignKey("samples.id", ondelete="SET NULL"))
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime.datetime] = mapped_column(server_default=func.now())
    updated_at: Mapped[datetime.datetime] = mapped_column(server_default=func.now(), onupdate=func.now())

    language: Mapped["Language"] = relationship(back_populates="consonants")
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


class User(Base):
    """
    A named profile, not an account — this app has deliberately had zero
    auth so far (see db/storage.py's AUDIO_BACKEND comment / formanter.py's
    admin-import endpoint) and that stance is kept here too. `User` exists
    purely to scope Settings and Shadowing data per person on a shared
    machine; there is no password and the "current" user is just a plain id
    the client remembers in localStorage, not a security boundary.
    """
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    created_at: Mapped[datetime.datetime] = mapped_column(server_default=func.now())

    settings: Mapped[list["Setting"]] = relationship(back_populates="user", cascade="all, delete-orphan")
    shadowing_media: Mapped[list["ShadowingMedia"]] = relationship(back_populates="user", cascade="all, delete-orphan", order_by="ShadowingMedia.created_at")


class Setting(Base):
    """
    A generic per-user key/value row, same JSONB-blob idiom as
    SampleAnalysis.config — used today for 'ipaChartFilters' (index.html's
    chart filter state) and 'transcribeBackend' (Shadowing's transcription
    backend config, replacing the old hardcoded TRANSCRIBE_SERVER constant
    and raw localStorage keys). No schema is enforced on `value` beyond
    "valid JSON" — same convention as the rest of this file's JSONB columns.
    """
    __tablename__ = "settings"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    key: Mapped[str] = mapped_column(Text, nullable=False)
    value: Mapped[dict | list | None] = mapped_column(JSONB)
    updated_at: Mapped[datetime.datetime] = mapped_column(server_default=func.now(), onupdate=func.now())

    user: Mapped["User"] = relationship(back_populates="settings")


class ShadowingMedia(Base):
    """
    One long-audio file (audiobook/video audio) a user is shadowing — audio
    bytes are NEVER stored server-side (decoding/storing a multi-hour file
    here was tried and reverted: it meant a multi-GB server-side decode on
    upload, again on split, and again on every single chapter-audio
    request, since nothing was cached between requests). Instead, `fingerprint`
    (a client-computed hash of file size + a few sampled byte ranges — see
    js/shadow.js's computeFingerprint, never the whole file) is how a
    re-uploaded file is recognized as "the same one": POST
    /api/v1/shadowing/media/find-or-create looks up (user_id, fingerprint)
    and returns the existing row (with its segments/progress) instead of
    creating a new one. Segmentation itself runs client-side (js/vad.js);
    this table only ever receives the resulting ms boundaries.
    """
    __tablename__ = "shadowing_media"
    __table_args__ = (UniqueConstraint("user_id", "fingerprint"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)

    fingerprint: Mapped[str] = mapped_column(Text, nullable=False)
    original_filename: Mapped[str | None] = mapped_column(Text)
    file_size_bytes: Mapped[int | None] = mapped_column()
    duration_ms: Mapped[int | None] = mapped_column(Integer)
    sample_rate_hz: Mapped[int | None] = mapped_column(Integer)
    channels: Mapped[int | None] = mapped_column(SmallInteger)

    # Last-used segmentation sliders — re-shown pre-filled when reopened.
    sentence_silence_ms: Mapped[int | None] = mapped_column(Integer)
    chapter_silence_ms: Mapped[int | None] = mapped_column(Integer)

    created_at: Mapped[datetime.datetime] = mapped_column(server_default=func.now())
    updated_at: Mapped[datetime.datetime] = mapped_column(server_default=func.now(), onupdate=func.now())

    user: Mapped["User"] = relationship(back_populates="shadowing_media")
    segments: Mapped[list["ShadowingSegment"]] = relationship(
        back_populates="media", cascade="all, delete-orphan", order_by="ShadowingSegment.order_index"
    )


class ShadowingSegment(Base):
    """
    One chapter or sentence of a ShadowingMedia's segmentation. Chapters and
    sentences share one table (kind='chapter'|'sentence') rather than two,
    with chapters as the (parent_segment_id IS NULL) top level and sentences
    pointing at their containing chapter — real relational rows, not a JSONB
    array, because manual split/merge is per-row CRUD and ordering/
    containment queries benefit from an indexed FK + order_index.
    `done`/`text` are the only durable "progress" — the user's own recorded
    take is deliberately never persisted (stays ephemeral client-side, to
    keep storage bounded for multi-hour books).
    """
    __tablename__ = "shadowing_segments"

    id: Mapped[int] = mapped_column(primary_key=True)
    media_id: Mapped[int] = mapped_column(ForeignKey("shadowing_media.id", ondelete="CASCADE"), nullable=False)
    kind: Mapped[str] = mapped_column(Text, nullable=False)  # 'chapter'|'sentence'
    parent_segment_id: Mapped[int | None] = mapped_column(ForeignKey("shadowing_segments.id", ondelete="CASCADE"))
    order_index: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    start_ms: Mapped[int] = mapped_column(Integer, nullable=False)
    end_ms: Mapped[int] = mapped_column(Integer, nullable=False)
    text: Mapped[str | None] = mapped_column(Text)  # transcript
    done: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime.datetime] = mapped_column(server_default=func.now())
    updated_at: Mapped[datetime.datetime] = mapped_column(server_default=func.now(), onupdate=func.now())

    media: Mapped["ShadowingMedia"] = relationship(back_populates="segments")
    parent: Mapped["ShadowingSegment | None"] = relationship(remote_side=[id])
