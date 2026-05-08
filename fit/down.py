import requests, os, subprocess
from pydub import AudioSegment

vowels = [('i_short',
  'https://fit-aussprache.com/wp-content/uploads/2018/09/w06_1.wav?_=1'),
 ('u_short',
  'https://fit-aussprache.com/wp-content/uploads/2018/09/w06_2.wav?_=2'),
 ('y_short',
  'https://fit-aussprache.com/wp-content/uploads/2018/09/w06_3.wav?_=3'),
 ('o_short',
  'https://fit-aussprache.com/wp-content/uploads/2018/09/w06_4.wav?_=4'),
 ('oe_short',
  'https://fit-aussprache.com/wp-content/uploads/2018/09/w06_5.wav?_=5'),
 ('u_long',
  'https://fit-aussprache.com/wp-content/uploads/2018/09/w05_1.wav?_=1'),
 ('o_long',
  'https://fit-aussprache.com/wp-content/uploads/2018/09/w05_2.wav?_=2'),
 ('schwa',
  'https://fit-aussprache.com/wp-content/uploads/2018/09/w04_1.wav?_=1'),
 ('er', 'https://fit-aussprache.com/wp-content/uploads/2018/09/w04_2.wav?_=2'),
 ('e_long',
  'https://fit-aussprache.com/wp-content/uploads/2018/09/w02_1.wav?_=1'),
 ('a_long',
  'https://fit-aussprache.com/wp-content/uploads/2018/09/w02_2-1.wav?_=2'),
 ('e_short',
  'https://fit-aussprache.com/wp-content/uploads/2018/09/w02_3-1.wav?_=3'),
 ('a_short',
  'https://fit-aussprache.com/wp-content/uploads/2018/09/w02_4-1.wav?_=4'),
 ('i_long',
  'https://fit-aussprache.com/wp-content/uploads/2018/09/w01_1.wav?_=1'),
 ('ee_long',
  'https://fit-aussprache.com/wp-content/uploads/2018/09/w01_2.wav?_=2'),
 ('y_long',
  'https://fit-aussprache.com/wp-content/uploads/2018/09/w01_3.wav?_=3'),
 ('oe_long',
  'https://fit-aussprache.com/wp-content/uploads/2018/09/w01_4.wav?_=4')]


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
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))
    path = os.path.join(BASE_DIR, vowel+".mp3")
    print (path )
    segment = load_audio(path)
    segment[:1000].export(os.path.join(BASE_DIR,f"out/{vowel}.mp3"), format="mp3")

    