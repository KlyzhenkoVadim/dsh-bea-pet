/* Bea companion UI. All pet assets and requests stay on the Harness origin. */
window.__ModuleLoader__.load({id:'bea-harness-pet',factory:() => ({apply(ctx){
  ctx.effect(() => {
    const root=document.createElement('div');root.id='bea-harness-companion';
    root.innerHTML=`<style>
#bea-harness-companion{position:fixed;right:26px;bottom:24px;z-index:10000;font:13px system-ui,sans-serif;color:#322648;pointer-events:none;user-select:none}
#bea-harness-companion button,#bea-harness-companion select{font:inherit;color:inherit;cursor:pointer}
#bea-harness-companion .bea-art{display:block;border:0;padding:0;background-color:transparent;background-repeat:no-repeat;pointer-events:auto;touch-action:none;cursor:grab;filter:drop-shadow(0 5px 4px #28104324)}
#bea-harness-companion .bea-bar{display:flex;align-items:center;justify-content:center;gap:6px;margin-top:-10px;pointer-events:auto}
#bea-harness-companion .bea-label{padding:5px 10px;border-radius:20px;background:#fcf9ffed;box-shadow:0 2px 9px #35205a16;font-size:12px}
#bea-harness-companion .bea-gear{border:0;border-radius:50%;background:#fcf9ffed;width:27px;height:27px;opacity:0;transition:opacity .15s}
#bea-harness-companion:hover .bea-gear,#bea-harness-companion:focus-within .bea-gear{opacity:1}
#bea-harness-companion .bea-panel{position:absolute;bottom:34px;right:0;width:220px;padding:15px;border-radius:16px;background:#fff;box-shadow:0 4px 30px #27134326;pointer-events:auto;display:none}
#bea-harness-companion .bea-panel[data-open=true]{display:grid;gap:12px}
#bea-harness-companion .bea-panel label{display:grid;gap:6px}
#bea-harness-companion .bea-panel select{border:1px solid #e2dce9;border-radius:8px;padding:7px;background:#faf8fc}
#bea-harness-companion .bea-panel button{border:0;border-radius:8px;padding:8px;background:#eee5fb}
#bea-harness-companion .bea-note{color:#82748c;font-size:11px;line-height:1.4}
</style><button class="bea-art" aria-label="Беа — питомец Harness" title="Нажми для прыжка. Перетащи, чтобы переместить."></button><div class="bea-bar"><span class="bea-label">Беа</span><button class="bea-gear" aria-label="Настройки Беа" title="Настройки Беа">⚙</button></div><div class="bea-panel"><strong>Беа с пчелой</strong><label>Размер<select class="bea-size"><option value="144">Маленькая</option><option value="192">Средняя</option><option value="224">Большая</option></select></label><label>Анимация<select class="bea-mode"><option value="auto">По состоянию Harness</option><option value="idle">Ожидание</option><option value="running-right">Ходьба вправо</option><option value="running-left">Ходьба влево</option><option value="waving">Радость</option><option value="jumping">Прыжок</option><option value="running">Работа</option><option value="waiting">Ждёт ответа</option><option value="failed">Расстроена</option><option value="review">Осматривается</option></select></label><button class="bea-tuck">Свернуть питомца</button><span class="bea-note">Нажми на Беа для прыжка.<br>Её можно перетаскивать.</span></div>`;
    document.body.append(root);
    const art=root.querySelector('.bea-art'),label=root.querySelector('.bea-label'),panel=root.querySelector('.bea-panel'),mode=root.querySelector('.bea-mode'),size=root.querySelector('.bea-size'),tuck=root.querySelector('.bea-tuck');
    const defaults={'idle':'Готова','running':'Думает','waiting':'Ждёт ответа','failed':'Ошибка','review':'Осматривается','waving':'Готово!','jumping':'Беа','running-right':'Беа','running-left':'Беа'};
    let current=null,pet=null,state='idle',stateStart=performance.now(),raf=0,alive=true,clickUntil=0,lastEvent='',happyUntil=0;
    let pos=null;try{pos=JSON.parse(localStorage.getItem('bea-pet-position'));}catch{}
    const place=(x,y)=>{root.style.left=Math.max(0,Math.min(innerWidth-root.offsetWidth,x))+'px';root.style.top=Math.max(0,Math.min(innerHeight-root.offsetHeight,y))+'px';root.style.right='auto';root.style.bottom='auto';};
    if(pos&&Number.isFinite(pos.x)&&Number.isFinite(pos.y))place(pos.x,pos.y);
    let drag=null;
    art.addEventListener('pointerdown',e=>{if(e.button!==0)return;const b=root.getBoundingClientRect();drag={x:e.clientX,y:e.clientY,left:b.left,top:b.top,moved:false};art.setPointerCapture(e.pointerId);art.style.cursor='grabbing';});
    art.addEventListener('pointermove',e=>{if(!drag)return;const dx=e.clientX-drag.x,dy=e.clientY-drag.y;if(Math.abs(dx)+Math.abs(dy)>5)drag.moved=true;if(drag.moved)place(drag.left+dx,drag.top+dy);});
    art.addEventListener('pointerup',()=>{if(drag?.moved){const b=root.getBoundingClientRect();try{localStorage.setItem('bea-pet-position',JSON.stringify({x:b.left,y:b.top}));}catch{}}else{clickUntil=performance.now()+2200;}drag=null;art.style.cursor='grab';});
    art.addEventListener('pointercancel',()=>{drag=null;art.style.cursor='grab';});
    root.querySelector('.bea-gear').onclick=()=>{panel.dataset.open=panel.dataset.open==='true'?'false':'true';};
    const action=async body=>{const res=await fetch('/__dsh/pet/api/action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});if(!res.ok)throw new Error('Не удалось сохранить настройку');const value=await res.json();if(value.ok)accept(value.value);};
    size.onchange=()=>{action({operation:'set-size',sizePx:Number(size.value)}).catch(e=>{label.textContent=e.message;});};
    tuck.onclick=()=>{action({operation:'set-awake',awake:!current?.preference.awake}).catch(e=>{label.textContent=e.message;});};
    function accept(snapshot){
      current=snapshot;pet=snapshot.catalog.pets.find(p=>p.id===snapshot.preference.selectedPetId)||snapshot.catalog.pets[0];
      if(!pet)return;
      const px=snapshot.preference.sizePx,ratio=px/pet.frame.height;
      art.style.width=pet.frame.width*ratio+'px';art.style.height=px+'px';art.style.backgroundImage=`url("${pet.assetUrl}")`;art.style.backgroundSize=pet.frame.columns*pet.frame.width*ratio+'px '+pet.frame.rows*pet.frame.height*ratio+'px';
      art.style.display=snapshot.preference.awake?'block':'none';tuck.textContent=snapshot.preference.awake?'Свернуть питомца':'Разбудить питомца';size.value=String(px);
      const a=snapshot.selectedActivity,key=a?`${a.sessionId}:${a.since}:${a.status}`:'';
      if(key!==lastEvent){if(a?.completed)happyUntil=performance.now()+3200;lastEvent=key;}
    }
    async function refresh(){try{const res=await fetch('/__dsh/pet/api/snapshot',{cache:'no-store'});if(!res.ok)throw new Error();const data=await res.json();if(alive&&data.ok)accept(data.value);}catch{if(alive)label.textContent='Переподключение…';}}
    function draw(now){
      if(!alive)return;
      if(pet&&current){
        const a=current.selectedActivity;
        let next=mode.value;
        if(next==='auto')next=clickUntil>now?'jumping':happyUntil>now?'waving':a?.pendingInteraction?'waiting':a?.status==='blocked'?'failed':a?.status==='running'?'running':'idle';
        if(next!==state){state=next;stateStart=now;}
        let track=pet.animations[state]||pet.animations.idle,elapsed=now-stateStart;
        let durations=track.frames.map(f=>f.durationMs),total=durations.reduce((a,b)=>a+b,0);
        if(track.loopStart!==null)elapsed%=total;else if(elapsed>=total){track=pet.animations.idle;total=track.frames.reduce((s,f)=>s+f.durationMs,0);elapsed%=total;}
        let f=track.frames[0];for(const candidate of track.frames){f=candidate;if(elapsed<candidate.durationMs)break;elapsed-=candidate.durationMs;}
        const ratio=current.preference.sizePx/pet.frame.height;
        art.style.backgroundPosition=-(f.spriteIndex%pet.frame.columns)*pet.frame.width*ratio+'px '+(-Math.floor(f.spriteIndex/pet.frame.columns)*pet.frame.height*ratio)+'px';
        label.textContent=current.preference.awake?(defaults[state]||'Беа'):'Беа спит';
      }
      raf=requestAnimationFrame(draw);
    }
    refresh();const timer=setInterval(refresh,800);raf=requestAnimationFrame(draw);
    return()=>{alive=false;clearInterval(timer);cancelAnimationFrame(raf);root.remove();};
  },'Bea pet companion');
}})});
