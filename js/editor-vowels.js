/**
 * editor-vowels.js — Vowel card rendering for the editor overview panel.
 *
 * Cards support drag-to-reorder (which changes the order in state.langDraft.vowels
 * and therefore in the saved JSON). Clicking a card plays its sound and opens
 * the vowel editor. Delete button is positioned absolutely at top-right.
 *
 * Dependencies: editor.html globals (state, openVowelEditor, closeVowelEditor,
 *   refreshCharts, markUnsaved)
 */

// ─── Vowel cards ─────────────────────────────────────────────────────────────
function renderVowelCards(){
  const grid=document.getElementById('vowelCards');
  if(!grid)return;
  grid.innerHTML='';
  const c=state.langDraft?.color||'#7eb8f7';
  let curAudio=null;
  let dragSrcIdx=null;
  function localPlay(url){if(!url)return;if(curAudio){curAudio.pause();curAudio.currentTime=0;}curAudio=new Audio(url);curAudio.play().catch(()=>{});}

  (state.langDraft.vowels||[]).forEach((v,i)=>{
    const isActive=state.vowelIdx===i;
    const card=document.createElement('div');
    card.className='vowel-card'+(isActive?' active':'');
    card.style.borderColor=isActive?c:'';
    card.draggable=true;

    // Drag-to-reorder
    card.addEventListener('dragstart',e=>{dragSrcIdx=i;card.classList.add('dragging');e.dataTransfer.effectAllowed='move';});
    card.addEventListener('dragend',()=>{card.classList.remove('dragging');grid.querySelectorAll('.vowel-card').forEach(el=>el.classList.remove('drag-over'));});
    card.addEventListener('dragover',e=>{e.preventDefault();e.dataTransfer.dropEffect='move';grid.querySelectorAll('.vowel-card').forEach(el=>el.classList.remove('drag-over'));if(i!==dragSrcIdx)card.classList.add('drag-over');});
    card.addEventListener('drop',e=>{
      e.preventDefault();
      if(dragSrcIdx===null||dragSrcIdx===i)return;
      const[moved]=state.langDraft.vowels.splice(dragSrcIdx,1);
      state.langDraft.vowels.splice(i,0,moved);
      if(state.vowelIdx===dragSrcIdx) state.vowelIdx=i;
      else if(state.vowelIdx>dragSrcIdx&&state.vowelIdx<=i) state.vowelIdx--;
      else if(state.vowelIdx<dragSrcIdx&&state.vowelIdx>=i) state.vowelIdx++;
      markUnsaved(); renderVowelCards(); refreshCharts();
    });

    // Delete button (top-right)
    const delBtn=document.createElement('button');
    delBtn.className='vc-del-btn'; delBtn.title='Delete vowel'; delBtn.textContent='\u2715';
    delBtn.addEventListener('click',e=>{
      e.stopPropagation();
      if(!confirm(`Delete vowel "${v.symbols?.[0]}"?`))return;
      state.langDraft.vowels.splice(i,1);
      if(state.vowelIdx===i)closeVowelEditor();
      else if(state.vowelIdx>i)state.vowelIdx--;
      markUnsaved(); renderVowelCards(); refreshCharts(); updateSectionTitle();
    });
    card.appendChild(delBtn);

    // Card body
    const sym=v.symbols?.[0]||'?';
    const body=document.createElement('div');
    body.innerHTML=`
      <div class="vc-ipa" style="color:${c}">${sym}</div>
      <div class="vc-desc">${v.desc||''}</div>
      <div class="vc-round" style="color:${c}70">${v.rounded?'\u2299 Rounded':'\u25cb Unrounded'} \u00b7 ${v.type||'short'}</div>
      ${v.f1?`<div class="vc-formants">F1 <span>${v.f1}</span> \u00b7 F2 <span>${v.f2}</span> Hz</div>`:''}`;
    card.appendChild(body);

    // ── Linked samples strip — same look/interaction as the public viewer's
    // vowel-detail cards (js/charts.js's renderDetail/buildDetailHighlightedText):
    // token-highlighted sample text, hover darken, click-to-play-slice. Built
    // from the DB relationship (Phase 5d) instead of charts.js's own
    // LANG_SAMPLES/symbol-matching, via a pseudo-sample adapter so the exact
    // same shared function can be reused untouched. ─────────────────────────
    const dbVowelId = state.dbVowelLinks?.[i]?.id;
    const myTokens = dbVowelId != null ? (state.dbLanguageTokens || []).filter(t => t.vowelId === dbVowelId) : [];
    const repSampleId = state.dbVowelLinks?.[i]?.representativeSampleId;
    const bySample = new Map();
    myTokens.forEach(t => {
      if (!bySample.has(t.sampleId)) {
        const smpMeta = (state.dbLanguageSamples || []).find(s => s.id === t.sampleId);
        bySample.set(t.sampleId, {
          text: t.sampleText, audio: smpMeta?.audioUrl,
          representative: t.sampleId === repSampleId ? sym : null,
          tokens: [],
        });
      }
      bySample.get(t.sampleId).tokens.push({
        symbol: t.symbol, position: [t.charStart ?? 0, t.charEnd ?? 0],
        analysis: (t.timeStartMs != null && t.timeEndMs != null) ? { slice: [t.timeStartMs, t.timeEndMs] } : null,
      });
    });
    const linked = Array.from(bySample.values())
      .sort((a, b) => (b.representative ? 1 : 0) - (a.representative ? 1 : 0));
    if (linked.length && typeof buildDetailHighlightedText === 'function') {
      const strip = document.createElement('div');
      strip.style.cssText = 'margin-top:6px;padding-top:6px;border-top:1px solid #1e3048;display:flex;flex-direction:column;gap:3px';
      for (const smp of linked.slice(0, 4)) {
        const chip = document.createElement('div');
        chip.style.cssText = `background:#0d1a28;border:1px solid #1e3048;border-radius:5px;padding:3px 7px;cursor:pointer`;
        chip.addEventListener('mouseenter', () => chip.style.borderColor = c + '55');
        chip.addEventListener('mouseleave', () => chip.style.borderColor = '#1e3048');
        const play = () => { if (smp.audio) new Audio(smp.audio).play().catch(() => {}); };
        chip.appendChild(buildDetailHighlightedText(smp, v.symbols, c, play));
        chip.addEventListener('click', e => { e.stopPropagation(); play(); });
        strip.appendChild(chip);
      }
      if (linked.length > 4) {
        const more = document.createElement('div');
        more.style.cssText = 'font-size:.6rem;color:#3a5878;text-align:center';
        more.textContent = `+${linked.length - 4} more`;
        strip.appendChild(more);
      }
      card.appendChild(strip);
    }

    // Card click: play the DB-assigned representative (or vowel's own inline
    // audio as fallback — see playVowel, js/audio.js), open editor. The
    // Tokens/Representative pickers live in the full edit form now (Phase 5d).
    card.addEventListener('click', () => {
      playVowel(v, null, state.selKey);
      openVowelEditor(i);
    });
    grid.appendChild(card);
  });
}

function updateSectionTitle(){const el=document.getElementById('sectionTitle');if(el)el.textContent=`Vowels (${(state.langDraft?.vowels||[]).length})`;}
function markUnsaved(){state.unsaved=true;const n=document.getElementById('unsavedNote');if(n)n.style.display='inline';}