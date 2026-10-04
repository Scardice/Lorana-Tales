import { expect, test, type Page } from '@playwright/test';
import { reactive } from 'vue';
import { storyFromLogItems } from '../../web/src/story/model';
import { createStoryPackage, readStoryPackage } from '../../web/src/story/package';
import { createPerformanceHtml } from '../../web/src/story/standalone-performance';
import { editStoryArchive } from '../../web/src/story/edit-archive';
import type { StoryArchive } from '../../web/src/story/types';

function archive(title='回归故事', count=2):StoryArchive {
  const document=storyFromLogItems([],[],{title});
  document.characters.push({id:'alice',name:'阿洛',imUserId:'',position:'left',color:'#167478',isNarrator:false,isDice:false,hidden:false});
  document.messages=Array.from({length:count},(_,i)=>({id:'message-'+i,kind:'text',characterId:'alice',time:0,text:'这是一条需要慢慢播放的长消息。我们检查暂停以后能否继续显示文字，以及所有叠加特效是否完整保留。第'+i+'条。'}));
  Object.assign(document.settings,{theme:'light',autoplay:true,playbackTiming:'fixed',fixedDelayMs:5000,streamEnabled:true,streamTokensPerSecond:4,streamSpeedJitterPercent:0,streamPauseMinMs:0,streamPauseMaxMs:0,typingIndicatorEnabled:false});
  return {document,assets:new Map()};
}
const packed=async(value:StoryArchive)=>Buffer.from(await(await createStoryPackage(value)).arrayBuffer());
async function open(page:Page){await page.addInitScript(()=>{document.cookie='lorana_tutorial_prompt_seen=1; Path=/; Max-Age=31536000';document.cookie='lorana_tutorial_playback_coach_seen=1; Path=/; Max-Age=31536000';});await page.goto('/story',{waitUntil:'networkidle'});}
async function load(page:Page,value:StoryArchive){await page.locator('.story-page > input[type=file]').setInputFiles({name:'test.ssp',mimeType:'application/vnd.lorana-tales.story+zip',buffer:await packed(value)});await expect(page.locator('.story-title strong')).toHaveText(value.document.title);}

test('cloud revision binding is discarded when a different or same-ID local SSP replaces the document',async({page})=>{
  const a=archive('云端 A'),b=archive('本地 B'); b.document.id=a.document.id;
  const writes:Array<{method:string;path:string;title:string}>=[];
  await page.route('**/api/account/config',r=>r.fulfill({json:{enabled:true,registrationEnabled:true,captchaProvider:'image'}}));
  await page.route('**/api/account/me',r=>r.fulfill({json:{authenticated:true,user:{id:'audit',username:'audit',nickname:'回归账号',email:'a@example.test',group:'default',role:'user'},storage:{quotaBytes:10000000,usedBytes:0,projectCount:1,maxProjects:100,retentionDays:180}}}));
  await page.route(/\/api\/account\/projects(?:\/[^/?]+)?(?:\?.*)?$/,async r=>{
    const request=r.request();
    if(request.method()==='GET'){
      if(request.url().endsWith('/cloud-a'))return r.fulfill({contentType:'application/vnd.lorana-tales.story+zip',headers:{'x-lorana-project-meta':Buffer.from(JSON.stringify({id:'cloud-a',revision:7})).toString('base64url')},body:await packed(a)});
      return r.fulfill({json:[{id:'cloud-a',title:'云端 A',revision:7,updatedAt:new Date().toISOString()}]});
    }
    const uploaded=await readStoryPackage(new Uint8Array(request.postDataBuffer()!));
    writes.push({method:request.method(),path:new URL(request.url()).pathname,title:uploaded.document.title});
    return r.fulfill({json:{id:'cloud-b',revision:1}});
  });
  await open(page);await page.locator('.account-trigger').click();await page.getByRole('button',{name:'打开',exact:true}).click();
  await expect(page.locator('.story-title strong')).toHaveText('云端 A');await load(page,b);
  await page.locator('.account-trigger').click();await expect(page.locator('.document-toolbar .primary')).toHaveText('保存当前文档');await page.locator('.document-toolbar .primary').click();
  await expect.poll(()=>writes).toEqual([{method:'POST',path:'/api/account/projects',title:'本地 B'}]);
});

test('batch SSP insertion completes and selects the imported messages',async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await open(page);await load(page,archive());
  await page.locator('article.story-message').first().getByRole('button',{name:'消息操作'}).click();await page.getByRole('menuitem',{name:'多插'}).click();
  const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'插入文件',exact:true}).click();await(await chooser).setFiles({name:'insert.ssp',mimeType:'application/vnd.lorana-tales.story+zip',buffer:await packed(archive('插入片段'))});
  await page.getByRole('button',{name:'插入并选中'}).click();await expect(page.locator('.batch-import-modal')).toBeHidden();await expect(page.locator('article.story-message')).toHaveCount(4);
  await expect(page.locator('.composer-reply')).toContainText('2');expect(errors).toEqual([]);
});

test('pause freezes streaming and independent effect layers, then resumes without completing the text',async({page})=>{
  const value=archive();value.document.messages[0].performance={effects:[{id:'fx-a',delayMs:0,screen:{effect:'damage',durationMs:5000}},{id:'fx-b',delayMs:200,screen:{effect:'flash',durationMs:5000}}]};
  await open(page);await load(page,value);await page.getByRole('button',{name:'演出编辑',exact:true}).click();await page.getByRole('button',{name:'开始演出',exact:true}).click();
  await expect(page.locator('.effect-screen-layer')).toHaveCount(2);await page.getByRole('button',{name:'暂停演出',exact:true}).click();
  const message=page.locator('article.player-message').first(),before=await message.innerText();await page.waitForTimeout(450);
  expect(await message.innerText()).toBe(before);await expect(page.locator('.effect-screen-layer')).toHaveCount(2);
  await page.getByRole('button',{name:'继续演出',exact:true}).click();await page.waitForTimeout(350);
  const after=await message.innerText();expect(after.length).toBeGreaterThan(before.length);expect(after.length).toBeLessThan(value.document.messages[0].kind==='text'?value.document.messages[0].text.length:0);
  await expect(page.locator('.effect-screen-layer')).toHaveCount(2);
});

test('offline autoplay advances once on next and weather scripts execute in player scope',async({page})=>{
  const value=archive('离线回归',8);Object.assign(value.document.settings,{streamEnabled:false,fixedDelayMs:3000});
  value.document.effectTracks=[{id:'rain',effect:'storm',startMessageId:'message-0',endMessageId:'message-7'},{id:'snow',effect:'snowfall',startMessageId:'message-0',endMessageId:'message-7'}];
  const html=await createPerformanceHtml(value,async()=>'',async()=>'');const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/offline-regression.html',r=>r.fulfill({contentType:'text/html',body:html}));await page.goto('/offline-regression.html');await page.locator('#start-button').click();await page.locator('#coach').click();
  await expect(page.locator('#counter')).toHaveText('1 / 8');await page.locator('#next').click();await page.waitForTimeout(400);await expect(page.locator('#counter')).toHaveText('2 / 8');
  await expect(page.locator('#persistent .persistent-weather-layer')).toHaveCount(2);await expect(page.locator('#persistent i')).toHaveCount(72);
  const particle=page.locator('#persistent i').first(),before=await particle.evaluate(el=>getComputedStyle(el).transform);await page.waitForTimeout(150);expect(await particle.evaluate(el=>getComputedStyle(el).transform)).not.toBe(before);expect(errors).toEqual([]);
});

test('same resource ID in a replacement archive shows the new image',async({page})=>{
  const fixture=(color:string)=>{const value=archive(color);value.document.characters[1].avatar={id:'same',mime:'image/svg+xml'};value.assets.set('same',new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="${color}"/></svg>`));return value};
  await open(page);await load(page,fixture('red'));const source=await page.locator('article.story-message img').first().getAttribute('src');await load(page,fixture('blue'));expect(await page.locator('article.story-message img').first().getAttribute('src')).not.toBe(source);
  const pixel=await page.locator('article.story-message img').first().evaluate(async(node)=>{const image=node as HTMLImageElement;await image.decode();const canvas=document.createElement('canvas');canvas.width=40;canvas.height=40;const ctx=canvas.getContext('2d')!;ctx.drawImage(image,0,0);return Array.from(ctx.getImageData(20,20,1,1).data)});expect(pixel).toEqual([0,0,255,255]);
});

test('mobile interaction picker has one collapsible preview and traps keyboard focus',async({page})=>{
  await page.setViewportSize({width:390,height:844});await open(page);await load(page,archive());await page.getByRole('button',{name:'演出编辑',exact:true}).click();await page.getByRole('banner').getByRole('button',{name:'演出编辑',exact:true}).click();await page.locator('article.player-message').first().click();
  const form=page.locator('.performance-modal').first();await form.getByRole('button',{name:'添加一段'}).click();await expect(page.getByLabel('特效时间轴')).toBeVisible();await form.getByRole('button',{name:'选择特效'}).click();
  const modal=page.locator('.effect-selection-modal');await modal.getByRole('button',{name:'互动特效',exact:true}).click();await expect(modal.locator('.effect-preview')).toHaveCount(0);await expect(modal.locator('.interaction-preview')).toHaveCount(1);
  await modal.getByRole('button',{name:'收起预览'}).click();await expect(modal.locator('.interaction-preview')).toHaveCount(0);await modal.getByRole('button',{name:'展开预览'}).click();
  await modal.getByRole('button',{name:'完成',exact:true}).focus();await page.keyboard.press('Tab');expect(await page.evaluate(()=>!!document.activeElement?.closest('.effect-selection-modal'))).toBe(true);
  await page.keyboard.press('Escape');await expect(modal).toBeHidden();await expect(form).toBeVisible();
});

test('copy-on-write isolates edits and shares untouched messages in a 10000-message document',()=>{
  const original=archive('长文档',10000);original.assets.set('image',new Uint8Array([1,2,3]));
  const before=performance.now();const next=editStoryArchive(reactive(original),draft=>{const message=draft.document.messages[5000];if(message.kind==='text')message.text='改动';draft.document.settings.theme='dark';draft.document.messages.push({...draft.document.messages[0],id:'new'});});
  expect(performance.now()-before).toBeLessThan(2000);expect(original.document.settings.theme).toBe('light');expect(next.document.messages[4999]).toBe(original.document.messages[4999]);expect(next.document.messages[5000]).not.toBe(original.document.messages[5000]);expect(next.assets.get('image')).toBe(original.assets.get('image'));expect(original.document.messages).toHaveLength(10000);expect(next.document.messages).toHaveLength(10001);expect(()=>structuredClone(next.document)).not.toThrow();
  const filtered=editStoryArchive(next,draft=>{draft.document.messages=draft.document.messages.filter((_,index)=>index!==5);draft.document.messages[0].performance={effects:[{id:'x',delayMs:20,screen:{effect:'damage'}}]};});expect(()=>structuredClone(filtered.document)).not.toThrow();expect(next.document.messages[0].performance).toBeUndefined();
});

test('text edits reuse persisted media and the draft restores after reload',async({page})=>{
  await page.addInitScript(()=>{const original=IDBObjectStore.prototype.put;(window as any).assetWrites=0;IDBObjectStore.prototype.put=function(...args:any[]){if(this.name==='draft-assets')(window as any).assetWrites++;return Reflect.apply(original,this,args)};});
  const value=archive('草稿资源复用');value.assets.set('avatar',new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="blue"/></svg>'));value.document.characters[1].avatar={id:'avatar',mime:'image/svg+xml'};
  await open(page);await load(page,value);await expect(page.locator('.story-save-status')).toContainText('本机草稿已保存');expect(await page.evaluate(()=>(window as any).assetWrites)).toBe(1);
  await page.getByRole('textbox',{name:'请输入文本'}).fill('草稿新增内容');await page.getByRole('button',{name:'发送',exact:true}).click();await expect(page.locator('.story-save-status')).toContainText('本机草稿已保存');expect(await page.evaluate(()=>(window as any).assetWrites)).toBe(1);
  page.on('dialog',dialog=>dialog.accept());await page.reload();await expect(page.locator('.story-title strong')).toHaveText('草稿资源复用');await expect(page.locator('article.story-message')).toHaveCount(3);await expect(page.locator('article.story-message').last()).toContainText('草稿新增内容');
});

test('offline screen and avatar overlays have independent lifetimes and pause together',async({page})=>{
  const value=archive('离线叠加');Object.assign(value.document.settings,{streamEnabled:false,fixedDelayMs:10000});value.document.messages[0].performance={effects:[
    {id:'a',delayMs:0,screen:{effect:'damage',durationMs:1400},interaction:{effect:'magic',speedPercent:50}},
    {id:'b',delayMs:200,screen:{effect:'flash',durationMs:2500},interaction:{effect:'blade',speedPercent:50}}
  ]};
  const html=await createPerformanceHtml(value,async()=>'',async()=>'');const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.route('**/layered.html',route=>route.fulfill({contentType:'text/html',body:html}));await page.goto('/layered.html');await page.locator('#start-button').click();await page.locator('#coach').click();await expect(page.locator('#screen > .screen-layer')).toHaveCount(2);await expect(page.locator('#interaction .lt-interaction-scene')).toHaveCount(2);
  await page.locator('#toggle').click();await page.waitForTimeout(1500);await expect(page.locator('#screen > .screen-layer')).toHaveCount(2);await page.locator('#toggle').click();await expect(page.locator('#screen > .screen-layer')).toHaveCount(1,{timeout:2000});await expect(page.locator('#interaction .lt-interaction-scene')).toHaveCount(2);expect(errors).toEqual([]);
});

test('version-one local drafts keep their document and assets during storage upgrade',async({page})=>{
  const value=archive('旧草稿迁移');
  await page.route('**/draft-setup.html',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Draft setup</title>'}));await page.goto('/draft-setup.html');
  await page.evaluate(async(document)=>{await new Promise<void>((resolve,reject)=>{const request=indexedDB.open('scardice-story-editor',1);request.onupgradeneeded=()=>request.result.createObjectStore('drafts',{keyPath:'key'});request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result,tx=db.transaction('drafts','readwrite');tx.objectStore('drafts').put({key:`story:${location.origin}/story?key=local`,document,assets:[['legacy-asset',new Uint8Array([8,9,10]).buffer]],savedAt:new Date().toISOString()});tx.oncomplete=()=>{db.close();resolve()};tx.onerror=()=>reject(tx.error)}});},value.document);
  page.on('dialog',dialog=>dialog.accept());await open(page);await expect(page.locator('.story-title strong')).toHaveText('旧草稿迁移');await expect(page.locator('article.story-message')).toHaveCount(2);
  await page.getByRole('textbox',{name:'请输入文本'}).fill('迁移后继续编辑');await page.getByRole('button',{name:'发送',exact:true}).click();await expect(page.locator('.story-save-status')).toContainText('本机草稿已保存');
  const stored=await page.evaluate(()=>new Promise<number[]>((resolve,reject)=>{const open=indexedDB.open('scardice-story-editor');open.onerror=()=>reject(open.error);open.onsuccess=()=>{const key=sessionStorage.getItem(`story:${location.origin}/story?key=local::active`)!;const db=open.result,read=db.transaction('draft-assets').objectStore('draft-assets').get([key,'legacy-asset']);read.onsuccess=()=>{resolve(Array.from(new Uint8Array(read.result)));db.close()};read.onerror=()=>reject(read.error)}}));expect(stored).toEqual([8,9,10]);
});

test('dragging out of a numeric settings field does not dismiss the dialog',async({page})=>{
  await page.setViewportSize({width:1280,height:900});await open(page);await load(page,archive());await page.getByRole('button',{name:'演出编辑',exact:true}).click();await page.getByRole('button',{name:'演出设置',exact:true}).click();
  const modal=page.locator('.performance-settings-modal');
  const fallback=page.getByLabel('演出设置',{exact:true});const input=page.locator('.settings-panel:visible .n-input-number input').first();await expect(input).toBeVisible();const rect=await input.boundingBox();await page.mouse.move(rect!.x+rect!.width/2,rect!.y+rect!.height/2);await page.mouse.down();await page.mouse.move(2,2,{steps:8});await page.mouse.up();await expect(page.getByRole('button',{name:'关闭演出设置'})).toBeVisible();
});
