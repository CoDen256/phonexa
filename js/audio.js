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
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const actx = new (window.AudioContext || window.webkitAudioContext)();
    const dec  = await actx.decodeAudioData(await resp.arrayBuffer());
    actx.close();
    return (_audioCache[url] = { samples: dec.getChannelData(0), sampleRate: dec.sampleRate });
}

/**
 * Play a token's analyzed slice from a sample.
 * Uses <audio>.currentTime to avoid CORS restrictions on HTTP audio sources.
 * @param {object} sample  — sample object with .audio
 * @param {object} tok     — token object with .analysis.slice = [startMs, endMs]
 */
function playTokenSlice(sample, tok) {
    if (!sample?.audio || !tok?.analysis?.slice) {
        if (typeof toast === 'function') toast('No audio or slice for this token');
        return;
    }
    const [startMs, endMs] = tok.analysis.slice;
    const audio = new Audio(sample.audio);
    audio.currentTime = startMs / 1000;
    audio.play().catch(e => { console.warn('playTokenSlice:', e); if (typeof toast === 'function') toast('Playback failed'); });
    // Poll to stop at slice end (ontimeupdate fires ~4× per second)
    audio.ontimeupdate = () => {
        if (audio.currentTime >= endMs / 1000) { audio.pause(); audio.ontimeupdate = null; }
    };
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
    if (v.audio) { playUrl(v.audio); return; }
    if (lk) {
        const rep = findRepresentativeSample(v.symbols, lk);
        if (rep?.audio) { playUrl(rep.audio); return; }
    }
    if (svgId === 'chartFormant' && v.f1 && v.f2) synthesizeVowel(v.f1, v.f2);
}