// ─── Editor geometry: IPA picker data + chart coordinate systems ──────────────
// ─── IPA data ─────────────────────────────────────────────────────────────────
const IPA_ROWS=[
  {label:'Close',   pairs:[['i','y'],['ɨ','ʉ'],['ɯ','u']]},
  {label:'Near-cl', pairs:[['ɪ','ʏ'],[null,null],['ʊ',null]]},
  {label:'Cl-mid',  pairs:[['e','ø'],['ɘ','ɵ'],['ɤ','o']]},
  {label:'Mid',     pairs:[[null,null],['ə',null],[null,null]]},
  {label:'Op-mid',  pairs:[['ɛ','œ'],['ɜ','ɞ'],['ʌ','ɔ']]},
  {label:'Near-op', pairs:[['æ',null],['ɐ',null],[null,null]]},
  {label:'Open',    pairs:[['a','ɶ'],[null,null],['ɑ','ɒ']]},
];
const IPA_MODS=[
  {ch:'ː',lbl:'long'},{ch:'ˑ',lbl:'½-long'},{ch:'̃',lbl:'nasal'},
  {ch:'ʲ',lbl:'palat'},{ch:'ʷ',lbl:'lab'},{ch:'ˠ',lbl:'velar'},
  {ch:'ˤ',lbl:'phar'},{ch:'ʰ',lbl:'asp'},{ch:'̥',lbl:'voiceless'},
];

// ─── Large chart geometry (viewBox 700 × 420) ─────────────────────────────────
// IPA trapezoid
const LT={TL:{x:90,y:42},TR:{x:648,y:42},BL:{x:234,y:378},BR:{x:648,y:378}};
function ltPos(h,b){const fX=LT.TL.x+h*(LT.BL.x-LT.TL.x);return{x:fX+b*(LT.TR.x-fX),y:LT.TL.y+h*(LT.BL.y-LT.TL.y)};}
function ltHB(px,py){
  const h=Math.max(0,Math.min(1,(py-LT.TL.y)/(LT.BL.y-LT.TL.y)));
  const fX=LT.TL.x+h*(LT.BL.x-LT.TL.x);
  return{h:+h.toFixed(4),b:+Math.max(0,Math.min(1,(px-fX)/(LT.TR.x-fX))).toFixed(4)};
}
// Formant plot (same viewBox)
const LF={x0:60,x1:685,y0:30,y1:390};
// F2MIN/MAX/F1MIN/MAX are shared from geometry.js
function lfPos(f1,f2){
  return{x:LF.x1-(f2-F2MIN)/(F2MAX-F2MIN)*(LF.x1-LF.x0),y:LF.y0+(f1-F1MIN)/(F1MAX-F1MIN)*(LF.y1-LF.y0)};
}
function lfF1F2(px,py){
  return{
    f2:Math.round(Math.max(F2MIN,Math.min(F2MAX,F2MAX-(px-LF.x0)/(LF.x1-LF.x0)*(F2MAX-F2MIN)))),
    f1:Math.round(Math.max(F1MIN,Math.min(F1MAX,F1MIN+(py-LF.y0)/(LF.y1-LF.y0)*(F1MAX-F1MIN)))),
  };
}
const TRAP_ROWS=[
  {h:0,label:'Close'},{h:1/6,label:'Near-cl'},{h:2/6,label:'Cl-mid'},
  {h:3/6,label:'Mid'},{h:4/6,label:'Op-mid'},{h:5/6,label:'Near-op'},{h:1,label:'Open'},
];