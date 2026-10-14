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
// ─── Server-persisted filter state (per-profile, via /api/v1/settings) ─────
let _persistFiltersTimer = null;

function serializeFilters() {
  return {
    languages: [...filters.languages], roundness: [...filters.roundness],
    vtype: [...filters.vtype], length: [...filters.length], ipaBase: [...filters.ipaBase],
    showTokens: filters.showTokens, showAverages: filters.showAverages,
  };
}

// Debounced — every chip/toggle click site calls this right after its own
// buildSidebar()/renderAll() pair, so a burst of rapid clicks writes once.
function persistFilters() {
  clearTimeout(_persistFiltersTimer);
  _persistFiltersTimer = setTimeout(async () => {
    try {
      const userId = await UserLib.getCurrentUserId();
      await fetch(`/api/v1/settings/ipaChartFilters?userId=${userId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: serializeFilters() }),
      });
    } catch (e) {
      console.warn('Failed to persist filters:', e.message);
    }
  }, 400);
}

// Mutates the live `filters` object from a previously-saved value —
// buildSidebar()/renderAll() (called by index.html's init() right after
// this) render purely off this object's current state, so no separate
// DOM-checkbox step is needed.
async function restoreFilters() {
  try {
    const userId = await UserLib.getCurrentUserId();
    const res = await fetch(`/api/v1/settings?userId=${userId}`);
    const saved = res.ok ? (await res.json()).ipaChartFilters : null;
    if (!saved) return;
    filters.languages = new Set(saved.languages || []);
    filters.roundness = new Set(saved.roundness || []);
    filters.vtype     = new Set(saved.vtype || ['monophthong']);
    filters.length    = new Set(saved.length || []);
    filters.ipaBase   = new Set(saved.ipaBase || []);
    if (typeof saved.showTokens === 'boolean')   filters.showTokens   = saved.showTokens;
    if (typeof saved.showAverages === 'boolean') filters.showAverages = saved.showAverages;
  } catch (e) {
    console.warn('Failed to restore filters:', e.message);
  }
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