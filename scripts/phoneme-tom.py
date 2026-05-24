import re
import requests
from bs4 import BeautifulSoup
import urllib3
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# --- brondsted.dk (German/Danish/English) ---

BRONDSTED_HEADERS = {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    "Accept-Encoding": "gzip, deflate",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "max-age=0",
    "Connection": "keep-alive",
    "Content-Type": "application/x-www-form-urlencoded",
    "Cookie": "PHPSESSID=5d0993bde44a1d9065f5cb42f335150a",
    "Host": "tom.brondsted.dk",
    "Origin": "http://tom.brondsted.dk",
    "Referer": "http://tom.brondsted.dk/text2phoneme/",
    "Upgrade-Insecure-Requests": "1",
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
}

def get_ipa_brondsted(text: str, language: str = "german") -> str:
    url = "https://tom.brondsted.dk/text2phoneme/"
    data = {"txt": text, "outputform": "raw", "language": language, "alphabet": "IPA"}
    response = requests.post(url, data=data, headers=BRONDSTED_HEADERS, verify=False)
    response.encoding = "utf-8"
    soup = BeautifulSoup(response.text, "html.parser")
    ipa_p = soup.find("p", style=lambda s: s and "times" in s)
    return ipa_p.get_text(strip=True).split()[0] if ipa_p else ""


# --- tophonetics.com (English) ---

TOPHONETICS_HEADERS = {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    "Accept-Encoding": "gzip, deflate",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "max-age=0",
    "Connection": "keep-alive",
    "Content-Type": "application/x-www-form-urlencoded",
    "Origin": "https://tophonetics.com",
    "Referer": "https://tophonetics.com/",
    "Upgrade-Insecure-Requests": "1",
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
}

def get_ipa_tophonetics(text: str, dialect: str = "am") -> str:
    """dialect: 'am' (American) or 'br' (British)"""
    url = "https://tophonetics.com/"
    data = {
        "text_to_transcribe": text,
        "submit": "Show transcription",
        "output_dialect": dialect,
        "output_style": "only_tr",
        "preBracket": "",
        "postBracket": "",
        "speech_support": "0",
    }
    response = requests.post(url, data=data, headers=TOPHONETICS_HEADERS)
    response.encoding = "utf-8"
    soup = BeautifulSoup(response.text, "html.parser")
    output_div = soup.find("div", id="transcr_output")
    return output_div.get_text(separator=" ", strip=True) if output_div else ""


def get_ipa_oxford(text: str, dialect: str = "NAmE") -> str:
    """
    dialect: 'NAmE' (American) or 'BrE' (British)
    Only works for single words — Oxford Learner's is word-by-word.
    """
    word = text.strip().lower().split()[0]  # single word only
    url = f"https://www.oxfordlearnersdictionaries.com/definition/english/{word}"
    headers = {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
    }
    response = requests.get(url, headers=headers)
    response.encoding = "utf-8"
    soup = BeautifulSoup(response.text, "html.parser")

    # Each pronunciation block has a <div class="phons_n_am"> or <div class="phons_br">
    css_class = "phons_n_am" if dialect == "NAmE" else "phons_br"
    block = soup.find("div", class_=css_class)
    if not block:
        return ""
    ipa_span = block.find("span", class_="phon")
    return ipa_span.get_text(strip=True).strip("/") if ipa_span else ""

# --- file updater ---

def update_phonemic(filepath: str, source: str = "brondsted", language: str = "german") -> None:
    """
    source: 'brondsted' (german/danish/english) or 'tophonetics' (english)
    language: for brondsted — 'german', 'danish', 'english'
              for tophonetics — 'am' or 'br' (dialect)
    """
    with open(filepath, "r", encoding="utf-8") as f:
        lines = f.readlines()

    current_text = None
    updated_lines = []
    i = 0

    for line in lines:
        if re.search(r'"text"\s*:\s*"', line):
            m = re.search(r'"text"\s*:\s*"([^"]+)"', line)
            current_text = m.group(1) if m else current_text
            updated_lines.append(line)
        elif re.search(r'"phonemic"\s*:', line) and current_text:
            if len(current_text.replace("ː", "")) <= 2:
                ipa = current_text
            if source == "tophonetics":
                ipa = get_ipa_tophonetics(current_text, dialect=language)
            elif source == "oxford":
                ipa = get_ipa_oxford(current_text, dialect=language)  # language = "NAmE" or "BrE"
            else:
                ipa = get_ipa_brondsted(current_text, language=language)

            indent = re.match(r'(\s*)', line).group(1)
            trailing = "," if line.rstrip().endswith(",") else ""
            new_line = f'{indent}"phonemic": "/{ipa}/"{trailing}\n'
            i += 1
            print(f"[{i}] {current_text}: {line.strip()} → {new_line.strip()}")
            updated_lines.append(new_line)
            current_text = None
        else:
            updated_lines.append(line)

    with open(filepath, "w", encoding="utf-8") as f:
        f.writelines(updated_lines)

    print(f"\nDone. Updated {i} entries in {filepath}")


if __name__ == "__main__":
    # German words via brondsted
    # update_phonemic("german_words.json", source="brondsted", language="german")

    # English words via tophonetics (American)
    update_phonemic("/home/coden/dev/phonapp/lang/en/samples.json", source="oxford", language="NAmE")