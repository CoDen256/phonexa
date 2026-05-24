// ─── Audio helpers ────────────────────────────────────────────────────────────
// ─── Helpers ─────────────────────────────────────────────────────────────────
let curAudio = null;

function isCompareMode() {
  return !!(recObjectURL && document.getElementById('practicePanel')?.classList.contains('open'));
}

function playUrl(url) {
  if (!url) return;
  const a = new Audio(url);
  if (isCompareMode()) {
    a.onended = () => setTimeout(() => playSelection(), 350);
  }
  a.play().catch(e => console.warn('Audio:', e.message));
}

function playUrlAtRate(url, rate=1) {
  if (!url) return;
  const a = new Audio(url); a.playbackRate = rate;
  if (isCompareMode()) {
    a.onended = () => setTimeout(() => playSelection(), 350);
  }
  a.play().catch(e => console.warn('Audio:', e.message));
}

// getLength and getBase live in utils.js (shared with editor which doesn't load filters.js)

// ─── Filter state ─────────────────────────────────────────────────────────────
// ─── Filter state ─────────────────────────────────────────────────────────────
const filters = {
  languages : new Set(),
  roundness : new Set(),
  vtype     : new Set(['monophthong']),  // monophthong | diphthong
  length    : new Set(),                 // long | short | variable
  ipaBase   : new Set(),
  showTokens:   false,                   // overlay individual token measurements on formant chart
  showAverages: true,                    // show average vowel dots on formant chart
};
function passesFilters(lk, v) {
  if (filters.languages.size > 0 && !filters.languages.has(lk))                              return false;
  if (filters.roundness.size > 0 && !filters.roundness.has(v.rounded?'rounded':'unrounded')) return false;
  if (filters.vtype.size > 0) {
    const isDiph = v.type === 'diphthong';
    if (!(filters.vtype.has('diphthong') && isDiph) && !(filters.vtype.has('monophthong') && !isDiph)) return false;
  }
  if (filters.length.size > 0) {
    const t = getLength(v);
    let passes = false;
    for (const f of filters.length) {
      if (f === 'long'     && (t==='long'     || t==='variable')) { passes=true; break; }
      if (f === 'short'    && (t==='short'    || t==='variable')) { passes=true; break; }
      if (f === 'variable' && t === 'variable')                   { passes=true; break; }
    }
    if (!passes) return false;
  }
  if (filters.ipaBase.size > 0 && !filters.ipaBase.has(getBase(v.symbols?.[0] ?? ''))) return false;
  return true;
}
function countShown() {
  let n=0;
  for (const [lk,lang] of Object.entries(LANGS))
    for (const v of lang.vowels) if (passesFilters(lk,v)) n++;
  return n;
}
function totalVowels() {
  return Object.values(LANGS).reduce((s,l)=>s+l.vowels.length, 0);
}