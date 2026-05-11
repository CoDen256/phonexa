import requests, os, subprocess
from pydub import AudioSegment

vowels = []


def load_audio(path: str) -> AudioSegment:
    """Load MP3 robustly — works even with missing/broken headers (NixOS ffmpeg)."""
    wav_path = path.replace(".mp3", "_tmp.wav")
    subprocess.run(
        [
            "ffmpeg", "-y",
            "-analyzeduration", "10000000",
            "-probesize",       "10000000",
            "-i", path,
            wav_path,
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    audio = AudioSegment.from_wav(wav_path)
    os.remove(wav_path)
    return audio

for (vowel, link) in vowels:
    (vowel, link) = vowels[-1]
    r = requests.get(link)
    open(f"{vowel}_raw.mp3", "wb").write(r.content)
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))
    path = os.path.join(BASE_DIR, vowel+"_raw.mp3")
    print (path )
    segment = load_audio(path)
    segment[:1200].export(os.path.join(BASE_DIR,f"{vowel}.mp3"), format="mp3")
    break

    