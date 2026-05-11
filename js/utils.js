// ── Shared SVG + IPA utilities ──────────────────────────────────────────────
// ─── SVG helpers ─────────────────────────────────────────────────────────────
const NS='http://www.w3.org/2000/svg';
function $s(tag,a={}) {
  const el=document.createElementNS(NS,tag);
  for(const[k,vv]of Object.entries(a)) el.setAttribute(k,String(vv));
  return el;
}
function $t(str,a={}) { const el=$s('text',a); el.textContent=str; return el; }
function ipaW(ipa,fs) { let w=0; for(const c of ipa) w+=c==='ː'?0.36:0.65; return w*fs; }

// isDiph — used by both index and editor
function isDiph(v){ return v.type==='diphthong' && v.h2!=null && v.b2!=null; }
