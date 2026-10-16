// ─── Symbol composition: every mark below is DERIVED from a Consonant's
// feature fields, never hand-baked into a stored string — see
// db/models.py's Consonant docstring / openspec/changes/add-consonant-chart
// /design.md decision 3. One function, one source of truth, shared by the
// grid, the strip, and the inspector (ported from the validated mockup's
// buildSymbol(p)).
//
// Expects a consonant shaped like the API's camelCase JSON:
//   { symbols, activeArticulator, secondaryArticulation, syllabic, ... }
function buildConsonantSymbol(c) {
  const base = (c.symbols && c.symbols[0]) || '';
  const sec = c.secondaryArticulation || [];
  const hasVel = sec.includes('velarized');
  const hasPhar = sec.includes('pharyngealized');

  let under = '';
  if (c.activeArticulator === 'apical') under += '̺';       // combining inverted bridge below
  else if (c.activeArticulator === 'laminal') under += '̻'; // combining square below

  const overlay = (hasVel || hasPhar) ? '̴' : ''; // combining tilde overlay — "dark l" look
  const syl = c.syllabic ? '̩' : '';              // combining vertical line below

  let supers = '';
  if (sec.includes('labialized')) supers += 'ʷ';   // ʷ
  if (sec.includes('palatalized')) supers += 'ʲ';  // ʲ
  if (hasVel) supers += 'ˠ';                        // ˠ
  if (hasPhar) supers += 'ˤ';                       // ˤ
  if (sec.includes('aspirated')) supers += 'ʰ';     // ʰ
  if (sec.includes('glottalized')) supers += 'ʼ';   // ʼ

  return base + under + overlay + syl + supers;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildConsonantSymbol };
}
