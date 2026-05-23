/**
 * audio.js — Vowel sound synthesis and playVowel helper.
 * Loaded by both index.html and editor.html.
 *
 * Requires playUrl() to be defined by the loading page:
 *   index.html  → filters.js defines playUrl (with compare-mode logic)
 *   editor.html → inline script defines playUrl (simple playback)
 */

/**
 * Synthesize an approximation of a vowel from its two lowest formant frequencies
 * using a sawtooth oscillator through two bandpass filters.
 */
function synthesizeVowel(f1, f2, duration=0.65) {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.value = 120; // nominal speaking fundamental

        const makeBP = (freq, q) => {
            const f = ctx.createBiquadFilter();
            f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = q; return f;
        };
        const bp1 = makeBP(f1, 6),  g1 = ctx.createGain(); g1.gain.value = 0.85;
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
        osc.onended = () => ctx.close().catch(()=>{});
    } catch(e) { console.warn('Synthesis error:', e); }
}

/**
 * Play a vowel's audio. On the formant chart, synthesizes from F1/F2 when audio is absent.
 * @param {object} v      Vowel object (new format: v.audio, v.f1, v.f2)
 * @param {string} svgId  ID of the SVG element the click came from
 */
function playVowel(v, svgId) {
    if (v.audio) { playUrl(v.audio); return; }
    if (svgId === 'chartFormant' && v.f1 && v.f2) synthesizeVowel(v.f1, v.f2);
}