/**
 * editor-charts.js — SVG chart helpers for the language editor page.
 *
 * Provides two kinds of functionality:
 *
 * 1. Grid drawing primitives (drawGridIpa, drawGridFormant, drawCardinalDots)
 *    These are called by renderLangIpa / renderLangFormant each time the
 *    language draft changes to establish the background before vowels are drawn.
 *
 * 2. Vowel overlay (drawVowelsOnChart, drawDiphArrow, renderLangIpa, renderLangFormant)
 *    Renders all vowels of the current draft onto the editor charts.
 *    The actively-edited vowel (state.vowelIdx) is highlighted with a larger
 *    dot, brighter label, and glow. Diphthong vowels skip the normal label
 *    and get an arrow with the label beside it instead.
 *
 * Chart geometry uses a smaller 700×420 viewBox (vs 1270×730 in index.html):
 *   LT / ltPos(h,b) / ltHB(px,py) — IPA trapezoid
 *   LF / lfPos(f1,f2) / lfF1F2(px,py) — Formant scatter
 *
 * Dependencies: utils.js, editor.html globals
 *   (state, LT, ltPos, LF, lfPos, F1MIN/MAX, F2MIN/MAX, TRAP_ROWS,
 *    openVowelEditor, isDiph)
 */

// ─── SVG draw helpers ─────────────────────────────────────────────────────────
function drawGridIpa(svg){
  TRAP_ROWS.forEach(row=>{
    const L=ltPos(row.h,0),R=ltPos(row.h,1);
    svg.appendChild($s('line',{x1:L.x,y1:L.y,x2:R.x,y2:R.y,stroke:'#1e3048','stroke-width':1}));
  });
  const cT=ltPos(0,.5),cB=ltPos(1,.5);
  svg.appendChild($s('line',{x1:cT.x,y1:cT.y,x2:cB.x,y2:cB.y,stroke:'#1e3048','stroke-width':1,'stroke-dasharray':'5 4'}));
  const T=LT;
  svg.appendChild($s('path',{d:`M${T.TL.x},${T.TL.y} L${T.TR.x},${T.TR.y} L${T.BR.x},${T.BR.y} L${T.BL.x},${T.BL.y}Z`,fill:'none',stroke:'#2e4a64','stroke-width':1.5}));
  TRAP_ROWS.forEach(row=>{const p=ltPos(row.h,0);svg.appendChild($t(row.label,{x:p.x-14,y:p.y,dy:'0.36em','text-anchor':'end','font-size':9,fill:'#4a6888','font-family':'system-ui'}));});
  [['Front',0],['Central',.5],['Back',1]].forEach(([l,b])=>{const p=ltPos(0,b);svg.appendChild($t(l,{x:p.x,y:p.y-16,'text-anchor':'middle','font-size':9,fill:'#4a6888','font-family':'system-ui'}));});
}

function drawGridFormant(svg){
  svg.appendChild($s('rect',{x:LF.x0,y:LF.y0,width:LF.x1-LF.x0,height:LF.y1-LF.y0,fill:'#192535',rx:4}));
  [500,700,900,1100,1400,1700,2000,2400,2800].forEach(f2=>{
    const{x}=lfPos(F1MIN,f2);
    svg.appendChild($s('line',{x1:x,y1:LF.y0,x2:x,y2:LF.y1,stroke:'#1e3048','stroke-width':1,'stroke-dasharray':'4 4'}));
    svg.appendChild($t(f2,{x,y:LF.y1+12,'text-anchor':'middle','font-size':8,fill:'#3a5878','font-family':'system-ui'}));
  });
  [200,300,400,500,600,700,800,900,1000].forEach(f1=>{
    const{y}=lfPos(f1,F2MIN);
    svg.appendChild($s('line',{x1:LF.x0,y1:y,x2:LF.x1,y2:y,stroke:'#1e3048','stroke-width':1,'stroke-dasharray':'4 4'}));
    svg.appendChild($t(f1,{x:LF.x0-5,y,'text-anchor':'end',dy:'0.35em','font-size':8,fill:'#3a5878','font-family':'system-ui'}));
  });
  svg.appendChild($s('rect',{x:LF.x0,y:LF.y0,width:LF.x1-LF.x0,height:LF.y1-LF.y0,fill:'none',stroke:'#2e4a64','stroke-width':1.5,rx:4}));
  svg.appendChild($t('← F2 (Hz)',{x:(LF.x0+LF.x1)/2,y:LF.y1+24,'text-anchor':'middle','font-size':8,fill:'#4a6888','font-family':'system-ui'}));
  const f1lbl=$t('F1 (Hz)↓',{x:18,y:(LF.y0+LF.y1)/2,'text-anchor':'middle','font-size':8,fill:'#4a6888','font-family':'system-ui'});
  f1lbl.setAttribute('transform',`rotate(-90,18,${(LF.y0+LF.y1)/2})`);
  svg.appendChild(f1lbl);
}

function drawCardinalDots(svg, posFn, validFn){
  const cl=state.langs['cardinal'];
  if(!cl)return;
  cl.vowels.forEach(cv=>{
    if(validFn&&!validFn(cv))return;
    const{x,y}=posFn(cv);
    svg.appendChild($s('circle',{cx:x,cy:y,r:3.5,fill:'#4a6888'}));
    svg.appendChild($t(cv.ipa,{x:x+(cv.rounded?5:-5),y,dy:'0.35em','text-anchor':cv.rounded?'start':'end','font-size':7,fill:'#4a6888','font-family':'Georgia,serif',style:'pointer-events:none'}));
  });
}

function isDiph(v){ return v.type==='diphthong' && v.h2!=null && v.b2!=null; }

function drawDiphArrow(layer, x1, y1, x2, y2, v, c, isAct, onClickFn=null){
  const dist=Math.hypot(x2-x1,y2-y1); if(dist<3)return;
  const op=isAct?0.88:0.5;
  const ux=(x2-x1)/dist, uy=(y2-y1)/dist, AR=9, W=4;
  const xe=x2-ux*AR, ye=y2-uy*AR;
  layer.appendChild($s('line',{x1,y1,x2:xe.toFixed(1),y2:ye.toFixed(1),
    stroke:c,'stroke-width':isAct?2:1.5,opacity:op,'stroke-linecap':'round',style:'pointer-events:none'}));
  layer.appendChild($s('polygon',{
    points:`${x2.toFixed(1)},${y2.toFixed(1)} ${(xe-uy*W).toFixed(1)},${(ye+ux*W).toFixed(1)} ${(xe+uy*W).toFixed(1)},${(ye-ux*W).toFixed(1)}`,
    fill:c,opacity:op,style:'pointer-events:none'}));
  // Label beside arrow (perpendicular offset)
  const SIDE=isAct?12:9, mx=(x1+x2)/2, my=(y1+y2)/2, FS=isAct?14:11;
  const lx=mx+uy*SIDE, ly=my-ux*SIDE;
  layer.appendChild($t(v.ipa||'?',{x:lx,y:ly,dy:'0.36em','text-anchor':'middle','font-size':FS,
    fill:c,opacity:isAct?0.95:0.7,'font-family':"Georgia,'Noto Serif',serif",'font-weight':'normal',
    style:'pointer-events:none;user-select:none;filter:drop-shadow(0 0 4px rgba(20,30,46,1)) drop-shadow(0 0 7px rgba(20,30,46,0.8))'}));
  // Hit area (always present, clickable for editing)
  const hit=$s('line',{x1,y1,x2,y2,stroke:'transparent','stroke-width':20,cursor:'pointer'});
  if(onClickFn) hit.addEventListener('click',onClickFn);
  layer.appendChild(hit);
}

function drawVowelsOnChart(svg, vowels, activeIdx, c, posFn, validFn, showArrows=false){
  const arrowL=$s('g'), dotLayer=$s('g'), labelLayer=$s('g');
  svg.appendChild(arrowL); svg.appendChild(dotLayer); svg.appendChild(labelLayer);

  // Draw diphthong arrows first (behind dots)
  if(showArrows){
    vowels.forEach((v,i)=>{
      if(!isDiph(v))return;
      if(validFn&&!validFn(v))return;
      const sp=posFn(v); if(!sp)return;
      const tp=posFn({...v,h:v.h2,b:v.b2}); if(!tp)return;
      const isAct=i===activeIdx;
      drawDiphArrow(arrowL,sp.x,sp.y,tp.x,tp.y,v,c,isAct, e=>{e.stopPropagation();openVowelEditor(i);});
      // Hollow target dot
      dotLayer.appendChild($s('circle',{cx:tp.x,cy:tp.y,r:isAct?6:4,fill:'none',stroke:c+(isAct?'cc':'88'),'stroke-width':isAct?2:1.5}));
    });
  }

  // Group by snapped pos
  const groups=new Map();
  vowels.forEach((v,i)=>{
    if(validFn&&!validFn(v))return;
    const pos=posFn(v); if(!pos)return;
    const{x,y}=pos;
    const pk=`${Math.round(x/3)},${Math.round(y/3)}`;
    if(!groups.has(pk))groups.set(pk,[]);
    groups.get(pk).push({v,i,x,y});
  });

  // Dots
  groups.forEach(grp=>{
    const{x,y}=grp[0];
    const isAct=grp.some(g=>g.i===activeIdx);
    const dotR=isAct?7:5;
    if(grp.length>1)dotLayer.appendChild($s('circle',{cx:x,cy:y,r:dotR+4,fill:'none',stroke:c+'55','stroke-width':1.5,'stroke-dasharray':'3 2'}));
    dotLayer.appendChild($s('circle',{cx:x,cy:y,r:dotR,fill:isAct?c:c+'99'}));
  });

  // Labels (skip diphthongs — their label is on the arrow)
  vowels.forEach((v,i)=>{
    if(validFn&&!validFn(v))return;
    if(isDiph(v))return;  // diphthong label lives on the arrow, not next to dot
    const pos=posFn(v); if(!pos)return;
    const{x,y}=pos;
    const isAct=i===activeIdx;
    const FS=isAct?17:13;
    const dotR=isAct?7:5;
    const GAP=5;
    const lx=v.rounded?x+dotR+GAP:x-dotR-GAP;
    const anchor=v.rounded?'start':'end';
    const g=$s('g',{style:'cursor:pointer'});
    const tw=(v.ipa||'').length*FS*0.6;
    g.appendChild($s('rect',{x:(v.rounded?lx:lx-tw)-4,y:y-FS*0.5-4,width:tw+8,height:FS+8,rx:4,fill:'transparent'}));
    const lbl=$t(v.ipa||'?',{x:lx,y,dy:'0.36em','text-anchor':anchor,'font-size':FS,fill:isAct?'#ffffff':c,opacity:isAct?1:0.82,'font-family':"Georgia,'Noto Serif',serif",'font-weight':isAct?'bold':'normal',style:`filter:drop-shadow(0 1px 2px rgba(0,0,0,.5));user-select:none`});
    if(isAct)lbl.style.filter=`drop-shadow(0 0 5px ${c}) drop-shadow(0 1px 2px rgba(0,0,0,.5))`;
    g.appendChild(lbl);
    g.addEventListener('click',e=>{e.stopPropagation();openVowelEditor(i);});
    g.addEventListener('mouseenter',e=>{const tip=document.getElementById('chartTip');tip.textContent=`${v.ipa} — ${v.desc||''}`;tip.style.display='block';tip.style.left=(e.clientX+12)+'px';tip.style.top=(e.clientY-28)+'px';});
    g.addEventListener('mousemove',e=>{const tip=document.getElementById('chartTip');tip.style.left=(e.clientX+12)+'px';tip.style.top=(e.clientY-28)+'px';});
    g.addEventListener('mouseleave',()=>document.getElementById('chartTip').style.display='none');
    labelLayer.appendChild(g);
  });
}

// ─── Render language IPA chart ────────────────────────────────────────────────
function renderLangIpa(){
  const svg=document.getElementById('langIpaSvg');
  if(!svg)return;
  while(svg.firstChild)svg.removeChild(svg.firstChild);
  drawGridIpa(svg);
  drawCardinalDots(svg,cv=>ltPos(+cv.h||0,+cv.b||0));
  const vowels=[...(state.langDraft?.vowels||[])];
  const activeIdx=state.vowelIdx;
  // If editing, show draft in place of the original
  if(state.vowelDraft!==null&&activeIdx>=0) vowels[activeIdx]=state.vowelDraft;
  else if(state.vowelDraft!==null&&activeIdx<0) vowels.push(state.vowelDraft);
  const c=state.langDraft?.color||'#7eb8f7';
  drawVowelsOnChart(svg,vowels,activeIdx<0?vowels.length-1:activeIdx,c,v=>ltPos(+v.h||0,+v.b||0),null,true);
}

// ─── Render language formant chart ────────────────────────────────────────────
function renderLangFormant(){
  const svg=document.getElementById('langFormSvg');
  if(!svg)return;
  while(svg.firstChild)svg.removeChild(svg.firstChild);
  drawGridFormant(svg);
  drawCardinalDots(svg,cv=>{
    const f1=+cv.f1,f2=+cv.f2;
    if(!f1||!f2)return{x:-100,y:-100};
    return lfPos(f1,f2);
  },cv=>cv.f1&&cv.f2);
  const vowels=[...(state.langDraft?.vowels||[])];
  const activeIdx=state.vowelIdx;
  if(state.vowelDraft!==null&&activeIdx>=0) vowels[activeIdx]=state.vowelDraft;
  else if(state.vowelDraft!==null&&activeIdx<0) vowels.push(state.vowelDraft);
  const c=state.langDraft?.color||'#7eb8f7';
  drawVowelsOnChart(svg,vowels,activeIdx<0?vowels.length-1:activeIdx,c,
    v=>{const f1=+v.f1,f2=+v.f2;if(!f1||!f2)return null;return lfPos(f1,f2);},
    v=>!!(v.f1&&v.f2));
}
