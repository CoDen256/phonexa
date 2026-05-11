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

function getLength(v) {
  return v.type || 'short';  // 'short' | 'long' | 'diphthong'
}

function getBase(ipa) {
  // Strip length mark, return first character as the base phoneme symbol
  return ipa.replace('ː', '')[0] || ipa;
}

// ─── Filter state ─────────────────────────────────────────────────────────────
// ─── Filter state ─────────────────────────────────────────────────────────────
const filters = {
  languages : new Set(),
  roundness : new Set(),
  length    : new Set(['monophthong']),  // default: show monophthongs
  ipaBase   : new Set(),
};
function passesFilters(lk, v) {
  if (filters.languages.size > 0 && !filters.languages.has(lk))                           return false;
  if (filters.roundness.size > 0 && !filters.roundness.has(v.rounded?'rounded':'unrounded')) return false;
  if (filters.length.size > 0) {
    const t = getLength(v);
    let passes = false;
    for (const f of filters.length) {
      if (f === 'monophthong' && t !== 'diphthong')               { passes=true; break; }
      if (f === 'diphthong'   && t === 'diphthong')               { passes=true; break; }
      if (f === 'long'        && (t==='long'     || t==='variable')){ passes=true; break; }
      if (f === 'short'       && (t==='short'    || t==='variable')){ passes=true; break; }
      if (f === 'variable'    && t === 'variable')                 { passes=true; break; }
    }
    if (!passes) return false;
  }
  if (filters.ipaBase.size   > 0 && !filters.ipaBase.has(getBase(v.ipa)))                 return false;
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