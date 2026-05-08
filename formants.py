import argparse
import parselmouth
from parselmouth.praat import call

parser = argparse.ArgumentParser(description="Extract F1/F2 formants from a vowel file.")
parser.add_argument("file", help="Path to audio file (mp3, wav, …)")
parser.add_argument("--start", type=float, default=0.33,
                    help="Start of analysis window. "
                         "0.0–1.0 = relative to duration (default: 0.33). "
                         "Values > 1.0 are treated as milliseconds.")
parser.add_argument("--end", type=float, default=0.67,
                    help="End of analysis window (same unit as --start, default: 0.67).")
parser.add_argument("--ceiling", type=float, default=5500,
                    help="Formant ceiling in Hz. 5500 = female (default), 5000 = male.")
args = parser.parse_args()

snd = parselmouth.Sound(args.file)
duration = snd.get_total_duration()

# Decide unit: values in (0, 1] → relative; anything > 1 → milliseconds
def resolve(val, duration):
    if val <= 1.0:
        return val * duration
    return val / 1000.0  # ms → seconds

t_start = resolve(args.start, duration)
t_end   = resolve(args.end,   duration)

if not (0 <= t_start < t_end <= duration):
    raise ValueError(f"Window [{t_start:.3f}, {t_end:.3f}] is outside file duration {duration:.3f} s")

formant = call(snd, "To Formant (burg)", 0.0, 5, args.ceiling, 0.025, 50.0)

f1 = call(formant, "Get mean", 1, t_start, t_end, "hertz")
f2 = call(formant, "Get mean", 2, t_start, t_end, "hertz")

print(f"File     : {args.file}")
print(f"Duration : {duration*1000:.1f} ms")
print(f"Window   : {t_start*1000:.1f} ms → {t_end*1000:.1f} ms")
print(f"F1       : {f1:.1f} Hz")
print(f"F2       : {f2:.1f} Hz")