// ─── Language loading — 100% DB-backed ─────────────────────────────────────
// Used to fetch lang/index.json + lang/<key>/lang.json + lang/<key>/samples.json
// (static files); now reads the DB throughout — /api/v1/languages for the
// list, /api/v1/languages/<key>/full for vowel geometry (replaces lang.json),
// /api/v1/tokens + /api/v1/sounds for token-scatter data (replaces
// samples.json, via buildPseudoSamplesFromDb — js/audio.js — so
// charts.js/diphthong.js's consumers need no changes at all).
const LANGS = {};   // populated by loadLanguages()

async function loadLanguages() {
  try {
    const [languages, sounds] = await Promise.all([
      fetch('/api/v1/languages').then(r => r.json()),
      fetch('/api/v1/sounds').then(r => r.ok ? r.json() : []).catch(() => []),
    ]);
    await Promise.all(languages.filter(l => l.enabled).map(async lang => {
      try {
        const data = await fetch(`/api/v1/languages/${lang.key}/full`).then(r => r.ok ? r.json() : null);
        if (!data) return;
        LANGS[data.key] = data;

        const tokens = await fetch(`/api/v1/tokens?languageId=${lang.id}`).then(r => r.ok ? r.json() : []).catch(() => []);
        const mySounds = sounds.filter(s => s.languageId === lang.id);
        if (typeof setLangSamples === 'function') {
          setLangSamples(data.key, buildPseudoSamplesFromDb(tokens, mySounds, data.vowels));
        }
      } catch (e) {
        console.warn(`Skipped language ${lang.key}:`, e.message);
      }
    }));
  } catch (e) {
    console.error('Failed to load /api/v1/languages:', e);
  }

  init();
}

loadLanguages();
