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

/**
 * Builds a DOM node rendering a sample's text with its tokens' char ranges
 * highlighted (hover-darken, click-to-play-that-token's-slice); clicking
 * anywhere else in the text calls onFullPlay (if given). Originally the
 * public viewer/language-editor's shared card-rendering helper (js/charts.js's
 * renderDetail/editor-vowels.js's pseudo-sample cards) — moved here so the
 * Sound/Token browsers can reuse the exact same thing without pulling in
 * charts.js's page-specific globals (LANGS, filters, etc).
 * @param {object} smp — {text, tokens:[{symbol, position:[start,end], analysis:{f1,f2}}]}
 * @param {string[]|null} filterSymbols — only highlight tokens whose symbol is in this list (null = all)
 * @param {string} langColor — hex color for the highlight tint
 * @param {function} [onFullPlay] — called when a non-token character is clicked
 */
function buildDetailHighlightedText(smp, filterSymbols, langColor, onFullPlay) {
  const text=smp.text||''; const c=langColor;
  const div=document.createElement('div');
  div.style.cssText='font-family:Georgia,serif;line-height:1.65;word-break:break-word';
  const toks=(smp.tokens||[]).filter(t=>!filterSymbols||filterSymbols.includes(t.symbol));
  if (!text) { div.textContent='?'; return div; }
  const charTok=new Array(text.length).fill(null);
  toks.forEach(tok=>{ const [ps,pe]=tok.position||[0,0]; for(let i=ps;i<Math.min(pe,text.length);i++) charTok[i]=tok; });
  let i=0;
  while (i<text.length) {
    const tok=charTok[i]; let j=i+1;
    while (j<text.length&&charTok[j]===tok) j++;
    const seg=document.createElement('span'); seg.textContent=text.slice(i,j);
    if (tok) {
      seg.style.cssText=`background:${c}28;color:${c};border-radius:2px;padding:0 1px;cursor:pointer;transition:background .1s`;
      seg.addEventListener('mouseenter',()=>seg.style.background=c+'50');
      seg.addEventListener('mouseleave',()=>seg.style.background=c+'28');
      const f=tok.analysis;
      seg.title=f?.f1?`/${tok.symbol}/  F1 ${f.f1} · F2 ${f.f2} Hz`:`/${tok.symbol}/`;
      seg.addEventListener('click',e=>{e.stopPropagation();playTokenSlice(smp,tok);});
    } else if (onFullPlay) {
      seg.style.cursor='pointer';
      seg.addEventListener('click',e=>{e.stopPropagation();onFullPlay();});
    }
    div.appendChild(seg); i=j;
  }
  return div;
}

// ─── Build the old samples.json-shaped array straight from the DB ─────────────
// js/lang.js's bootstrap fetches `/api/v1/tokens?languageId=`/`/api/v1/sounds`
// instead of a static samples.json now — this adapts that DB shape back into
// exactly what LANG_SAMPLES/findRepresentativeSample/renderTokenLayer/
// buildDetailHighlightedText already expect, so none of those (proven,
// shared) consumers need to change at all. `sampleId`s with no token yet but
// that ARE some vowel's representative are still included (representative-
// only playback must work even before anyone's tagged a token in it).
function buildPseudoSamplesFromDb(tokens, sounds, vowels) {
  const soundsById = new Map((sounds || []).map(s => [s.id, s]));
  const bySample = new Map();
  const ensure = (sampleId, fallbackText, fallbackAudio) => {
    if (bySample.has(sampleId)) return bySample.get(sampleId);
    const smp = soundsById.get(sampleId);
    const entry = {
      id: sampleId, text: smp?.text ?? fallbackText ?? '', audio: smp?.audioUrl ?? fallbackAudio ?? null,
      phonemic: smp?.phonemic || null, representative: null, tokens: [],
    };
    bySample.set(sampleId, entry);
    return entry;
  };
  for (const t of (tokens || [])) {
    const smp = ensure(t.sampleId, t.sampleText, t.audioUrl);
    smp.tokens.push({
      symbol: t.symbol, position: [t.charStart ?? 0, t.charEnd ?? 0],
      analysis: (t.f1 != null && t.f2 != null)
        ? { f1: t.f1, f2: t.f2, slice: (t.timeStartMs != null && t.timeEndMs != null) ? [t.timeStartMs, t.timeEndMs] : null }
        : null,
    });
  }
  for (const v of (vowels || [])) {
    if (v.representativeSampleId == null) continue;
    const smp = ensure(v.representativeSampleId);
    smp.representative = v.symbols?.[0] || smp.representative;
  }
  return Array.from(bySample.values());
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
    // IPA chart / other: DB-assigned representative sample (Phase 5d) first,
    // then the vowel's own inline audio, then the old samples.json-based
    // lookup — kept only as a last resort for anything not yet DB-assigned.
    if (v.representativeAudioUrl) { playUrl(v.representativeAudioUrl); return; }
    if (v.audio) { playUrl(v.audio); return; }
    if (lk) {
        const rep = findRepresentativeSample(v.symbols, lk);
        if (rep?.audio) { playUrl(rep.audio); return; }
    }
}

// ─── WAV blob encoder (shared: editor + viewer trace + shadow.js + ingest.js) ──
function encodeWavBlob(samples, sr) {
    const buf = new ArrayBuffer(44 + samples.length * 2);
    const v   = new DataView(buf);
    const w16 = (o,x) => v.setInt16(o,x,true);
    const w32 = (o,x) => v.setUint32(o,x,true);
    const wr  = (o,s) => { for(let i=0;i<s.length;i++) v.setUint8(o+i,s.charCodeAt(i)); };
    wr(0,'RIFF'); w32(4,36+samples.length*2); wr(8,'WAVE');
    wr(12,'fmt '); w32(16,16); w16(20,1); w16(22,1);
    w32(24,sr); w32(28,sr*2); w16(32,2); w16(34,16);
    wr(36,'data'); w32(40,samples.length*2);
    let offset=44;
    for(let i=0;i<samples.length;i++){
        const s16=Math.max(-32768,Math.min(32767,samples[i]*32768));
        v.setInt16(offset,s16,true); offset+=2;
    }
    return new Blob([buf],{type:'audio/wav'});
}

// ─── Mono slice extraction (shared: shadow.js has its own identical copies
// today — js/vad.js, a later phase, will consolidate those too) ───────────────
function computeMonoData(buffer) {
    if (buffer.numberOfChannels === 1) return buffer.getChannelData(0);
    const n = buffer.length;
    const out = new Float32Array(n);
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
        const data = buffer.getChannelData(ch);
        for (let i = 0; i < n; i++) out[i] += data[i] / buffer.numberOfChannels;
    }
    return out;
}

function extractMonoSlice(buffer, startMs, endMs) {
    const sr = buffer.sampleRate;
    const data = computeMonoData(buffer);
    const i0 = Math.floor(startMs / 1000 * sr), i1 = Math.min(data.length, Math.ceil(endMs / 1000 * sr));
    return { samples: data.slice(i0, i1), sampleRate: sr };
}