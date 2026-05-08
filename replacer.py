import os
import json
import re
import subprocess
from urllib.parse import urlparse

IPA_MAP = {
    # ---------------- FRONT VOWELS ----------------
    "i": "i",
    "y": "y",
    "ɨ": "i_bar",
    "ʉ": "u_bar",
    "ɯ": "u_back",
    "u": "u",

    "ɪ": "i_short",
    "ʏ": "y_short",
    "ʊ": "u_short",

    "e": "e",
    "ø": "oe",
    "ɘ": "e_mid",
    "ɵ": "o_mid_front",
    "ɤ": "o_mid_back",
    "o": "o",

    "ə": "schwa",

    # ---------------- OPEN-MID / MID ----------------
    "ɛ": "e_open",
    "œ": "oe_open",
    "ɜ": "e_reversed",
    "ɞ": "o_reversed",
    "ʌ": "vowel_wedge",
    "ɔ": "o_open",

    # ---------------- OPEN VOWELS ----------------
    "æ": "ae",
    "ɐ": "a_neutral",

    "a": "a",
    "ɶ": "oe_front",
    "ä": "a_front",
    "ɑ": "a_back",
    "ɒ": "a_round_back",

    # ---------------- LOWERED / DIACRITICIZED ----------------
    "ø̞": "oe_lower",
    "e̞": "e_lower",
    "ɤ̞": "o_mid_lower",
    "o̞": "o_lower",
    "ɝ": "er_rhotacized",
}

def safe_filename(name: str) -> str:
    result = []

    for ch in name:
        print(result)
        if ch in IPA_MAP:
            result.append(IPA_MAP[ch])
        elif ch in ["ː", "ː"]:
            result.append("_long")
        elif ch in ["ˈ", "ˌ"]:
            # stress markers ignored or optional
            continue
        elif ch.isalnum():
            result.append(ch)
        else:
            # fallback for unknown symbols
            result.append("_")

    # collapse multiple underscores
    out = "".join(result)
    return out.replace("<b>", "").replace("</b>", "")

def get_extension(url: str) -> str:
    path = urlparse(url).path
    ext = os.path.splitext(path)[1]
    return ext if ext else ".mp3"

def download_with_curl(url: str, out_path: str):
    try:
        subprocess.run(
            ["curl", "-L", "-o", out_path, url],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL
        )
        print(f"Downloaded: {url} -> {out_path}")
        #raise ValueError("")
    except subprocess.CalledProcessError:
        print(f"Failed: {url}")

def process_vowels(vowels, json_dir):
    for vowel in vowels:
        # ---- IPA AUDIO ----
        ipa_url = vowel.get("ipaAudio")
        if ipa_url and ipa_url.startswith("http"):
            ipa_name = safe_filename(vowel.get("ipa", "ipa_audio"))
            ext = get_extension(ipa_url)

            filename = f"{ipa_name}{ext}"
            full_path = os.path.join(json_dir, filename)

            download_with_curl(ipa_url, full_path)
            vowel["ipaAudio"] = os.path.relpath(full_path, start=os.getcwd())

def process_json_file(path):
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)

    if "vowels" not in data:
        return

    json_dir = os.path.dirname(path)
    process_vowels(data["vowels"], json_dir+"/audio/auto")

    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    print(f"Updated: {path}")

def walk(root="."):
    for dirpath, _, filenames in os.walk(root):
        for file in filenames:
            if file == "lang.json":
                process_json_file(os.path.join(dirpath, file))

if __name__ == "__main__":
    walk("./lang/no")