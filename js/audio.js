/**
 * audio.js — Audio playback, synthesis, and representative sample lookup.
 * Loaded by index.html and editor.html.
 *
 * playUrl() is provided by the page:
 *   index.html  → filters.js (with compare-mode logic)
 *   editor.html → inline script (simple playback)
 *
 * LANG_SAMPLES is populated by:
 *   lang.js        → setLangSamples(lk, samples) after fetching samples.json
 *   editor-lang.js → setLangSamples(lk, samples) after selectLang
 */

// ─── Samples store (shared between viewer + editor) ───────────────────────────
const LANG_SAMPLES = {};   // lk → samples array

function setLangSamples(lk, samples) {
    LANG_SAMPLES[lk] = samples || [];
}

/** Find the representative sample for a vowel's symbol list, in a given language. */
function findRepresentativeSample(symbols, lk) {
    return (LANG_SAMPLES[lk] || []).find(s => symbols?.includes(s.representative)) || null;
}

// ─── Audio decode cache (shared for card + slice playback) ───────────────────
const _audioCache = {};   // url → { samples: Float32Array, sampleRate }

async function fetchDecodeAudio(url) {
    if (_audioCache[url]) return _audioCache[url];
    // Use XHR — works with local servers that don't send CORS headers for fetch()
    const ab = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', url); xhr.responseType = 'arraybuffer';
        xhr.onload  = () => xhr.status < 400 ? resolve(xhr.response) : reject(new Error('HTTP ' + xhr.status));
        xhr.onerror = () => reject(new Error('Network error'));
        xhr.send();
    });
    const actx = new (window.AudioContext || window.webkitAudioContext)();
    const dec  = await actx.decodeAudioData(ab);
    actx.close();
    return (_audioCache[url] = { samples: dec.getChannelData(0), sampleRate: dec.sampleRate });
}

/**
 * Play a token's analyzed slice from a sample.
 * Uses <audio>.currentTime to avoid CORS restrictions on HTTP audio sources.
 * @param {object} sample  — sample object with .audio
 * @param {object} tok     — token object with .analysis.slice = [startMs, endMs]
 */
async function playTokenSlice(sample, tok) {
    if (!sample?.audio || !tok?.analysis?.slice) {
        if (typeof toast === 'function') toast('No audio or slice for this token');
        return;
    }
    const [startMs, endMs] = tok.analysis.slice;
    try {
        // Decode PCM → extract exact slice → play via BufferSource (sample-perfect, same as waveform editor)
        const wav  = await fetchDecodeAudio(sample.audio);
        const i0   = Math.floor(startMs / 1000 * wav.sampleRate);
        const i1   = Math.ceil( endMs   / 1000 * wav.sampleRate);
        const actx = new (window.AudioContext || window.webkitAudioContext)();
        const buf  = actx.createBuffer(1, i1 - i0, wav.sampleRate);
        buf.getChannelData(0).set(wav.samples.slice(i0, i1));
        const src  = actx.createBufferSource();
        src.buffer = buf; src.connect(actx.destination); src.start();
        src.onended = () => actx.close();
    } catch(e) {
        // Fallback: <audio> element with RAF polling when decode isn't available
        console.warn('playTokenSlice decode failed, falling back to <audio>:', e);
        const endSec = endMs / 1000;
        const audio  = new Audio(sample.audio);
        audio.currentTime = startMs / 1000;
        audio.play().catch(() => {});
        const tick = () => {
            if (audio.paused || audio.ended) return;
            if (audio.currentTime >= endSec) { audio.pause(); return; }
            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    }
}

// ─── Vowel synthesis ──────────────────────────────────────────────────────────
function synthesizeVowel(f1, f2, duration = 0.65) {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth'; osc.frequency.value = 120;
        const makeBP = (freq, q) => {
            const f = ctx.createBiquadFilter();
            f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = q; return f;
        };
        const bp1 = makeBP(f1, 6), g1 = ctx.createGain(); g1.gain.value = 0.85;
        const bp2 = makeBP(f2, 10), g2 = ctx.createGain(); g2.gain.value = 0.55;
        const master = ctx.createGain();
        const t = ctx.currentTime;
        master.gain.setValueAtTime(0, t);
        master.gain.linearRampToValueAtTime(0.28, t + 0.04);
        master.gain.setValueAtTime(0.28, t + duration - 0.08);
        master.gain.linearRampToValueAtTime(0, t + duration);
        osc.connect(bp1); bp1.connect(g1); g1.connect(master);
        osc.connect(bp2); bp2.connect(g2); g2.connect(master);
        master.connect(ctx.destination);
        osc.start(t); osc.stop(t + duration);
        osc.onended = () => ctx.close().catch(() => {});
    } catch(e) { console.warn('Synthesis error:', e); }
}

/**
 * Play a vowel:
 *  1. Use vowel's own audio if present
 *  2. Use representative sample audio for this language (if lk provided)
 *  3. Synthesize from F1/F2 (formant chart only)
 */
function playVowel(v, svgId, lk) {
    // Formant chart: always synthesize at the exact plotted F1/F2
    if (svgId === 'chartFormant' && v.f1 && v.f2) { synthesizeVowel(v.f1, v.f2); return; }
    // IPA chart / other: use representative sample audio, then own audio
    if (v.audio) { playUrl(v.audio); return; }
    if (lk) {
        const rep = findRepresentativeSample(v.symbols, lk);
        if (rep?.audio) { playUrl(rep.audio); return; }
    }
}