/**
 * realtime.js — Real-time formant streaming and trail display.
 *
 * Connects to analyze_server.py's /stream WebSocket, streams mic audio,
 * and draws a fading formant trail on the formant chart SVG.
 *
 * Also provides testSyntheticVowel(f1, f2) for objective algorithm
 * verification without needing any external tools.
 *
 * Dependencies: geometry.js (formantPos, FP, F1MIN/MAX, F2MIN/MAX),
 *               utils.js ($s)
 *
 * Usage:
 *   liveTracker.start()   // connect WebSocket + open mic
 *   liveTracker.stop()    // disconnect and clean up
 *   testSyntheticVowel(500, 1800)  // calibration check
 */

// ─── WebSocket URL (matches analyze_server.py port) ──────────────────────────
const WS_URL = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//localhost:5050/stream';
const HTTP_URL = 'http://localhost:5050';

// ─── Trail display constants ──────────────────────────────────────────────────
const TRAIL_MAX_MS   = 3000;   // how long a trail point lives (ms)
const TRAIL_COLOR    = '#34d399';  // green — distinct from vowel dots
const TRAIL_DOT_R    = 4;
const TRAIL_HEAD_R   = 9;      // most recent point is larger
const CHUNK_SIZE     = 4096;   // ScriptProcessor buffer size (samples)
                               // ~93ms at 44100Hz — fine for Phase 1

// ─── RealtimeTracker ─────────────────────────────────────────────────────────
class RealtimeTracker {
  constructor() {
    this.ws        = null;
    this.audioCtx  = null;
    this.processor = null;
    this.micStream = null;
    this.trail     = [];   // [{f1, f2, t}]   t = Date.now() when received
    this.active    = false;
    this.rafId     = null;
    this.svgGroup  = null; // <g> element in the SVG
    this.stats     = { frames: 0, voiced: 0, start: 0 };

    // Phase 2: EMA state (stored here, updated on each voiced frame)
    // this._emaF1 = null;
    // this._emaF2 = null;
  }

  // ── Start streaming ──────────────────────────────────────────────────────────
  async start() {
    if (this.active) return;
    try {
      await this._openWebSocket();
      await this._openMic();
      this.active = true;
      this.stats  = { frames: 0, voiced: 0, start: Date.now() };
      this._ensureSvgGroup();
      this._scheduleRender();
      this._updateUI(true);
    } catch (err) {
      console.error('Realtime start failed:', err);
      this.stop();
      throw err;
    }
  }

  // ── Stop streaming ───────────────────────────────────────────────────────────
  stop() {
    this.active = false;
    cancelAnimationFrame(this.rafId);
    this.rafId = null;

    if (this.processor) { try { this.processor.disconnect(); } catch(_) {} this.processor = null; }
    if (this.micStream) { this.micStream.getTracks().forEach(t => t.stop()); this.micStream = null; }
    if (this.audioCtx)  { this.audioCtx.close(); this.audioCtx = null; }
    if (this.ws)        { try { this.ws.close(); } catch(_) {} this.ws = null; }

    // Leave trail on screen briefly then fade it
    setTimeout(() => { this._clearSvgGroup(); this.trail = []; }, 1500);
    this._updateUI(false);
  }

  // ── WebSocket ────────────────────────────────────────────────────────────────
  _openWebSocket() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(WS_URL);
      ws.binaryType = 'arraybuffer';

      const timeout = setTimeout(() => { ws.close(); reject(new Error('WS timeout')); }, 3000);

      ws.onopen = () => {
        clearTimeout(timeout);
        this.ws = ws;
        // Send init config first
        ws.send(JSON.stringify({ type: 'init', sample_rate: 44100 })); // updated after audioCtx
        resolve();
      };

      ws.onmessage = e => {
        try { this._onFrame(JSON.parse(e.data)); } catch (_) {}
      };

      ws.onerror = err => { clearTimeout(timeout); reject(err); };
      ws.onclose = () => { if (this.active) { console.warn('WS closed unexpectedly'); this.stop(); } };
    });
  }

  // ── Microphone ──────────────────────────────────────────────────────────────
  async _openMic() {
    this.micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      video: false
    });

    this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const sampleRate = this.audioCtx.sampleRate;

    // Update server with the real sample rate now that we have AudioContext
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'init', sample_rate: sampleRate }));
    }

    const source = this.audioCtx.createMediaStreamSource(this.micStream);

    // ScriptProcessorNode (deprecated but widely supported; upgrade to AudioWorklet in Phase 2)
    this.processor = this.audioCtx.createScriptProcessor(CHUNK_SIZE, 1, 1);
    this.processor.onaudioprocess = e => {
      if (!this.active || this.ws?.readyState !== WebSocket.OPEN) return;
      const float32 = e.inputBuffer.getChannelData(0);
      this._sendChunk(float32);
    };

    source.connect(this.processor);
    this.processor.connect(this.audioCtx.destination); // must be connected to fire
  }

  // ── Send chunk to server ─────────────────────────────────────────────────────
  _sendChunk(float32) {
    const int16 = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      int16[i] = Math.max(-32768, Math.min(32767, Math.round(float32[i] * 32768)));
    }
    this.ws.send(int16.buffer);
  }

  // ── Receive formant frame ────────────────────────────────────────────────────
  _onFrame(data) {
    this.stats.frames++;
    if (!data.voiced) return;
    this.stats.voiced++;

    // Phase 2: apply EMA smoothing here before pushing to trail
    // const alpha = 0.35;
    // this._emaF1 = this._emaF1 == null ? data.f1 : alpha * data.f1 + (1-alpha) * this._emaF1;
    // this._emaF2 = this._emaF2 == null ? data.f2 : alpha * data.f2 + (1-alpha) * this._emaF2;
    // const f1 = this._emaF1, f2 = this._emaF2;

    const f1 = data.f1, f2 = data.f2;
    this.trail.push({ f1, f2, t: Date.now() });
  }

  // ── Render trail on the formant SVG ─────────────────────────────────────────
  _scheduleRender() {
    const render = () => {
      if (!this.active) return;
      this._drawTrail();
      this._updateStats();
      this.rafId = requestAnimationFrame(render);
    };
    this.rafId = requestAnimationFrame(render);
  }

  _ensureSvgGroup() {
    const svg = document.getElementById('chartFormant');
    if (!svg) return;
    let g = svg.querySelector('#rt-trail-group');
    if (!g) {
      g = $s('g', { id: 'rt-trail-group', style: 'pointer-events:none' });
      svg.appendChild(g);
    }
    this.svgGroup = g;
  }

  _clearSvgGroup() {
    if (this.svgGroup) while (this.svgGroup.firstChild) this.svgGroup.removeChild(this.svgGroup.firstChild);
  }

  _drawTrail() {
    if (!this.svgGroup) return;
    const now = Date.now();

    // Prune old points
    this.trail = this.trail.filter(p => now - p.t < TRAIL_MAX_MS);

    this._clearSvgGroup();
    if (this.trail.length === 0) return;

    this.trail.forEach((p, i) => {
      const age     = (now - p.t) / TRAIL_MAX_MS;      // 0=new … 1=old
      const opacity = Math.max(0, 1 - age * 0.85);
      const isHead  = i === this.trail.length - 1;
      const r       = isHead ? TRAIL_HEAD_R : TRAIL_DOT_R;
      const { x, y } = formantPos(p.f1, p.f2);

      const dot = $s('circle', {
        cx: x.toFixed(1), cy: y.toFixed(1), r,
        fill: TRAIL_COLOR,
        opacity: opacity.toFixed(3),
      });
      this.svgGroup.appendChild(dot);
    });
  }

  // ── Stats overlay ────────────────────────────────────────────────────────────
  _updateStats() {
    const el = document.getElementById('rtStats');
    if (!el) return;
    const elapsedS  = Math.max(1, (Date.now() - this.stats.start) / 1000);
    const fps       = (this.stats.frames / elapsedS).toFixed(1);
    const voicedPct = this.stats.frames ? Math.round(this.stats.voiced / this.stats.frames * 100) : 0;
    const recent    = this.trail.slice(-5);
    const f1Vals    = recent.map(p => p.f1);
    const f2Vals    = recent.map(p => p.f2);
    const f1Now     = f1Vals.length ? Math.round(f1Vals.reduce((a,b)=>a+b,0)/f1Vals.length) : '—';
    const f2Now     = f2Vals.length ? Math.round(f2Vals.reduce((a,b)=>a+b,0)/f2Vals.length) : '—';
    el.textContent  = `${fps} fr/s  ·  ${voicedPct}% voiced  ·  F1 ${f1Now}  F2 ${f2Now} Hz`;
  }

  // ── UI button state ──────────────────────────────────────────────────────────
  _updateUI(on) {
    const btn = document.getElementById('ppLive');
    if (!btn) return;
    btn.textContent = on ? '⏹ Live' : '⬤ Live';
    btn.classList.toggle('rec-active', on);

    // Auto-switch to formant tab when going live
    if (on) document.getElementById('tabFormant')?.click();

    // Show/hide stats bar
    const stats = document.getElementById('rtStats');
    if (stats) stats.style.display = on ? 'block' : 'none';
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────────
const liveTracker = new RealtimeTracker();

function startLive() { liveTracker.start().catch(e => alert('Live mode failed: ' + e.message)); }
function stopLive()  { liveTracker.stop(); }
function toggleLive() { liveTracker.active ? stopLive() : startLive(); }

// ─── Synthetic vowel verification tool ──────────────────────────────────────
/**
 * testSyntheticVowel(f1, f2)
 *
 * Generates white noise filtered at exactly F1 and F2 Hz using Web Audio API,
 * renders it offline, then sends it to the server's /analyze endpoint.
 * Reports measured vs. expected frequencies.
 *
 * This is the ground-truth verifier: you set the formant frequencies,
 * the algorithm should return approximately those values.
 *
 * Usage in browser console:
 *   testSyntheticVowel(300, 800)   // /u/ approximation
 *   testSyntheticVowel(280, 2250)  // /i/ approximation
 *   testSyntheticVowel(740, 1180)  // /a/ approximation
 */
async function testSyntheticVowel(targetF1, targetF2, durationS = 0.5) {
  const sampleRate = 22050;
  const ctx = new OfflineAudioContext(1, Math.round(sampleRate * durationS), sampleRate);

  // White noise buffer
  const bufLen  = ctx.sampleRate * durationS;
  const noiseBuf = ctx.createBuffer(1, bufLen, ctx.sampleRate);
  const data     = noiseBuf.getChannelData(0);
  for (let i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;

  // Bandpass at F1 — simulates first formant resonance
  // Q = f/bandwidth; typical vowel formant bandwidth is ~80Hz → Q ≈ f/80
  const filt1 = ctx.createBiquadFilter();
  filt1.type = 'bandpass';
  filt1.frequency.value = targetF1;
  filt1.Q.value = targetF1 / 80;

  // Bandpass at F2
  const filt2 = ctx.createBiquadFilter();
  filt2.type = 'bandpass';
  filt2.frequency.value = targetF2;
  filt2.Q.value = targetF2 / 100;

  // Mix: F1 louder than F2 (mimics natural speech falloff)
  const gain1 = ctx.createGain(); gain1.gain.value = 1.0;
  const gain2 = ctx.createGain(); gain2.gain.value = 0.6;
  const mix   = ctx.createGain(); mix.gain.value = 0.8;

  src.connect(filt1); filt1.connect(gain1); gain1.connect(mix);
  src.connect(filt2); filt2.connect(gain2); gain2.connect(mix);
  mix.connect(ctx.destination);
  src.start(0);

  const rendered = await ctx.startRendering();
  const float32  = rendered.getChannelData(0);

  // Convert to Int16 WAV and POST to /analyze
  const wav = encodeWAV(float32, sampleRate);
  try {
    const resp = await fetch(`${HTTP_URL}/analyze`, {
      method: 'POST',
      headers: {
        'Content-Type': 'audio/wav',
        'X-Window-Start': '0',
        'X-Window-End': '1',
      },
      body: wav,
    });

    if (!resp.ok) {
      const err = await resp.json();
      console.warn('[SynthTest] Server error:', err);
      return null;
    }

    const result = await resp.json();
    const errF1  = Math.round(result.f1 - targetF1);
    const errF2  = Math.round(result.f2 - targetF2);
    const pctF1  = ((Math.abs(errF1) / targetF1) * 100).toFixed(1);
    const pctF2  = ((Math.abs(errF2) / targetF2) * 100).toFixed(1);

    const summary = {
      expected:  { f1: targetF1, f2: targetF2 },
      measured:  { f1: result.f1, f2: result.f2 },
      error:     { f1: errF1, f2: errF2 },
      errorPct:  { f1: pctF1 + '%', f2: pctF2 + '%' },
    };

    console.table(summary);
    console.log(
      `[SynthTest] F1: expected ${targetF1}, got ${result.f1} (${errF1 >= 0 ? '+' : ''}${errF1} Hz, ${pctF1}%)`
    );
    console.log(
      `[SynthTest] F2: expected ${targetF2}, got ${result.f2} (${errF2 >= 0 ? '+' : ''}${errF2} Hz, ${pctF2}%)`
    );
    return summary;
  } catch (e) {
    console.error('[SynthTest] Failed:', e);
    return null;
  }
}

/**
 * runVerificationSuite()
 *
 * Tests the algorithm against the 7 primary cardinal vowel positions.
 * Published F1/F2 from Ladefoged "A Course in Phonetics" (2006), male averages.
 * Run this in the browser console to get a quick accuracy report.
 */
async function runVerificationSuite() {
  const CARDINALS = [
    { ipa: 'i', f1: 240,  f2: 2400 },
    { ipa: 'e', f1: 390,  f2: 2300 },
    { ipa: 'ɛ', f1: 610,  f2: 1900 },
    { ipa: 'a', f1: 850,  f2: 1610 },
    { ipa: 'ɔ', f1: 590,  f2: 920  },
    { ipa: 'o', f1: 360,  f2: 760  },
    { ipa: 'u', f1: 250,  f2: 595  },
  ];

  console.log('[VerifySuite] Testing 7 cardinal vowel positions...');
  const results = [];

  for (const c of CARDINALS) {
    const r = await testSyntheticVowel(c.f1, c.f2);
    if (r) results.push({ ipa: c.ipa, ...r });
    await new Promise(res => setTimeout(res, 100)); // brief gap between tests
  }

  // Summary table
  console.log('\n[VerifySuite] Summary:');
  console.table(results.map(r => ({
    vowel:   r.ipa,
    'F1 exp':  r.expected.f1,
    'F1 meas': r.measured.f1,
    'F1 err':  r.error.f1 + ' Hz',
    'F1 %':    r.errorPct.f1,
    'F2 exp':  r.expected.f2,
    'F2 meas': r.measured.f2,
    'F2 err':  r.error.f2 + ' Hz',
    'F2 %':    r.errorPct.f2,
  })));

  return results;
}