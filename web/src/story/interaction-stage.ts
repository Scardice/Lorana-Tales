export interface InteractionVisual {
  effect:string;reaction:string;emoji?:string;color:string;duration:number;avatarSize?:number;
  sourceName:string;sourceAvatar?:string;targetName?:string;targetAvatar?:string;reverse?:boolean;sprite?:string;labels?:boolean;
}

/** Identical DOM for the picker, SSP player and offline HTML; no Vue/browser closure dependencies. */
export function interactionMarkup(value:InteractionVisual):string {
  const escape=(input:unknown)=>String(input??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));
  const effect=/^(throw|heart|magic|magic-circle|surprise|impact|bullet|blade)$/.test(value.effect)?value.effect:'none';
  const reaction=/^(none|bounce|stagger|faint|shatter|gray|affection)$/.test(value.reaction)?value.reaction:'none';
  const color=/^#[a-f\d]{3,8}$/i.test(value.color)?value.color:'#6bcfc6',size=Math.max(20,Math.min(120,value.avatarSize||42));
  const avatar=(name:string,url?:string)=>'<span class="lt-avatar">'+(url?'<img src="'+escape(url)+'" alt="" />':'<i>'+escape(name.slice(0,1))+'</i>')+'</span>'+(value.labels?'<small>'+escape(name)+'</small>':'');
  const actor=(kind:string,name:string,url?:string)=>'<span class="lt-interaction-character lt-interaction-character--'+kind+'">'+avatar(name,url)+'</span>';
  const builtIn=effect==='heart'?'<span class="lt-interaction-heart-particles">♥</span>':effect==='surprise'?'<span class="lt-interaction-surprise-mark">!</span>':effect==='impact'?'<span class="lt-interaction-impact-burst"></span>':effect==='bullet'?'<span class="lt-interaction-bullet-core"></span>':effect==='magic'?'<span class="lt-interaction-magic-orb"></span>':effect==='throw'?'🪨':'<span class="lt-interaction-projectile__sprite"></span>';
  const magic=!value.emoji&&(effect==='magic'||effect==='magic-circle')?'<span class="lt-interaction-magic-array"><i></i><i></i><i></i></span>':'';
  const projectile=effect==='none'||effect==='magic-circle'?'':'<span class="lt-interaction-projectile'+(value.emoji?' lt-interaction-projectile--custom':'')+'">'+(value.emoji?escape(value.emoji):builtIn)+'</span>';
  return '<div class="lt-interaction-host"><div class="lt-interaction-scene lt-interaction-scene--'+effect+' lt-interaction-scene--reaction-'+reaction+(value.reverse?' lt-interaction-scene--reverse':'')+(!value.targetName?' lt-interaction-scene--source-only':'')+'" style="--interaction-color:'+color+';--interaction-duration:'+Math.max(120,value.duration)+'ms;--avatar-size:'+size+'px;--avatar-half-size:'+(size/2)+'px;--interaction-sprite:url(&quot;'+escape(value.sprite||'')+'&quot;)">'+actor('source',value.sourceName,value.sourceAvatar)+magic+projectile+(value.targetName?actor('target',value.targetName,value.targetAvatar):'')+'</div></div>';
}
