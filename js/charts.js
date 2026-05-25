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
// Shared constants used by buildVowels + renderTokenLayer
const DOT_R=3, DH=14, PROX=22;

function buildVowels(svg, getPos, svgId, showArrows=false, getTargetPos=null) {
  const showAsRing = (typeof filters!=='undefined') && filters.showTokens && svgId==='chartFormant';
  const arrowL=$s('g'), langL=$s('g'), cardL=$s('g'), dotL=$s('g');
  svg.appendChild(arrowL); svg.appendChild(langL); svg.appendChild(cardL); svg.appendChild(dotL);

  const SF='drop-shadow(0px 1px 2px rgba(0,0,0,0.45))';

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

    // Collect label hit-rects to add to dotL AFTER dg so they're always on top
    const _pendingHits = [];
    for (const {lk,lang,v,dx,dy} of members) {
      const ic=lk==='cardinal', lyr=ic?cardL:langL;
      const sym=v.symbols?.[0]??'?';
      const FS=22, GAP=5, PAD=4;
      const lx=v.rounded?dx+DOT_R+GAP:dx-DOT_R-GAP;
      const anch=v.rounded?'start':'end', tw=ipaW(sym,FS);
      const hx=(v.rounded?lx:lx-tw)-PAD, hy=dy-FS*0.40-PAD;
      const lg=$s('g',{style:'cursor:pointer'});
      // Text display in langL/cardL (visual layer, below dots)
      lg.appendChild($t(sym,{x:lx,y:dy,dy:'0.36em','text-anchor':anch,'font-size':FS,
        fill:lang.color,opacity:ic?0.98:0.78,
        'font-family':"Georgia,'Noto Serif',serif",'font-weight':'normal',
        style:`filter:${SF};user-select:none;pointer-events:none`}));
      lg.addEventListener('mouseenter',e=>showTip(e,v,lang));
      lg.addEventListener('mousemove',moveTip); lg.addEventListener('mouseleave',hideTip);
      lyr.appendChild(lg);
      dotL.appendChild(showAsRing
          ? $s('circle',{cx:dx,cy:dy,r:DOT_R+1,fill:lang.color+'18',stroke:lang.color,'stroke-width':'1.5','stroke-dasharray':'3 2',opacity:'0.75'})
          : $s('circle',{cx:dx,cy:dy,r:DOT_R,fill:lang.color+'cc'}));
      // Save hit-rect params — will be added to dotL AFTER dg
      _pendingHits.push({hx,hy,tw,PAD,FS,v,lang,lk,dx,dy});
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
      dg.addEventListener('click',()=>{playVowel(v,svgId,lk);onVowelClicked(v,lang,lk);pulse(svgId,dx,dy,lang.color);});
      let tm=false;
      dg.addEventListener('touchstart',e=>{tm=false;e.preventDefault();showTip(e.touches[0],v,lang);},{passive:false});
      dg.addEventListener('touchmove', e=>{tm=true;moveTip(e.touches[0]);},{passive:false});
      dg.addEventListener('touchend', ()=>{hideTip();if(!tm){playVowel(v,svgId,lk);onVowelClicked(v,lang,lk);pulse(svgId,dx,dy,lang.color);}});
    }
    dotL.appendChild(dg);
    // Add label hit-rects ABOVE dg: clicking any label always plays that vowel
    for (const {hx,hy,tw,PAD,FS,v,lang,lk,dx,dy} of _pendingHits) {
      const hit=$s('g',{style:'cursor:pointer'});
      hit.appendChild($s('rect',{x:hx,y:hy,width:tw+PAD*2,height:FS*0.82+PAD*2,rx:3,fill:'transparent'}));
      hit.addEventListener('mouseenter',e=>showTip(e,v,lang));
      hit.addEventListener('mousemove',moveTip); hit.addEventListener('mouseleave',hideTip);
      hit.addEventListener('click',e=>{e.stopPropagation();playVowel(v,svgId,lk);onVowelClicked(v,lang,lk);pulse(svgId,dx,dy,lang.color);});
      dotL.appendChild(hit);
    }
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

  // Average vowel dots (optional, dimmed when tokens shown)
  if (filters.showAverages !== false)
    buildVowels(svg, v=>(v.f1&&v.f2?formantPos(v.f1,v.f2):null), 'chartFormant', true,
        v=>(v.target?.f1&&v.target?.f2?formantPos(v.target.f1,v.target.f2):null));
  // Token scatter layer — individual measurements on top
  renderTokenLayer(svg);

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


// ─── Token scatter layer (with disambiguation clustering) ────────────────────
function renderTokenLayer(svg) {
  if (!filters.showTokens) return;
  const tokL = $s('g'); tokL.setAttribute('class','tok-layer');
  svg.appendChild(tokL);

  // Two sub-layers matching buildVowels: dots below, labels+rings on top
  const dotL = $s('g'), topL = $s('g');
  tokL.appendChild(dotL); tokL.appendChild(topL);

  // ── Step 1: collect renderable token items ────────────────────────────────
  const items = [];
  for (const [lk, lang] of Object.entries(LANGS)) {
    for (const sample of (LANG_SAMPLES[lk]||[])) {
      for (const tok of (sample.tokens||[])) {
        const f = tok.analysis;
        if (!f?.f1 || !f?.f2) continue;
        const vowel = (lang.vowels||[]).find(v => v.symbols?.includes(tok.symbol));
        if (!vowel || !passesFilters(lk, vowel)) continue;
        items.push({lk, lang, c:lang.color, sample, tok, vowel,
          pos: formantPos(f.f1, f.f2)});
      }
    }
  }

  // ── Step 2: greedy proximity clustering — IDENTICAL to buildVowels ────────
  const clusters = [];
  for (const item of items) {
    let found = null, best = Infinity;
    for (const cl of clusters) {
      const d = Math.hypot(item.pos.x-cl.cx, item.pos.y-cl.cy);
      if (d < PROX && d < best) { best = d; found = cl; }
    }
    if (found) {
      found.members.push(item);
      // Update rolling cluster centre, same as buildVowels
      found.cx = found.members.reduce((a,m)=>a+m.pos.x,0)/found.members.length;
      found.cy = found.members.reduce((a,m)=>a+m.pos.y,0)/found.members.length;
    } else {
      clusters.push({cx:item.pos.x, cy:item.pos.y, members:[item]});
    }
  }

  // ── Step 3: render — MIRRORS buildVowels Step 3 exactly ──────────────────
  for (const {cx, cy, members} of clusters) {
    const multi = members.length > 1;

    // Each member: dot + label — collect hit-rects for adding AFTER dg
    const _tokPendingHits = [];
    for (const {pos, tok, sample, lang, lk, vowel, c} of members) {
      dotL.appendChild($s('circle',{cx:pos.x,cy:pos.y,r:DOT_R,fill:c,opacity:'0.9'}));
      const rounded = vowel?.rounded ?? false;
      const FS=22, PAD=3;
      const lx = rounded?pos.x+DOT_R+4:pos.x-DOT_R-4;
      const tw = ipaW(tok.symbol, FS);
      const hx = (rounded?lx:lx-tw)-PAD, hy = pos.y-FS*0.40-PAD;
      // Text display — pointer-events:none so hit-rect below handles interaction
      topL.appendChild($t(tok.symbol,{
        x:lx, y:pos.y, dy:'0.36em',
        'text-anchor': rounded?'start':'end',
        'font-size':FS, fill:c, opacity:'0.85',
        'font-family':"Georgia,'Noto Serif',serif",
        style:'pointer-events:none;user-select:none;filter:drop-shadow(0 1px 2px rgba(0,0,0,.85))'
      }));
      _tokPendingHits.push({hx,hy,tw,PAD,FS,pos,tok,sample,lang,lk,c,vowel});
    }

    // Disambiguation group at cluster centre — mirrors buildVowels dg exactly
    const dg = $s('g',{style:'cursor:pointer'});
    dg.appendChild($s('circle',{cx,cy,r:DH,fill:'transparent'}));

    if (multi) {
      // Dashed ring + cluster picker (same neutral color as buildVowels: #8090a8)
      dg.appendChild($s('circle',{cx,cy,r:DOT_R+4,fill:'none',stroke:'#8090a8',
        'stroke-width':1,'stroke-dasharray':'3 2',opacity:0.5}));
      dg.addEventListener('mouseenter',e=>{showTokenClusterTip(e,members);moveTip(e);});
      dg.addEventListener('mousemove',moveTip);
      dg.addEventListener('mouseleave',hideTip);
      dg.addEventListener('click',e=>{e.stopPropagation();hideTip();showTokenClusterPicker(e.clientX,e.clientY,members,'chartFormant');});
      dg.addEventListener('contextmenu',e=>{e.preventDefault();e.stopPropagation();hideTip();showTokenClusterPicker(e.clientX,e.clientY,members,'chartFormant');});
    } else {
      // Single token: interactions (label already added in the member loop above)
      const {pos,tok,sample,lang,lk,c,vowel:_sv} = members[0];
      dg.addEventListener('mouseenter',e=>{showTokenTip(e,tok,sample,lang);moveTip(e);});
      dg.addEventListener('mousemove',moveTip);
      dg.addEventListener('mouseleave',hideTip);
      dg.addEventListener('click',e=>{
        e.stopPropagation();
        if(sample.audio) new Audio(sample.audio).play().catch(()=>{});
        pulse('chartFormant',pos.x,pos.y,c);
        // Update practice panel reference with this token's audio + F1/F2
        if(typeof onVowelClicked==='function'){
          const tv={..._sv,f1:tok.analysis?.f1||_sv?.f1,f2:tok.analysis?.f2||_sv?.f2,audio:sample.audio};
          onVowelClicked(tv,lang,lk);
        }
      });
      dg.addEventListener('mousedown',e=>{
        if(e.button===1){e.preventDefault();playTokenSlice(sample,tok);pulse('chartFormant',pos.x,pos.y,c);}
      });
      dg.addEventListener('contextmenu',e=>{
        e.preventDefault();e.stopPropagation();hideTip();
        showTokenContextMenu(e,sample,tok,lang,lk);
      });
    }
    topL.appendChild(dg);
    // Label hit-rects above dg — clicking the IPA symbol always interacts with that token
    for (const {hx,hy,tw,PAD,FS,pos,tok,sample,lang,lk,c,vowel:_hv} of _tokPendingHits) {
      const hit=$s('g',{style:'cursor:pointer'});
      hit.appendChild($s('rect',{x:hx,y:hy,width:tw+PAD*2,height:FS*0.82+PAD*2,rx:3,fill:'transparent'}));
      hit.addEventListener('mouseenter',e=>{showTokenTip(e,tok,sample,lang);moveTip(e);});
      hit.addEventListener('mousemove',moveTip); hit.addEventListener('mouseleave',hideTip);
      hit.addEventListener('click',e=>{
        e.stopPropagation();
        if(sample.audio) new Audio(sample.audio).play().catch(()=>{});
        pulse('chartFormant',pos.x,pos.y,c);
        if(typeof onVowelClicked==='function'){
          const tv={..._hv,f1:tok.analysis?.f1||_hv?.f1,f2:tok.analysis?.f2||_hv?.f2,audio:sample.audio};
          onVowelClicked(tv,lang,lk);
        }
      });
      hit.addEventListener('mousedown',e=>{
        if(e.button===1){e.preventDefault();playTokenSlice(sample,tok);pulse('chartFormant',pos.x,pos.y,c);}
      });
      hit.addEventListener('contextmenu',e=>{
        e.preventDefault();e.stopPropagation();hideTip();
        showTokenContextMenu(e,sample,tok,lang,lk);
      });
      topL.appendChild(hit);
    }
  }
}

// ─── Token cluster tooltip ────────────────────────────────────────────────────
function showTokenClusterTip(e, members) {
  tip.innerHTML = `
    <div class="tip-meta">${members.length} tokens — click to pick</div>
    ${members.slice(0,4).map(({tok,sample,c:mc})=>`
      <div style="display:flex;gap:6px;align-items:baseline;margin-top:3px">
        <span style="font-family:Georgia,serif;color:${mc};min-width:18px">${tok.symbol}</span>
        <span style="font-size:.75rem;color:#8fa8c0">${sample.text||'?'}</span>
        <span style="font-size:.62rem;color:#4a6878;font-family:monospace">${tok.analysis?.f1?`${tok.analysis.f1}·${tok.analysis.f2} Hz`:''}</span>
      </div>`).join('')}
    ${members.length>4?`<div style="font-size:.6rem;color:#4a6898;margin-top:3px">+${members.length-4} more</div>`:''}
    <div style="font-size:.58rem;color:#4a6878;margin-top:5px">▶ click · ◉ middle · ⋯ right-click</div>`;
  tip.style.display='block';
}

// ─── Token cluster picker ─────────────────────────────────────────────────────
function showTokenClusterPicker(px, py, members, svgId) {
  document.getElementById('_tokClusterPick')?.remove();
  const picker = document.createElement('div');
  picker.id = '_tokClusterPick';
  picker.style.cssText = 'position:fixed;z-index:9999;background:#0d1a28;border:1px solid #2e4560;border-radius:8px;padding:5px 0;min-width:230px;max-height:320px;overflow-y:auto;box-shadow:0 4px 20px #000a;user-select:none';

  const hd = document.createElement('div');
  hd.style.cssText = 'padding:5px 12px 6px;border-bottom:1px solid #1e3048;margin-bottom:3px;font-size:.65rem;color:#4a6898;text-transform:uppercase;letter-spacing:.04em';
  hd.textContent = `${members.length} tokens`;
  picker.appendChild(hd);

  for (const {tok, sample, lang, lk, c} of members) {
    const row = document.createElement('div');
    row.style.cssText = 'padding:6px 10px;cursor:pointer;display:flex;gap:7px;align-items:center';
    row.addEventListener('mouseenter', ()=>row.style.background='#1a2e44');
    row.addEventListener('mouseleave', ()=>row.style.background='');

    const esc = x=>String(x).replace(/&/g,'&amp;').replace(/</g,'&lt;');
    const f   = tok.analysis;
    const [ps,pe]=[tok.position||[0,0]][0];
    const txt = sample.text||'';
    const hl  = esc(txt.slice(0,ps))+`<mark style="background:${c}33;color:${c};border-radius:2px;padding:0 1px">${esc(txt.slice(ps,pe)||'?')}</mark>`+esc(txt.slice(pe));

    row.innerHTML = `
      <span style="font-family:Georgia,serif;font-size:1.1rem;color:${c};min-width:22px">${tok.symbol}</span>
      <span style="flex:1;min-width:0">
        <div style="font-family:Georgia,serif;font-size:.82rem;color:#c8d8e8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${hl}</div>
        <div style="font-size:.62rem;color:#4a7898;font-family:monospace">${f?.f1?`F1 ${f.f1} · F2 ${f.f2} Hz`:''}</div>
      </span>
      <button class="_tpFull"  style="background:none;border:none;color:#6a8898;cursor:pointer;padding:2px 4px;font-size:.9rem" title="Play full">▶</button>
      <button class="_tpSlice" style="background:none;border:none;color:#6a8898;cursor:pointer;padding:2px 4px;font-size:.9rem" title="Play slice">◉</button>`;

    row.querySelector('._tpFull').addEventListener('click', e => {
      e.stopPropagation();
      if (sample.audio) { new Audio(sample.audio).play().catch(()=>{}); pulse(svgId,px,py,c); }
    });
    row.querySelector('._tpSlice').addEventListener('click', e => {
      e.stopPropagation();
      playTokenSlice(sample, tok); pulse(svgId,px,py,c);
    });
    row.addEventListener('click', ()=>{
      picker.remove();
      showTokenContextMenu({clientX:px+10,clientY:py}, sample, tok, lang, lk);
    });
    picker.appendChild(row);
  }

  document.body.appendChild(picker);
  const pw=picker.offsetWidth||230, ph=picker.scrollHeight||200;
  picker.style.left=Math.min(px+4,window.innerWidth-pw-8)+'px';
  picker.style.top=Math.min(py+4,window.innerHeight-ph-8)+'px';

  const dismiss=ev=>{if(!picker.contains(ev.target)){picker.remove();document.removeEventListener('click',dismiss,true);}};
  setTimeout(()=>document.addEventListener('click',dismiss,true),50);
  document.addEventListener('keydown',ev=>{if(ev.key==='Escape')picker.remove();},{once:true});
}

// ─── Token right-click context menu ───────────────────────────────────────────
function showTokenContextMenu(e, sample, tok, lang, lk) {
  document.getElementById('_tokCtxMenu')?.remove();
  const c = lang.color;
  const menu = document.createElement('div');
  menu.id = '_tokCtxMenu';
  menu.style.cssText = 'position:fixed;z-index:9999;background:#0d1a28;border:1px solid #2e4560;border-radius:8px;padding:5px 0;min-width:195px;box-shadow:0 4px 20px #000a;user-select:none';

  // Header
  const hd = document.createElement('div');
  hd.style.cssText = 'padding:7px 12px 8px;border-bottom:1px solid #1e3048;margin-bottom:3px';
  const f  = tok.analysis;
  const esc = x => String(x).replace(/&/g,'&amp;').replace(/</g,'&lt;');
  const [ps,pe] = tok.position||[0,0];
  const txt = sample.text||'';
  const hl  = esc(txt.slice(0,ps))
      + `<mark style="background:${c}33;color:${c};padding:0 1px;border-radius:2px">${esc(txt.slice(ps,pe)||'?')}</mark>`
      + esc(txt.slice(pe));
  hd.innerHTML = `<span style="font-family:Georgia,serif;font-size:1.1rem;color:${c}">${tok.symbol}</span>`
      + `<span style="font-size:.7rem;color:#6a8298;margin-left:6px">${lang.label}</span>`
      + `<div style="font-family:Georgia,serif;font-size:.8rem;color:#8fa8c0;margin-top:3px">${hl}${sample.phonemic?` <span style='opacity:.5;font-style:italic'>${sample.phonemic}</span>`:''}</div>`
      + (f?.f1?`<div style="font-size:.65rem;color:#4a7898;font-family:monospace;margin-top:3px">F1 ${f.f1} · F2 ${f.f2} Hz</div>`:'');
  menu.appendChild(hd);

  const item = (icon, label, cb) => {
    const d = document.createElement('div');
    d.style.cssText = 'padding:7px 14px;cursor:pointer;font-size:.8rem;color:#c8d8e8;display:flex;gap:8px;align-items:center';
    d.innerHTML = `<span style="opacity:.7;width:12px">${icon}</span><span>${label}</span>`;
    d.addEventListener('mouseenter', () => d.style.background = '#1a2e44');
    d.addEventListener('mouseleave', () => d.style.background = '');
    d.addEventListener('click', () => { menu.remove(); cb(); });
    menu.appendChild(d);
  };

  item('▶', 'Play full sample',  () => { if (sample.audio) new Audio(sample.audio).play().catch(()=>{}); });
  item('◉', 'Play token slice',  () => playTokenSlice(sample, tok));
  item('⬤', 'Trace token slice',      () => traceOnFormantChart(sample, tok, lang, lk, false));
  item('⬤', 'Trace full audio',       () => traceOnFormantChart(sample, tok, lang, lk, true));
  // Only offer 'Open' when this token's language is the one currently being edited
  const _st = typeof state !== 'undefined' ? state : null;
  if (_st && lk === _st.selKey && typeof openSampleInVowelEditor === 'function') {
    item('↗', `Open "${esc(sample.text||'?')}"`, () => {
      // LANG_SAMPLES[lk] was set to state.samplesDraft by setLangSamples — same array
      const smpIdx = (_st.samplesDraft||[]).indexOf(sample);
      if (smpIdx < 0) return;
      // Open the vowel that owns this token first
      const vowelIdx = (_st.langDraft?.vowels||[]).findIndex(v => v.symbols?.includes(tok.symbol));
      if (vowelIdx >= 0 && typeof openVowelEditor === 'function') {
        openVowelEditor(vowelIdx);
        openSampleInVowelEditor(smpIdx);
      } else {
        // Vowel not found — fall back to the samples panel
        if (typeof switchToSamplesTab === 'function') switchToSamplesTab();
        if (typeof openSampleEditor  === 'function') openSampleEditor(smpIdx);
      }
    });
  }

  document.body.appendChild(menu);
  const pw = menu.offsetWidth||195, ph = menu.offsetHeight||130;
  menu.style.left = Math.min(e.clientX+4, window.innerWidth -pw-8) + 'px';
  menu.style.top  = Math.min(e.clientY+4, window.innerHeight-ph-8) + 'px';

  const dismiss = ev => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('click',dismiss,true); } };
  setTimeout(() => document.addEventListener('click',dismiss,true), 50);
  document.addEventListener('keydown', ev => { if (ev.key==='Escape') menu.remove(); },{once:true});
}


// ─── Animated F1/F2 trace on formant chart ────────────────────────────────────
async function traceOnFormantChart(sample, tok, lang, lk, fullAudio=false) {
  const srv = typeof SAMPLE_SERVER !== 'undefined' ? SAMPLE_SERVER : 'http://localhost:5050';
  const cfg = tok.analysis || {};
  const c   = lang?.color || LANGS[lk]?.color || '#7eb8f7';

  // Remove any previous trace
  document.getElementById('_chartTrace')?.remove();
  const svg = document.getElementById('chartFormant');
  if (!svg) return;

  // Build SVG overlay: trail + moving dot + start/end markers
  const grp  = document.createElementNS('http://www.w3.org/2000/svg','g');
  grp.id = '_chartTrace';
  const trail = document.createElementNS('http://www.w3.org/2000/svg','polyline');
  trail.setAttribute('fill','none'); trail.setAttribute('stroke',c);
  trail.setAttribute('stroke-width','2'); trail.setAttribute('stroke-linecap','round');
  trail.setAttribute('stroke-linejoin','round'); trail.setAttribute('opacity','0.65');
  grp.appendChild(trail);
  const dot = document.createElementNS('http://www.w3.org/2000/svg','circle');
  dot.setAttribute('r','6'); dot.setAttribute('fill',c); dot.setAttribute('opacity','0.9');
  grp.appendChild(dot);
  svg.appendChild(grp);

  // Fetch all formant frames for the full audio
  let frames = [];
  try {
    const wav = await fetchDecodeAudio(sample.audio);
    const form = new FormData();
    form.append('file', encodeWavBlob(wav.samples, wav.sampleRate), 'audio.wav');
    form.append('config', JSON.stringify({
      single_segment: false,
      max_f:        cfg.max_f        || 5000,
      n_formants:   cfg.n_formants   || 5,
      window_ms:    cfg.window_ms    || 25,
      pre_emphasis: cfg.pre_emphasis || 50,
      rms_floor:    cfg.rms_floor    || 0.005,
      median_n:     cfg.median_n     || 5,
    }));
    const resp = await fetch(`${srv}/frames`, {method:'POST', body:form});
    if (!resp.ok) throw new Error('Server ' + resp.status);
    const data = await resp.json();
    frames = data.frames || [];
  } catch(e) {
    grp.remove();
    if (typeof toast === 'function') toast('Trace failed: ' + e.message);
    return;
  }
  if (!frames.length) { grp.remove(); return; }

  // Playback range — server time is in f.segment.at_ms (ms)
  const lastFrameMs = frames[frames.length-1]?.segment?.at_ms ?? 0;
  const [startMs, endMs] = fullAudio
      ? [0, lastFrameMs]
      : (cfg.slice || [0, lastFrameMs]);
  const audio = new Audio(sample.audio);
  audio.currentTime = startMs / 1000;
  audio.play().catch(()=>{});

  const trailPts = [];
  const t0 = performance.now();

  const tick = () => {
    // Match elapsed ms to nearest voiced frame by f.segment.at_ms
    const elapsedMs = performance.now() - t0 + startMs;
    let best = null, bestD = Infinity;
    for (const f of frames) {
      if (!f.voiced || f.f1 == null) continue;
      const d = Math.abs(f.segment.at_ms - elapsedMs);
      if (d < bestD) { bestD = d; best = f; }
    }
    if (best?.f1 && best?.f2) {
      const pos = formantPos(best.f1, best.f2);
      dot.setAttribute('cx', pos.x);
      dot.setAttribute('cy', pos.y);
      trailPts.push(`${pos.x.toFixed(1)},${pos.y.toFixed(1)}`);
      if (trailPts.length > 80) trailPts.shift();
      trail.setAttribute('points', trailPts.join(' '));
    }
    const elapsedTotal = performance.now() - t0;
    const duration = endMs - startMs;
    if (elapsedTotal < duration && !audio.paused && !audio.ended) {
      requestAnimationFrame(tick);
    } else {
      audio.pause();
      setTimeout(() => grp.remove(), 2500);
    }
  };
  requestAnimationFrame(tick);
}

function renderAll() { renderIpa(); renderFormant(); renderDetail(); updateCount(); }

// ─── View tabs ────────────────────────────────────────────────────────────────
document.getElementById('tabIpa')?.addEventListener('click',()=>{
  document.getElementById('tabIpa').classList.add('active');
  document.getElementById('tabFormant').classList.remove('active');
  document.getElementById('panelIpa').classList.add('active');
  document.getElementById('panelFormant').classList.remove('active');
  buildSidebar();
});
document.getElementById('tabFormant')?.addEventListener('click',()=>{
  document.getElementById('tabFormant').classList.add('active');
  document.getElementById('tabIpa').classList.remove('active');
  document.getElementById('panelFormant').classList.add('active');
  document.getElementById('panelIpa').classList.remove('active');
  buildSidebar();
});

// ─── Sidebar ──────────────────────────────────────────────────────────────────
function updateCount() {
  const el = document.getElementById('sbCount');
  if (el) el.innerHTML = `<b>${countShown()}</b> of ${totalVowels()} vowels shown`;
}

function buildSidebar() {
  const body=document.getElementById('sidebarBody');
  if (!body) return;
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

  // ── Formant Layers chips: only when Formant Plot tab active ─────────────────
  if (document.getElementById('tabFormant')?.classList.contains('active')) {
    const flSec = document.createElement('div'); flSec.className='filter-section';
    const flLbl = document.createElement('div'); flLbl.className='filter-label'; flLbl.textContent='Formant Layers';
    const flGrid = document.createElement('div'); flGrid.className='chip-grid';
    const mkChip = (label, active, onToggle) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip' + (active ? ' on' : '');
      b.textContent = label;
      b.addEventListener('click', () => { onToggle();
        if (typeof buildSidebar==='function') buildSidebar();
        if (typeof renderAll==='function') renderAll(); else if (typeof refreshCharts==='function') refreshCharts();
      });
      return b;
    };
    flGrid.appendChild(mkChip('◎ Averages', filters.showAverages!==false, () => { filters.showAverages = !filters.showAverages; }));
    flGrid.appendChild(mkChip('◉ Tokens',   filters.showTokens,           () => { filters.showTokens   = !filters.showTokens;   }));
    flSec.appendChild(flLbl); flSec.appendChild(flGrid); body.appendChild(flSec);
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
// ─── Shared highlighted-text builder (viewer context) ────────────────────────
function buildDetailHighlightedText(smp, filterSymbols, langColor, onFullPlay) {
  const text=smp.text||''; const c=langColor;
  const div=document.createElement('div');
  div.style.cssText='font-family:Georgia,serif;line-height:1.65;word-break:break-word';
  const toks=(smp.tokens||[]).filter(t=>!filterSymbols||filterSymbols.includes(t.symbol));
  if (!text) { div.textContent='?'; return div; }
  const charTok=new Array(text.length).fill(null);
  toks.forEach(tok=>{ const [ps,pe]=tok.position||[0,0]; for(let i=ps;i<Math.min(pe,text.length);i++) charTok[i]=tok; });
  let i=0;
  while (i<text.length) {
    const tok=charTok[i]; let j=i+1;
    while (j<text.length&&charTok[j]===tok) j++;
    const seg=document.createElement('span'); seg.textContent=text.slice(i,j);
    if (tok) {
      seg.style.cssText=`background:${c}28;color:${c};border-radius:2px;padding:0 1px;cursor:pointer;transition:background .1s`;
      seg.addEventListener('mouseenter',()=>seg.style.background=c+'50');
      seg.addEventListener('mouseleave',()=>seg.style.background=c+'28');
      const f=tok.analysis;
      seg.title=f?.f1?`/${tok.symbol}/  F1 ${f.f1} · F2 ${f.f2} Hz`:`/${tok.symbol}/`;
      seg.addEventListener('click',e=>{e.stopPropagation();playTokenSlice(smp,tok);});
    } else if (onFullPlay) {
      seg.style.cursor='pointer';
      seg.addEventListener('click',e=>{e.stopPropagation();onFullPlay();});
    }
    div.appendChild(seg); i=j;
  }
  return div;
}

function buildSampleDetailCard(smp, lang) {
  const c=lang.color;
  const card=document.createElement('div');
  card.style.cssText=`background:var(--card,#223042);border:1px solid ${c}40;border-radius:10px;padding:10px 12px;width:160px;flex-shrink:0;cursor:pointer;position:relative;transition:border-color .12s`;
  card.addEventListener('mouseenter',()=>card.style.borderColor=c+'80');
  card.addEventListener('mouseleave',()=>card.style.borderColor=c+'40');
  if (smp.representative) {
    const rep=document.createElement('div');
    rep.style.cssText=`position:absolute;top:5px;right:8px;font-size:.55rem;color:${c};background:${c}18;border:1px solid ${c}50;border-radius:3px;padding:1px 5px`;
    rep.textContent=`\u2605 ${smp.representative}`; card.appendChild(rep);
  }
  const play=()=>{ if(smp.audio) new Audio(smp.audio).play().catch(()=>{}); };
  const txtDiv=buildDetailHighlightedText(smp,null,c,play);
  txtDiv.style.fontSize='.9rem'; txtDiv.style.color='#c8d8e8'; card.appendChild(txtDiv);
  if (smp.phonemic) {
    const ph=document.createElement('div');
    ph.style.cssText='font-size:.62rem;color:#4a6888;font-style:italic;margin-top:2px';
    ph.textContent=smp.phonemic; card.appendChild(ph);
  }
  card.addEventListener('click',play); return card;
}

function renderDetail() {
  const sec=document.getElementById('detailSection'); if (!sec) return;
  sec.innerHTML='';
  const all=[];
  for (const [lk,lang] of Object.entries(LANGS))
    for (const v of (lang.vowels||[])) if (passesFilters(lk,v)) all.push({lk,lang,v});
  if (!all.length) { sec.innerHTML='<div class="detail-empty">No vowels match the current filters</div>'; return; }

  // Tab bar
  const tabBar=document.createElement('div'); tabBar.style.cssText='display:flex;gap:2px';
  const mkTab=(label,active)=>{
    const b=document.createElement('button'); b.type='button'; b.textContent=label;
    b.style.cssText=`padding:6px 18px;border-radius:8px 8px 0 0;font-size:.78rem;font-weight:700;cursor:pointer;border:1px solid var(--border,#2e4560);border-bottom:none;background:${active?'#253850':'var(--surface,#213040)'};color:${active?'#7eb8f7':'#6a8298'};transition:background .15s,color .15s`;
    return b;
  };
  const tabV=mkTab('\u25ce Vowels',true), tabS=mkTab('\u25b6 Samples',false);
  tabBar.appendChild(tabV); tabBar.appendChild(tabS); sec.appendChild(tabBar);

  const paneV=document.createElement('div');
  paneV.style.cssText='background:var(--surface,#213040);border:1px solid var(--border,#2e4560);border-radius:0 14px 14px 14px;padding:12px';
  const paneS=document.createElement('div');
  paneS.style.cssText='display:none;background:var(--surface,#213040);border:1px solid var(--border,#2e4560);border-radius:0 14px 14px 14px;padding:12px';

  tabV.addEventListener('click',()=>{
    tabV.style.background='#253850'; tabV.style.color='#7eb8f7';
    tabS.style.background='var(--surface,#213040)'; tabS.style.color='#6a8298';
    paneV.style.display=''; paneS.style.display='none';
  });
  tabS.addEventListener('click',()=>{
    tabS.style.background='#253850'; tabS.style.color='#7eb8f7';
    tabV.style.background='var(--surface,#213040)'; tabV.style.color='#6a8298';
    paneS.style.display=''; paneV.style.display='none';
  });

  // Vowel cards
  all.sort((a,b)=>{ const dh=a.v.heightBackness[0]-b.v.heightBackness[0]; return Math.abs(dh)>.001?dh:a.v.heightBackness[1]-b.v.heightBackness[1]; });
  const vGrid=document.createElement('div'); vGrid.className='detail-cards-row';
  for (const {lk,lang,v} of all) {
    const c=lang.color;
    const tPos=trapPos(v.heightBackness[0],v.heightBackness[1]);
    const fPos=v.f1&&v.f2?formantPos(v.f1,v.f2):null;
    const sym=v.symbols?.[0]??'?';
    const card=document.createElement('div'); card.className='dcard'; card.style.borderColor=c;

    const info=document.createElement('div');
    info.innerHTML=`
      <div class="dcard-ipa" style="color:${c}">${sym}</div>
      <div class="dcard-sublang" style="color:${c}bb">${lang.label}</div>
      <div class="dcard-desc">${v.desc||''}</div>
      <div class="dcard-round" style="color:${c}88">${v.rounded?'\u2299 Rounded':'\u25cb Unrounded'} \u00b7 ${getLength(v)}</div>
      ${v.f1?`<div class="dcard-formants">F1 <span>${v.f1}</span> \u00b7 F2 <span>${v.f2}</span> Hz</div>`:''}`;
    card.appendChild(info);

    // Linked samples
    const linked=(LANG_SAMPLES[lk]||[])
        .filter(smp=>smp.tokens?.some(t=>v.symbols?.includes(t.symbol)))
        .sort((a,b)=>(v.symbols?.includes(b.representative)?1:0)-(v.symbols?.includes(a.representative)?1:0));
    if (linked.length) {
      const strip=document.createElement('div');
      strip.style.cssText='margin-top:6px;padding-top:6px;border-top:1px solid #1e3048;display:flex;flex-direction:column;gap:3px';
      for (const smp of linked.slice(0,4)) {
        const chip=document.createElement('div');
        chip.style.cssText=`background:#0d1a28;border:1px solid #1e3048;border-radius:5px;padding:3px 7px;cursor:pointer`;
        chip.addEventListener('mouseenter',()=>chip.style.borderColor=c+'55');
        chip.addEventListener('mouseleave',()=>chip.style.borderColor='#1e3048');
        const play=()=>{ if(smp.audio) new Audio(smp.audio).play().catch(()=>{}); };
        chip.appendChild(buildDetailHighlightedText(smp,v.symbols,c,play));
        if (smp.phonemic) {
          const ph=document.createElement('div');
          ph.style.cssText='font-size:.58rem;color:#4a6888;font-style:italic';
          ph.textContent=smp.phonemic; chip.appendChild(ph);
        }
        chip.addEventListener('click',play); strip.appendChild(chip);
      }
      card.appendChild(strip);
    }

    const act=document.createElement('div'); act.className='dcard-actions';
    const playBtn=document.createElement('button'); playBtn.className='dcard-btn dcard-play'; playBtn.textContent='\u25b6 Sound';
    playBtn.addEventListener('click',()=>{ playVowel(v,'chartFormant',lk); pulse('chartIpa',tPos.x,tPos.y,c); if(fPos) pulse('chartFormant',fPos.x,fPos.y,c); });
    act.appendChild(playBtn);
    if (v.wikiUrl) {
      const wl=document.createElement('a'); wl.className='dcard-btn'; wl.href=v.wikiUrl; wl.target='_blank'; wl.rel='noopener'; wl.textContent='Wiki \u2197';
      act.appendChild(wl);
    }
    card.appendChild(act); vGrid.appendChild(card);
  }
  paneV.appendChild(vGrid);

  // Sample cards
  for (const [lk,lang] of Object.entries(LANGS)) {
    const samples=LANG_SAMPLES[lk]||[]; if (!samples.length) continue;
    const langSec=document.createElement('div'); langSec.style.cssText='margin-bottom:18px';
    const hdg=document.createElement('div');
    hdg.style.cssText=`font-size:.65rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:${lang.color};margin-bottom:8px`;
    hdg.textContent=lang.label; langSec.appendChild(hdg);
    const sGrid=document.createElement('div'); sGrid.className='detail-cards-row';
    for (const smp of samples) { if (smp.text) sGrid.appendChild(buildSampleDetailCard(smp,lang)); }
    langSec.appendChild(sGrid); paneS.appendChild(langSec);
  }

  sec.appendChild(paneV); sec.appendChild(paneS);
}