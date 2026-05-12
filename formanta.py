"""
analyze_server.py — Local formant analysis server for the IPA Vowel Chart.

SETUP (one time):
    pip install flask flask-cors parselmouth

RUN:
    python analyze_server.py

The server listens on http://localhost:5050
Keep it running while you use the IPA chart's 🎤 Practice panel.
"""

from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
import parselmouth
from parselmouth.praat import call
import tempfile
import os
import math

app = Flask(__name__)


@app.route("/")
def home():
    return send_from_directory(".", "index.html")
@app.route("/index.html")
def home2():
    return send_from_directory(".", "index.html")
@app.route("/editor.html")
def editor():
    return send_from_directory(".", "editor.html")
@app.route("/lang/<path:filename>")
def lang_files(filename):
    return send_from_directory("lang", filename)

@app.route("/ping")
def ping():
    return jsonify({"ok": True, "service": "IPA formant analyser"})

CORS(app, origins=["*"])




@app.route("/analyze", methods=["POST"])
def analyze():
    audio_bytes = request.data
    if not audio_bytes:
        return jsonify({"error": "No audio data received"}), 400

    # Write to a temp WAV file (browser sends audio/wav from the JS encoder)
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        f.write(audio_bytes)
        tmp_path = f.name

    try:
        snd = parselmouth.Sound(tmp_path)
        duration = snd.get_total_duration()

        if duration < 0.05:
            return jsonify({"error": f"Recording too short ({duration*1000:.0f} ms)"}), 400

        # Analysis window from request headers (fractions 0–1), fallback to middle third
        t_start_frac = float(request.headers.get('X-Window-Start', 0.33))
        t_end_frac   = float(request.headers.get('X-Window-End',   0.67))
        t_start = max(0.0, min(t_start_frac, 0.99)) * duration
        t_end   = max(0.01, min(t_end_frac,  1.0))  * duration
        if t_end <= t_start + 0.02:
            t_end = min(duration, t_start + 0.05)

        # Auto-select formant ceiling: default 5500 Hz (works for most voices)
        # Users can POST JSON {"ceiling": 5000} to override (male voices)
        ceiling = 5500.0
        try:
            body = request.get_json(silent=True)
            if body and "ceiling" in body:
                ceiling = float(body["ceiling"])
        except Exception:
            pass

        formant = call(snd, "To Formant (burg)", 0.0, 5, ceiling, 0.025, 50.0)
        f1 = call(formant, "Get mean", 1, t_start, t_end, "hertz")
        f2 = call(formant, "Get mean", 2, t_start, t_end, "hertz")

        if math.isnan(f1) or math.isnan(f2):
            return jsonify({"error": "No formants detected — try a different window or check audio quality"}), 400

        return jsonify({
            "f1": round(f1, 1),
            "f2": round(f2, 1),
            "duration_ms": round(duration * 1000, 1),
            "window_ms": [round(t_start * 1000, 1), round(t_end * 1000, 1)],
        })

    except Exception as e:
        return jsonify({"error": str(e)}), 500

    finally:
        os.unlink(tmp_path)


if __name__ == "__main__":
    print("IPA Formant Analysis Server")
    print("  Press Ctrl+C to stop\n")
    app.run(host="0.0.0.0", port=5000, debug=False)