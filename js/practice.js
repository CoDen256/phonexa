/**
 * practice.js — Pronunciation practice panel.
 *
 * Manages the fixed bottom-bar panel with two columns:
 *   Left  — user's own recording: mic capture, waveform with draggable selection
 *           handles, WAV encoding, send to local server for F1/F2 analysis
 *   Right — reference vowel: fetch + decode any vowel's audio, same waveform
 *           and analysis flow
 *
 * Comparison mode: when a recording exists and the panel is open,
 * every vowel click in the main chart triggers playback of the reference
 * vowel followed by the user's selected recording slice.
 *
 * Waveform system: makeWavePainter() creates a canvas draw function;
 * addWaveDrag() attaches drag interaction; playSlice() handles audio
 * playback and animates the cursor on the waveform.
 *
 * Server: expects analyze_server.py running on localhost:5050.
 * Audio is sent as multipart/form-data to /frames with single_segment:true
 * (whole uploaded audio = one segment). Returns frames[0].f1 / frames[0].f2.
 *
 * Dependencies: utils.js (encodeWAV), index.html globals
 *   (LANGS, passesFilters, renderFormant, playUrl, playUrlAtRate,
 *    recordedVowel, refAnalyzed, refVowelMeta, analyzedFormants)
 */

// ─── Practice panel ───────────────────────────────────────────────────────────
const SERVER='';
let recState='idle';
let recBlob=null, recObjectURL=null, recSamples=null, recSampleRate=22050;
let waveStart=0.33, waveEnd=0.67, waveDrag=null, waveCursorPos=null;

// Reference vowel state
let refSamples=null, refSampleRate=44100;
let refStart=0.33, refEnd=0.67, refDrag=null, refCursorPos=null;
let refAnalyzed=null, refVowelMeta=null; // {v, lang, lk}

// ── Waveform helpers (shared pattern for both canvases) ───────────────────────
function makeWavePainter(canvasId, infoId, getStart, getEnd, getCursor, getDrag){
  return function drawW(){
    const canvas=document.getElementById(canvasId);
    if(!canvas)return;
    const samples=canvasId==='waveCanvas'?recSamples:refSamples;
    if(!samples)return;
    const W=canvas.width=canvas.offsetWidth, H=44;
    canvas.height=H;
    const ctx=canvas.getContext('2d');
    ctx.fillStyle='#1a2e48'; ctx.fillRect(0,0,W,H);
    const step=Math.max(1,Math.ceil(samples.length/W));
    const sx=getStart()*W, ex=getEnd()*W;
    for(let x=0;x<W;x++){
      let pk=0;
      for(let i=x*step;i<Math.min((x+1)*step,samples.length);i++) pk=Math.max(pk,Math.abs(samples[i]));
      ctx.fillStyle=(x>=sx&&x<=ex)?'#4a90c8':'#253d54';
      ctx.fillRect(x,(H-Math.max(1,pk*(H-4)))/2,1,Math.max(1,pk*(H-4)));
    }
    ctx.fillStyle='rgba(74,144,200,0.1)'; ctx.fillRect(sx,0,ex-sx,H);
    const cur=getCursor();
    if(cur!==null){
      const cx=cur*W;
      ctx.fillStyle='rgba(255,255,255,0.08)'; ctx.fillRect(sx,0,cx-sx,H);
      ctx.strokeStyle='#ffffff'; ctx.lineWidth=1.5;
      ctx.beginPath(); ctx.moveTo(cx,0); ctx.lineTo(cx,H); ctx.stroke();
    }
    [[sx,'start'],[ex,'end']].forEach(([x,w])=>{
      const active=getDrag()===w;
      ctx.strokeStyle=active?'#fff':'#7eb8f7'; ctx.lineWidth=2;
      ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H); ctx.stroke();
      ctx.fillStyle=active?'#fff':'#7eb8f7';
      ctx.beginPath(); ctx.moveTo(x-5,0); ctx.lineTo(x+5,0); ctx.lineTo(x,8); ctx.fill();
    });
    const sr=canvasId==='waveCanvas'?recSampleRate:refSampleRate;
    const dur=samples.length/sr*1000;
    const info=document.getElementById(infoId);
    if(info) info.textContent=`${(getStart()*dur).toFixed(0)} – ${(getEnd()*dur).toFixed(0)} ms  (${dur.toFixed(0)} ms total)`;
  };
}
const drawWave   =makeWavePainter('waveCanvas',   'waveInfo',   ()=>waveStart, ()=>waveEnd, ()=>waveCursorPos, ()=>waveDrag);
const drawRefWave=makeWavePainter('refWaveCanvas', 'refWaveInfo',()=>refStart,  ()=>refEnd,  ()=>refCursorPos,  ()=>refDrag);

function waveXfrac(canvas,e){const r=canvas.getBoundingClientRect();return((e.clientX??e.touches?.[0].clientX??0)-r.left)/r.width;}
const GRAB=0.07;

function addWaveDrag(canvasId, getStart, setStart, getEnd, setEnd, getDrag, setDrag, redraw){
  const c=document.getElementById(canvasId);
  const down=e=>{const x=waveXfrac(c,e);setDrag(Math.abs(x-getStart())<GRAB?'start':Math.abs(x-getEnd())<GRAB?'end':null);};
  const move=e=>{if(!getDrag())return;const x=Math.max(0,Math.min(1,waveXfrac(c,e)));if(getDrag()==='start')setStart(Math.min(x,getEnd()-0.05));else setEnd(Math.max(x,getStart()+0.05));redraw();};
  c.addEventListener('mousedown',down);
  c.addEventListener('touchstart',e=>{e.preventDefault();down(e);},{passive:false});
  document.addEventListener('mousemove',e=>{if(getDrag())move(e);});
  document.addEventListener('touchmove',e=>{if(getDrag()){e.preventDefault();move(e);}},{passive:false});
  document.addEventListener('mouseup',()=>setDrag(null));
  document.addEventListener('touchend',()=>setDrag(null));
}
addWaveDrag('waveCanvas',   ()=>waveStart, v=>waveStart=v, ()=>waveEnd, v=>waveEnd=v, ()=>waveDrag, v=>waveDrag=v, drawWave);
addWaveDrag('refWaveCanvas',()=>refStart,  v=>refStart=v,  ()=>refEnd,  v=>refEnd=v,  ()=>refDrag,  v=>refDrag=v,  drawRefWave);

// Play a slice of samples with waveform cursor animation
function playSlice(samples, sr, getStart, getEnd, setCursor, redraw, onEnded){
  if(!samples)return null;
  const s=Math.floor(getStart()*samples.length), e=Math.floor(getEnd()*samples.length);
  const blob=encodeWAV(samples.slice(s,e),sr);
  const url=URL.createObjectURL(blob);
  const audio=new Audio(url);
  const selDur=(e-s)/sr;
  const t0=performance.now();
  function animate(){
    const elapsed=(performance.now()-t0)/1000;
    if(elapsed>=selDur||audio.ended||audio.paused){
      setCursor(null); redraw(); URL.revokeObjectURL(url); onEnded?.(); return;
    }
    setCursor(getStart()+(elapsed/selDur)*(getEnd()-getStart()));
    redraw(); requestAnimationFrame(animate);
  }
  audio.addEventListener('play',()=>requestAnimationFrame(animate));
  audio.play().catch(()=>{});
  return audio;
}
function playSelection(onEnded){
  return playSlice(recSamples, recSampleRate, ()=>waveStart, ()=>waveEnd, v=>waveCursorPos=v, drawWave, onEnded);
}
function playRefSelection(){
  return playSlice(refSamples, refSampleRate, ()=>refStart, ()=>refEnd, v=>refCursorPos=v, drawRefWave);
}

// ── Vowel click hook (fires when a vowel is clicked anywhere on the chart) ────
function onVowelClicked(v, lang, lk){
  if(!document.getElementById('practicePanel').classList.contains('open'))return;
  if(!v.audio)return;
  refVowelMeta={v,lang,lk};
  refAnalyzed=null;
  document.getElementById('refColTitle').textContent=`Reference: ${lang.label} /${v.symbols?.[0]}/`;
  document.getElementById('refStatus').textContent='Loading audio…';
  document.getElementById('refPlay').disabled=true;
  document.getElementById('refAnalyse').disabled=true;
  document.getElementById('refFormants').innerHTML='';
  document.getElementById('refWaveCanvas').style.display='none';
  document.getElementById('refWaveInfo').style.display='none';
  loadRefAudio(v.audio, lang);
}

async function loadRefAudio(url, lang){
  try{
    const resp=await fetch(url,{mode:'cors'});
    if(!resp.ok) throw new Error(resp.status);
    const arrayBuf=await resp.arrayBuffer();
    const audioCtx=new (window.AudioContext||window.webkitAudioContext)();
    const audioBuf=await audioCtx.decodeAudioData(arrayBuf);
    refSamples=audioBuf.getChannelData(0).slice();
    refSampleRate=audioBuf.sampleRate;
    refStart=0.33; refEnd=0.67; refCursorPos=null;
    document.getElementById('refWaveCanvas').style.display='block';
    document.getElementById('refWaveInfo').style.display='block';
    document.getElementById('refStatus').textContent=`${(audioBuf.duration*1000).toFixed(0)} ms — drag handles to set window`;
    document.getElementById('refPlay').disabled=false;
    document.getElementById('refAnalyse').disabled=false;
    if(refVowelMeta?.v?.f1){
      document.getElementById('refFormants').innerHTML=
          `Specified: F1 <b>${refVowelMeta.v.f1}</b> · F2 <b>${refVowelMeta.v.f2}</b> Hz`;
    }
    requestAnimationFrame(drawRefWave);
  }catch(e){
    document.getElementById('refStatus').textContent='Could not load: '+e.message;
  }
}

document.getElementById('refPlay').addEventListener('click',()=>playRefSelection());
document.getElementById('refAnalyse').addEventListener('click', async()=>{
  if(!refSamples)return;
  const btn=document.getElementById('refAnalyse');
  btn.textContent='Analysing…'; btn.disabled=true;
  try{
    const fullBlob=encodeWAV(refSamples,refSampleRate);
    const data=await analyzeWav(fullBlob, AbortSignal.timeout(10000), refStart, refEnd);
    refAnalyzed={f1:data.f1,f2:data.f2};
    // Store in analyzedFormants for mode toggle
    if(refVowelMeta){
      const key=`${refVowelMeta.lk}::${refVowelMeta.v.symbols?.[0]}`;
      analyzedFormants[key]={f1:data.f1,f2:data.f2};
    }
    const v=refVowelMeta?.v;
    const specHtml=v?.f1?`Specified: F1 <b>${v.f1}</b> · F2 <b>${v.f2}</b> Hz<br>`:'';
    document.getElementById('refFormants').innerHTML=
        specHtml+`Analyzed: F1 <b>${data.f1.toFixed(0)}</b> · F2 <b>${data.f2.toFixed(0)}</b> Hz`;
    document.getElementById('tabFormant').click();
    renderFormant();
  }catch(e){
    document.getElementById('refFormants').textContent='Error: '+e.message;
  }
  btn.textContent='⚡ F1/F2'; btn.disabled=false;
});

// ── Toggle panel ──────────────────────────────────────────────────────────────
function updateHint(){
  const hint=document.getElementById('ppHint');
  if(hint) hint.style.display=(recObjectURL&&document.getElementById('practicePanel').classList.contains('open'))?'inline':'none';
}
document.getElementById('practiceTrigger').addEventListener('click',()=>{
  const p=document.getElementById('practicePanel'), b=document.getElementById('practiceTrigger');
  const open=p.classList.toggle('open');
  b.classList.toggle('open',open);
  document.body.classList.toggle('practice-open',open);
  if(open){checkServer();updateHint();if(recSamples)requestAnimationFrame(drawWave);if(refSamples)requestAnimationFrame(drawRefWave);}
  else updateHint();
});
document.getElementById('ppClose').addEventListener('click',()=>{
  document.getElementById('practicePanel').classList.remove('open');
  document.getElementById('practiceTrigger').classList.remove('open');
  document.body.classList.remove('practice-open');
  updateHint();
});

// ── Server analysis helper ─────────────────────────────────────────────────────
// Sends a pre-sliced WAV blob to /frames for single-frame formant analysis.
// The client already trims the selection; single_segment:true analyses the whole clip.
async function analyzeWav(wavBlob, signal, sliceStart=null, sliceEnd=null) {
  const form = new FormData();
  form.append('file', wavBlob, 'audio.wav');
  const cfg = {single_segment: true};
  if (sliceStart != null) cfg.slice_start = sliceStart;
  if (sliceEnd   != null) cfg.slice_end   = sliceEnd;
  form.append('config', JSON.stringify(cfg));
  const resp = await fetch(SERVER + '/frames', {method: 'POST', body: form, signal});
  if (!resp.ok) throw new Error(await resp.text());
  const data  = await resp.json();
  const frame = data.frames?.[0];
  if (!frame?.voiced) throw new Error('No voiced speech detected');
  return frame;   // caller uses frame.f1, frame.f2
}

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
    document.getElementById('ppAnalyse').disabled=true;
  }catch(e){document.getElementById('ppStatus').textContent='Mic error: '+e.message;}
});
function stopRec(){
  recProcessor?.disconnect(); recStream?.getTracks().forEach(t=>t.stop());
  const total=recChunks.reduce((s,c)=>s+c.length,0);
  recSamples=new Float32Array(total);
  let off=0; for(const c of recChunks){recSamples.set(c,off);off+=c.length;}
  recBlob=encodeWAV(recSamples,recSampleRate);
  if(recObjectURL)URL.revokeObjectURL(recObjectURL);
  recObjectURL=URL.createObjectURL(recBlob);
  waveStart=0.33; waveEnd=0.67; waveCursorPos=null;
  recState='ready';
  document.getElementById('ppRecord').textContent='● Record';
  document.getElementById('ppRecord').classList.remove('rec-active');
  document.getElementById('recDot').classList.remove('on');
  document.getElementById('ppStatus').textContent=`${(total/recSampleRate*1000).toFixed(0)} ms — drag handles to set analysis window`;
  document.getElementById('ppPlay').disabled=false;
  document.getElementById('ppClear').disabled=false;
  document.getElementById('ppAnalyse').disabled=false;
  document.getElementById('waveCanvas').style.display='block';
  document.getElementById('waveInfo').style.display='block';
  requestAnimationFrame(drawWave); updateHint();
}
document.getElementById('ppPlay').addEventListener('click',()=>playSelection());
document.getElementById('ppClear').addEventListener('click',()=>{
  recBlob=null; recSamples=null; if(recObjectURL){URL.revokeObjectURL(recObjectURL);recObjectURL=null;}
  recState='idle'; recordedVowel=null;
  document.getElementById('ppStatus').textContent='Press Record and say a vowel';
  ['ppPlay','ppClear','ppAnalyse'].forEach(id=>document.getElementById(id).disabled=true);
  document.getElementById('ppFormants').textContent='';
  document.getElementById('waveCanvas').style.display='none';
  document.getElementById('waveInfo').style.display='none';
  updateHint(); renderFormant();
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

// ── User formant analysis ─────────────────────────────────────────────────────
document.getElementById('ppAnalyse').addEventListener('click', async()=>{
  if(!recSamples)return;
  const btn=document.getElementById('ppAnalyse');
  btn.textContent='…'; btn.disabled=true;
  try{
    const fullBlob=encodeWAV(recSamples,recSampleRate);
    const data=await analyzeWav(fullBlob, AbortSignal.timeout(10000), waveStart, waveEnd);
    recordedVowel={f1:data.f1,f2:data.f2};
    document.getElementById('ppFormants').innerHTML=`F1 <b>${data.f1.toFixed(0)}</b> F2 <b>${data.f2.toFixed(0)}</b> Hz`;
    document.getElementById('tabFormant').click(); renderFormant();
  }catch(e){document.getElementById('ppFormants').textContent='Error: '+e.message;}
  btn.textContent='⚡'; btn.disabled=false;
});