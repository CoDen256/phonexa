// ─── IPA Consonant Chart — grid + per-language strip ───────────────────────
// Ports the validated mockup (openspec/changes/add-consonant-chart/mockup.html)
// onto live DB data (GET /api/v1/consonants, /api/v1/languages). Symbol
// composition is delegated to js/consonant-symbol.js — never hand-baked here.

const PLACES = ['labial', 'dental', 'alveolar', 'postalveolar', 'alveolo_palatal', 'palatal', 'velar', 'uvular', 'glottal'];
const PLACE_LABEL = {
  labial: 'Labial', dental: 'Dental', alveolar: 'Alveolar', postalveolar: 'Postalveolar',
  alveolo_palatal: 'Alveolo-palatal', palatal: 'Palatal', velar: 'Velar', uvular: 'Uvular',
  glottal: 'Glottal', exo_labial: 'Exo-labial', endo_labial: 'Endo-labial', pharyngeal: 'Pharyngeal',
  epiglottal: 'Epiglottal', retroflex: 'Retroflex',
};
const PLACE_SUB = { labial: 'bilabial/labiodental', alveolo_palatal: 'pre-palatal' };
const MANNERS = ['nasal', 'plosive', 'affricate', 'fricative', 'trill', 'approximant', 'lateral_approximant'];
const MANNER_LABEL = {
  nasal: 'Nasal', plosive: 'Plosive', affricate: 'Affricate', fricative: 'Fricative',
  trill: 'Trill', tap_or_flap: 'Tap/Flap', approximant: 'Approximant', lateral_approximant: 'Lateral Approximant',
  lateral_fricative: 'Lateral Fricative', lateral_flap: 'Lateral Flap', click: 'Click', ejective: 'Ejective', implosive: 'Implosive',
};
const SECONDARY = ['aspirated', 'palatalized', 'velarized', 'pharyngealized', 'labialized', 'glottalized'];
const SEC_LABEL = {
  aspirated: 'Aspirated ʰ', palatalized: 'Palatalized ʲ', velarized: 'Velarized ˠ',
  pharyngealized: 'Pharyngealized ˤ', labialized: 'Labialized ʷ', glottalized: 'Glottalized ʼ',
};
const ACTIVE_LABEL = { apical: 'Apical ◌̺', laminal: 'Laminal ◌̻', labial: 'Labial', sub_apical: 'Sub-apical', antero_dorsal: 'Antero-dorsal', postero_dorsal: 'Postero-dorsal', radical: 'Radical' };

let LANGS = {};        // key -> {id, label, color}
let CONSONANTS = [];   // all loaded consonants, camelCase fields + `lang` (key) attached

let activeLangs = new Set();
let activeSec = new Set();
let activeActiveArt = new Set();
let activeVoicing = new Set();
let activeSyllabic = false;
let currentStripLang = null;

// AND across categories, OR within a category — same semantics as index.html's
// passesFilters (js/filters.js), just driving a highlight/dim treatment
// instead of a hide (see design.md decision 5).
function anyHighlightActive() { return activeSec.size || activeActiveArt.size || activeVoicing.size || activeSyllabic; }
function matchesHighlight(c) {
  if (activeSec.size && !c.secondaryArticulation.some(s => activeSec.has(s))) return false;
  if (activeActiveArt.size && !(c.activeArticulator && activeActiveArt.has(c.activeArticulator))) return false;
  if (activeVoicing.size && !activeVoicing.has(c.voicing)) return false;
  if (activeSyllabic && !c.syllabic) return false;
  return true;
}

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const k in attrs) { if (k === 'html') n.innerHTML = attrs[k]; else n.setAttribute(k, attrs[k]); }
  kids.forEach(k => { if (typeof k === 'string') n.appendChild(document.createTextNode(k)); else if (k) n.appendChild(k); });
  return n;
}

// ---------- Bootstrap ----------
async function init() {
  const [languages, consonants] = await Promise.all([
    fetch('/api/v1/languages').then(r => r.json()),
    fetch('/api/v1/consonants').then(r => r.json()),
  ]);
  const idToLang = {};
  languages.forEach(l => { idToLang[l.id] = l; });

  CONSONANTS = consonants
    .filter(c => idToLang[c.languageId])
    .map(c => ({ ...c, lang: idToLang[c.languageId].key }));

  const usedKeys = [...new Set(CONSONANTS.map(c => c.lang))];
  languages
    .filter(l => usedKeys.includes(l.key))
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .forEach(l => { LANGS[l.key] = { id: l.id, label: l.label, color: l.color }; });

  activeLangs = new Set(Object.keys(LANGS));
  currentStripLang = Object.keys(LANGS)[0] || null;

  buildLangChips(); buildSecChips(); buildActiveChips(); buildVoicingChips(); buildSyllChips(); buildStripRadios();
  renderGrid(); renderStrip();

  document.getElementById('loading').style.display = 'none';
  document.getElementById('app').style.display = '';
}

// ---------- Rail: language + highlight chips ----------
function buildLangChips() {
  const wrap = document.getElementById('conLangChips'); wrap.innerHTML = '';
  Object.entries(LANGS).forEach(([key, lang]) => {
    const chip = el('button', { class: 'con-chip con-lang', 'aria-pressed': 'true' },
      el('span', { class: 'con-dot', style: `background:${lang.color}` }), lang.label);
    chip.addEventListener('click', () => {
      if (activeLangs.has(key)) activeLangs.delete(key); else activeLangs.add(key);
      chip.setAttribute('aria-pressed', activeLangs.has(key));
      renderGrid();
    });
    wrap.appendChild(chip);
  });
}
function buildSecChips() {
  const wrap = document.getElementById('conSecChips'); wrap.innerHTML = '';
  SECONDARY.forEach(key => {
    const chip = el('button', { class: 'con-chip con-sec', 'aria-pressed': 'false' }, SEC_LABEL[key]);
    chip.addEventListener('click', () => {
      if (activeSec.has(key)) activeSec.delete(key); else activeSec.add(key);
      chip.setAttribute('aria-pressed', activeSec.has(key));
      renderGrid(); renderStrip();
    });
    wrap.appendChild(chip);
  });
}
function buildActiveChips() {
  const wrap = document.getElementById('conActiveChips'); wrap.innerHTML = '';
  ['apical', 'laminal'].forEach(key => {
    const chip = el('button', { class: 'con-chip con-sec', 'aria-pressed': 'false' }, ACTIVE_LABEL[key]);
    chip.addEventListener('click', () => {
      if (activeActiveArt.has(key)) activeActiveArt.delete(key); else activeActiveArt.add(key);
      chip.setAttribute('aria-pressed', activeActiveArt.has(key));
      renderGrid(); renderStrip();
    });
    wrap.appendChild(chip);
  });
}
function buildVoicingChips() {
  const wrap = document.getElementById('conVoicingChips'); wrap.innerHTML = '';
  [['voiceless', 'Voiceless ○'], ['voiced', 'Voiced ●']].forEach(([key, label]) => {
    const chip = el('button', { class: 'con-chip con-sec', 'aria-pressed': 'false' }, label);
    chip.addEventListener('click', () => {
      if (activeVoicing.has(key)) activeVoicing.delete(key); else activeVoicing.add(key);
      chip.setAttribute('aria-pressed', activeVoicing.has(key));
      renderGrid(); renderStrip();
    });
    wrap.appendChild(chip);
  });
}
function buildSyllChips() {
  const wrap = document.getElementById('conSyllChips'); wrap.innerHTML = '';
  const chip = el('button', { class: 'con-chip con-sec', 'aria-pressed': 'false' }, 'Syllabic ◌̩');
  chip.addEventListener('click', () => {
    activeSyllabic = !activeSyllabic;
    chip.setAttribute('aria-pressed', activeSyllabic);
    renderGrid(); renderStrip();
  });
  wrap.appendChild(chip);
}

// ---------- Grid view ----------
function renderGrid() {
  const table = document.getElementById('conGrid');
  table.innerHTML = '';
  const thead = el('thead');
  const hr = el('tr'); hr.appendChild(el('th', { style: 'background:var(--surface);border:none;' }));
  PLACES.forEach(p => {
    hr.appendChild(el('th', {}, PLACE_LABEL[p], PLACE_SUB[p] ? el('span', { class: 'con-ph' }, PLACE_SUB[p]) : null));
  });
  thead.appendChild(hr); table.appendChild(thead);

  const tbody = el('tbody');
  MANNERS.forEach(manner => {
    const row = el('tr');
    row.appendChild(el('th', {}, MANNER_LABEL[manner]));
    PLACES.forEach(place => {
      const matches = CONSONANTS.filter(c => c.manner === manner && c.passivePlace === place && activeLangs.has(c.lang));
      if (!matches.length) { row.appendChild(el('td', { class: 'con-empty' })); return; }
      const td = el('td');
      const wrap = el('div', { class: 'con-cellPills' });
      matches.forEach(c => wrap.appendChild(renderPill(c)));
      td.appendChild(wrap);
      row.appendChild(td);
    });
    tbody.appendChild(row);
  });
  table.appendChild(tbody);
}

function renderPill(c) {
  const active = anyHighlightActive();
  const lit = active && matchesHighlight(c);
  const dim = active && !lit;
  const pill = el('button', {
    class: 'con-pill' + (lit ? ' con-lit' : '') + (dim ? ' con-dimmed' : ''), 'data-voicing': c.voicing,
    style: `color:${LANGS[c.lang].color}`, title: LANGS[c.lang].label + ' — click for full feature breakdown',
  });
  pill.appendChild(el('span', { class: 'con-vdot' }));
  pill.appendChild(el('span', { class: 'con-glyph' }, buildConsonantSymbol(c)));
  pill.addEventListener('click', e => openInspector(c, e.currentTarget));
  return pill;
}

// ---------- Inspector ----------
const insp = document.getElementById('conInspector');
let inspAudio = null;
function openInspector(c, anchor) {
  document.getElementById('conInspIpa').textContent = buildConsonantSymbol(c);
  const langEl = document.getElementById('conInspLang');
  langEl.textContent = LANGS[c.lang].label; langEl.style.color = LANGS[c.lang].color;
  document.getElementById('conInspManner').textContent = MANNER_LABEL[c.manner] || c.manner;
  const placeLabel = PLACE_LABEL[c.passivePlace] || c.passivePlace;
  document.getElementById('conInspPlace').textContent = placeLabel + (c.coarticulatedPlace ? `  (co-articulated: ${placeLabel}+${PLACE_LABEL[c.coarticulatedPlace] || c.coarticulatedPlace})` : '');
  document.getElementById('conInspActive').textContent = c.activeArticulator ? (ACTIVE_LABEL[c.activeArticulator] || c.activeArticulator) : '— (implied by manner/place)';
  document.getElementById('conInspVoicing').textContent = c.voicing[0].toUpperCase() + c.voicing.slice(1) + (c.syllabic ? ' · syllabic' : '');
  const secWrap = document.getElementById('conInspSec'); secWrap.innerHTML = '';
  if (c.secondaryArticulation.length) c.secondaryArticulation.forEach(s => secWrap.appendChild(el('span', { class: 'con-secbadge' }, SEC_LABEL[s] || s)));
  else secWrap.appendChild(el('span', { style: 'color:var(--muted);font-size:.74rem;' }, 'none'));
  const noteEl = document.getElementById('conInspNote');
  if (c.desc) { noteEl.style.display = 'block'; noteEl.textContent = c.desc; } else { noteEl.style.display = 'none'; }

  const playBtn = document.getElementById('conInspPlay');
  if (c.representativeAudioUrl) {
    playBtn.style.display = '';
    playBtn.onclick = () => { if (inspAudio) inspAudio.pause(); inspAudio = new Audio(c.representativeAudioUrl); inspAudio.play().catch(() => {}); };
  } else {
    playBtn.style.display = 'none';
    playBtn.onclick = null;
  }

  const r = anchor.getBoundingClientRect();
  insp.style.top = Math.min(window.innerHeight - 280, r.bottom + 8) + 'px';
  insp.style.left = Math.min(window.innerWidth - 296, Math.max(10, r.left - 60)) + 'px';
  insp.classList.add('show');
}
document.getElementById('conInspClose').addEventListener('click', () => insp.classList.remove('show'));
document.addEventListener('click', e => {
  if (insp.classList.contains('show') && !insp.contains(e.target) && !e.target.closest('.con-pill') && !e.target.closest('.con-pcard')) insp.classList.remove('show');
});

// ---------- Strip view ----------
function buildStripRadios() {
  const wrap = document.getElementById('conStripRadios'); wrap.innerHTML = '';
  Object.entries(LANGS).forEach(([key, lang]) => {
    const btn = el('button', { class: 'con-langRadio', 'aria-pressed': key === currentStripLang ? 'true' : 'false', style: `color:${lang.color}` },
      el('span', { class: 'con-dot', style: `background:${lang.color}` }), lang.label);
    btn.addEventListener('click', () => { currentStripLang = key; renderStrip(); buildStripRadios(); });
    wrap.appendChild(btn);
  });
}
function renderStrip() {
  const body = document.getElementById('conStripBody'); body.innerHTML = '';
  if (!currentStripLang) return;
  const phones = CONSONANTS.filter(c => c.lang === currentStripLang);
  document.getElementById('conStripMeta').textContent =
    `${phones.length} consonant phones · ${new Set(phones.map(c => c.manner)).size} manners · ${new Set(phones.map(c => c.passivePlace)).size} places`;
  MANNERS.forEach(manner => {
    const inManner = phones.filter(c => c.manner === manner);
    if (!inManner.length) return;
    const group = el('div', { class: 'con-mannerGroup' });
    group.appendChild(el('h3', {}, MANNER_LABEL[manner]));
    const row = el('div', { class: 'con-cardRow' });
    inManner.forEach(c => {
      const active = anyHighlightActive();
      const lit = active && matchesHighlight(c);
      const dim = active && !lit;
      const card = el('div', { class: 'con-pcard' + (lit ? ' con-lit' : '') + (dim ? ' con-dimmed' : '') });
      card.appendChild(el('div', { class: 'con-glyph', style: `color:${LANGS[c.lang].color}` }, buildConsonantSymbol(c)));
      card.appendChild(el('div', { class: 'con-place' },
        (PLACE_LABEL[c.passivePlace] || c.passivePlace) + ' · ' + c.voicing +
        (c.activeArticulator ? ' · ' + (ACTIVE_LABEL[c.activeArticulator] || c.activeArticulator) : '') +
        (c.syllabic ? ' · syllabic' : '')));
      if (c.secondaryArticulation.length) {
        const sec = el('div', { class: 'con-sec' });
        c.secondaryArticulation.forEach(s => sec.appendChild(el('span', {}, SEC_LABEL[s] || s)));
        card.appendChild(sec);
      }
      if (c.desc) card.appendChild(el('div', { class: 'con-cnote' }, c.desc));
      card.addEventListener('click', e => openInspector(c, e.currentTarget));
      row.appendChild(card);
    });
    group.appendChild(row);
    body.appendChild(group);
  });
}

// ---------- Tabs ----------
document.querySelectorAll('.con-viewTab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.con-viewTab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.con-view').forEach(v => v.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('conView-' + tab.dataset.view).classList.add('active');
  });
});

init();
