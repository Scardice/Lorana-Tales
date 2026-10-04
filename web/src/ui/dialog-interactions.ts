/** Shared keyboard and pointer behaviour for the editor's teleported dialogs. */
export function installDialogInteractions() {
  const selector='[role="dialog"],[role="alertdialog"],.performance-modal>form,.performance-modal>section,.character-modal>form,.settings-modal>section,.settings-modal>form,.message-edit-sheet';
  const focusable='button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href],[tabindex]:not([tabindex="-1"]),[contenteditable="true"]';
  const portals='.n-base-select-menu,.n-select-menu,.n-dropdown-menu,.n-date-panel,.n-popover';
  const visible=(node:HTMLElement)=>node.isConnected&&node.getClientRects().length>0&&getComputedStyle(node).visibility!=='hidden';
  function top(){return Array.from(document.querySelectorAll<HTMLElement>(selector)).filter(visible).map((node,index)=>{let z=0;for(let parent:HTMLElement|null=node;parent;parent=parent.parentElement)z=Math.max(z,Number.parseInt(getComputedStyle(parent).zIndex)||0);return{node,z,index}}).sort((a,b)=>a.z-b.z||a.index-b.index).at(-1)?.node;}
  let active:HTMLElement|undefined, frame=0, origin:HTMLElement|undefined;
  const previous=new WeakMap<HTMLElement,HTMLElement>();
  function refresh(){frame=0;const next=top();if(next===active)return;const old=active;active=next;if(next){if(!previous.has(next)){if(document.activeElement instanceof HTMLElement)previous.set(next,document.activeElement);if(!next.hasAttribute('tabindex'))next.tabIndex=-1;}if(!next.contains(document.activeElement)){const restore=old&&previous.get(old);(restore&&next.contains(restore)?restore:next.querySelector<HTMLElement>('[autofocus]')||next).focus({preventScroll:true});}}else if(old){const restore=previous.get(old);if(restore?.isConnected)restore.focus({preventScroll:true});}}
  function key(event:KeyboardEvent){const dialog=top();if(!dialog)return;if(event.target instanceof Element&&event.target.closest(portals))return;
    if(event.key==='Escape'){
      if(Array.from(document.querySelectorAll<HTMLElement>(portals)).some(visible))return;
      const close=dialog.querySelector<HTMLElement>('[aria-label^="关闭"],.modal-close,button[title="关闭"]')||Array.from(dialog.querySelectorAll<HTMLButtonElement>('button')).find(button=>/^(取消|返回选择|暂不|稍后)/.test(button.textContent?.trim()||''));
      if(close){event.preventDefault();event.stopImmediatePropagation();close.click();}return;
    }
    if(event.key!=='Tab')return;const controls=Array.from(dialog.querySelectorAll<HTMLElement>(focusable)).filter(visible);
    const first=controls[0],last=controls.at(-1),focused=document.activeElement;
    if(!first){event.preventDefault();dialog.focus();return;}
    if(event.shiftKey&&(!dialog.contains(focused)||focused===first||focused===dialog)){event.preventDefault();last?.focus();}
    else if(!event.shiftKey&&(!dialog.contains(focused)||focused===last||focused===dialog)){event.preventDefault();first.focus();}
  }
  function pointer(event:PointerEvent){const dialog=top();origin=dialog&&event.target instanceof Node&&dialog.contains(event.target)?dialog:undefined;}
  function click(event:MouseEvent){if(origin?.isConnected&&event.target instanceof Node&&!origin.contains(event.target)){event.stopImmediatePropagation();event.preventDefault();}origin=undefined;}
  function focus(event:FocusEvent){const dialog=top();if(!dialog||!(event.target instanceof Element)||dialog.contains(event.target)||event.target.closest(portals))return;dialog.focus({preventScroll:true});}
  const observer=new MutationObserver(records=>{if(frame)return;if(records.some(record=>[...Array.from(record.addedNodes),...Array.from(record.removedNodes)].some(node=>node instanceof Element&&(node.matches(selector)||node.querySelector(selector)))))frame=requestAnimationFrame(refresh);});
  observer.observe(document.body,{subtree:true,childList:true});
  document.addEventListener('keydown',key,true);document.addEventListener('pointerdown',pointer,true);document.addEventListener('click',click,true);document.addEventListener('focusin',focus,true);
  return()=>{observer.disconnect();cancelAnimationFrame(frame);document.removeEventListener('keydown',key,true);document.removeEventListener('pointerdown',pointer,true);document.removeEventListener('click',click,true);document.removeEventListener('focusin',focus,true);};
}
