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

    // ── Linked samples ──────────────────────────────────────────────────
    const linked = (state.samplesDraft||[]).filter(s =>
        s.tokens?.some(t => v.symbols?.includes(t.symbol))
    );
    if (linked.length) {
      const sampDiv = document.createElement('div');
      sampDiv.style.cssText = 'border-top:1px solid var(--border);margin-top:6px;padding-top:6px;display:grid;grid-template-columns:1fr 1fr;gap:4px';
      const shown = linked.slice(0, 6);
      shown.forEach(smp => {
        const chip = document.createElement('div');
        chip.style.cssText = `background:#0d1a28;border:1px solid #1e3048;border-radius:6px;padding:5px 7px;cursor:pointer;transition:border-color .12s,background .12s`;
        chip.addEventListener('mouseenter', ()=>{ chip.style.borderColor=c+'55'; chip.style.background='#111e2e'; });
        chip.addEventListener('mouseleave', ()=>{ chip.style.borderColor='#1e3048'; chip.style.background='#0d1a28'; });

        // Rich text: relevant vowel tokens highlighted, click-to-play
        // Use indexOf: smp is a direct reference to state.samplesDraft element
        // (findIndex with id comparison fails when id is undefined for all samples)
        const smpIdx = state.samplesDraft.indexOf(smp);
        const textDiv = buildHighlightedText(smp, v.symbols, c, {
          textStyle: 'font-size:.82rem;color:#c8d8e8;',
          onFullPlay:  () => localPlay(smp.audio),
          onTokenPlay: tok => playTokenSlice(smp, tok),
        });
        chip.appendChild(textDiv);

        // Chip click: open inline editor (text spans handle audio + stopPropagation)
        chip.addEventListener('click', e => {
          e.stopPropagation();  // prevent vowel card's own click firing
          // Play full audio (text spans handle their own audio + stopPropagation,
          // so this only runs when user clicks on chip padding)
          localPlay(smp.audio);
          // Switch vowel editor to THIS vowel, then open sample inline.
          // openVowelEditor(i) rebuilds veInline (which includes seVowelInline).
          openVowelEditor(i);
          if (smpIdx >= 0) openSampleInVowelEditor(smpIdx);
        });
        sampDiv.appendChild(chip);
      });
      if (linked.length > 6) {
        const more = document.createElement('div');
        more.style.cssText = 'font-size:.6rem;color:#3a5878;grid-column:span 2;text-align:center';
        more.textContent = `+${linked.length-6} more samples`;
        sampDiv.appendChild(more);
      }
      card.appendChild(sampDiv);
    }

    // Card click: play representative sample or vowel audio, open editor
    card.addEventListener('click', () => {
      const rep = (state.samplesDraft||[]).find(s => v.symbols?.includes(s.representative));
      localPlay(rep?.audio || v.audio || null);
      openVowelEditor(i);
    });
    grid.appendChild(card);
  });
}

function updateSectionTitle(){const el=document.getElementById('sectionTitle');if(el)el.textContent=`Vowels (${(state.langDraft?.vowels||[]).length})`;}
function markUnsaved(){state.unsaved=true;const n=document.getElementById('unsavedNote');if(n)n.style.display='inline';}