/**
 * editor-vowels.js — Vowel card rendering for the editor overview panel.
 *
 * renderVowelCards() builds the horizontal strip of vowel cards shown
 * below the editor charts. Each card shows the IPA symbol, description,
 * rounded/type info, formant values, example word chips (with audio), and
 * Edit/Delete action buttons.
 *
 * Cards are rebuilt whenever:
 *   - a vowel is applied or deleted
 *   - the active vowel index changes (to update the highlighted card)
 *   - any draft field changes that affects the card display
 *
 * Also exports updateSectionTitle() and markUnsaved() as small state helpers
 * used by the editor's vowel lifecycle functions.
 *
 * Dependencies: editor.html globals (state, openVowelEditor, closeVowelEditor,
 *   renderLangIpa, renderLangFormant)
 */

// ─── Vowel cards ─────────────────────────────────────────────────────────────
function renderVowelCards(){
  const grid=document.getElementById('vowelCards');
  if(!grid)return;
  grid.innerHTML='';
  const c=state.langDraft?.color||'#7eb8f7';
  let curAudio=null;
  function playUrl(url){if(!url)return;if(curAudio){curAudio.pause();curAudio.currentTime=0;}curAudio=new Audio(url);curAudio.play().catch(()=>{});}

  (state.langDraft.vowels||[]).forEach((v,i)=>{
    const isActive=state.vowelIdx===i;
    const card=document.createElement('div');
    card.className='vowel-card'+(isActive?' active':'');
    card.style.borderColor=isActive?c:'';

    // Delete button — top-right corner
    const delBtn=document.createElement('button');
    delBtn.className='vc-del-btn'; delBtn.title='Delete vowel'; delBtn.textContent='✕';
    delBtn.addEventListener('click',e=>{
      e.stopPropagation();
      if(!confirm(`Delete vowel "${v.ipa}"?`))return;
      state.langDraft.vowels.splice(i,1);
      if(state.vowelIdx===i)closeVowelEditor();
      else if(state.vowelIdx>i)state.vowelIdx--;
      markUnsaved(); renderVowelCards(); refreshCharts(); updateSectionTitle();
    });
    card.appendChild(delBtn);

    // Word chips
    const ws=v.words||[];
    let wordsHtml='';
    if(ws.length){
      wordsHtml+='<div class="vc-words-label">Examples</div><div class="vc-words">';
      ws.forEach((w,wi)=>{const ha=!!w.audio;wordsHtml+=`<button class="vc-word ${ha?'has-audio':'no-audio'}" data-wi="${wi}" data-audio="${w.audio||''}">${ha?'<span class="pi">▶</span>':''}${w.text||''}</button>`;});
      wordsHtml+='</div>';
    }

    const body=document.createElement('div');
    body.innerHTML=`
      <div class="vc-ipa" style="color:${c}">${v.ipa||'?'}</div>
      <div class="vc-desc">${v.desc||''}</div>
      <div class="vc-round" style="color:${c}70">${v.rounded?'⊙ Rounded':'○ Unrounded'} · ${v.type||'short'}</div>
      ${v.f1?`<div class="vc-formants">F1 <span>${v.f1}</span> · F2 <span>${v.f2}</span> Hz</div>`:''}
      ${wordsHtml}`;
    card.appendChild(body);

    // Word chip audio playback (stop propagation so card click doesn't also open editor)
    card.querySelectorAll('.vc-word.has-audio').forEach(btn=>btn.addEventListener('click',e=>{e.stopPropagation();playUrl(btn.dataset.audio);}));

    // Click card: play sound + open editor
    card.addEventListener('click',()=>{
      playUrl(v.ipaAudio);
      openVowelEditor(i);
    });

    grid.appendChild(card);
  });
}

function updateSectionTitle(){const el=document.getElementById('sectionTitle');if(el)el.textContent=`Vowels (${(state.langDraft?.vowels||[]).length})`;}
function markUnsaved(){state.unsaved=true;const n=document.getElementById('unsavedNote');if(n)n.style.display='inline';}