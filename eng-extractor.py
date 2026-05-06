#!/usr/bin/env python3
"""
extract_audio_segments.py

Downloads MP3 files from URLs and slices each into 3 parts:
  1. The vowel sound
  2. The first word
  3. The second word

Detection works by finding non-silent chunks and taking the first three.

Dependencies:
    pip install requests pydub
    sudo apt-get install ffmpeg   # or: brew install ffmpeg
"""

import os
import sys
import requests
from pydub import AudioSegment
from pydub.silence import detect_nonsilent


# ──────────────────────────────────────────────
# CONFIGURATION
# ──────────────────────────────────────────────

# Add your entries here:
#   "url"   – direct link to the MP3 file
#   "sound" – label used in the output filenames (e.g. the vowel name)


base = "https://bilingueanglaismedia.s3.amazonaws.com/blog/infographics/api/mp3"

sounds = ["green", "pink", "blue", "wood", "dust", "purple", "mauve", "coffee", "sand", "red"]

ENTRIES = list(
    (f"{base}/PHONEME-{i.upper()}.mp3", f"{base}/NORMAL-{i.upper()}.mp3", i) for i in sounds
)



# Output directory for the extracted clips
OUTPUT_DIR = "output_clips"

# ── Silence-detection tuning ──────────────────
# Lower MIN_SILENCE_LEN  → detects shorter pauses as separators (more splits)
# Higher SILENCE_THRESH  → only treat very quiet parts as silence (fewer splits)
# Raise PADDING_MS       → include more audio around each detected chunk

MIN_SILENCE_LEN = 400   # ms  – minimum pause length to count as a separator
SILENCE_THRESH  = -40   # dBFS – anything quieter is "silence"
PADDING_MS      = 80    # ms  – extra audio kept before/after each chunk


# ──────────────────────────────────────────────
# HELPERS
# ──────────────────────────────────────────────

def download_mp3(url: str, dest_path: str) -> None:
    """Stream-download an MP3 to *dest_path*."""
    print(f"  Downloading {url} …")
    with requests.get(url, stream=True, timeout=30) as r:
        r.raise_for_status()
        with open(dest_path, "wb") as f:
            for chunk in r.iter_content(chunk_size=8192):
                f.write(chunk)


def extract_segments(audio: AudioSegment,
                     min_silence_len: int = MIN_SILENCE_LEN,
                     silence_thresh: int  = SILENCE_THRESH,
                     padding_ms: int      = PADDING_MS,
                     n: int = 3) -> list[AudioSegment]:
    """
    Detect non-silent chunks in *audio* and return the first *n* of them,
    each padded by *padding_ms* milliseconds on both sides.
    """
    ranges = detect_nonsilent(
        audio,
        min_silence_len=min_silence_len,
        silence_thresh=silence_thresh,
    )

    if not ranges:
        raise ValueError("No non-silent segments found – try lowering SILENCE_THRESH.")

    segments = []
    for start_ms, end_ms in ranges[:n]:
        padded_start = max(0, start_ms - padding_ms)
        padded_end   = min(len(audio), end_ms + padding_ms)
        segments.append(audio[padded_start:padded_end])

    if len(segments) < n:
        print(f"  ⚠  Only {len(segments)} segment(s) found (expected {n}).")

    return segments


def save_segment(segment: AudioSegment, path: str) -> None:
    segment.export(path, format="mp3")
    duration_s = len(segment) / 1000
    print(f"  → saved {path}  ({duration_s:.2f}s)")


# ──────────────────────────────────────────────
# MAIN
# ──────────────────────────────────────────────

LABELS = ["sound", "word1", "word2"]   # names for the 3 output slots


def process_entry(url, sound, output_dir: str) -> None:

    print(f"\n{'─'*55}")
    print(f"Processing sound: '{sound}'")

    # 1. Download
    raw_path = os.path.join(output_dir, f"{sound}.mp3")
    download_mp3(url, raw_path)

    # 2. Load audio
    audio = AudioSegment.from_mp3(raw_path)
    print(f"  Loaded {len(audio)/1000:.1f}s of audio")
    return
    # 3. Detect the first 3 non-silent chunks
    try:
        segments = extract_segments(audio)
    except ValueError as exc:
        print(f"  ✗ Skipping '{sound}': {exc}")
        return

    # 4. Save each chunk
    for label, segment in zip(LABELS, segments):
        out_path = os.path.join(output_dir, f"{sound}_{label}.mp3")
        save_segment(segment, out_path)

    # 5. Optionally remove the raw download to save space
    os.remove(raw_path)


def main() -> None:
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    if not ENTRIES:
        print("No entries defined. Edit the ENTRIES list at the top of the script.")
        sys.exit(1)

    for (vowel, word, sound) in ENTRIES:
        try:
            process_entry(vowel, sound, OUTPUT_DIR)
            process_entry(word, sound+"_word", OUTPUT_DIR)
        except Exception as exc:
            print(f"  ✗ Error processing {(vowel, word, sound)}: {exc}")

    print(f"\n✓ Done. Clips saved to '{OUTPUT_DIR}/'")


if __name__ == "__main__":
    main()