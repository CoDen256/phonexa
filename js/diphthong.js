// ── Diphthong rendering + animation ─────────────────────────────────────────
const _diphState = {};   // key: `${lk}::${ipa}` → {lastClick, slowed}

function playUrlAtRate(url, rate=1) {
  if(!url)return;
  const a=new Audio(url); a.playbackRate=rate;
  a.play().catch(e=>console.warn('Audio:',e.message));
}

function spawnRing(svg, x, y, color, r0=4, speed=1.8, opStart=0.8) {
  const ring=$s('circle',{cx:x,cy:y,r:r0,fill:'none',stroke:color,'stroke-width':1.5,opacity:opStart,style:'pointer-events:none'});
  svg.appendChild(ring);
  let r=r0, op=opStart;
  const step=()=>{
    if(!ring.parentNode)return; r+=speed; op-=speed*0.048;
    ring.setAttribute('r',r); ring.setAttribute('opacity',Math.max(0,op).toFixed(3));
    if(op>0)requestAnimationFrame(step); else ring.parentNode?.removeChild(ring);
  };
  requestAnimationFrame(step);
}

// Single dot + ring bursts at endpoints
function pulseDiphthong(svgId, x1, y1, x2, y2, color) {
  const svg=document.getElementById(svgId); if(!svg)return;
  spawnRing(svg,x1,y1,color,4,2,0.8);
  setTimeout(()=>spawnRing(svg,x1,y1,color,2,1.4,0.5),90);
  const dot=$s('circle',{r:5,fill:color,opacity:0.9,style:'pointer-events:none'});
  svg.appendChild(dot);
  let t=0; const D=55;
  const step=()=>{
    if(!dot.parentNode)return; t++; if(t>D){
      svg.removeChild(dot);
      spawnRing(svg,x2,y2,color,4,2,0.85);
      spawnRing(svg,x2,y2,color,2,1.3,0.5);
      return;
    }
    const p=t/D, e=p<0.5?2*p*p:-1+(4-2*p)*p;
    dot.setAttribute('cx',(x1+(x2-x1)*e).toFixed(1));
    dot.setAttribute('cy',(y1+(y2-y1)*e).toFixed(1));
    dot.setAttribute('opacity',(p>0.75?(1-p)*4*0.9:0.9).toFixed(3));
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// Diphthong arrow: straight line + arrowhead + label beside arrow + rate-aware playback
function renderDiph(arrowL, dotL, x1, y1, x2, y2, v, lang, lk, svgId) {
  const color=lang.color, dist=Math.hypot(x2-x1,y2-y1);
  if(dist<5)return;
  const ux=(x2-x1)/dist, uy=(y2-y1)/dist;
  const AR=11, W=5;
  const xe=x2-ux*AR, ye=y2-uy*AR;
  const FAINT=0.3;
  const lineEl=$s('line',{x1,y1,x2:xe.toFixed(1),y2:ye.toFixed(1),
    stroke:color,'stroke-width':1.5,opacity:FAINT,'stroke-linecap':'round',
    'stroke-dasharray':'6 4',style:'pointer-events:none'});
  arrowL.appendChild(lineEl);
  const headEl=$s('polygon',{
    points:`${x2.toFixed(1)},${y2.toFixed(1)} ${(xe-uy*W).toFixed(1)},${(ye+ux*W).toFixed(1)} ${(xe+uy*W).toFixed(1)},${(ye-ux*W).toFixed(1)}`,
    fill:color,opacity:FAINT,style:'pointer-events:none'});
  arrowL.appendChild(headEl);
  dotL.appendChild($s('circle',{cx:x1,cy:y1,r:3,fill:color+'55',style:'pointer-events:none'}));
  dotL.appendChild($s('circle',{cx:x2,cy:y2,r:3.5,fill:'none',stroke:color,'stroke-width':1,opacity:FAINT,style:'pointer-events:none'}));
  // Label — always full color, independent of arrow state
  const SIDE=13, mx=(x1+x2)/2, my=(y1+y2)/2, FS=17;
  const lx=mx+uy*SIDE, ly=my-ux*SIDE;
  arrowL.appendChild($t(v.ipa,{x:lx,y:ly,dy:'0.36em','text-anchor':'middle','font-size':FS,
    fill:color,opacity:0.95,'font-family':"Georgia,'Noto Serif',serif",'font-weight':'normal',
    style:'pointer-events:none;user-select:none;filter:drop-shadow(0 0 4px rgba(20,30,46,1)) drop-shadow(0 0 8px rgba(20,30,46,0.9))'}));
  // Hit area — hover highlights arrow to full solid, mouseleave reverts
  const stateKey=`${lk}::${v.ipa}`;
  if(!_diphState[stateKey]) _diphState[stateKey]={lastClick:0,slowed:false};
  const hit=$s('line',{x1,y1,x2,y2,stroke:'transparent','stroke-width':22,cursor:'pointer'});
  hit.addEventListener('mouseenter',e=>{
    lineEl.setAttribute('opacity','0.85');
    lineEl.setAttribute('stroke-dasharray','none');
    headEl.setAttribute('opacity','0.85');
    showTip(e,v,lang);
  });
  hit.addEventListener('mousemove',moveTip);
  hit.addEventListener('mouseleave',()=>{
    lineEl.setAttribute('opacity',FAINT);
    lineEl.setAttribute('stroke-dasharray','6 4');
    headEl.setAttribute('opacity',FAINT);
    hideTip();
  });
  hit.addEventListener('click',()=>{
    const st=_diphState[stateKey], now=Date.now();
    if(now-st.lastClick>5000) st.slowed=false;
    else st.slowed=!st.slowed;
    st.lastClick=now;
    playUrlAtRate(v.ipaAudio, st.slowed?0.5:1.0);
    pulseDiphthong(svgId,x1,y1,x2,y2,color);
  });
  arrowL.appendChild(hit);
}
