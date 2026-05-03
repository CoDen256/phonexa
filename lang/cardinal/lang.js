// lang/cardinal/lang.js
// IPA Cardinal vowels — reference positions for the standard IPA chart.
//
// Paired vowels (unrounded/rounded) share the SAME (h, b) coordinates,
// matching the official IPA chart where both appear left/right of one dot.
//
// Audio: Wikimedia Commons CC-licensed IPA recordings.
// Wiki:  English Wikipedia article for each phoneme.

(function() {
  const WM   = 'https://commons.wikimedia.org/wiki/Special:Redirect/file/';
  const WIKI = 'https://en.wikipedia.org/wiki/';

  function ipa(symbol, f) {
    return WM + f + '_vowel.ogg';
  }

  registerLang({
    key:   'cardinal',
    label: 'Cardinal',
    color: '#607a96',

    vowels: [
      // ── Close ──────────────────────────────────────────────────────────────
      { ipa:'i',  h:0,    b:0.00, rounded:false,
        desc:'Close front unrounded',        f1:240, f2:2400,
        ipaAudio: WM+'Close_front_unrounded_vowel.ogg',
        wikiUrl:  WIKI+'Close_front_unrounded_vowel',  words:[] },
      { ipa:'y',  h:0,    b:0.00, rounded:true,
        desc:'Close front rounded',          f1:235, f2:1870,
        ipaAudio: WM+'Close_front_rounded_vowel.ogg',
        wikiUrl:  WIKI+'Close_front_rounded_vowel',    words:[] },
      { ipa:'ɨ',  h:0,    b:0.50, rounded:false,
        desc:'Close central unrounded',      f1:250, f2:1450,
        ipaAudio: WM+'Close_central_unrounded_vowel.ogg',
        wikiUrl:  WIKI+'Close_central_unrounded_vowel',words:[] },
      { ipa:'ʉ',  h:0,    b:0.50, rounded:true,
        desc:'Close central rounded',        f1:250, f2:1380,
        ipaAudio: WM+'Close_central_rounded_vowel.ogg',
        wikiUrl:  WIKI+'Close_central_rounded_vowel',  words:[] },
      { ipa:'ɯ',  h:0,    b:1.00, rounded:false,
        desc:'Close back unrounded',         f1:250, f2:800,
        ipaAudio: WM+'Close_back_unrounded_vowel.ogg',
        wikiUrl:  WIKI+'Close_back_unrounded_vowel',   words:[] },
      { ipa:'u',  h:0,    b:1.00, rounded:true,
        desc:'Close back rounded',           f1:250, f2:595,
        ipaAudio: WM+'Close_back_rounded_vowel.ogg',
        wikiUrl:  WIKI+'Close_back_rounded_vowel',     words:[] },

      // ── Close-mid ───────────────────────────────────────────────────────────
      { ipa:'e',  h:2/6,  b:0.00, rounded:false,
        desc:'Close-mid front unrounded',    f1:400, f2:2300,
        ipaAudio: WM+'Close-mid_front_unrounded_vowel.ogg',
        wikiUrl:  WIKI+'Close-mid_front_unrounded_vowel', words:[] },
      { ipa:'ø',  h:2/6,  b:0.00, rounded:true,
        desc:'Close-mid front rounded',      f1:370, f2:1600,
        ipaAudio: WM+'Close-mid_front_rounded_vowel.ogg',
        wikiUrl:  WIKI+'Close-mid_front_rounded_vowel',   words:[] },
      { ipa:'ɘ',  h:2/6,  b:0.50, rounded:false,
        desc:'Close-mid central unrounded',  f1:390, f2:1480,
        ipaAudio: WM+'Close-mid_central_unrounded_vowel.ogg',
        wikiUrl:  WIKI+'Close-mid_central_unrounded_vowel', words:[] },
      { ipa:'ɤ',  h:2/6,  b:1.00, rounded:false,
        desc:'Close-mid back unrounded',     f1:430, f2:1000,
        ipaAudio: WM+'Close-mid_back_unrounded_vowel.ogg',
        wikiUrl:  WIKI+'Close-mid_back_unrounded_vowel',  words:[] },
      { ipa:'o',  h:2/6,  b:1.00, rounded:true,
        desc:'Close-mid back rounded',       f1:400, f2:840,
        ipaAudio: WM+'Close-mid_back_rounded_vowel.ogg',
        wikiUrl:  WIKI+'Close-mid_back_rounded_vowel',    words:[] },

      // ── Mid ─────────────────────────────────────────────────────────────────
      { ipa:'ə',  h:3/6,  b:0.50, rounded:false,
        desc:'Mid central',                  f1:490, f2:1490,
        ipaAudio: WM+'Mid-central_vowel.ogg',
        wikiUrl:  WIKI+'Mid-central_vowel',               words:[] },

      // ── Open-mid ────────────────────────────────────────────────────────────
      { ipa:'ɛ',  h:4/6,  b:0.00, rounded:false,
        desc:'Open-mid front unrounded',     f1:610, f2:2000,
        ipaAudio: WM+'Open-mid_front_unrounded_vowel.ogg',
        wikiUrl:  WIKI+'Open-mid_front_unrounded_vowel',  words:[] },
      { ipa:'œ',  h:4/6,  b:0.00, rounded:true,
        desc:'Open-mid front rounded',       f1:480, f2:1260,
        ipaAudio: WM+'Open-mid_front_rounded_vowel.ogg',
        wikiUrl:  WIKI+'Open-mid_front_rounded_vowel',    words:[] },
      { ipa:'ɜ',  h:4/6,  b:0.50, rounded:false,
        desc:'Open-mid central unrounded',   f1:500, f2:1490,
        ipaAudio: WM+'Open-mid_central_unrounded_vowel.ogg',
        wikiUrl:  WIKI+'Open-mid_central_unrounded_vowel',words:[] },
      { ipa:'ʌ',  h:4/6,  b:1.00, rounded:false,
        desc:'Open-mid back unrounded',      f1:650, f2:1200,
        ipaAudio: WM+'Open-mid_back_unrounded_vowel.ogg',
        wikiUrl:  WIKI+'Open-mid_back_unrounded_vowel',   words:[] },
      { ipa:'ɔ',  h:4/6,  b:1.00, rounded:true,
        desc:'Open-mid back rounded',        f1:560, f2:920,
        ipaAudio: WM+'Open-mid_back_rounded_vowel.ogg',
        wikiUrl:  WIKI+'Open-mid_back_rounded_vowel',     words:[] },

      // ── Near-open ───────────────────────────────────────────────────────────
      { ipa:'æ',  h:5/6,  b:0.00, rounded:false,
        desc:'Near-open front unrounded',    f1:740, f2:1660,
        ipaAudio: WM+'Near-open_front_unrounded_vowel.ogg',
        wikiUrl:  WIKI+'Near-open_front_unrounded_vowel', words:[] },
      { ipa:'ɐ',  h:5/6,  b:0.50, rounded:false,
        desc:'Near-open central',            f1:700, f2:1400,
        ipaAudio: WM+'Near-open_central_vowel.ogg',
        wikiUrl:  WIKI+'Near-open_central_vowel',         words:[] },

      // ── Open ────────────────────────────────────────────────────────────────
      { ipa:'a',  h:1,    b:0.00, rounded:false,
        desc:'Open front unrounded',         f1:850, f2:1610,
        ipaAudio: WM+'Open_front_unrounded_vowel.ogg',
        wikiUrl:  WIKI+'Open_front_unrounded_vowel',      words:[] },
      { ipa:'ɶ',  h:1,    b:0.00, rounded:true,
        desc:'Open front rounded',           f1:820, f2:1320,
        ipaAudio: WM+'Open_front_rounded_vowel.ogg',
        wikiUrl:  WIKI+'Open_front_rounded_vowel',        words:[] },
      { ipa:'ɑ',  h:1,    b:1.00, rounded:false,
        desc:'Open back unrounded',          f1:850, f2:1100,
        ipaAudio: WM+'Open_back_unrounded_vowel.ogg',
        wikiUrl:  WIKI+'Open_back_unrounded_vowel',       words:[] },
      { ipa:'ɒ',  h:1,    b:1.00, rounded:true,
        desc:'Open back rounded',            f1:820, f2:900,
        ipaAudio: WM+'Open_back_rounded_vowel.ogg',
        wikiUrl:  WIKI+'Open_back_rounded_vowel',         words:[] },
    ],
  });
})();