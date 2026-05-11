/**
 * utils.js — Shared primitives used by both index.html and editor.html.
 *
 * Deliberately minimal: only things that are genuinely reused across pages
 * belong here. Page-specific helpers live in their own files.
 * encodeWAV lives in practice.js; svgPt lives in editor.html (editor-only).
 */

// ─── SVG helpers ─────────────────────────────────────────────────────────────
const NS='http://www.w3.org/2000/svg';

/** Create an SVG element and set all given attributes. */
function $s(tag,a={}) {
  const el=document.createElementNS(NS,tag);
  for(const[k,vv]of Object.entries(a))el.setAttribute(k,String(vv));
  return el;
}

/** Create an SVG <text> element with the given textContent and attributes. */
function $t(str,a={}) { const el=$s('text',a); el.textContent=str; return el; }

/**
 * Estimate rendered pixel width of an IPA string at a given font size.
 * ː is narrower (ratio 0.36) than a regular glyph (0.65).
 * Used for hit-rect sizing and label offset calculations.
 */
function ipaW(ipa,fs) { let w=0; for(const c of ipa) w+=c==='ː'?0.36:0.65; return w*fs; }

/**
 * Returns true when a vowel is a fully-specified diphthong.
 * Requires type==='diphthong' AND both target coords h2/b2 to be non-null.
 * Vowels missing h2/b2 are treated as monophthongs until set in the editor.
 */
function isDiph(v){ return v.type==='diphthong' && v.h2!=null && v.b2!=null; }