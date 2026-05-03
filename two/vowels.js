// vowels.js — Single source of truth for all IPA vowel data
// ─────────────────────────────────────────────────────────────────────────────
// Edit this file to add languages, adjust formant values, or swap audio files.

// ─── Audio configuration ─────────────────────────────────────────────────────
// Option A (default): stream from Wikimedia Commons (CC-licensed IPA recordings)
// Option B: set USE_LOCAL_AUDIO = true and place files at:
//           audio/{langKey}/{ipa}.ogg   e.g.  audio/english/iː.ogg
//   File name must exactly match the `ipa` field (url-encoded where needed).
//   Supported formats: .ogg  .mp3  .wav  — OGG recommended for browser compat.
//   Good sources for language-specific recordings:
//     • https://forvo.com       (native speaker recordings by language)
//     • https://phonetics.ucla.edu/research/uclarclarchive.html
//     • https://www.internationalphoneticalphabet.org/ipa-sounds/ipa-chart-with-sounds/
const USE_LOCAL_AUDIO  = false;
const LOCAL_AUDIO_BASE = './audio/';

// Wikimedia Commons OGG recordings — keyed by IPA base symbol (no length mark)
const WM_AUDIO = {
  'i':  'Close_front_unrounded_vowel.ogg',
  'y':  'Close_front_rounded_vowel.ogg',
  'ɨ':  'Close_central_unrounded_vowel.ogg',
  'ʉ':  'Close_central_rounded_vowel.ogg',
  'ɯ':  'Close_back_unrounded_vowel.ogg',
  'u':  'Close_back_rounded_vowel.ogg',
  'ɪ':  'Near-close_near-front_unrounded_vowel.ogg',
  'ʏ':  'Near-close_near-front_rounded_vowel.ogg',
  'ʊ':  'Near-close_near-back_rounded_vowel.ogg',
  'e':  'Close-mid_front_unrounded_vowel.ogg',
  'ø':  'Close-mid_front_rounded_vowel.ogg',
  'ɘ':  'Close-mid_central_unrounded_vowel.ogg',
  'ɤ':  'Close-mid_back_unrounded_vowel.ogg',
  'o':  'Close-mid_back_rounded_vowel.ogg',
  'ə':  'Mid-central_vowel.ogg',
  'ɛ':  'Open-mid_front_unrounded_vowel.ogg',
  'œ':  'Open-mid_front_rounded_vowel.ogg',
  'ɜ':  'Open-mid_central_unrounded_vowel.ogg',
  'ʌ':  'Open-mid_back_unrounded_vowel.ogg',
  'ɔ':  'Open-mid_back_rounded_vowel.ogg',
  'æ':  'Near-open_front_unrounded_vowel.ogg',
  'ɐ':  'Near-open_central_vowel.ogg',
  'a':  'Open_front_unrounded_vowel.ogg',
  'ɶ':  'Open_front_rounded_vowel.ogg',
  'ɑ':  'Open_back_unrounded_vowel.ogg',
  'ɒ':  'Open_back_rounded_vowel.ogg',
};

// Diphthongs/long variants → base phoneme for audio lookup
const DIPHTHONG_MAP = {
  'eɪ': 'e', 'oʊ': 'o', 'aɪ': 'a',
};

// Wikipedia articles per IPA base symbol (used for "Open in Wikipedia" links)
const WIKI_ARTICLE = {
  'i':  'https://en.wikipedia.org/wiki/Close_front_unrounded_vowel',
  'y':  'https://en.wikipedia.org/wiki/Close_front_rounded_vowel',
  'ɨ':  'https://en.wikipedia.org/wiki/Close_central_unrounded_vowel',
  'ʉ':  'https://en.wikipedia.org/wiki/Close_central_rounded_vowel',
  'ɯ':  'https://en.wikipedia.org/wiki/Close_back_unrounded_vowel',
  'u':  'https://en.wikipedia.org/wiki/Close_back_rounded_vowel',
  'ɪ':  'https://en.wikipedia.org/wiki/Near-close_near-front_unrounded_vowel',
  'ʏ':  'https://en.wikipedia.org/wiki/Near-close_near-front_rounded_vowel',
  'ʊ':  'https://en.wikipedia.org/wiki/Near-close_near-back_rounded_vowel',
  'e':  'https://en.wikipedia.org/wiki/Close-mid_front_unrounded_vowel',
  'ø':  'https://en.wikipedia.org/wiki/Close-mid_front_rounded_vowel',
  'ɘ':  'https://en.wikipedia.org/wiki/Close-mid_central_unrounded_vowel',
  'ɤ':  'https://en.wikipedia.org/wiki/Close-mid_back_unrounded_vowel',
  'o':  'https://en.wikipedia.org/wiki/Close-mid_back_rounded_vowel',
  'ə':  'https://en.wikipedia.org/wiki/Mid-central_vowel',
  'ɛ':  'https://en.wikipedia.org/wiki/Open-mid_front_unrounded_vowel',
  'œ':  'https://en.wikipedia.org/wiki/Open-mid_front_rounded_vowel',
  'ɜ':  'https://en.wikipedia.org/wiki/Open-mid_central_unrounded_vowel',
  'ʌ':  'https://en.wikipedia.org/wiki/Open-mid_back_unrounded_vowel',
  'ɔ':  'https://en.wikipedia.org/wiki/Open-mid_back_rounded_vowel',
  'æ':  'https://en.wikipedia.org/wiki/Near-open_front_unrounded_vowel',
  'ɐ':  'https://en.wikipedia.org/wiki/Near-open_central_vowel',
  'a':  'https://en.wikipedia.org/wiki/Open_front_unrounded_vowel',
  'ɶ':  'https://en.wikipedia.org/wiki/Open_front_rounded_vowel',
  'ɑ':  'https://en.wikipedia.org/wiki/Open_back_unrounded_vowel',
  'ɒ':  'https://en.wikipedia.org/wiki/Open_back_rounded_vowel',
};

// ─── Vowel data ───────────────────────────────────────────────────────────────
// h      : 0 (Close) → 1 (Open)          — articulatory height / F1 proxy
// b      : 0 (Front) → 1 (Back)          — backness / F2 proxy  
// rounded: lip rounding (drives tongue diagram lip shape)
// f1/f2  : formant frequencies in Hz (mean values from literature)
// word   : example words; HTML <b> marks the target sound
const LANGS = {

  cardinal: {
    label: 'Cardinal', color: '#607a96',
    vowels: [
      { ipa:'i',  h:0,    b:0.00, rounded:false, desc:'Close front unrounded',        f1:240, f2:2400 },
      { ipa:'y',  h:0,    b:0.02, rounded:true,  desc:'Close front rounded',          f1:235, f2:1870 },
      { ipa:'ɨ',  h:0,    b:0.50, rounded:false, desc:'Close central unrounded',      f1:250, f2:1450 },
      { ipa:'ʉ',  h:0,    b:0.55, rounded:true,  desc:'Close central rounded',        f1:250, f2:1380 },
      { ipa:'ɯ',  h:0,    b:0.95, rounded:false, desc:'Close back unrounded',         f1:250, f2: 800 },
      { ipa:'u',  h:0,    b:1.00, rounded:true,  desc:'Close back rounded',           f1:250, f2: 595 },
      { ipa:'e',  h:2/6,  b:0.00, rounded:false, desc:'Close-mid front unrounded',    f1:400, f2:2300 },
      { ipa:'ø',  h:2/6,  b:0.05, rounded:true,  desc:'Close-mid front rounded',      f1:370, f2:1600 },
      { ipa:'ɘ',  h:2/6,  b:0.50, rounded:false, desc:'Close-mid central unrounded',  f1:390, f2:1480 },
      { ipa:'ɤ',  h:2/6,  b:0.95, rounded:false, desc:'Close-mid back unrounded',     f1:430, f2:1000 },
      { ipa:'o',  h:2/6,  b:1.00, rounded:true,  desc:'Close-mid back rounded',       f1:400, f2: 840 },
      { ipa:'ə',  h:3/6,  b:0.50, rounded:false, desc:'Mid central',                  f1:490, f2:1490 },
      { ipa:'ɛ',  h:4/6,  b:0.00, rounded:false, desc:'Open-mid front unrounded',     f1:610, f2:2000 },
      { ipa:'œ',  h:4/6,  b:0.05, rounded:true,  desc:'Open-mid front rounded',       f1:480, f2:1260 },
      { ipa:'ɜ',  h:4/6,  b:0.50, rounded:false, desc:'Open-mid central unrounded',   f1:500, f2:1490 },
      { ipa:'ʌ',  h:4/6,  b:0.95, rounded:false, desc:'Open-mid back unrounded',      f1:650, f2:1200 },
      { ipa:'ɔ',  h:4/6,  b:1.00, rounded:true,  desc:'Open-mid back rounded',        f1:560, f2: 920 },
      { ipa:'æ',  h:5/6,  b:0.00, rounded:false, desc:'Near-open front unrounded',    f1:740, f2:1660 },
      { ipa:'ɐ',  h:5/6,  b:0.50, rounded:false, desc:'Near-open central',            f1:700, f2:1400 },
      { ipa:'a',  h:1,    b:0.00, rounded:false, desc:'Open front unrounded',         f1:850, f2:1610 },
      { ipa:'ɶ',  h:1,    b:0.05, rounded:true,  desc:'Open front rounded',           f1:820, f2:1320 },
      { ipa:'ɑ',  h:1,    b:1.00, rounded:false, desc:'Open back unrounded',          f1:850, f2:1100 },
      { ipa:'ɒ',  h:1,    b:0.95, rounded:true,  desc:'Open back rounded',            f1:820, f2: 900 },
    ]
  },

  english: {
    label: 'English', color: '#60a5fa',
    vowels: [
      { ipa:'iː',  h:0.03, b:0.04, rounded:false, desc:'Close front unrounded (long)',           word:'f<b>ee</b>t, s<b>ee</b>n',       f1:270, f2:2290 },
      { ipa:'ɪ',   h:0.20, b:0.20, rounded:false, desc:'Near-close near-front unrounded',        word:'k<b>i</b>t, b<b>i</b>t',         f1:400, f2:1920 },
      { ipa:'eɪ',  h:0.30, b:0.04, rounded:false, desc:'Close-mid front unrounded (diphthong)',  word:'f<b>a</b>ce, b<b>a</b>ke',       f1:430, f2:2090 },
      { ipa:'ɛ',   h:0.63, b:0.04, rounded:false, desc:'Open-mid front unrounded',               word:'dr<b>e</b>ss, b<b>e</b>d',       f1:580, f2:1990 },
      { ipa:'æ',   h:0.80, b:0.04, rounded:false, desc:'Near-open front unrounded',              word:'tr<b>a</b>p, c<b>a</b>t',        f1:750, f2:1660 },
      { ipa:'ɑː',  h:0.97, b:0.97, rounded:false, desc:'Open back unrounded (long)',             word:'f<b>a</b>ther, p<b>a</b>lm',     f1:800, f2:1100 },
      { ipa:'ɔː',  h:0.65, b:0.97, rounded:true,  desc:'Open-mid back rounded (long)',           word:'th<b>ough</b>t, cl<b>aw</b>',    f1:590, f2: 920 },
      { ipa:'oʊ',  h:0.27, b:0.93, rounded:true,  desc:'Close-mid back rounded (diphthong)',     word:'g<b>oa</b>t, n<b>o</b>',         f1:449, f2:1020 },
      { ipa:'ʊ',   h:0.20, b:0.78, rounded:true,  desc:'Near-close near-back rounded',           word:'f<b>oo</b>t, p<b>u</b>t',        f1:374, f2:1005 },
      { ipa:'uː',  h:0.04, b:0.84, rounded:true,  desc:'Close back rounded (long)',              word:'g<b>oo</b>se, f<b>oo</b>d',      f1:300, f2: 870 },
      { ipa:'ʌ',   h:0.67, b:0.62, rounded:false, desc:'Open-mid back unrounded',               word:'str<b>u</b>t, b<b>u</b>s',       f1:760, f2:1260 },
      { ipa:'ə',   h:0.48, b:0.50, rounded:false, desc:'Mid central (schwa)',                    word:'<b>a</b>bout, comm<b>a</b>',     f1:500, f2:1500 },
      { ipa:'ɜː',  h:0.63, b:0.44, rounded:false, desc:'Open-mid central unrounded (long)',      word:'n<b>ur</b>se, b<b>ir</b>d',      f1:500, f2:1490 },
    ]
  },

  german: {
    label: 'German', color: '#fb923c',
    vowels: [
      { ipa:'iː',  h:0.02, b:0.01, rounded:false, desc:'Close front unrounded (long)',           word:'L<b>ie</b>be, w<b>ie</b>',       f1:270, f2:2290 },
      { ipa:'yː',  h:0.02, b:0.08, rounded:true,  desc:'Close front rounded (long)',             word:'<b>ü</b>ber, gr<b>ün</b>',       f1:235, f2:1870 },
      { ipa:'ɪ',   h:0.21, b:0.18, rounded:false, desc:'Near-close near-front unrounded',        word:'m<b>i</b>t, b<b>i</b>tte',       f1:380, f2:1940 },
      { ipa:'ʏ',   h:0.21, b:0.24, rounded:true,  desc:'Near-close near-front rounded',          word:'h<b>ü</b>bsch, fl<b>üs</b>se',   f1:355, f2:1695 },
      { ipa:'eː',  h:0.30, b:0.01, rounded:false, desc:'Close-mid front unrounded (long)',       word:'S<b>ee</b>, g<b>e</b>ben',       f1:390, f2:2070 },
      { ipa:'øː',  h:0.30, b:0.08, rounded:true,  desc:'Close-mid front rounded (long)',         word:'sch<b>ö</b>n, h<b>ö</b>ren',     f1:370, f2:1615 },
      { ipa:'ɛ',   h:0.63, b:0.02, rounded:false, desc:'Open-mid front unrounded',               word:'B<b>e</b>tt, H<b>ä</b>nde',      f1:580, f2:1820 },
      { ipa:'œ',   h:0.63, b:0.09, rounded:true,  desc:'Open-mid front rounded',                 word:'zw<b>ö</b>lf, H<b>öl</b>le',     f1:490, f2:1290 },
      { ipa:'a',   h:0.97, b:0.18, rounded:false, desc:'Open front/central unrounded',           word:'M<b>a</b>nn, d<b>a</b>s',        f1:800, f2:1300 },
      { ipa:'aː',  h:0.94, b:0.23, rounded:false, desc:'Open central unrounded (long)',          word:'B<b>ah</b>n, j<b>a</b>',         f1:780, f2:1230 },
      { ipa:'oː',  h:0.28, b:0.97, rounded:true,  desc:'Close-mid back rounded (long)',          word:'gr<b>o</b>ß, S<b>oh</b>n',       f1:400, f2: 840 },
      { ipa:'ɔ',   h:0.66, b:0.94, rounded:true,  desc:'Open-mid back rounded',                  word:'K<b>o</b>pf, P<b>o</b>st',       f1:555, f2: 870 },
      { ipa:'uː',  h:0.02, b:0.97, rounded:true,  desc:'Close back rounded (long)',              word:'B<b>u</b>ch, R<b>uh</b>e',       f1:250, f2: 600 },
      { ipa:'ʊ',   h:0.21, b:0.80, rounded:true,  desc:'Near-close near-back rounded',           word:'M<b>u</b>tter, H<b>u</b>nd',     f1:360, f2: 780 },
      { ipa:'ə',   h:0.48, b:0.50, rounded:false, desc:'Mid central (Schwa)',                    word:'hab<b>e</b>, Kett<b>e</b>',      f1:490, f2:1350 },
    ]
  },

  russian: {
    label: 'Russian', color: '#f43f5e',
    vowels: [
      { ipa:'i',  h:0.02, b:0.02, rounded:false, desc:'Close front unrounded (и)',              word:'м<b>и</b>р (world)',              f1:270, f2:2200 },
      { ipa:'ɨ',  h:0.03, b:0.52, rounded:false, desc:'Close central unrounded (ы)',            word:'б<b>ы</b>ть (to be), т<b>ы</b>', f1:320, f2:1380 },
      { ipa:'u',  h:0.02, b:0.97, rounded:true,  desc:'Close back rounded (у)',                 word:'д<b>у</b>ша (soul)',              f1:300, f2: 680 },
      { ipa:'e',  h:0.44, b:0.04, rounded:false, desc:'Close-mid front unrounded (е/э)',        word:'<b>э</b>то (this), м<b>е</b>сто', f1:440, f2:1900 },
      { ipa:'o',  h:0.40, b:0.90, rounded:true,  desc:'Close-mid back rounded (о)',             word:'д<b>о</b>м (house)',              f1:500, f2:1000 },
      { ipa:'a',  h:0.97, b:0.38, rounded:false, desc:'Open central unrounded (а)',             word:'д<b>а</b> (yes), м<b>а</b>ть',   f1:850, f2:1350 },
    ]
  },

  norwegian: {
    label: 'Norwegian', color: '#22d3ee',
    vowels: [
      { ipa:'i',  h:0.02, b:0.02, rounded:false, desc:'Close front unrounded',                  word:'f<b>i</b>n, l<b>i</b>ten',       f1:240, f2:2380 },
      { ipa:'y',  h:0.02, b:0.08, rounded:true,  desc:'Close front rounded',                    word:'n<b>y</b>, b<b>y</b>',            f1:235, f2:1810 },
      { ipa:'ʉ',  h:0.04, b:0.54, rounded:true,  desc:'Close central rounded (Norwegian u)',    word:'h<b>u</b>s, sk<b>u</b>lle',       f1:260, f2:1370 },
      { ipa:'e',  h:0.30, b:0.02, rounded:false, desc:'Close-mid front unrounded',              word:'s<b>e</b>, br<b>e</b>v',          f1:395, f2:2080 },
      { ipa:'ø',  h:0.30, b:0.08, rounded:true,  desc:'Close-mid front rounded',                word:'gr<b>ø</b>t, s<b>ø</b>t',         f1:375, f2:1590 },
      { ipa:'o',  h:0.28, b:0.97, rounded:true,  desc:'Close-mid back rounded',                 word:'b<b>o</b>, g<b>o</b>d',           f1:410, f2: 880 },
      { ipa:'ɛ',  h:0.62, b:0.03, rounded:false, desc:'Open-mid front unrounded',               word:'s<b>e</b>tt, m<b>e</b>d',         f1:575, f2:1880 },
      { ipa:'æ',  h:0.80, b:0.03, rounded:false, desc:'Near-open front unrounded',              word:'l<b>æ</b>rer, v<b>æ</b>re',       f1:730, f2:1700 },
      { ipa:'a',  h:0.97, b:0.18, rounded:false, desc:'Open front unrounded',                   word:'m<b>a</b>t, d<b>a</b>g',          f1:820, f2:1380 },
      { ipa:'ɔ',  h:0.64, b:0.94, rounded:true,  desc:'Open-mid back rounded (å)',              word:'<b>å</b>tte, b<b>å</b>t',         f1:545, f2: 865 },
    ]
  },

};