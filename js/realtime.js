/**
 * realtime.js — Phase 2 (fixed).
 *
 * Fixes vs previous:
 *   1. WS port changed to 5051 (standalone websockets server, not flask-sock)
 *   2. Ring buffer + 30ms timer — decouples capture granularity from analysis
 *      window, giving ~30fps trail updates instead of ~10fps
 *   3. Synthetic test uses sawtooth oscillator (harmonic source) instead of
 *      white noise — Praat's LPC needs periodicity, not noise
 */

const WS_URL   = (location.protocol==='https:'?'wss:':'ws:')+'//localhost:5051';
const HTTP_URL = 'http://localhost:5050';
const TRAIL_DOTS    = 50;     // keep last N voiced frames
const TRAIL_COLOR   = '#ffd700'; // gold — matches reference style

// Ring buffer config — separates "how often we capture" from "how much we analyze"
const SP_BUF         = 512;    // ScriptProcessor fires every 512/sr ≈ 11ms (small = responsive)
const DEFAULT_RMS_FLOOR = 0.005; // sent to server as rms_floor; 0 = gate disabled
const DEFAULT_MEDIAN_N  = 5;     // sent to server as median_n
const STREAK_MIN        = 1;     // consecutive voiced frames before adding to trail
// Ring buffer and send timer removed — server now does sliding-window analysis

class RealtimeTracker {
  constructor() {
    this.ws = this.audioCtx = this.workletNode = this.micStream = null;
    this.trail    = [];
    this.active   = false;
    this.rafId    = null;
    this.svgGroup = null;
    this.stats    = { frames:0, voiced:0, start:0 };
    // Streak stays client-side (display preference, not analysis)
    this._voicedStreak = 0;
    // Most recent frame from server — used for gate indicator in _stats()
    this._lastFrame    = null;
  }

  async start() {
    if (this.active) return;
    await this._openWS();
    await this._openMic();
    this.active        = true;
    this.stats         = { frames:0, voiced:0, start:Date.now() };
    this._voicedStreak = 0;
    this._lastFrame    = null;
    this._ensureGroup();
    this._raf();
    this._ui(true);
  }

  stop() {
    this.active = false;
    cancelAnimationFrame(this.rafId);
    this.rafId = null;
    try { this.workletNode?.disconnect(); } catch(_){}
    this.micStream?.getTracks().forEach(t=>t.stop());
    this.audioCtx?.close().catch(()=>{});
    try { this.ws?.close(); } catch(_){}
    this.ws = this.audioCtx = this.workletNode = this.micStream = null;

    // Don't _clearGroup() — that destroys the pool elements.
    // Just hide them and null the pool so _ensureGroup recreates on next start.
    if (this._dotPool) this._dotPool.forEach(el => el.setAttribute('opacity','0'));
    this._dotPool      = null;
    this.svgGroup      = null;
    this.trail         = [];
    this._voicedStreak = 0;
    this._lastFrame    = null;
    this._ui(false);
  }

  // ── WebSocket ─────────────────────────────────────────────────────────────
  _openWS() {
    return new Promise((res,rej)=>{
      const ws = new WebSocket(WS_URL);
      ws.binaryType = 'arraybuffer';
      const t = setTimeout(()=>{ ws.close(); rej(new Error('WS timeout — is server running on :5051?')); }, 3000);
      ws.onopen    = ()=>{ clearTimeout(t); this.ws=ws; res(); };
      ws.onmessage = e=>{ try{ this._msg(JSON.parse(e.data)); }catch(_){} };
      ws.onerror   = err=>{ clearTimeout(t); rej(new Error('WS connection failed — check server')); };
      ws.onclose   = ()=>{ if(this.active){ console.warn('WS closed'); this.stop(); } };
    });
  }

  // ── Mic (AudioWorklet with ScriptProcessor fallback) ─────────────────────
  async _openMic() {
    this.micStream = await navigator.mediaDevices.getUserMedia({
      audio:{ echoCancellation:false, noiseSuppression:false, autoGainControl:false },
      video:false,
    });
    this.audioCtx = new (window.AudioContext||window.webkitAudioContext)();
    const sr  = this.audioCtx.sampleRate;
    const src = this.audioCtx.createMediaStreamSource(this.micStream);
    if (this.ws?.readyState===WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type:'init', sample_rate:sr }));
      this.ws.send(JSON.stringify({
        type:      'config',
        rms_floor: DEFAULT_RMS_FLOOR,
        median_n:  DEFAULT_MEDIAN_N,
      }));
    }

    // AudioWorklet runs off main thread — no UI jitter
    try {
      await this.audioCtx.audioWorklet.addModule('js/audio-worklet.js');
      this.workletNode = new AudioWorkletNode(this.audioCtx,'chunk-processor',
          { processorOptions:{ chunkSize: SP_BUF } });
      this.workletNode.port.onmessage = e=>{
        if (this.active && e.data.type==='chunk') this._accumulate(e.data.data);
      };
      src.connect(this.workletNode);
      console.log('[Live] Using AudioWorklet (off main thread)');
    } catch(err) {
      console.warn('[Live] AudioWorklet unavailable, using ScriptProcessor:', err.message);
      const proc = this.audioCtx.createScriptProcessor(SP_BUF, 1, 1);
      proc.onaudioprocess = e=>{
        if (this.active) this._accumulate(e.inputBuffer.getChannelData(0));
      };
      src.connect(proc);
      proc.connect(this.audioCtx.destination);
      this.workletNode = proc;
    }
  }

  // ── Audio chunk handler — encode and send every chunk directly ──────────────
  // No client-side gate or calibration. The server applies rms_floor and
  // handles all analysis (Praat, continuity, median). Client just sends raw audio.
  _accumulate(float32) {
    if (!this.active || this.ws?.readyState !== WebSocket.OPEN) return;
    const i16 = new Int16Array(float32.length);
    for (let j = 0; j < float32.length; j++)
      i16[j] = Math.max(-32768, Math.min(32767, Math.round(float32[j] * 32768)));
    this.ws.send(i16.buffer);
  }



  // ── Handle server response ─────────────────────────────────────────────────
  // f1_median / f2_median are computed server-side (sliding median, median_n frames).
  // Streak tracking and trail management stay on the client (display preference).
  _msg(data) {
    const frames = data.frames || (data.voiced !== undefined ? [data] : []);
    for (const f of frames) {
      this.stats.frames++;
      this._lastFrame = f;   // retained for _stats() gate indicator

      if (!f.voiced) {
        if (this._voicedStreak > 0) {
          // First silent frame after voiced run — clear stale trail
          this.trail = [];
          if (this._dotPool) this._dotPool.forEach(el => el.setAttribute('opacity', '0'));
        }
        this._voicedStreak = 0;
        continue;
      }

      this.stats.voiced++;
      this._voicedStreak++;
      if (this._voicedStreak < STREAK_MIN) continue;

      // Smoothed values come from the server — no client-side median needed
      if (f.f1_median == null || f.f2_median == null) continue;
      this.trail.push({ f1: f.f1_median, f2: f.f2_median });
      if (this.trail.length > TRAIL_DOTS) this.trail.shift();
    }
  }

  // ── Trail rendering at screen refresh rate ────────────────────────────────
  _raf() {
    const tick = ()=>{
      if (!this.active) return;
      this._draw();
      this._stats();
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  _ensureGroup() {
    const svg = document.getElementById('chartFormant'); if(!svg) return;
    let g = svg.querySelector('#rt-trail-group');
    if (!g || !this._dotPool) {
      if (g) g.remove();   // remove stale empty group
      g = $s('g', { id:'rt-trail-group', style:'pointer-events:none' });
      svg.appendChild(g);
      // Pre-allocate dot pool — updated in place every frame, no createElement overhead
      this._dotPool = Array.from({ length: TRAIL_DOTS + 1 }, () => {
        const c = $s('circle', { cx:'0', cy:'0', r:'4', fill:TRAIL_COLOR, opacity:'0' });
        g.appendChild(c);
        return c;
      });
    }
    this.svgGroup = g;
  }

  _draw() {
    if (!this.svgGroup || !this._dotPool) return;
    const n = this.trail.length;
    // Update pre-allocated pool in place — no DOM creation, no GC, smooth RAF
    this._dotPool.forEach((el, i) => {
      if (i >= n) { el.setAttribute('opacity','0'); return; }
      const p      = this.trail[i];
      const {x, y} = formantPos(p.f1, p.f2);
      const isCur  = i === n - 1;
      el.setAttribute('cx', x.toFixed(1));
      el.setAttribute('cy', y.toFixed(1));
      el.setAttribute('r',  isCur ? '9' : '4');
      // Reference-style opacity: index/total * 0.7, current solid
      el.setAttribute('opacity', isCur ? '0.95' : ((i / n) * 0.7).toFixed(3));
    });
  }

  _stats() {
    const el = document.getElementById('rtStats'); if(!el) return;
    const s   = this.stats;
    const fps = (s.frames / Math.max(1, (Date.now() - s.start) / 1000)).toFixed(1);
    const pct = s.frames ? Math.round(s.voiced / s.frames * 100) : 0;
    const r   = this.trail.slice(-5);
    const f1  = r.length ? Math.round(r.reduce((a, p) => a + p.f1, 0) / r.length) : '—';
    const f2  = r.length ? Math.round(r.reduce((a, p) => a + p.f2, 0) / r.length) : '—';
    // Gate status comes from the server frame (is_above_rms reflects server rms_floor)
    const gate = !this._lastFrame         ? '⏳ connecting…'
        : this._lastFrame.is_above_rms ? '🟢 speech'
            :                           '🔴 silence';
    el.textContent = `${gate}  ·  ${fps} fr/s  ·  ${pct}% voiced  ·  F1 ${f1}  F2 ${f2} Hz`;
  }

  _ui(on) {
    const btn = document.getElementById('ppLive');
    if (btn) { btn.textContent=on?'⏹ Live':'⬤ Live'; btn.classList.toggle('rec-active',on); }
    const st = document.getElementById('rtStats'); if(st) st.style.display=on?'block':'none';
    if (on) document.getElementById('tabFormant')?.click();
  }
}

const liveTracker = new RealtimeTracker();
function startLive()  { liveTracker.start().catch(e=>alert('Live mode: '+e.message)); }
function stopLive()   { liveTracker.stop(); }
function toggleLive() { liveTracker.active ? stopLive() : startLive(); }


// ─── Synthetic vowel verification ────────────────────────────────────────────
// Cascade resonator + impulse train (Klatt source-filter model).
// This is how proper speech synthesis works and is reliably analyzable by LPC.
// Each resonator is a 2nd-order IIR all-pole filter at the given formant frequency.

function resonatorFilter(x, freq, bw, sr) {
  // H(z) = 1 / (1 - 2r·cos(2πF/sr)·z⁻¹ + r²·z⁻²)  where r = e^(-π·B/sr)
  const r  = Math.exp(-Math.PI * bw / sr);
  const a1 = 2 * r * Math.cos(2 * Math.PI * freq / sr);
  const a2 = -(r * r);
  const y  = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    y[i] = x[i]
        + (i > 0 ? a1 * y[i-1] : 0)
        + (i > 1 ? a2 * y[i-2] : 0);
  }
  return y;
}

async function buildSynthBuffer(f1, f2, dur=0.6) {
  const SR  = 22050;
  // Adaptive F0: choose so harmonic n0 lands exactly on F1.
  // n0*F0 = F1, keeping F0 in the 80-130Hz realistic vocal range.
  // This eliminates the pre-emphasis-induced F1 overestimation that occurs
  // when F1 sits between two harmonics and the higher one gets boosted.
  const n0 = Math.max(2, Math.round(f1 / 100));
  const F0 = f1 / n0;   // n0-th harmonic lands exactly on F1
  const len = Math.round(SR * dur);

  // Glottal impulse train — one impulse every period
  const source = new Float32Array(len);
  const period = Math.round(SR / F0);
  for (let i = 0; i < len; i += period) source[i] = 1.0;

  // F3 well above F2 — lip rounding raises it for back vowels too
  const F3 = Math.max(f2 * 2.2, 2200);

  // Cascade of three resonators (source → F1 resonator → F2 resonator → F3 resonator)
  // Bandwidth: B1 ≈ 10% of F1, B2 ≈ 7% of F2, B3 fixed at 200Hz
  let sig = resonatorFilter(source, f1, Math.max(50, f1 * 0.10), SR);
  sig     = resonatorFilter(sig,    f2, Math.max(60, f2 * 0.07), SR);
  sig     = resonatorFilter(sig,    F3, 200, SR);

  // Normalize to ±0.8 to avoid clipping
  const peak = sig.reduce((m, v) => Math.max(m, Math.abs(v)), 1e-9);
  for (let i = 0; i < sig.length; i++) sig[i] *= 0.8 / peak;

  // Wrap in AudioBuffer via OfflineAudioContext (required for encodeWAV compatibility)
  const ctx = new OfflineAudioContext(1, len, SR);
  const buf = ctx.createBuffer(1, len, SR);
  buf.getChannelData(0).set(sig);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start(0);

  return { buffer: await ctx.startRendering(), sampleRate: SR };
}

function playSynthBuffer({buffer}) {
  return new Promise(res=>{
    const ctx=new AudioContext(), src=ctx.createBufferSource();
    src.buffer=buffer; src.connect(ctx.destination);
    src.onended=()=>{ ctx.close(); res(); };
    src.start(0);
  });
}

async function analyzeSynthBuffer({buffer, sampleRate}) {
  const wav  = encodeWAV(buffer.getChannelData(0), sampleRate);
  const resp = await fetch(`${HTTP_URL}/analyze`,{
    method:'POST',
    headers:{'Content-Type':'audio/wav','X-Window-Start':'0.1','X-Window-End':'0.9'},
    body:wav,
  });
  if (!resp.ok) throw new Error((await resp.json()).error||resp.status);
  return resp.json();
}

async function testSyntheticVowel(tF1, tF2, opts={}) {
  const { play=true, quiet=false } = opts;
  if (!quiet) console.log(`  → Synth F1=${tF1} F2=${tF2}…`);
  const synth = await buildSynthBuffer(tF1, tF2);
  const [result] = await Promise.all([
    analyzeSynthBuffer(synth).catch(e=>({error:e.message})),
    play ? playSynthBuffer(synth) : Promise.resolve(),
  ]);
  if (result.error) { if(!quiet) console.warn('  ✗',result.error); return null; }
  const eF1=result.f1-tF1, eF2=result.f2-tF2;
  const pF1=Math.abs(eF1/tF1*100), pF2=Math.abs(eF2/tF2*100);
  const gF1=pF1<5?'PASS':pF1<15?'WARN':'FAIL';
  const gF2=pF2<8?'PASS':pF2<15?'WARN':'FAIL';
  const r={
    expected:{f1:tF1,f2:tF2}, measured:{f1:result.f1,f2:result.f2},
    error:{f1:eF1,f2:eF2}, errorPct:{f1:pF1.toFixed(1),f2:pF2.toFixed(1)},
    grade:{f1:gF1,f2:gF2,overall:gF1==='FAIL'||gF2==='FAIL'?'FAIL':gF1==='WARN'||gF2==='WARN'?'WARN':'PASS'},
  };
  if (!quiet) {
    const s=g=>g==='PASS'?'✓':g==='WARN'?'~':'✗';
    console.log(`    F1: ${s(gF1)} got ${result.f1} (${eF1>=0?'+':''}${eF1}Hz, ${pF1.toFixed(1)}%) [${gF1}]`);
    console.log(`    F2: ${s(gF2)} got ${result.f2} (${eF2>=0?'+':''}${eF2}Hz, ${pF2.toFixed(1)}%) [${gF2}]`);
  }
  return r;
}

const CARDINALS = [
  {ipa:'i',f1:240,f2:2400},{ipa:'e',f1:390,f2:2300},{ipa:'ɛ',f1:610,f2:1900},
  {ipa:'a',f1:850,f2:1610},{ipa:'ɔ',f1:590,f2:920}, {ipa:'o',f1:360,f2:760},
  {ipa:'u',f1:250,f2:595},
];

async function runVerificationSuite(opts={}) {
  const { play=true } = opts;
  const phase = 'Phase 2b-fix (dual-ceiling, continuity+EMA, cascade resonator + adaptive F0)';
  console.log(`\n═══ Verification Suite: ${phase} ═══`);
  const rows=[];
  for (const c of CARDINALS) {
    console.log(`  /${c.ipa}/  F1=${c.f1}  F2=${c.f2}`);
    const r = await testSyntheticVowel(c.f1,c.f2,{play,quiet:true});
    if (r) rows.push({ipa:c.ipa,...r});
    if (play) await new Promise(res=>setTimeout(res,300));
    await new Promise(res=>setTimeout(res,80));
  }
  console.log('\n── Results ──');
  console.table(rows.map(r=>({
    ipa:r.ipa,'F1 exp':r.expected.f1,'F1 got':r.measured.f1,
    'F1 err':`${r.error.f1>=0?'+':''}${r.error.f1}Hz`,'F1%':r.errorPct.f1+'%','F1✓':r.grade.f1,
    'F2 exp':r.expected.f2,'F2 got':r.measured.f2,
    'F2 err':`${r.error.f2>=0?'+':''}${r.error.f2}Hz`,'F2%':r.errorPct.f2+'%','F2✓':r.grade.f2,
    '★':r.grade.overall,
  })));
  // ASCII scatter
  const W=48,H=18,grid=Array.from({length:H},()=>Array(W).fill('·'));
  const toC=f2=>Math.max(0,Math.min(W-1,Math.round((3000-f2)/(3000-400)*(W-1))));
  const toR=f1=>Math.max(0,Math.min(H-1,Math.round((f1-150)/(1000-150)*(H-1))));
  rows.forEach(r=>{
    grid[toR(r.expected.f1)][toC(r.expected.f2)]=r.ipa;
    const mr=toR(r.measured.f1),mc=toC(r.measured.f2);
    if(grid[mr][mc]==='·') grid[mr][mc]=r.grade.overall==='PASS'?'+':'×';
  });
  console.log('\n── F1/F2 plane (letter=expected, +=pass, ×=fail) ──');
  console.log('     F2→  front'+' '.repeat(W-17)+'back');
  grid.forEach((row,i)=>console.log(`  F1=${String(Math.round(150+i/(H-1)*850)).padStart(4)}  ${row.join('')}`));
  // JSON blob
  const pF1=rows.filter(r=>r.grade.f1==='PASS').length;
  const pF2=rows.filter(r=>r.grade.f2==='PASS').length;
  const mF1=(rows.reduce((a,r)=>a+parseFloat(r.errorPct.f1),0)/rows.length).toFixed(1);
  const mF2=(rows.reduce((a,r)=>a+parseFloat(r.errorPct.f2),0)/rows.length).toFixed(1);
  const blob={phase,config:{ceiling_front:4200,n_front:3,ceiling_back:1800,n_back:2,ema_alpha:0.35,continuity:true,source:'cascade_resonator_adaptive_F0'},
    score:{f1_pass:`${pF1}/${rows.length}`,f2_pass:`${pF2}/${rows.length}`,mean_f1_pct:mF1,mean_f2_pct:mF2},
    results:rows.map(r=>({ipa:r.ipa,
      f1:{exp:r.expected.f1,got:r.measured.f1,err:r.error.f1,pct:r.errorPct.f1,g:r.grade.f1},
      f2:{exp:r.expected.f2,got:r.measured.f2,err:r.error.f2,pct:r.errorPct.f2,g:r.grade.f2},ok:r.grade.overall}))};
  console.log('\n── PASTE INTO NEXT CONVERSATION ──');
  console.log(JSON.stringify(blob,null,2));
  console.log('──────────────────────────────────\n');
  return blob;
}


// ─── Real-speech verification using IPA audio from the app ───────────────────
/**
 * verifyFromIpaAudio(langKey, opts)
 *
 * THIS IS THE PRIMARY VERIFICATION METHOD for real-speech accuracy.
 * It fetches the IPA audio files already loaded in the app, analyses them
 * with the server, and compares against the f1/f2 values in lang.json.
 *
 * This is better than the synthetic test because:
 *   1. Real human speech — same characteristics Praat needs to handle live
 *   2. Reference values are the app's own targets (no population-average mismatch)
 *   3. Tests the complete pipeline end-to-end
 *
 * Usage (browser console):
 *   verifyFromIpaAudio('en')          // English vowels
 *   verifyFromIpaAudio('de')          // German vowels
 *   verifyFromIpaAudio('cardinal')    // IPA cardinal vowels
 *
 * Requires: LANGS object loaded, server running on HTTP_URL
 */
async function verifyFromIpaAudio(langKey, opts={}) {
  const { play=false, quiet=false } = opts;
  const lang = LANGS[langKey];
  if (!lang) { console.error(`Language "${langKey}" not loaded`); return null; }

  const vowels = (lang.vowels||[]).filter(v=>v.ipaAudio && v.f1 && v.f2);
  if (!vowels.length) { console.error('No vowels with both ipaAudio and f1/f2 in', langKey); return null; }

  const phase = `Real-speech (${lang.label||langKey} IPA audio)`;
  console.log(`
═══ Verification: ${phase} ═══`);
  console.log(`Testing ${vowels.length} vowels with f1/f2 reference…
`);

  const rows = [];
  for (const v of vowels) {
    if (!quiet) console.log(`  /${v.ipa}/ …`);
    try {
      // Fetch and decode the audio file
      const resp = await fetch(v.ipaAudio);
      if (!resp.ok) { console.warn(`  /${v.ipa}/ — fetch failed (${resp.status})`); continue; }
      const arrayBuf = await resp.arrayBuffer();
      const ctx      = new (window.AudioContext||window.webkitAudioContext)();
      const audioBuf = await ctx.decodeAudioData(arrayBuf);
      ctx.close().catch(()=>{});

      const float32 = audioBuf.getChannelData(0);

      // Optionally play the audio
      if (play) {
        const pCtx = new AudioContext();
        const pBuf = pCtx.createBuffer(1, float32.length, audioBuf.sampleRate);
        pBuf.getChannelData(0).set(float32);
        const src = pCtx.createBufferSource(); src.buffer=pBuf; src.connect(pCtx.destination);
        src.onended = ()=>pCtx.close();
        src.start(0);
        await new Promise(res=>setTimeout(res, Math.min(2000, audioBuf.duration*1000+300)));
      }

      // Encode as WAV and send to server
      const wav  = encodeWAV(float32, audioBuf.sampleRate);
      const sResp = await fetch(`${HTTP_URL}/analyze`, {
        method: 'POST',
        headers: { 'Content-Type':'audio/wav', 'X-Window-Start':'0.15', 'X-Window-End':'0.85' },
        body: wav,
      });

      if (!sResp.ok) {
        const err = await sResp.json();
        console.warn(`  /${v.ipa}/ — server error: ${err.error}`);
        continue;
      }
      const measured = await sResp.json();

      const eF1  = measured.f1 - v.f1, eF2 = measured.f2 - v.f2;
      const pF1  = Math.abs(eF1/v.f1*100), pF2 = Math.abs(eF2/v.f2*100);
      const gF1  = pF1<5?'PASS':pF1<15?'WARN':'FAIL';
      const gF2  = pF2<8?'PASS':pF2<15?'WARN':'FAIL';
      const overall = gF1==='FAIL'||gF2==='FAIL'?'FAIL':gF1==='WARN'||gF2==='WARN'?'WARN':'PASS';
      rows.push({
        ipa: v.ipa, desc: (v.desc||'').slice(0,28),
        expected:{f1:v.f1,f2:v.f2}, measured:{f1:measured.f1,f2:measured.f2},
        error:{f1:eF1,f2:eF2}, errorPct:{f1:pF1.toFixed(1),f2:pF2.toFixed(1)},
        grade:{f1:gF1,f2:gF2,overall},
      });
      if (!quiet) {
        const s=g=>g==='PASS'?'✓':g==='WARN'?'~':'✗';
        console.log(`  /${v.ipa}/ F1: ${s(gF1)} ${v.f1}→${measured.f1} (${eF1>=0?'+':''}${eF1}Hz ${pF1.toFixed(1)}%)  F2: ${s(gF2)} ${v.f2}→${measured.f2} (${eF2>=0?'+':''}${eF2}Hz ${pF2.toFixed(1)}%) [${overall}]`);
      }
    } catch(e) { console.warn(`  /${v.ipa}/ — error: ${e.message}`); }
    await new Promise(res=>setTimeout(res, 100));
  }

  if (!rows.length) { console.log('No results.'); return null; }

  // Table
  console.log('\n── Results ──');
  console.table(rows.map(r=>({
    ipa:r.ipa, desc:r.desc,
    'F1 ref':r.expected.f1,'F1 got':r.measured.f1,'F1%':r.errorPct.f1+'%','F1✓':r.grade.f1,
    'F2 ref':r.expected.f2,'F2 got':r.measured.f2,'F2%':r.errorPct.f2+'%','F2✓':r.grade.f2,
    '★':r.grade.overall,
  })));

  const pF1=rows.filter(r=>r.grade.f1==='PASS').length;
  const pF2=rows.filter(r=>r.grade.f2==='PASS').length;
  const mF1=(rows.reduce((a,r)=>a+parseFloat(r.errorPct.f1),0)/rows.length).toFixed(1);
  const mF2=(rows.reduce((a,r)=>a+parseFloat(r.errorPct.f2),0)/rows.length).toFixed(1);

  const blob = {
    phase, lang:langKey,
    config:{ceiling_front:4200,ceiling_back:1800,ema_alpha:0.35,continuity:true},
    score:{f1_pass:`${pF1}/${rows.length}`,f2_pass:`${pF2}/${rows.length}`,mean_f1_pct:mF1,mean_f2_pct:mF2},
    results:rows.map(r=>({
      ipa:r.ipa,
      f1:{ref:r.expected.f1,got:r.measured.f1,err:r.error.f1,pct:r.errorPct.f1,g:r.grade.f1},
      f2:{ref:r.expected.f2,got:r.measured.f2,err:r.error.f2,pct:r.errorPct.f2,g:r.grade.f2},
      ok:r.grade.overall,
    })),
  };
  console.log('\n── PASTE INTO NEXT CONVERSATION ──');
  console.log(JSON.stringify(blob,null,2));
  console.log('──────────────────────────────────\n');
  return blob;
}

// ─── Debug helper — paste in browser console ─────────────────────────────────
// debugVowel('lang/me/audio/i.wav')  →  shows raw Praat formant values
async function debugVowel(audioUrl) {
  const resp = await fetch(audioUrl);
  const ab   = await resp.arrayBuffer();
  const ctx  = new (window.AudioContext || window.webkitAudioContext)();
  const buf  = await ctx.decodeAudioData(ab);
  ctx.close();
  const wav  = encodeWAV(buf.getChannelData(0), buf.sampleRate);
  const r    = await fetch(`${HTTP_URL}/analyze-debug`, {
    method: 'POST',
    headers: { 'Content-Type':'audio/wav', 'X-Window-Start':'0.15', 'X-Window-End':'0.85' },
    body: wav,
  });
  const data = await r.json();
  console.log(JSON.stringify(data, null, 2));
  return data;
}

// ─── Smoothing cross-check utility ───────────────────────────────────────────
// Feeds a WS reference file through the real RealtimeTracker._msg() pipeline
// and returns the trail that would appear on screen.
//
// Use this ONCE before the server-side median migration to capture the
// JS reference, then compare to Python's compute_smooth_reference() output.
//
// Usage (browser console on any page that loads realtime.js):
//   const t = await verifySmoothing('tests/references/ws/i_128.json');
//   console.log(JSON.stringify(t.trail));
//
// Compare that output to the Python test:
//   python tests/server_tests.py ws --smooth-check i_128
//
async function verifySmoothing(referenceUrl) {
  const ref     = await fetch(referenceUrl).then(r => r.json());
  const frames  = ref.response?.frames ?? [];
  const tracker = new RealtimeTracker();   // no DOM access in constructor or _msg

  for (const frame of frames) {
    tracker._msg({ frames: [frame] });     // exact same path as live streaming
  }

  const result = {
    reference:  referenceUrl,
    n_input:    frames.length,
    trail:      tracker.trail,             // [{f1, f2}, ...] — what would be drawn
    stats:      tracker.stats,
    median_n:   DEFAULT_MEDIAN_N,
  };
  console.log('verifySmoothing →', JSON.stringify(result, null, 2));
  return result;
}