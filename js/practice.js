/**
 * practice.js — Pronunciation practice panel.
 *
 * Manages the fixed bottom-bar panel with two columns:
 *   Left  — user's own recording: mic capture, Praat spectrogram with a
 *           draggable analysis slice — same machinery Formant Lab uses, via
 *           js/spectro.js. Dragging the slice recomputes a live mean F1/F2,
 *           shown as a label on top of the spectrogram and plotted live on
 *           the formant chart (via recordedVowel, same dot js/charts.js's
 *           renderFormant() already draws).
 *   Right — reference: a token click loads the owning sample's FULL audio,
 *           same spectrogram+slice view, slice defaulting to that token's
 *           own time range (or a plain default window if there's no specific
 *           token) — same live-mean-into-chart wiring via refAnalyzed.
 *
 * Compare plays the FULL reference sample then the FULL recording, each
 * starting from its own detected leading-silence point (computed once, independent
 * of wherever the analysis slice above gets dragged to afterward) — not the
 * adjustable analysis slice, which is for the live F1/F2 readout only. Same
 * split js/drill.js already settled on for its own Compare.
 *
 * Dependencies: js/spectro.js (SpectroLib), js/vad.js (detectLeadingSilenceMs),
 * index.html globals (LANGS, passesFilters, renderFormant, playUrl,
 * playUrlAtRate, recordedVowel, refAnalyzed, refVowelMeta, analyzedFormants)
 */

// ─── Practice panel ───────────────────────────────────────────────────────────
const SERVER='';   // used by checkServer()'s /ping health check below
let recState='idle';
let recBlob=null, recObjectURL=null, recSamples=null, recSampleRate=22050;
let recAnalysisResult=null, recCursorFrac=null;
let waveStart=0.33, waveEnd=0.67, recTrimStartFrac=0;

// Reference vowel state
let refSamples=null, refSampleRate=44100;
let refAnalysisResult=null, refCursorFrac=null;
let refStart=0.33, refEnd=0.67, refTrimStartFrac=0;
let refAnalyzed=null, refVowelMeta=null; // {v, lang, lk}

function durationMsOf(samples, sr){ return samples ? samples.length/sr*1000 : 0; }

// ── Spectrogram rendering (base image + overlay), one pair per column ──────────
function drawRecSpectrogram(){
  const cv=document.getElementById('waveCanvas'); if(!cv||!recAnalysisResult)return;
  const W=cv.width=cv.offsetWidth||400, H=cv.height=cv.offsetHeight||120;
  SpectroLib.drawSpectrogramCrop(cv,W,H,0,1,recAnalysisResult);
}
function drawRecOverlay(){
  const cv=document.getElementById('waveOverlay'); if(!cv)return;
  const W=cv.width=cv.offsetWidth||400, H=cv.height=cv.offsetHeight||120;
  const ctx=cv.getContext('2d'); ctx.clearRect(0,0,W,H);
  if(recAnalysisResult) SpectroLib.drawFormantPitchOverlay(ctx,W,H,0,1,recAnalysisResult,durationMsOf(recSamples,recSampleRate),75,600);
  drawSelectionBandPP(ctx,W,H,waveStart,waveEnd);
  if(recCursorFrac!=null) SpectroLib.drawPlaybackCursor(ctx,W,H,0,1,recCursorFrac);
  const info=document.getElementById('waveInfo');
  if(info&&recSamples){ const dur=durationMsOf(recSamples,recSampleRate); info.textContent=`${(waveStart*dur).toFixed(0)} – ${(waveEnd*dur).toFixed(0)} ms  (${dur.toFixed(0)} ms total)`; }
}
function drawRefSpectrogram(){
  const cv=document.getElementById('refWaveCanvas'); if(!cv||!refAnalysisResult)return;
  const W=cv.width=cv.offsetWidth||400, H=cv.height=cv.offsetHeight||120;
  SpectroLib.drawSpectrogramCrop(cv,W,H,0,1,refAnalysisResult);
}
function drawRefOverlay(){
  const cv=document.getElementById('refWaveOverlay'); if(!cv)return;
  const W=cv.width=cv.offsetWidth||400, H=cv.height=cv.offsetHeight||120;
  const ctx=cv.getContext('2d'); ctx.clearRect(0,0,W,H);
  if(refAnalysisResult) SpectroLib.drawFormantPitchOverlay(ctx,W,H,0,1,refAnalysisResult,durationMsOf(refSamples,refSampleRate),75,600);
  drawSelectionBandPP(ctx,W,H,refStart,refEnd);
  if(refCursorFrac!=null) SpectroLib.drawPlaybackCursor(ctx,W,H,0,1,refCursorFrac);
  const info=document.getElementById('refWaveInfo');
  if(info&&refSamples){ const dur=durationMsOf(refSamples,refSampleRate); info.textContent=`${(refStart*dur).toFixed(0)} – ${(refEnd*dur).toFixed(0)} ms  (${dur.toFixed(0)} ms total)`; }
}
function drawSelectionBandPP(ctx,W,H,start,end){
  const x0=start*W, x1=end*W;
  ctx.fillStyle='rgba(126,184,247,0.18)'; ctx.fillRect(x0,0,x1-x0,H);
  ctx.fillStyle='#7eb8f7'; ctx.fillRect(x0,0,1.5,H); ctx.fillRect(x1-1.5,0,1.5,H);
}

// ── Live mean F1/F2 as the slice is dragged — feeds the formant-chart dots
// directly (recordedVowel/refAnalyzed, same globals js/charts.js's
// renderFormant() already plots as "Your recorded vowel"/"Reference
// analyzed"), replacing the old one-shot-analysis-fed values. ──────────────
function updateLiveMeansRec(){
  const el=document.getElementById('ppLiveMeans');
  if(!recAnalysisResult){ if(el)el.textContent=''; recordedVowel=null; renderFormant(); return; }
  const means=SpectroLib.computeMeansForRange(recAnalysisResult, durationMsOf(recSamples,recSampleRate), waveStart, waveEnd);
  if(means?.nFormantFrames){
    recordedVowel={f1:means.f1,f2:means.f2};
    if(el)el.textContent=`F1 ${Math.round(means.f1)} · F2 ${Math.round(means.f2)} Hz`;
  } else {
    recordedVowel=null;
    if(el)el.textContent='no voiced frames in slice';
  }
  renderFormant();
}
function updateLiveMeansRef(){
  const el=document.getElementById('refLiveMeans');
  if(!refAnalysisResult){ if(el)el.textContent=''; refAnalyzed=null; renderFormant(); return; }
  const means=SpectroLib.computeMeansForRange(refAnalysisResult, durationMsOf(refSamples,refSampleRate), refStart, refEnd);
  if(means?.nFormantFrames){
    refAnalyzed={f1:means.f1,f2:means.f2};
    if(refVowelMeta){
      const key=`${refVowelMeta.lk}::${refVowelMeta.v.symbols?.[0]}`;
      analyzedFormants[key]={f1:means.f1,f2:means.f2};
    }
    if(el)el.textContent=`F1 ${Math.round(means.f1)} · F2 ${Math.round(means.f2)} Hz`;
  } else {
    refAnalyzed=null;
    if(el)el.textContent='no voiced frames in slice';
  }
  renderFormant();
}

// ── Drag-to-adjust the analysis slice — generic single-slice drag shared with Formant Lab (js/spectro.js) ──
SpectroLib.wireSliceDrag(document.getElementById('waveOverlay'), {
  getWinStart:()=>0, getWinEnd:()=>1,
  getStart:()=>waveStart, setStart:v=>waveStart=v,
  getEnd:()=>waveEnd, setEnd:v=>waveEnd=v,
  onChange:()=>{ drawRecOverlay(); updateLiveMeansRec(); },
});
SpectroLib.wireSliceDrag(document.getElementById('refWaveOverlay'), {
  getWinStart:()=>0, getWinEnd:()=>1,
  getStart:()=>refStart, setStart:v=>refStart=v,
  getEnd:()=>refEnd, setEnd:v=>refEnd=v,
  onChange:()=>{ drawRefOverlay(); updateLiveMeansRef(); },
});

// ── Playback (with a moving spectrogram cursor) ─────────────────────────────
function playBufferRange(samples, sr, startFrac, endFrac, setCursor, redraw, onEnded){
  if(!samples) return null;
  const s=Math.floor(startFrac*samples.length), e=Math.floor(endFrac*samples.length);
  const blob=encodeWAV(samples.slice(s,e),sr);
  const url=URL.createObjectURL(blob);
  const audio=new Audio(url);
  audio.addEventListener('play',()=>{
    SpectroLib.animatePlaybackCursor({
      startFrac, endFrac, durationSec: samples.length/sr,
      onFrame:f=>{ setCursor(f); redraw(); },
      onDone:()=>{ setCursor(null); redraw(); URL.revokeObjectURL(url); onEnded?.(); },
      isStopped:()=>audio.paused||audio.ended,
    });
  });
  audio.play().catch(()=>{});
  return audio;
}
function playSelection(onEnded){
  return playBufferRange(recSamples, recSampleRate, waveStart, waveEnd, v=>recCursorFrac=v, drawRecOverlay, onEnded);
}
function playRefSelection(onEnded){
  return playBufferRange(refSamples, refSampleRate, refStart, refEnd, v=>refCursorFrac=v, drawRefOverlay, onEnded);
}
/** Full recording, skipping its own detected leading silence — a persistent
 * trim point computed once in stopRec(), independent of wherever the
 * adjustable analysis slice (waveStart/waveEnd) later gets dragged to. */
function playFullRecording(onEnded){
  return playBufferRange(recSamples, recSampleRate, recTrimStartFrac, 1, v=>recCursorFrac=v, drawRecOverlay, onEnded);
}
/** Full reference sample, skipping its own detected leading silence (computed once in loadRefAudio()). */
function playFullReference(onEnded){
  return playBufferRange(refSamples, refSampleRate, refTrimStartFrac, 1, v=>refCursorFrac=v, drawRefOverlay, onEnded);
}
/** Full reference sample, then your full recording — both silence-trimmed, natural-context comparison, same split js/drill.js's compareToken() already settled on (the adjustable slice above is for the live F1/F2 readout only, not for Compare). */
function playCompare(){
  if(!refSamples){ playFullRecording(); return; }
  playFullReference(()=>setTimeout(()=>playFullRecording(),250));
}

// ── Run a Praat spectrogram+formant+pitch analysis (default params) ────────
async function analyzeRecordingSpectrogram(){
  const el=document.getElementById('ppLiveMeans'); if(el) el.textContent='Analyzing spectrogram…';
  try{
    recAnalysisResult=await SpectroLib.runPraatAnalysis({getChannelData:()=>recSamples, sampleRate:recSampleRate}, {});
    drawRecSpectrogram(); drawRecOverlay(); updateLiveMeansRec();
  }catch(e){
    if(el) el.textContent='Spectrogram analysis failed: '+e.message;
  }
}
async function analyzeReferenceSpectrogram(myToken){
  const el=document.getElementById('refLiveMeans'); if(el) el.textContent='Analyzing spectrogram…';
  try{
    const result=await SpectroLib.runPraatAnalysis({getChannelData:()=>refSamples, sampleRate:refSampleRate}, {});
    if(myToken!==refLoadToken)return;   // superseded by a later vowel click — don't let a stale result win
    refAnalysisResult=result;
    drawRefSpectrogram(); drawRefOverlay(); updateLiveMeansRef();
  }catch(e){
    if(myToken!==refLoadToken)return;
    if(el) el.textContent='Spectrogram analysis failed: '+e.message;
  }
}

// ── Vowel click hook (fires when a vowel is clicked anywhere on the chart) ────
// refLoadToken guards against a race: clicking vowel B while vowel A's audio
// fetch/decode/analysis is still in flight must never let A's later-arriving
// result overwrite B's (dot would otherwise flicker back to the wrong vowel,
// or linger after switching) — every async step below checks it's still current.
let refLoadToken=0;
function onVowelClicked(v, lang, lk){
  if(!document.getElementById('practicePanel').classList.contains('open'))return;
  if(!v.audio)return;
  const myToken=++refLoadToken;
  refVowelMeta={v,lang,lk};
  refAnalyzed=null; refAnalysisResult=null; refCursorFrac=null;
  renderFormant();
  document.getElementById('refColTitle').textContent=`Reference: ${lang.label} /${v.symbols?.[0]}/`;
  document.getElementById('refStatus').textContent='Loading audio…';
  document.getElementById('refPlay').disabled=true;
  document.getElementById('refLiveMeans').textContent='';
  document.getElementById('refWaveWrap').style.display='none';
  document.getElementById('refWaveInfo').style.display='none';
  loadRefAudio(v.audio, lang, myToken);
}

async function loadRefAudio(url, lang, myToken){
  try{
    const resp=await fetch(url,{mode:'cors'});
    if(!resp.ok) throw new Error(resp.status);
    const arrayBuf=await resp.arrayBuffer();
    const audioCtx=new (window.AudioContext||window.webkitAudioContext)();
    const audioBuf=await audioCtx.decodeAudioData(arrayBuf);
    if(myToken!==refLoadToken)return;   // superseded while fetching/decoding
    // Always the FULL sample now (Compare needs real, natural-context audio
    // to play) — a token click's own [timeStartMs,timeEndMs] just positions
    // the adjustable analysis slice below, instead of pre-cropping the buffer.
    refSamples=audioBuf.getChannelData(0).slice();
    refSampleRate=audioBuf.sampleRate;
    const v=refVowelMeta?.v;
    const durationMs=refSamples.length/refSampleRate*1000;
    if(v?.timeStartMs!=null&&v?.timeEndMs!=null){
      refStart=Math.max(0,v.timeStartMs/durationMs); refEnd=Math.min(1,v.timeEndMs/durationMs);
    } else {
      refStart=0.33; refEnd=0.67;
    }
    refCursorFrac=null;
    refTrimStartFrac=Math.min(0.9, (typeof detectLeadingSilenceMs==='function'
      ? detectLeadingSilenceMs({sampleRate:refSampleRate,numberOfChannels:1,getChannelData:()=>refSamples})
      : 0)/durationMs);
    document.getElementById('refWaveWrap').style.display='block';
    document.getElementById('refWaveInfo').style.display='block';
    document.getElementById('refStatus').textContent=refVowelMeta?.v?.f1
      ? `Specified: F1 ${refVowelMeta.v.f1} F2 ${refVowelMeta.v.f2} Hz` : '';
    document.getElementById('refPlay').disabled=false;
    drawRefOverlay();
    analyzeReferenceSpectrogram(myToken);
  }catch(e){
    if(myToken!==refLoadToken)return;
    document.getElementById('refStatus').textContent='Could not load: '+e.message;
  }
}

document.getElementById('refPlay').addEventListener('click',()=>playRefSelection());

// ── Toggle panel ──────────────────────────────────────────────────────────────
document.getElementById('practiceTrigger').addEventListener('click',()=>{
  const p=document.getElementById('practicePanel'), b=document.getElementById('practiceTrigger');
  const open=p.classList.toggle('open');
  b.classList.toggle('open',open);
  document.body.classList.toggle('practice-open',open);
  if(open){checkServer();if(recSamples){drawRecSpectrogram();drawRecOverlay();}if(refSamples){drawRefSpectrogram();drawRefOverlay();}}
});
document.getElementById('ppClose').addEventListener('click',()=>{
  document.getElementById('practicePanel').classList.remove('open');
  document.getElementById('practiceTrigger').classList.remove('open');
  document.body.classList.remove('practice-open');
});

// ── WAV encoder ───────────────────────────────────────────────────────────────
function encodeWAV(samples, sampleRate){
  const buf=new ArrayBuffer(44+samples.length*2);
  const v=new DataView(buf);
  const ws=(off,str)=>{for(let i=0;i<str.length;i++)v.setUint8(off+i,str.charCodeAt(i));};
  ws(0,'RIFF'); v.setUint32(4,36+samples.length*2,true); ws(8,'WAVE');
  ws(12,'fmt '); v.setUint32(16,16,true); v.setUint16(20,1,true); v.setUint16(22,1,true);
  v.setUint32(24,sampleRate,true); v.setUint32(28,sampleRate*2,true);
  v.setUint16(32,2,true); v.setUint16(34,16,true);
  ws(36,'data'); v.setUint32(40,samples.length*2,true);
  for(let i=0,off=44;i<samples.length;i++,off+=2){
    const s=Math.max(-1,Math.min(1,samples[i]));
    v.setInt16(off,s<0?s*0x8000:s*0x7FFF,true);
  }
  return new Blob([buf],{type:'audio/wav'});
}

// ── Recording ─────────────────────────────────────────────────────────────────
let recCtx=null, recProcessor=null, recStream=null, recChunks=[];
document.getElementById('ppRecord').addEventListener('click', async()=>{
  if(recState==='recording'){stopRec();return;}
  try{
    recChunks=[];
    recStream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,sampleRate:22050}});
    recCtx=new AudioContext(); recSampleRate=recCtx.sampleRate;
    const src=recCtx.createMediaStreamSource(recStream);
    recProcessor=recCtx.createScriptProcessor(4096,1,1);
    recProcessor.onaudioprocess=e=>recChunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    src.connect(recProcessor); recProcessor.connect(recCtx.destination);
    recState='recording';
    document.getElementById('ppRecord').textContent='■ Stop';
    document.getElementById('ppRecord').classList.add('rec-active');
    document.getElementById('recDot').classList.add('on');
    document.getElementById('ppStatus').textContent='Recording…';
    document.getElementById('ppPlay').disabled=true;
  }catch(e){document.getElementById('ppStatus').textContent='Mic error: '+e.message;}
});
function stopRec(){
  recProcessor?.disconnect(); recStream?.getTracks().forEach(t=>t.stop());
  const total=recChunks.reduce((s,c)=>s+c.length,0);
  const rawSamples=new Float32Array(total);
  let off=0; for(const c of recChunks){rawSamples.set(c,off);off+=c.length;}
  // Actually cut the leading silence out of the recording itself — not just
  // a default analysis-window marker the user could drag back over it.
  const trimStartMs=typeof detectLeadingSilenceMs==='function'
    ? detectLeadingSilenceMs({sampleRate:recSampleRate,numberOfChannels:1,getChannelData:()=>rawSamples})
    : 0;
  const i0=Math.floor(trimStartMs/1000*recSampleRate);
  recSamples=rawSamples.slice(i0);
  recBlob=encodeWAV(recSamples,recSampleRate);
  if(recObjectURL)URL.revokeObjectURL(recObjectURL);
  recObjectURL=URL.createObjectURL(recBlob);
  // Already trimmed above, so there's no silence left to skip — Compare's
  // "from here" point is just the start of this (already-cut) buffer.
  const durationMs=recSamples.length/recSampleRate*1000;
  recTrimStartFrac=0;
  waveStart=0; waveEnd=Math.min(1,0.34); recCursorFrac=null;
  recState='ready';
  document.getElementById('ppRecord').textContent='● Record';
  document.getElementById('ppRecord').classList.remove('rec-active');
  document.getElementById('recDot').classList.remove('on');
  document.getElementById('ppStatus').textContent='';
  document.getElementById('ppPlay').disabled=false;
  document.getElementById('ppCompare').disabled=false;
  document.getElementById('ppClear').disabled=false;
  document.getElementById('waveWrap').style.display='block';
  document.getElementById('waveInfo').style.display='block';
  drawRecOverlay();
  recAnalysisResult=null;
  analyzeRecordingSpectrogram();
}
document.getElementById('ppPlay').addEventListener('click',()=>playSelection());
document.getElementById('ppCompare').addEventListener('click',()=>playCompare());
document.getElementById('ppClear').addEventListener('click',()=>{
  recBlob=null; recSamples=null; recAnalysisResult=null; recCursorFrac=null; if(recObjectURL){URL.revokeObjectURL(recObjectURL);recObjectURL=null;}
  recState='idle'; recordedVowel=null;
  document.getElementById('ppStatus').textContent='Press Record and say a vowel';
  ['ppPlay','ppCompare','ppClear'].forEach(id=>document.getElementById(id).disabled=true);
  document.getElementById('ppLiveMeans').textContent='';
  document.getElementById('waveWrap').style.display='none';
  document.getElementById('waveInfo').style.display='none';
  renderFormant();
});

// ── Server check ──────────────────────────────────────────────────────────────
async function checkServer(){
  const el=document.getElementById('ppServer');
  try{
    const r=await fetch(SERVER+'/ping',{signal:AbortSignal.timeout(1500)});
    if(r.ok){el.textContent='✓ Server connected';el.className='pp-server ok';return true;}
  }catch(e){}
  el.textContent='Server offline — run: python analyze_server.py';
  el.className='pp-server'; return false;
}