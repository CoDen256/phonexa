// ─── Chart geometry: IPA trapezoid + formant plot constants ──────────────────
// IPA base display order (Close → Open, Front → Back)
const IPA_BASE_ORDER = [
  'i','y','ɨ','ʉ','ɯ','u',
  'ɪ','ʏ','ʊ',
  'e','ø','ɘ','ɵ','ɤ','o',
  'ə',
  'ɛ','œ','ɜ','ɞ','ʌ','ɔ',
  'æ','ɐ',
  'a','ɶ','ä','ɑ','ɒ',
];

// ─── IPA trapezoid ────────────────────────────────────────────────────────────
const TRAP = { TL:{x:155,y:110}, TR:{x:1115,y:110}, BL:{x:390,y:618}, BR:{x:1115,y:618} };
function trapPos(h, b) {
  const fX = TRAP.TL.x + h*(TRAP.BL.x-TRAP.TL.x);
  return { x: fX + b*(TRAP.TR.x-fX), y: TRAP.TL.y + h*(TRAP.BL.y-TRAP.TL.y) };
}
const ROWS = [
  {h:0,label:'Close'},{h:1/6,label:'Near-close'},{h:2/6,label:'Close-mid'},
  {h:3/6,label:'Mid'},{h:4/6,label:'Open-mid'},{h:5/6,label:'Near-open'},{h:1,label:'Open'},
];

// ─── Formant plot ─────────────────────────────────────────────────────────────
const FP = {x0:90, x1:1150, y0:60, y1:660};
const F2MIN=400, F2MAX=2800, F1MIN=150, F1MAX=1000;
function formantPos(f1, f2) {
  const xf=(f2-F2MIN)/(F2MAX-F2MIN), yf=(f1-F1MIN)/(F1MAX-F1MIN);
  return { x: FP.x1 - xf*(FP.x1-FP.x0), y: FP.y0 + yf*(FP.y1-FP.y0) };
}