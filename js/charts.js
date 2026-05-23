/**
 * charts.js — All chart rendering for the main chart page.
 *
 * Rendering pipeline:
 *   renderAll() → renderIpa() + renderFormant() + renderDetail() + updateCount()
 *
 * The core is buildVowels(), which is called by both renderIpa and renderFormant
 * with different getPos functions. Everything else feeds into or wraps it.
 *
 * Also contains buildSidebar() which builds the filter UI, and renderDetail()
 * which renders the per-language vowel card strip below the charts.
 *
 * Dependencies: utils.js, diphthong.js, index.html globals
 *   (LANGS, filters, passesFilters, showTip, showClusterTip, moveTip, hideTip,
 *    showPicker, pulse, onVowelClicked, playUrl, recordedVowel, analyzedFormants,
 *    refAnalyzed, refVowelMeta, TRAP, trapPos, ROWS, FP, formantPos, F1MIN/MAX,
 *    F2MIN/MAX, IPA_BASE_ORDER, getBase, getLength)
 */

// ─── Chart builder (shared by IPA + Formant renderers) ───────────────────────
function buildVowels(svg, getPos, svgId, showArrows=false, getTargetPos=null) {
  const arrowL=$s('g'), langL=$s('g'), cardL=$s('g'), dotL=$s('g');
  svg.appendChild(arrowL); svg.appendChild(langL); svg.appendChild(cardL); svg.appendChild(dotL);

  const SF='drop-shadow(0px 1px 2px rgba(0,0,0,0.45))';
  const DOT_R=3, DH=14, PROX=22;

  // ── Step 1: separate diphthongs (IPA chart only) from monophthongs ───────────
  const diphs=[], items=[];
  for (const [lk,lang] of Object.entries(LANGS)) {
    for (const v of lang.vowels) {
      if (!passesFilters(lk,v)) continue;
      const pos=getPos(v); if(!pos) continue;
      if (showArrows && isDiph(v)) {
        diphs.push({lk,lang,v,dx:pos.x,dy:pos.y});
      } else {
        items.push({lk,lang,v,dx:pos.x,dy:pos.y});
      }
    }
  }

  // ── Step 2: greedy proximity clustering of monophthongs ──────────────────────
  const clusters=[];
  for (const item of items) {
    let found=null, best=Infinity;
    for (const cl of clusters) {
      const d=Math.hypot(item.dx-cl.cx,item.dy-cl.cy);
      if (d<PROX&&d<best){best=d;found=cl;}
    }
    if (found){
      found.members.push(item);
      found.cx=found.members.reduce((s,m)=>s+m.dx,0)/found.members.length;
      found.cy=found.members.reduce((s,m)=>s+m.dy,0)/found.members.length;
    } else {
      clusters.push({cx:item.dx,cy:item.dy,members:[item]});
    }
  }

  // ── Step 3: render monophthong clusters ──────────────────────────────────────
  for (const cl of clusters) {
    const {members,cx,cy}=cl;
    const multi=members.length>1;

    for (const {lk,lang,v,dx,dy} of members) {
      const ic=lk==='cardinal', lyr=ic?cardL:langL;
      const sym=v.symbols?.[0]??'?';
      const FS=22, GAP=5, PAD=4;
      const lx=v.rounded?dx+DOT_R+GAP:dx-DOT_R-GAP;
      const anch=v.rounded?'start':'end', tw=ipaW(sym,FS);
      const hx=(v.rounded?lx:lx-tw)-PAD, hy=dy-FS*0.40-PAD;
      const lg=$s('g',{style:'cursor:pointer'});
      lg.appendChild($s('rect',{x:hx,y:hy,width:tw+PAD*2,height:FS*0.82+PAD*2,rx:3,fill:'transparent'}));
      lg.appendChild($t(sym,{x:lx,y:dy,dy:'0.36em','text-anchor':anch,'font-size':FS,
        fill:lang.color,opacity:ic?0.98:0.78,
        'font-family':"Georgia,'Noto Serif',serif",'font-weight':'normal',
        style:`filter:${SF};user-select:none`}));
      lg.addEventListener('mouseenter',e=>showTip(e,v,lang));
      lg.addEventListener('mousemove',moveTip); lg.addEventListener('mouseleave',hideTip);
      lg.addEventListener('click',()=>{playVowel(v,svgId);onVowelClicked(v,lang,lk);pulse(svgId,dx,dy,lang.color);});
      lyr.appendChild(lg);
      dotL.appendChild($s('circle',{cx:dx,cy:dy,r:DOT_R,fill:lang.color+'cc'}));
    }

    const dg=$s('g',{style:'cursor:pointer'});
    dg.appendChild($s('circle',{cx,cy,r:DH,fill:'transparent'}));
    if (multi) {
      dg.appendChild($s('circle',{cx,cy,r:DOT_R+4,fill:'none',stroke:'#8090a8',
        'stroke-width':1,'stroke-dasharray':'3 2',opacity:0.5}));
      dg.addEventListener('mouseenter',e=>showClusterTip(e,members));
      dg.addEventListener('mousemove',moveTip);
      dg.addEventListener('mouseleave',hideTip);
      dg.addEventListener('click',e=>{e.stopPropagation();hideTip();showPicker(e.clientX,e.clientY,members,svgId,cx,cy);});
      dg.addEventListener('touchend',e=>{e.preventDefault();const t=e.changedTouches[0];showPicker(t.clientX,t.clientY,members,svgId,cx,cy);},{passive:false});
    } else {
      const {lk,lang,v,dx,dy}=members[0];
      dg.addEventListener('mouseenter',e=>showTip(e,v,lang));
      dg.addEventListener('mousemove',moveTip); dg.addEventListener('mouseleave',hideTip);
      dg.addEventListener('click',()=>{playVowel(v,svgId);onVowelClicked(v,lang,lk);pulse(svgId,dx,dy,lang.color);});
      let tm=false;
      dg.addEventListener('touchstart',e=>{tm=false;e.preventDefault();showTip(e.touches[0],v,lang);},{passive:false});
      dg.addEventListener('touchmove', e=>{tm=true;moveTip(e.touches[0]);},{passive:false});
      dg.addEventListener('touchend', ()=>{hideTip();if(!tm){playVowel(v,svgId);onVowelClicked(v,lang,lk);pulse(svgId,dx,dy,lang.color);}});
    }
    dotL.appendChild(dg);
  }

  // ── Step 4: render diphthong arrows (IPA chart only) ─────────────────────────
  for (const {lk,lang,v,dx,dy} of diphs) {
    const tp = getTargetPos ? getTargetPos(v)
        : (v.target?.heightBackness ? getPos({heightBackness:v.target.heightBackness}) : null);
    if (tp) renderDiph(arrowL, dotL, dx, dy, tp.x, tp.y, v, lang, lk, svgId);
  }
}

// ─── IPA Chart ────────────────────────────────────────────────────────────────
function renderIpa() {
  const svg=document.getElementById('chartIpa');
  while(svg.firstChild)svg.removeChild(svg.firstChild);
  for(const r of ROWS){
    const L=trapPos(r.h,0),R=trapPos(r.h,1);
    svg.appendChild($s('line',{x1:L.x,y1:L.y,x2:R.x,y2:R.y,stroke:'#2e4560','stroke-width':1.5}));
  }
  const cT=trapPos(0,.5),cB=trapPos(1,.5);
  svg.appendChild($s('line',{x1:cT.x,y1:cT.y,x2:cB.x,y2:cB.y,stroke:'#2e4560','stroke-width':1,'stroke-dasharray':'6 5'}));
  const{TL,TR,BL,BR}=TRAP;
  svg.appendChild($s('path',{d:`M${TL.x},${TL.y} L${TR.x},${TR.y} L${BR.x},${BR.y} L${BL.x},${BL.y}Z`,fill:'none',stroke:'#385878','stroke-width':2}));
  for(const r of ROWS){
    const p=trapPos(r.h,0);
    svg.appendChild($t(r.label,{x:p.x-56,y:p.y,dy:'0.36em','text-anchor':'end','font-size':13,fill:'#6a8298','font-family':'system-ui,sans-serif'}));
  }
  for(const[l,b]of[['Front',0],['Central',.5],['Back',1]]){
    const p=trapPos(0,b);
    svg.appendChild($t(l,{x:p.x,y:p.y-28,'text-anchor':'middle','font-size':13,fill:'#6a8298','font-family':'system-ui,sans-serif'}));
  }
  buildVowels(svg, v=>trapPos(v.heightBackness[0],v.heightBackness[1]), 'chartIpa', true);
}

// ─── Formant Plot ─────────────────────────────────────────────────────────────
let recordedVowel=null; // {f1, f2, blob}

const analyzedFormants={}; // lk::ipa → {f1,f2} — populated by ref analysis

function renderFormant() {
  const svg=document.getElementById('chartFormant');
  while(svg.firstChild)svg.removeChild(svg.firstChild);
  svg.appendChild($s('rect',{x:FP.x0,y:FP.y0,width:FP.x1-FP.x0,height:FP.y1-FP.y0,fill:'#192838',rx:6}));
  for(const f2 of[500,700,900,1100,1400,1700,2000,2400,2800]){
    const{x}=formantPos(F1MIN,f2);
    svg.appendChild($s('line',{x1:x,y1:FP.y0,x2:x,y2:FP.y1,stroke:'#2a3e58','stroke-width':1,'stroke-dasharray':'4 4'}));
    svg.appendChild($t(f2,{x,y:FP.y1+18,'text-anchor':'middle','font-size':11,fill:'#4a6888','font-family':'system-ui,sans-serif'}));
  }
  for(const f1 of[200,300,400,500,600,700,800,900,1000]){
    const{y}=formantPos(f1,F2MIN);
    svg.appendChild($s('line',{x1:FP.x0,y1:y,x2:FP.x1,y2:y,stroke:'#2a3e58','stroke-width':1,'stroke-dasharray':'4 4'}));
    svg.appendChild($t(f1,{x:FP.x0-8,y,'text-anchor':'end','font-size':11,dy:'0.35em',fill:'#4a6888','font-family':'system-ui,sans-serif'}));
  }
  svg.appendChild($t('← F2 (Hz)',{x:(FP.x0+FP.x1)/2,y:FP.y1+38,'text-anchor':'middle','font-size':12,fill:'#6a8298','font-family':'system-ui,sans-serif'}));
  const f1el=$t('F1 (Hz) ↓',{x:18,y:(FP.y0+FP.y1)/2,'text-anchor':'middle','font-size':12,fill:'#6a8298','font-family':'system-ui,sans-serif'});
  f1el.setAttribute('transform',`rotate(-90,18,${(FP.y0+FP.y1)/2})`);
  svg.appendChild(f1el);
  svg.appendChild($s('rect',{x:FP.x0,y:FP.y0,width:FP.x1-FP.x0,height:FP.y1-FP.y0,fill:'none',stroke:'#385878','stroke-width':1.5,rx:6}));

  // Normal vowel dots (using JSON-specified F1/F2)
  buildVowels(svg, v=>(v.f1&&v.f2?formantPos(v.f1,v.f2):null), 'chartFormant', true,
      v=>(v.target?.f1&&v.target?.f2?formantPos(v.target.f1,v.target.f2):null));

  // Analyzed overlay — shown automatically when available (dashed line + filled dot)
  const overlayL=$s('g'); svg.appendChild(overlayL);
  for(const[lk,lang]of Object.entries(LANGS)){
    for(const v of lang.vowels){
      if(!passesFilters(lk,v))continue;
      const an=analyzedFormants[`${lk}::${v.symbols?.[0]}`]; if(!an)continue;
      const{x:ax,y:ay}=formantPos(an.f1,an.f2);
      if(v.f1&&v.f2){
        const{x:jx,y:jy}=formantPos(v.f1,v.f2);
        overlayL.appendChild($s('line',{x1:jx,y1:jy,x2:ax,y2:ay,stroke:lang.color,opacity:0.4,'stroke-width':1.5,'stroke-dasharray':'4 3',style:'pointer-events:none'}));
      }
      overlayL.appendChild($s('circle',{cx:ax,cy:ay,r:6,fill:lang.color,opacity:0.9,style:'pointer-events:none'}));
      overlayL.appendChild($s('circle',{cx:ax,cy:ay,r:9,fill:'none',stroke:lang.color,opacity:0.35,'stroke-width':1.5,style:'pointer-events:none'}));
    }
  }

  // Your recorded vowel
  if(recordedVowel){
    const{x,y}=formantPos(recordedVowel.f1,recordedVowel.f2);
    svg.appendChild($s('circle',{cx:x,cy:y,r:10,fill:'none',stroke:'#fff','stroke-width':1.5,opacity:0.4,style:'pointer-events:none'}));
    svg.appendChild($s('circle',{cx:x,cy:y,r:6,fill:'#ffffff',opacity:0.9,style:'pointer-events:none'}));
    svg.appendChild($t('You',{x:x+10,y,dy:'0.36em','font-size':12,fill:'#ffffff',opacity:0.9,'font-family':'system-ui,sans-serif','font-weight':'700',style:'pointer-events:none;filter:drop-shadow(0 1px 2px rgba(0,0,0,.8))'}));
  }
  // Reference analyzed dot
  if(refAnalyzed&&refVowelMeta){
    const{x,y}=formantPos(refAnalyzed.f1,refAnalyzed.f2);
    svg.appendChild($s('circle',{cx:x,cy:y,r:9,fill:'none',stroke:'#fbbf24',opacity:0.7,'stroke-width':2,style:'pointer-events:none'}));
    svg.appendChild($s('circle',{cx:x,cy:y,r:5,fill:'#fbbf24',opacity:0.9,style:'pointer-events:none'}));
    svg.appendChild($t('Ref⚡',{x:x+10,y,dy:'0.36em','font-size':11,fill:'#fbbf24',opacity:0.9,'font-family':'system-ui,sans-serif','font-weight':'700',style:'pointer-events:none;filter:drop-shadow(0 1px 2px rgba(0,0,0,.8))'}));
  }
}

function renderAll() { renderIpa(); renderFormant(); renderDetail(); updateCount(); }

// ─── View tabs ────────────────────────────────────────────────────────────────
document.getElementById('tabIpa').addEventListener('click',()=>{
  document.getElementById('tabIpa').classList.add('active');
  document.getElementById('tabFormant').classList.remove('active');
  document.getElementById('panelIpa').classList.add('active');
  document.getElementById('panelFormant').classList.remove('active');
});
document.getElementById('tabFormant').addEventListener('click',()=>{
  document.getElementById('tabFormant').classList.add('active');
  document.getElementById('tabIpa').classList.remove('active');
  document.getElementById('panelFormant').classList.add('active');
  document.getElementById('panelIpa').classList.remove('active');
});

// ─── Sidebar ──────────────────────────────────────────────────────────────────
function updateCount() {
  document.getElementById('sbCount').innerHTML =
      `<b>${countShown()}</b> of ${totalVowels()} vowels shown`;
}

function buildSidebar() {
  const body=document.getElementById('sidebarBody');
  body.innerHTML='';

  function chip(label, fset, value, color) {
    const btn=document.createElement('button');
    btn.type='button'; btn.className='chip'+(fset.has(value)?' on':'');
    if(color) btn.style.setProperty('--chip-color',color);
    btn.textContent=label;
    btn.addEventListener('click',()=>{ fset.has(value)?fset.delete(value):fset.add(value); buildSidebar(); renderAll(); });
    return btn;
  }
  function ipaChip(base) {
    const b=chip(base,filters.ipaBase,base); b.classList.add('ipa'); return b;
  }
  function section(title, fset, buildFn) {
    const sec=document.createElement('div'); sec.className='filter-section';
    const lbl=document.createElement('div'); lbl.className='filter-label';
    const sp=document.createElement('span'); sp.textContent=title;
    const cl=document.createElement('button'); cl.className='filter-clear-link'; cl.textContent='clear'; cl.type='button';
    cl.addEventListener('click',()=>{ fset.clear(); buildSidebar(); renderAll(); });
    lbl.appendChild(sp); lbl.appendChild(cl);
    const grid=document.createElement('div'); grid.className='chip-grid';
    buildFn(grid);
    sec.appendChild(lbl); sec.appendChild(grid);
    return sec;
  }

  body.appendChild(section('Language', filters.languages, grid=>{
    for (const[lk,lang] of Object.entries(LANGS))
      grid.appendChild(chip(lang.label, filters.languages, lk, lang.color));
  }));

  body.appendChild(section('Roundness', filters.roundness, grid=>{
    grid.appendChild(chip('Rounded',   filters.roundness,'rounded',  '#c084fc'));
    grid.appendChild(chip('Unrounded', filters.roundness,'unrounded','#7eb8f7'));
  }));

  body.appendChild(section('Type', filters.vtype, grid=>{
    grid.appendChild(chip('Monophthong', filters.vtype,'monophthong','#7eb8f7'));
    grid.appendChild(chip('Diphthong',   filters.vtype,'diphthong',  '#f87171'));
  }));

  body.appendChild(section('Length', filters.length, grid=>{
    grid.appendChild(chip('Long ː',   filters.length,'long',    '#34d399'));
    grid.appendChild(chip('Short',    filters.length,'short',   '#fbbf24'));
    grid.appendChild(chip('Variable', filters.length,'variable','#c084fc'));
  }));

  // Collect which base symbols actually exist in current loaded languages
  const existingBases=new Set();
  for (const lang of Object.values(LANGS))
    for (const v of lang.vowels) existingBases.add(getBase(v.symbols?.[0]??''));

  body.appendChild(section('IPA Base', filters.ipaBase, grid=>{
    for (const base of IPA_BASE_ORDER) if (existingBases.has(base)) grid.appendChild(ipaChip(base));
    for (const base of existingBases)  if (!IPA_BASE_ORDER.includes(base)) grid.appendChild(ipaChip(base));
  }));

  updateCount();
}

document.getElementById('clearAllFilters')?.addEventListener('click',()=>{
  filters.languages.clear(); filters.roundness.clear();
  filters.vtype.clear();     filters.length.clear(); filters.ipaBase.clear();
  buildSidebar(); renderAll();
});

// ─── Detail cards ─────────────────────────────────────────────────────────────
function renderDetail() {
  const sec=document.getElementById('detailSection');
  sec.innerHTML='';
  const all=[];
  for (const [lk,lang] of Object.entries(LANGS))
    for (const v of lang.vowels) if (passesFilters(lk,v)) all.push({lk,lang,v});
  if (!all.length) {
    sec.innerHTML='<div class="detail-empty">No vowels match the current filters</div>';
    return;
  }
  all.sort((a,b)=>{ const dh=a.v.heightBackness[0]-b.v.heightBackness[0]; return Math.abs(dh)>.001?dh:a.v.heightBackness[1]-b.v.heightBackness[1]; });
  const grid=document.createElement('div'); grid.className='detail-cards-row';

  for (const {lk,lang,v} of all) {
    const c=lang.color;
    const tPos=trapPos(v.heightBackness[0],v.heightBackness[1]);
    const fPos=v.f1&&v.f2?formantPos(v.f1,v.f2):null;
    const sym=v.symbols?.[0]??'?';
    const card=document.createElement('div');
    card.className='dcard'; card.style.borderColor=c;
    card.innerHTML=`
      <div class="dcard-ipa" style="color:${c}">${sym}</div>
      <div class="dcard-sublang" style="color:${c}bb">${lang.label}</div>
      <div class="dcard-desc">${v.desc}</div>
      <div class="dcard-round" style="color:${c}88">${v.rounded?'⊙ Rounded':'○ Unrounded'} · ${getLength(v)}</div>
      ${v.f1?`<div class="dcard-formants">F1 <span>${v.f1}</span> · F2 <span>${v.f2}</span> Hz</div>`:''}
      <div class="dcard-actions">
        <button class="dcard-btn dcard-play">▶ Sound</button>
        ${v.wikiUrl?`<a class="dcard-btn" href="${v.wikiUrl}" target="_blank" rel="noopener">Wiki ↗</a>`:''}
      </div>`;

    card.querySelector('.dcard-play').addEventListener('click',()=>{
      playVowel(v,'chartFormant');
      pulse('chartIpa',tPos.x,tPos.y,c);
      if(fPos) pulse('chartFormant',fPos.x,fPos.y,c);
    });
    grid.appendChild(card);
  }
  sec.appendChild(grid);
}