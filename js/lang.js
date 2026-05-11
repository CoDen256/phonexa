// ─── Language loading ────────────────────────────────────────────────────────
const LANGS = {};   // populated by loadLanguages()

async function loadLanguages() {
  try {
    // 1. Load the language list
    const idx = await fetch('lang/index.json').then(r => r.json());
    const names = (idx.languages || []).filter(n => !n.startsWith('_'));

    // 2. Fetch all language files in parallel
    const results = await Promise.all(
      names.map(name =>
        fetch(`lang/${name}/lang.json`)
          .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
          .catch(e => { console.warn(`Skipped lang/${name}/lang.json:`, e.message); return null; })
      )
    );

    // 3. Register each successfully loaded language
    for (const data of results) {
      if (data && data.key) LANGS[data.key] = data;
    }
  } catch (e) {
    console.error('Failed to load lang/index.json:', e);
  }

  init();
}

loadLanguages();