// ─── Pulse animation + tooltip + disambiguation picker ───────────────────────
// ─── Pulse ────────────────────────────────────────────────────────────────────
function pulse(svgId, x, y, color) {
  const svg=document.getElementById(svgId); if(!svg)return;
  const ring=$s('circle',{cx:x,cy:y,r:6,fill:'none',stroke:color,'stroke-width':2,opacity:.9,style:'pointer-events:none'});
  svg.appendChild(ring);
  let r=6, op=.9;
  const step=()=>{
    if(!ring.parentNode)return; r+=2; op-=.045;
    ring.setAttribute('r',r); ring.setAttribute('opacity',Math.max(0,op).toFixed(3));
    if(op>0)requestAnimationFrame(step); else ring.parentNode?.removeChild(ring);
  };
  requestAnimationFrame(step);
}

// ─── Tooltip ─────────────────────────────────────────────────────────────────
const tip=document.getElementById('tip');
function showTip(e,v,lang) {
  const roundType=`${v.rounded?'⊙ Rounded':'○ Unrounded'} · ${getLength(v)}`;
  const sym=v.symbols?.[0]??'?';
  const targetLine = v.target
      ? `<div class="tip-meta" style="margin-top:1px">→ ${v.target.rounded?'⊙ Rounded':'○ Unrounded'}${v.target.f1?` · F1 <span style="color:#789ab8">${v.target.f1}</span> F2 <span style="color:#789ab8">${v.target.f2}</span> Hz`:''}</div>`
      : '';
  tip.innerHTML=`
    <div class="tip-ipa" style="color:${lang.color}">${sym}</div>
    <div class="tip-lang" style="color:${lang.color}">${lang.label}</div>
    <div class="tip-desc">${v.desc}</div>
    <div class="tip-meta">${roundType}</div>
    ${v.f1?`<div class="tip-f">F1 <span>${v.f1} Hz</span> · F2 <span>${v.f2} Hz</span></div>`:''}
    ${targetLine}
  `;
  tip.style.display='block'; moveTip(e);
}
function showClusterTip(e, members) {
  const rows = members.map(({lang,v}) => {
    const sym=v.symbols?.[0]??'?';
    const freq = v.f1 ? `<span class="tip-f" style="margin-top:2px">F1 <span>${v.f1}</span> · F2 <span>${v.f2}</span> Hz</span>` : '';
    const roundType=`${v.rounded?'⊙ Rounded':'○ Unrounded'} · ${getLength(v)}`;
    return `<div class="ctip-row">
      <span class="tip-ipa" style="color:${lang.color};font-size:1.3rem;line-height:1">${sym}</span>
      <span class="ctip-info">
        <span class="tip-lang" style="color:${lang.color};display:block">${lang.label}</span>
        <span class="tip-desc">${v.desc}</span>
        <span class="tip-meta">${roundType}</span>
        ${freq}
      </span>
    </div>`;
  }).join('');
  tip.innerHTML = `
    ${rows}
    <div class="ctip-hint">Click to choose which sound to play</div>`;
  tip.style.display = 'block';
  moveTip(e);
}
function moveTip(e) {
  const x=e.clientX+18, y=e.clientY-12, r=tip.getBoundingClientRect();
  tip.style.left=Math.min(x,window.innerWidth-r.width-8)+'px';
  tip.style.top=Math.max(4,Math.min(y,window.innerHeight-r.height-8))+'px';
}
function hideTip() { tip.style.display='none'; }

// ─── Disambiguation picker ────────────────────────────────────────────────────
const picker=document.getElementById('vowelPicker');
function showPicker(cx, cy, group, svgId, dx, dy) {
  hideTip();
  document.getElementById('pickerItems').innerHTML='';
  for (const {lk,lang,v} of group) {
    const btn=document.createElement('button'); btn.className='picker-btn';
    const sym=v.symbols?.[0]??'?';
    btn.innerHTML=`<span class="picker-ipa" style="color:${lang.color}">${sym}</span><span class="picker-info"><span class="picker-lang" style="color:${lang.color}">${lang.label}</span><span class="picker-desc">${v.desc}</span></span>`;
    btn.addEventListener('click',()=>{ hidePicker(); playVowel(v,svgId,lk); pulse(svgId,dx,dy,lang.color); onVowelClicked(v,lang,lk); });
    document.getElementById('pickerItems').appendChild(btn);
  }
  picker.style.display='block';
  const pw=Math.max(picker.offsetWidth,170), ph=picker.scrollHeight||120;
  let px=cx+10, py=cy-10;
  if(px+pw>window.innerWidth-8)  px=cx-pw-10;
  if(py+ph>window.innerHeight-8) py=window.innerHeight-ph-8;
  picker.style.left=Math.max(4,px)+'px'; picker.style.top=Math.max(4,py)+'px';
}
function hidePicker() { picker.style.display='none'; }
document.addEventListener('click', e=>{ if(!picker.contains(e.target)) hidePicker(); }, true);