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
    const ws=v.words||[];
    let wordsHtml='';
    if(ws.length){
      wordsHtml+='<div class="vc-words-label">Examples</div><div class="vc-words">';
      ws.forEach((w,wi)=>{const ha=!!w.audio;wordsHtml+=`<button class="vc-word ${ha?'has-audio':'no-audio'}" data-wi="${wi}" data-audio="${w.audio||''}">${ha?'<span class="pi">▶</span>':''}${w.text||''}</button>`;});
      wordsHtml+='</div>';
    }
    card.innerHTML=`
      <div class="vc-ipa" style="color:${c}">${v.ipa||'?'}</div>
      <div class="vc-desc">${v.desc||''}</div>
      <div class="vc-round" style="color:${c}70">${v.rounded?'⊙ Rounded':'○ Unrounded'} · ${v.type||'short'}</div>
      ${v.f1?`<div class="vc-formants">F1 <span>${v.f1}</span> · F2 <span>${v.f2}</span> Hz</div>`:''}
      ${wordsHtml}
      <div class="vc-actions">
        <button class="vc-btn vc-play">▶ Sound</button>
        <button class="vc-btn" data-i="${i}" data-action="edit">✎ Edit</button>
        <button class="vc-btn del" data-i="${i}" data-action="del">✕</button>
      </div>`;
    card.querySelectorAll('.vc-word.has-audio').forEach(btn=>btn.addEventListener('click',e=>{e.stopPropagation();playUrl(btn.dataset.audio);}));
    card.querySelector('.vc-play').addEventListener('click',e=>{e.stopPropagation();playUrl(v.ipaAudio);});
    card.querySelectorAll('.vc-btn[data-action]').forEach(btn=>{
      btn.addEventListener('click',e=>{
        e.stopPropagation();
        const idx=+btn.dataset.i;
        if(btn.dataset.action==='edit')openVowelEditor(idx);
        else if(btn.dataset.action==='del'&&confirm(`Delete vowel "${v.ipa}"?`)){
          state.langDraft.vowels.splice(idx,1);
          if(state.vowelIdx===idx)closeVowelEditor();
          else if(state.vowelIdx>idx)state.vowelIdx--;
          markUnsaved(); renderVowelCards(); refreshCharts(); updateSectionTitle();
        }
      });
    });
    card.addEventListener('click',()=>openVowelEditor(i));
    grid.appendChild(card);
  });
}

function updateSectionTitle(){const el=document.getElementById('sectionTitle');if(el)el.textContent=`Vowels (${(state.langDraft?.vowels||[]).length})`;}
function markUnsaved(){state.unsaved=true;const n=document.getElementById('unsavedNote');if(n)n.style.display='inline';}
