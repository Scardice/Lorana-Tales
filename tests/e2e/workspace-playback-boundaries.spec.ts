import { expect, test, type Page } from '@playwright/test';
import { storyFromLogItems } from '../../web/src/story/model';
import { createStoryPackage, readStoryPackage } from '../../web/src/story/package';
import { createPerformanceHtml } from '../../web/src/story/standalone-performance';
import type { StoryArchive } from '../../web/src/story/types';

function fixture(title: string, count=8): StoryArchive {
  const document=storyFromLogItems([],[],{title});
  document.characters.push({id:'alice',name:'阿洛',imUserId:'',position:'left',color:'#167478',isNarrator:false,isDice:false,hidden:false});
  document.messages=Array.from({length:count},(_,i)=>({id:'m'+i,kind:'text',characterId:'alice',time:0,text:'第'+i+'句。这是检查切换文档、暂停和进度调整时状态保持的长消息。'}));
  Object.assign(document.settings,{theme:'light',autoplay:true,playbackTiming:'fixed',fixedDelayMs:1800,streamEnabled:false,streamTokensPerSecond:4,streamSpeedJitterPercent:0,streamPauseMinMs:0,streamPauseMaxMs:0,typingIndicatorEnabled:false});
  return {document,assets:new Map()};
}
const packed=async(value:StoryArchive)=>Buffer.from(await(await createStoryPackage(value)).arrayBuffer());
async function open(page:Page){
  await page.addInitScript(()=>{for(const key of ['lorana_tutorial_prompt_seen','lorana_tutorial_playback_coach_seen'])document.cookie=key+'=1; Path=/; Max-Age=31536000';});
  await page.goto('/story',{waitUntil:'networkidle'});
}
async function load(page:Page,value:StoryArchive){await page.locator('.story-page > input[type=file]').setInputFiles({name:'test.ssp',mimeType:'application/vnd.lorana-tales.story+zip',buffer:await packed(value)});await expect(page.locator('.story-title strong')).toHaveText(value.document.title);}
async function saved(page:Page){await expect(page.locator('.story-save-status')).toContainText('本机草稿已保存');}
async function send(page:Page,text:string){await page.getByRole('textbox',{name:'请输入文本'}).fill(text);await page.getByRole('button',{name:'发送',exact:true}).click();}
async function draft(page:Page){return page.evaluate(()=>new Promise<any>((resolve,reject)=>{const request=indexedDB.open('scardice-story-editor');request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result,key=sessionStorage.getItem(`story:${location.origin}/story?key=local::active`)!;const read=db.transaction('drafts').objectStore('drafts').get(key);read.onsuccess=()=>{resolve(read.result);db.close()};read.onerror=()=>reject(read.error)}}));}
async function play(page:Page){await page.getByRole('button',{name:'演出编辑',exact:true}).click();await page.getByRole('button',{name:'开始演出',exact:true}).click();}
async function offline(page:Page,value:StoryArchive){const html=await createPerformanceHtml(value,async()=>'',async()=>'');await page.route('**/boundary.html',r=>r.fulfill({contentType:'text/html',body:html}));await page.goto('/boundary.html');await page.locator('#start-button').click();await page.locator('#coach').click();}
async function seek(page:Page,value:number){await page.locator('#progress').evaluate((el,value)=>{(el as HTMLInputElement).value=String(value);el.dispatchEvent(new Event('input',{bubbles:true}));},value);}

test('an upload finishing after document replacement cannot insert into the new document',async({page})=>{
  let release:()=>void=()=>{};const pending=new Promise<void>(resolve=>release=resolve);
  await page.route('**/api/editor/resources',async r=>{await pending;await r.fulfill({json:{id:'uploaded',url:'/upload-fixture.svg'}})});
  await page.route('**/upload-fixture.svg',r=>r.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"/>'}));
  await open(page);await load(page,fixture('等待上传的文档',2));const request=page.waitForRequest(r=>r.url().endsWith('/api/editor/resources'));
  await page.locator('input[type=file][accept="image/*"]').first().setInputFiles({name:'picture.svg',mimeType:'image/svg+xml',buffer:Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"/>')});await request;
  await load(page,fixture('上传完成前已切换',2));release();await expect(page.getByText('文档已切换，未插入图片',{exact:true})).toBeVisible();await expect(page.locator('article.story-message')).toHaveCount(2);await saved(page);expect((await draft(page)).document.messages).toHaveLength(2);
});

test('a tab inheriting sessionStorage forks its recovered draft instead of sharing a writer',async({page,context})=>{
  await open(page);await load(page,fixture('复制标签前的文档',2));await saved(page);const original=await draft(page);const pointer=await page.evaluate(()=>({name:`story:${location.origin}/story?key=local::active`,value:sessionStorage.getItem(`story:${location.origin}/story?key=local::active`)!}));
  const duplicate=await context.newPage();await duplicate.addInitScript(pointer=>sessionStorage.setItem(pointer.name,pointer.value),pointer);duplicate.on('dialog',dialog=>dialog.accept());await open(duplicate);await expect(duplicate.locator('.story-title strong')).toHaveText('复制标签前的文档');await send(duplicate,'只在副本编辑');await saved(duplicate);
  const copied=await draft(duplicate);expect(copied.key).not.toBe(original.key);expect(copied.document.messages).toHaveLength(3);expect((await draft(page)).document.messages).toHaveLength(2);
});

test('turning autoplay off during streaming preserves the active stream after dismissing the coach',async({page})=>{
  const value=fixture('手动流式');value.document.settings.streamEnabled=true;await open(page);await load(page,value);await play(page);const message=page.locator('article.player-message').first();await expect(message).toBeVisible();await page.waitForTimeout(300);
  await page.locator('.playback-only-controls').getByRole('switch').click();await page.getByRole('button',{name:'知道啦',exact:true}).click();const before=await message.innerText();await page.waitForTimeout(600);expect((await message.innerText()).length).toBeGreaterThan(before.length);await expect(page.locator('article.player-message')).toHaveCount(1);
});

test('offline cursor disappears on natural streaming completion',async({page})=>{
  const value=fixture('短句光标',2);Object.assign(value.document.settings,{streamEnabled:true,streamTokensPerSecond:4,fixedDelayMs:10000});if(value.document.messages[0].kind==='text')value.document.messages[0].text='完成';await offline(page,value);await expect(page.locator('.cursor')).toHaveCount(1);await expect(page.locator('.cursor')).toHaveCount(0);await expect(page.locator('.message-text')).toHaveText('完成');
});

test('replacing a document resets sender, reply, selection and insertion even for the same document ID',async({page})=>{
  const a=fixture('原文档',2),b=fixture('新文档',2);b.document.id=a.document.id;b.document.characters[1].id='bob';b.document.characters[1].name='贝拉';for(const m of b.document.messages)m.characterId='bob';
  await open(page);await load(page,a);await page.locator('article.story-message').first().getByRole('button',{name:'消息操作'}).click();await page.getByRole('menuitem',{name:'多插'}).click();
  await page.getByRole('textbox',{name:'请输入文本'}).fill('旧文档尚未发送的内容');await load(page,b);
  await expect(page.getByRole('textbox',{name:'请输入文本'})).toHaveText('');await expect(page.locator('.composer-batch')).toBeHidden();
  await send(page,'新文档直接发送');await saved(page);const stored=await draft(page);
  expect(stored.document.messages.at(-1).characterId).toBe('bob');expect(stored.document.messages.at(-1).replyToId).toBeUndefined();expect(stored.document.messages).toHaveLength(3);
  await expect(readStoryPackage(new Uint8Array(await packed({document:stored.document,assets:new Map()})))).resolves.toBeTruthy();
  await send(page,'同文档连续发送不会重置编辑器');await expect(page.locator('article.story-message')).toHaveCount(4);
});

test('latest cloud open wins and closing the panel invalidates pending document loads',async({page})=>{
  const a=fixture('云端 A',2),b=fixture('云端 B',2);let release:()=>void=()=>{};let pending=Promise.resolve();
  await page.route('**/api/account/config',r=>r.fulfill({json:{enabled:true,registrationEnabled:true,captchaProvider:'image'}}));
  await page.route('**/api/account/me',r=>r.fulfill({json:{authenticated:true,user:{id:'audit',username:'audit',nickname:'回归账号',email:'a@example.test',group:'default',role:'user'},storage:{quotaBytes:10000000,usedBytes:0,projectCount:2,maxProjects:100,retentionDays:180}}}));
  await page.route(/\/api\/account\/projects(?:\/[^/?]+)?$/,async r=>{
    const id=new URL(r.request().url()).pathname.split('/').at(-1);
    if(id==='projects')return r.fulfill({json:[a,b].map((value,i)=>({id:i?'b':'a',title:value.document.title,revision:1,updatedAt:new Date().toISOString()}))});
    if(id==='a')await pending;
    await r.fulfill({contentType:'application/vnd.lorana-tales.story+zip',headers:{'x-lorana-project-meta':Buffer.from(JSON.stringify({id,revision:1})).toString('base64url')},body:await packed(id==='a'?a:b)}).catch(()=>{});
  });
  const startA=async()=>{pending=new Promise<void>(resolve=>release=resolve);const request=page.waitForRequest(r=>r.url().endsWith('/projects/a'));await page.locator('.document-grid article').filter({hasText:'云端 A'}).getByRole('button',{name:'打开',exact:true}).click();await request;};
  await open(page);await page.locator('.account-trigger').click();await startA();await page.locator('.document-grid article').filter({hasText:'云端 B'}).getByRole('button',{name:'打开',exact:true}).click();await expect(page.locator('.story-title strong')).toHaveText('云端 B');await send(page,'B 的新编辑');release();await saved(page);await page.waitForTimeout(250);
  await expect(page.locator('.story-title strong')).toHaveText('云端 B');await expect(page.locator('article.story-message').last()).toContainText('B 的新编辑');
  await page.locator('.account-trigger').click();await startA();await page.getByRole('button',{name:'继续当前编辑',exact:true}).click();release();await page.waitForTimeout(250);await expect(page.locator('.story-title strong')).toHaveText('云端 B');
});

test('two tabs and pending document replacements keep independent recoverable drafts',async({page,context})=>{
  await open(page);await load(page,fixture('标签 A',2));await saved(page);const aKey=(await draft(page)).key;
  const second=await context.newPage();second.on('dialog',dialog=>dialog.dismiss());await open(second);await load(second,fixture('标签 B',2));await saved(second);expect((await draft(second)).key).not.toBe(aKey);
  page.on('dialog',dialog=>dialog.accept());await page.reload();await expect(page.locator('.story-title strong')).toHaveText('标签 A');expect((await draft(page)).key).toBe(aKey);
  await send(page,'切换前最后一个修改');await load(page,fixture('标签 C',2));await saved(page);
  const old=await page.evaluate(key=>new Promise<any>(resolve=>{const r=indexedDB.open('scardice-story-editor');r.onsuccess=()=>{const db=r.result,read=db.transaction('drafts').objectStore('drafts').get(key);read.onsuccess=()=>{resolve(read.result);db.close()}}}),aKey);
  expect(old.document.messages.at(-1).text).toBe('切换前最后一个修改');expect((await draft(page)).document.title).toBe('标签 C');
  second.removeAllListeners('dialog');second.on('dialog',dialog=>dialog.accept());await second.reload();await expect(second.locator('.story-title strong')).toHaveText('标签 B');
});

test('first manual-play coach cancels the pending auto advance without freezing text streaming',async({page})=>{
  const value=fixture('关闭自动播放');value.document.settings.fixedDelayMs=700;
  await open(page);await load(page,value);await play(page);await expect(page.locator('article.player-message')).toHaveCount(1);await page.locator('.playback-only-controls').getByRole('switch').click();await expect(page.locator('.playback-coach')).toBeVisible();await page.getByRole('button',{name:'知道啦',exact:true}).click();await page.waitForTimeout(1100);await expect(page.locator('article.player-message')).toHaveCount(1);await expect(page.locator('.playback-only-controls').getByRole('switch')).toHaveAttribute('aria-checked','false');
  await page.locator('.playback-only-controls').getByRole('switch').click();await expect(page.locator('article.player-message')).toHaveCount(2);
});

test('changing speed while paused preserves online screen-effect phase',async({page})=>{
  const value=fixture('暂停变速');value.document.settings.fixedDelayMs=12000;value.document.messages[0].performance={effects:[{id:'fx',delayMs:0,screen:{effect:'damage',durationMs:6000}}]};
  await open(page);await load(page,value);await play(page);const layer=page.locator('.effect-screen-layer');await expect(layer).toHaveCount(1);await page.waitForTimeout(400);await page.getByRole('button',{name:'暂停演出',exact:true}).click();await page.waitForTimeout(80);
  const snapshot=()=>layer.evaluate(el=>{const a=el.getAnimations({subtree:true})[0];return {progress:a.effect!.getComputedTiming().progress!,rate:a.playbackRate,duration:a.effect!.getTiming().duration}});
  const before=await snapshot();await page.locator('.playback-only-controls .n-select').click();await page.locator('.n-base-select-option').filter({hasText:'2×'}).click();await page.waitForTimeout(80);const after=await snapshot();expect(after.progress).toBeCloseTo(before.progress,3);expect(after.duration).toBe(before.duration);expect(after.rate).toBe(2);
  await page.getByRole('button',{name:'继续演出',exact:true}).click();await page.waitForTimeout(200);expect((await snapshot()).progress).toBeGreaterThan(after.progress);
});

test('offline seek resumes autoplay but stays still when paused or manual',async({page})=>{
  const value=fixture('离线跳转',12);value.document.settings.fixedDelayMs=650;await offline(page,value);
  await seek(page,4);await expect(page.locator('#counter')).toHaveText('4 / 12');await expect(page.locator('#counter')).toHaveText('5 / 12');
  await page.locator('#toggle').click();await seek(page,7);await page.waitForTimeout(850);await expect(page.locator('#counter')).toHaveText('7 / 12');await page.locator('#toggle').click();
  await page.locator('#autoplay').uncheck();await seek(page,3);await page.waitForTimeout(850);await expect(page.locator('#counter')).toHaveText('3 / 12');
  await page.locator('#autoplay').check();await seek(page,4);await seek(page,5);await seek(page,6);await page.waitForTimeout(850);await expect(page.locator('#counter')).toHaveText('7 / 12');
  await seek(page,12);await page.waitForTimeout(850);await expect(page.locator('#counter')).toHaveText('12 / 12');
});

test('offline paused speed changes keep screen-overlay phase and rate synchronized',async({page})=>{
  const value=fixture('离线变速');value.document.settings.fixedDelayMs=12000;value.document.messages[0].performance={effects:[{id:'fx',delayMs:0,screen:{effect:'damage',durationMs:6000}}]};await offline(page,value);const layer=page.locator('#screen > .screen-layer');await expect(layer).toHaveCount(1);await page.waitForTimeout(350);await page.locator('#toggle').click();await page.waitForTimeout(80);
  const snapshot=()=>layer.evaluate(el=>{const a=el.getAnimations({subtree:true})[0];return{progress:a.effect!.getComputedTiming().progress!,rate:a.playbackRate}});const before=await snapshot();await page.locator('#speed').click();await page.waitForTimeout(80);const after=await snapshot();expect(after.progress).toBeCloseTo(before.progress,3);expect(after.rate).not.toBe(before.rate);await page.locator('#toggle').click();await page.waitForTimeout(200);expect((await snapshot()).progress).toBeGreaterThan(after.progress);
});

for(const cursor of ['bar','block','dot','none'] as const)test(`offline streaming cursor ${cursor} follows tokens and is removed on skip and seek`,async({page})=>{
  const value=fixture('流式光标');Object.assign(value.document.settings,{streamEnabled:true,streamCursor:cursor,fixedDelayMs:10000});await offline(page,value);await expect(page.locator('.stream-token').first()).toBeVisible();await expect(page.locator('.cursor')).toHaveCount(cursor==='none'?0:1);
  if(cursor!=='none')await expect(page.locator('.message-text > :last-child')).toHaveClass('cursor '+cursor);
  await page.locator('#next').click();await expect(page.locator('.cursor')).toHaveCount(0);await expect(page.locator('#counter')).toHaveText('1 / 8');await page.locator('#next').click();await expect(page.locator('#counter')).toHaveText('2 / 8');await seek(page,4);await expect(page.locator('.cursor')).toHaveCount(0);
});
