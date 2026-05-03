// vowels.js — Single source of truth for all IPA vowel data
// ─────────────────────────────────────────────────────────────────────────────

// ─── IPA phoneme audio ────────────────────────────────────────────────────────
// Option A (default): Wikimedia Commons CC-licensed IPA recordings.
// Option B: set USE_LOCAL_AUDIO = true, place files at audio/{langKey}/{ipa}.ogg
const USE_LOCAL_AUDIO  = false;
const LOCAL_AUDIO_BASE = './audio/';

const WM_AUDIO = {
  'i':'Close_front_unrounded_vowel.ogg',      'y':'Close_front_rounded_vowel.ogg',
  'ɨ':'Close_central_unrounded_vowel.ogg',    'ʉ':'Close_central_rounded_vowel.ogg',
  'ɯ':'Close_back_unrounded_vowel.ogg',       'u':'Close_back_rounded_vowel.ogg',
  'ɪ':'Near-close_near-front_unrounded_vowel.ogg',
  'ʏ':'Near-close_near-front_rounded_vowel.ogg',
  'ʊ':'Near-close_near-back_rounded_vowel.ogg',
  'e':'Close-mid_front_unrounded_vowel.ogg',  'ø':'Close-mid_front_rounded_vowel.ogg',
  'ɘ':'Close-mid_central_unrounded_vowel.ogg','ɤ':'Close-mid_back_unrounded_vowel.ogg',
  'o':'Close-mid_back_rounded_vowel.ogg',     'ə':'Mid-central_vowel.ogg',
  'ɛ':'Open-mid_front_unrounded_vowel.ogg',   'œ':'Open-mid_front_rounded_vowel.ogg',
  'ɜ':'Open-mid_central_unrounded_vowel.ogg', 'ʌ':'Open-mid_back_unrounded_vowel.ogg',
  'ɔ':'Open-mid_back_rounded_vowel.ogg',      'æ':'Near-open_front_unrounded_vowel.ogg',
  'ɐ':'Near-open_central_vowel.ogg',          'a':'Open_front_unrounded_vowel.ogg',
  'ɶ':'Open_front_rounded_vowel.ogg',         'ɑ':'Open_back_unrounded_vowel.ogg',
  'ɒ':'Open_back_rounded_vowel.ogg',
};

// Diphthongs → base phoneme for IPA audio lookup
const DIPHTHONG_MAP = { 'eɪ':'e', 'oʊ':'o', 'aɪ':'a' };

// Wikipedia articles per base symbol
const WIKI_ARTICLE = {
  'i':'https://en.wikipedia.org/wiki/Close_front_unrounded_vowel',
  'y':'https://en.wikipedia.org/wiki/Close_front_rounded_vowel',
  'ɨ':'https://en.wikipedia.org/wiki/Close_central_unrounded_vowel',
  'ʉ':'https://en.wikipedia.org/wiki/Close_central_rounded_vowel',
  'ɯ':'https://en.wikipedia.org/wiki/Close_back_unrounded_vowel',
  'u':'https://en.wikipedia.org/wiki/Close_back_rounded_vowel',
  'ɪ':'https://en.wikipedia.org/wiki/Near-close_near-front_unrounded_vowel',
  'ʏ':'https://en.wikipedia.org/wiki/Near-close_near-front_rounded_vowel',
  'ʊ':'https://en.wikipedia.org/wiki/Near-close_near-back_rounded_vowel',
  'e':'https://en.wikipedia.org/wiki/Close-mid_front_unrounded_vowel',
  'ø':'https://en.wikipedia.org/wiki/Close-mid_front_rounded_vowel',
  'ɘ':'https://en.wikipedia.org/wiki/Close-mid_central_unrounded_vowel',
  'ɤ':'https://en.wikipedia.org/wiki/Close-mid_back_unrounded_vowel',
  'o':'https://en.wikipedia.org/wiki/Close-mid_back_rounded_vowel',
  'ə':'https://en.wikipedia.org/wiki/Mid-central_vowel',
  'ɛ':'https://en.wikipedia.org/wiki/Open-mid_front_unrounded_vowel',
  'œ':'https://en.wikipedia.org/wiki/Open-mid_front_rounded_vowel',
  'ɜ':'https://en.wikipedia.org/wiki/Open-mid_central_unrounded_vowel',
  'ʌ':'https://en.wikipedia.org/wiki/Open-mid_back_unrounded_vowel',
  'ɔ':'https://en.wikipedia.org/wiki/Open-mid_back_rounded_vowel',
  'æ':'https://en.wikipedia.org/wiki/Near-open_front_unrounded_vowel',
  'ɐ':'https://en.wikipedia.org/wiki/Near-open_central_vowel',
  'a':'https://en.wikipedia.org/wiki/Open_front_unrounded_vowel',
  'ɶ':'https://en.wikipedia.org/wiki/Open_front_rounded_vowel',
  'ɑ':'https://en.wikipedia.org/wiki/Open_back_unrounded_vowel',
  'ɒ':'https://en.wikipedia.org/wiki/Open_back_rounded_vowel',
};

// ─── Vowel data ───────────────────────────────────────────────────────────────
// h       : 0 (Close) → 1 (Open)
// b       : 0 (Front) → 1 (Back)
// rounded : lip rounding
// f1/f2   : formant Hz
// words   : array of { text: HTML string (<b> = target sound), audio: URL|null }
//           Each word is rendered individually; audio plays the whole spoken word.
//           Sources: Wikimedia Commons  https://commons.wikimedia.org/wiki/Special:Redirect/file/FILENAME
//                    Forvo              https://forvo.com/word/WORD/#LANG_CODE
//                    Local files        ./word-audio/{langKey}/{word}.ogg
//
// Cardinal pairs share the SAME (h, b) — matching the standard IPA chart where
// unrounded/rounded partners appear left/right of one shared dot.

const WM = 'https://commons.wikimedia.org/wiki/Special:Redirect/file/';

const LANGS = {

  cardinal: {
    label:'Cardinal', color:'#607a96',
    vowels:[
      {ipa:'i',  h:0,    b:0.00, rounded:false, desc:'Close front unrounded',        f1:240,f2:2400,words:[]},
      {ipa:'y',  h:0,    b:0.00, rounded:true,  desc:'Close front rounded',          f1:235,f2:1870,words:[]},
      {ipa:'ɨ',  h:0,    b:0.50, rounded:false, desc:'Close central unrounded',      f1:250,f2:1450,words:[]},
      {ipa:'ʉ',  h:0,    b:0.50, rounded:true,  desc:'Close central rounded',        f1:250,f2:1380,words:[]},
      {ipa:'ɯ',  h:0,    b:1.00, rounded:false, desc:'Close back unrounded',         f1:250,f2:800, words:[]},
      {ipa:'u',  h:0,    b:1.00, rounded:true,  desc:'Close back rounded',           f1:250,f2:595, words:[]},
      {ipa:'e',  h:2/6,  b:0.00, rounded:false, desc:'Close-mid front unrounded',    f1:400,f2:2300,words:[]},
      {ipa:'ø',  h:2/6,  b:0.00, rounded:true,  desc:'Close-mid front rounded',      f1:370,f2:1600,words:[]},
      {ipa:'ɘ',  h:2/6,  b:0.50, rounded:false, desc:'Close-mid central unrounded',  f1:390,f2:1480,words:[]},
      {ipa:'ɤ',  h:2/6,  b:1.00, rounded:false, desc:'Close-mid back unrounded',     f1:430,f2:1000,words:[]},
      {ipa:'o',  h:2/6,  b:1.00, rounded:true,  desc:'Close-mid back rounded',       f1:400,f2:840, words:[]},
      {ipa:'ə',  h:3/6,  b:0.50, rounded:false, desc:'Mid central',                  f1:490,f2:1490,words:[]},
      {ipa:'ɛ',  h:4/6,  b:0.00, rounded:false, desc:'Open-mid front unrounded',     f1:610,f2:2000,words:[]},
      {ipa:'œ',  h:4/6,  b:0.00, rounded:true,  desc:'Open-mid front rounded',       f1:480,f2:1260,words:[]},
      {ipa:'ɜ',  h:4/6,  b:0.50, rounded:false, desc:'Open-mid central unrounded',   f1:500,f2:1490,words:[]},
      {ipa:'ʌ',  h:4/6,  b:1.00, rounded:false, desc:'Open-mid back unrounded',      f1:650,f2:1200,words:[]},
      {ipa:'ɔ',  h:4/6,  b:1.00, rounded:true,  desc:'Open-mid back rounded',        f1:560,f2:920, words:[]},
      {ipa:'æ',  h:5/6,  b:0.00, rounded:false, desc:'Near-open front unrounded',    f1:740,f2:1660,words:[]},
      {ipa:'ɐ',  h:5/6,  b:0.50, rounded:false, desc:'Near-open central',            f1:700,f2:1400,words:[]},
      {ipa:'a',  h:1,    b:0.00, rounded:false, desc:'Open front unrounded',         f1:850,f2:1610,words:[]},
      {ipa:'ɶ',  h:1,    b:0.00, rounded:true,  desc:'Open front rounded',           f1:820,f2:1320,words:[]},
      {ipa:'ɑ',  h:1,    b:1.00, rounded:false, desc:'Open back unrounded',          f1:850,f2:1100,words:[]},
      {ipa:'ɒ',  h:1,    b:1.00, rounded:true,  desc:'Open back rounded',            f1:820,f2:900, words:[]},
    ]
  },

  english: {
    label:'English', color:'#60a5fa',
    vowels:[
      {ipa:'iː', h:0.03,b:0.04,rounded:false,desc:'Close front unrounded (long)',
        f1:270,f2:2290,words:[
          {text:'f<b>ee</b>t', audio:WM+'En-us-feet.ogg'},
          {text:'s<b>ee</b>n', audio:WM+'En-us-seen.ogg'},
      ]},
      {ipa:'ɪ',  h:0.20,b:0.20,rounded:false,desc:'Near-close near-front unrounded',
        f1:400,f2:1920,words:[
          {text:'k<b>i</b>t',  audio:WM+'En-us-kit.ogg'},
          {text:'b<b>i</b>t',  audio:WM+'En-us-bit.ogg'},
      ]},
      {ipa:'eɪ', h:0.30,b:0.04,rounded:false,desc:'Close-mid front unrounded (diphthong)',
        f1:430,f2:2090,words:[
          {text:'f<b>a</b>ce', audio:WM+'En-us-face.ogg'},
          {text:'b<b>a</b>ke', audio:WM+'En-us-bake.ogg'},
      ]},
      {ipa:'ɛ',  h:0.63,b:0.04,rounded:false,desc:'Open-mid front unrounded',
        f1:580,f2:1990,words:[
          {text:'dr<b>e</b>ss',audio:WM+'En-us-dress.ogg'},
          {text:'b<b>e</b>d',  audio:WM+'En-us-bed.ogg'},
      ]},
      {ipa:'æ',  h:0.80,b:0.04,rounded:false,desc:'Near-open front unrounded',
        f1:750,f2:1660,words:[
          {text:'tr<b>a</b>p', audio:WM+'En-us-trap.ogg'},
          {text:'c<b>a</b>t',  audio:WM+'En-us-cat.ogg'},
      ]},
      {ipa:'ɑː', h:0.97,b:0.97,rounded:false,desc:'Open back unrounded (long)',
        f1:800,f2:1100,words:[
          {text:'f<b>a</b>ther',audio:WM+'En-us-father.ogg'},
          {text:'p<b>a</b>lm', audio:WM+'En-us-palm.ogg'},
      ]},
      {ipa:'ɔː', h:0.65,b:0.97,rounded:true, desc:'Open-mid back rounded (long)',
        f1:590,f2:920,words:[
          {text:'th<b>ough</b>t',audio:WM+'En-us-thought.ogg'},
          {text:'cl<b>aw</b>',  audio:WM+'En-us-claw.ogg'},
      ]},
      {ipa:'oʊ', h:0.27,b:0.93,rounded:true, desc:'Close-mid back rounded (diphthong)',
        f1:449,f2:1020,words:[
          {text:'g<b>oa</b>t',  audio:WM+'En-us-goat.ogg'},
          {text:'n<b>o</b>',    audio:WM+'En-us-no.ogg'},
      ]},
      {ipa:'ʊ',  h:0.20,b:0.78,rounded:true, desc:'Near-close near-back rounded',
        f1:374,f2:1005,words:[
          {text:'f<b>oo</b>t',  audio:WM+'En-us-foot.ogg'},
          {text:'p<b>u</b>t',   audio:WM+'En-us-put.ogg'},
      ]},
      {ipa:'uː', h:0.04,b:0.84,rounded:true, desc:'Close back rounded (long)',
        f1:300,f2:870,words:[
          {text:'g<b>oo</b>se', audio:WM+'En-us-goose.ogg'},
          {text:'f<b>oo</b>d',  audio:WM+'En-us-food.ogg'},
      ]},
      {ipa:'ʌ',  h:0.67,b:0.62,rounded:false,desc:'Open-mid back unrounded',
        f1:760,f2:1260,words:[
          {text:'str<b>u</b>t', audio:WM+'En-us-strut.ogg'},
          {text:'b<b>u</b>s',   audio:WM+'En-us-bus.ogg'},
      ]},
      {ipa:'ə',  h:0.48,b:0.50,rounded:false,desc:'Mid central (schwa)',
        f1:500,f2:1500,words:[
          {text:'<b>a</b>bout', audio:WM+'En-us-about.ogg'},
          {text:'comm<b>a</b>', audio:null},
      ]},
      {ipa:'ɜː', h:0.63,b:0.44,rounded:false,desc:'Open-mid central unrounded (long)',
        f1:500,f2:1490,words:[
          {text:'n<b>ur</b>se', audio:WM+'En-us-nurse.ogg'},
          {text:'b<b>ir</b>d',  audio:WM+'En-us-bird.ogg'},
      ]},
    ]
  },

  german: {
    label:'German', color:'#fb923c',
    vowels:[
      {ipa:'iː', h:0.02,b:0.01,rounded:false,desc:'Close front unrounded (long)',
        f1:270,f2:2290,words:[
          {text:'L<b>ie</b>be',  audio:WM+'De-Liebe.ogg'},
          {text:'w<b>ie</b>',    audio:WM+'De-wie.ogg'},
      ]},
      {ipa:'yː', h:0.02,b:0.08,rounded:true, desc:'Close front rounded (long)',
        f1:235,f2:1870,words:[
          {text:'<b>ü</b>ber',   audio:WM+'De-über.ogg'},
          {text:'gr<b>ün</b>',   audio:WM+'De-grün.ogg'},
      ]},
      {ipa:'ɪ',  h:0.21,b:0.18,rounded:false,desc:'Near-close near-front unrounded',
        f1:380,f2:1940,words:[
          {text:'m<b>i</b>t',    audio:WM+'De-mit.ogg'},
          {text:'b<b>i</b>tte',  audio:WM+'De-Bitte.ogg'},
      ]},
      {ipa:'ʏ',  h:0.21,b:0.24,rounded:true, desc:'Near-close near-front rounded',
        f1:355,f2:1695,words:[
          {text:'h<b>ü</b>bsch', audio:null},
          {text:'fl<b>ü</b>sse', audio:null},
      ]},
      {ipa:'eː', h:0.30,b:0.01,rounded:false,desc:'Close-mid front unrounded (long)',
        f1:390,f2:2070,words:[
          {text:'S<b>ee</b>',    audio:WM+'De-See.ogg'},
          {text:'g<b>e</b>ben',  audio:WM+'De-geben.ogg'},
      ]},
      {ipa:'øː', h:0.30,b:0.08,rounded:true, desc:'Close-mid front rounded (long)',
        f1:370,f2:1615,words:[
          {text:'sch<b>ö</b>n',  audio:WM+'De-schön.ogg'},
          {text:'h<b>ö</b>ren',  audio:WM+'De-hören.ogg'},
      ]},
      {ipa:'ɛ',  h:0.63,b:0.02,rounded:false,desc:'Open-mid front unrounded',
        f1:580,f2:1820,words:[
          {text:'B<b>e</b>tt',   audio:WM+'De-Bett.ogg'},
          {text:'H<b>ä</b>nde',  audio:WM+'De-Hände.ogg'},
      ]},
      {ipa:'œ',  h:0.63,b:0.09,rounded:true, desc:'Open-mid front rounded',
        f1:490,f2:1290,words:[
          {text:'zw<b>ö</b>lf',  audio:WM+'De-zwölf.ogg'},
          {text:'H<b>öl</b>le',  audio:WM+'De-Hölle.ogg'},
      ]},
      {ipa:'a',  h:0.97,b:0.18,rounded:false,desc:'Open front/central unrounded',
        f1:800,f2:1300,words:[
          {text:'M<b>a</b>nn',   audio:WM+'De-Mann.ogg'},
          {text:'d<b>a</b>s',    audio:WM+'De-das.ogg'},
      ]},
      {ipa:'aː', h:0.94,b:0.23,rounded:false,desc:'Open central unrounded (long)',
        f1:780,f2:1230,words:[
          {text:'B<b>ah</b>n',   audio:WM+'De-Bahn.ogg'},
          {text:'j<b>a</b>',     audio:WM+'De-ja.ogg'},
      ]},
      {ipa:'oː', h:0.28,b:0.97,rounded:true, desc:'Close-mid back rounded (long)',
        f1:400,f2:840,words:[
          {text:'gr<b>o</b>ß',   audio:WM+'De-groß.ogg'},
          {text:'S<b>oh</b>n',   audio:WM+'De-Sohn.ogg'},
      ]},
      {ipa:'ɔ',  h:0.66,b:0.94,rounded:true, desc:'Open-mid back rounded',
        f1:555,f2:870,words:[
          {text:'K<b>o</b>pf',   audio:WM+'De-Kopf.ogg'},
          {text:'P<b>o</b>st',   audio:WM+'De-Post.ogg'},
      ]},
      {ipa:'uː', h:0.02,b:0.97,rounded:true, desc:'Close back rounded (long)',
        f1:250,f2:600,words:[
          {text:'B<b>u</b>ch',   audio:WM+'De-Buch.ogg'},
          {text:'R<b>uh</b>e',   audio:WM+'De-Ruhe.ogg'},
      ]},
      {ipa:'ʊ',  h:0.21,b:0.80,rounded:true, desc:'Near-close near-back rounded',
        f1:360,f2:780,words:[
          {text:'M<b>u</b>tter', audio:WM+'De-Mutter.ogg'},
          {text:'H<b>u</b>nd',   audio:WM+'De-Hund.ogg'},
      ]},
      {ipa:'ə',  h:0.48,b:0.50,rounded:false,desc:'Mid central (Schwa)',
        f1:490,f2:1350,words:[
          {text:'hab<b>e</b>',   audio:null},
          {text:'Kett<b>e</b>',  audio:WM+'De-Kette.ogg'},
      ]},
    ]
  },

  russian: {
    label:'Russian', color:'#f43f5e',
    vowels:[
      {ipa:'i',  h:0.02,b:0.02,rounded:false,desc:'Close front unrounded (и)',
        f1:270,f2:2200,words:[
          {text:'м<b>и</b>р',   audio:WM+'Ru-мир.ogg'},
          {text:'л<b>и</b>с',   audio:null},
      ]},
      {ipa:'ɨ',  h:0.03,b:0.52,rounded:false,desc:'Close central unrounded (ы)',
        f1:320,f2:1380,words:[
          {text:'б<b>ы</b>ть',  audio:WM+'Ru-быть.ogg'},
          {text:'т<b>ы</b>',    audio:null},
      ]},
      {ipa:'u',  h:0.02,b:0.97,rounded:true, desc:'Close back rounded (у)',
        f1:300,f2:680,words:[
          {text:'д<b>у</b>ша',  audio:WM+'Ru-душа.ogg'},
          {text:'р<b>у</b>ка',  audio:null},
      ]},
      {ipa:'e',  h:0.44,b:0.04,rounded:false,desc:'Close-mid front unrounded (е/э)',
        f1:440,f2:1900,words:[
          {text:'<b>э</b>то',   audio:WM+'Ru-это.ogg'},
          {text:'м<b>е</b>сто', audio:null},
      ]},
      {ipa:'o',  h:0.40,b:0.90,rounded:true, desc:'Close-mid back rounded (о)',
        f1:500,f2:1000,words:[
          {text:'д<b>о</b>м',   audio:WM+'Ru-дом.ogg'},
          {text:'н<b>о</b>с',   audio:null},
      ]},
      {ipa:'a',  h:0.97,b:0.38,rounded:false,desc:'Open central unrounded (а)',
        f1:850,f2:1350,words:[
          {text:'м<b>а</b>ть',  audio:WM+'Ru-мать.ogg'},
          {text:'д<b>а</b>',    audio:null},
      ]},
    ]
  },

  norwegian: {
    label:'Norwegian', color:'#22d3ee',
    vowels:[
      {ipa:'i',  h:0.02,b:0.02,rounded:false,desc:'Close front unrounded',
        f1:240,f2:2380,words:[
          {text:'f<b>i</b>n',    audio:null},
          {text:'l<b>i</b>ten',  audio:null},
      ]},
      {ipa:'y',  h:0.02,b:0.08,rounded:true, desc:'Close front rounded',
        f1:235,f2:1810,words:[
          {text:'n<b>y</b>',     audio:null},
          {text:'b<b>y</b>',     audio:null},
      ]},
      {ipa:'ʉ',  h:0.04,b:0.54,rounded:true, desc:'Close central rounded (Norwegian u)',
        f1:260,f2:1370,words:[
          {text:'h<b>u</b>s',    audio:null},
          {text:'sk<b>u</b>lle', audio:null},
      ]},
      {ipa:'e',  h:0.30,b:0.02,rounded:false,desc:'Close-mid front unrounded',
        f1:395,f2:2080,words:[
          {text:'s<b>e</b>',     audio:null},
          {text:'br<b>e</b>v',   audio:null},
      ]},
      {ipa:'ø',  h:0.30,b:0.08,rounded:true, desc:'Close-mid front rounded',
        f1:375,f2:1590,words:[
          {text:'gr<b>ø</b>t',   audio:null},
          {text:'s<b>ø</b>t',    audio:null},
      ]},
      {ipa:'o',  h:0.28,b:0.97,rounded:true, desc:'Close-mid back rounded',
        f1:410,f2:880,words:[
          {text:'b<b>o</b>',     audio:null},
          {text:'g<b>o</b>d',    audio:null},
      ]},
      {ipa:'ɛ',  h:0.62,b:0.03,rounded:false,desc:'Open-mid front unrounded',
        f1:575,f2:1880,words:[
          {text:'s<b>e</b>tt',   audio:null},
          {text:'m<b>e</b>d',    audio:null},
      ]},
      {ipa:'æ',  h:0.80,b:0.03,rounded:false,desc:'Near-open front unrounded',
        f1:730,f2:1700,words:[
          {text:'v<b>æ</b>re',   audio:null},
          {text:'l<b>æ</b>rer',  audio:null},
      ]},
      {ipa:'a',  h:0.97,b:0.18,rounded:false,desc:'Open front unrounded',
        f1:820,f2:1380,words:[
          {text:'m<b>a</b>t',    audio:null},
          {text:'d<b>a</b>g',    audio:null},
      ]},
      {ipa:'ɔ',  h:0.64,b:0.94,rounded:true, desc:'Open-mid back rounded (å)',
        f1:545,f2:865,words:[
          {text:'<b>å</b>tte',   audio:null},
          {text:'b<b>å</b>t',    audio:null},
      ]},
    ]
  },

};