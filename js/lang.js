// ─── Language loading ────────────────────────────────────────────────────────
const LANGS = {};   // populated by loadLanguages()

async function loadLanguages() {
  try {
    // 1. Load the language list
    const idx = await fetch('lang/index.json').then(r => r.json());
    const names = (idx.languages || []).filter(n => n && n.length > 0 && !n.startsWith('_'));

    // 2. Fetch lang.json + samples.json for every language in parallel,
    //    awaiting both before calling init() so LANG_SAMPLES is ready.
    await Promise.all(names.map(async name => {
      try {
        const r = await fetch(`lang/${name}/lang.json`);
        if (!r.ok) throw new Error(r.status);
        const data = await r.json();
        if (data && data.key) {
          LANGS[data.key] = data;
          // Load samples — use data.key so it matches LANGS key
          try {
            const samples = await fetch(`lang/${name}/samples.json`).then(r => r.ok ? r.json() : []);
            if (typeof setLangSamples === 'function') setLangSamples(data.key, samples);
          } catch (_) { /* samples optional */ }
        }
      } catch (e) {
        console.warn(`Skipped lang/${name}:`, e.message);
      }
    }));
  } catch (e) {
    console.error('Failed to load lang/index.json:', e);
  }

  init();
}

loadLanguages();