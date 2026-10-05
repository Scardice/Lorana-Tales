import { expect, test, type Page } from '@playwright/test';
import { deflateSync } from 'node:zlib';
import { storyFromLogItems } from '../../web/src/story/model';
import { createStoryPackage, readStoryPackage } from '../../web/src/story/package';
import { createPerformanceHtml } from '../../web/src/story/standalone-performance';
import { editStoryArchive } from '../../web/src/story/edit-archive';
import { repairStoryReferences } from '../../web/src/story/document-references';
import type { StoryArchive } from '../../web/src/story/types';

const errors=new WeakMap<Page,string[]>();
test.beforeEach(async({page})=>{const list:string[]=[];errors.set(page,list);page.on('pageerror',e=>list.push(e.message));});
test.afterEach(async({page})=>{expect(errors.get(page)).toEqual([]);});

function fixture(title:string,count=3):StoryArchive {
  const document=storyFromLogItems([],[],{title});
  document.characters.push({id:'alice',name:'阿洛',imUserId:'',position:'left',color:'#167478',isNarrator:false,isDice:false,hidden:false});
  document.characters.push({id:'bob',name:'贝拉',imUserId:'',position:'right',color:'#98425e',isNarrator:false,isDice:false,hidden:false});
  document.messages=Array.from({length:count},(_,i)=>({id:'m'+i,kind:'text',characterId:'alice',time:1,text:'第'+i+'条消息。这是一段用于复核引用预览、流式输出和最终播放状态的较长台词。'}));
  Object.assign(document.settings,{theme:'light',autoplay:true,playbackTiming:'fixed',fixedDelayMs:10000,streamEnabled:false,streamTokensPerSecond:4,streamSpeedJitterPercent:0,streamPauseMinMs:0,streamPauseMaxMs:0,typingIndicatorEnabled:false});
  return {document,assets:new Map()};
}
const pack=async(value:StoryArchive)=>Buffer.from(await(await createStoryPackage(value)).arrayBuffer());
async function open(page:Page,path='/story'){
  await page.addInitScript(()=>{for(const key of ['lorana_tutorial_prompt_seen','lorana_tutorial_playback_coach_seen','lorana_legacy_link_hint_seen'])document.cookie=key+'=1; Path=/; Max-Age=31536000';});
  await page.goto(path,{waitUntil:'networkidle'});
}
async function load(page:Page,value:StoryArchive){await page.locator('.story-page > input[type=file]').setInputFiles({name:'test.ssp',mimeType:'application/vnd.lorana-tales.story+zip',buffer:await pack(value)});await expect(page.locator('.story-title strong')).toHaveText(value.document.title);}
async function saved(page:Page){await expect(page.locator('.story-save-status')).toContainText('本机草稿已保存');}
async function stored(page:Page){await saved(page);return page.evaluate(()=>new Promise<any>((resolve,reject)=>{const r=indexedDB.open('scardice-story-editor');r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result,key=sessionStorage.getItem('story:'+location.origin+'/story?key='+(new URLSearchParams(location.search).get('key')||'local')+'::active')!,read=db.transaction('drafts').objectStore('drafts').get(key);read.onsuccess=()=>{resolve(read.result.document);db.close()};read.onerror=()=>reject(read.error)}}));}
async function allDrafts(page:Page){return page.evaluate(()=>new Promise<any[]>(resolve=>{const r=indexedDB.open('scardice-story-editor');r.onsuccess=()=>{const db=r.result,read=db.transaction('drafts').objectStore('drafts').getAll();read.onsuccess=()=>{resolve(read.result.map((item:any)=>item.document));db.close()}}}));}
async function mockAccount(page:Page){
  await page.route('**/api/account/config',r=>r.fulfill({json:{enabled:true,registrationEnabled:true,captchaProvider:'image'}}));
  await page.route('**/api/account/me',r=>r.fulfill({json:{authenticated:true,user:{id:'qa',username:'qa',nickname:'回归账号',email:'qa@example.test',group:'default',role:'user',tutorialPromptSeen:true,tutorialPlaybackCoachSeen:true,legacyLinkHintSeen:true},storage:{quotaBytes:10000000,usedBytes:0,projectCount:2,maxProjects:100,retentionDays:180}}}));
}
async function dismissClaim(page:Page){const dialog=page.getByRole('dialog',{name:'认领这个故事？'});if(await dialog.isVisible())await dialog.getByRole('button',{name:'暂不认领'}).click();}
async function offline(page:Page,value:StoryArchive){const html=await createPerformanceHtml(value,async()=>'',async()=>'');await page.route('**/round3.html',r=>r.fulfill({contentType:'text/html',body:html}));await page.goto('/round3.html');await page.locator('#start-button').click();await page.locator('#coach').click();}
async function seek(page:Page,value:number){await page.locator('#progress').evaluate((el,value)=>{(el as HTMLInputElement).value=String(value);el.dispatchEvent(new Event('input',{bubbles:true}));},value);}

for(const sameId of [false,true])test('late claim response cannot bind a replacement document (same ID: '+sameId+')',async({page})=>{
  await mockAccount(page);let release:()=>void=()=>{};const pending=new Promise<void>(resolve=>release=resolve),writes:any[]=[];
  await page.route(/\/api\/account\/projects(?:\/[^/?]+)?$/,async r=>{
    const req=r.request();if(req.method()==='GET')return r.fulfill({json:[]});
    const incoming=await readStoryPackage(new Uint8Array(req.postDataBuffer()!));writes.push({method:req.method(),path:new URL(req.url()).pathname,title:incoming.document.title});
    if(writes.length===1)await pending;await r.fulfill({json:{id:writes.length===1?'claimed-a':'saved-b',revision:1}});
  });
  const a=fixture('认领 A'),b=fixture('新文档 B');if(sameId)b.document.id=a.document.id;
  await open(page,'/story?key=claim-qa');await dismissClaim(page);await load(page,a);await dismissClaim(page);
  const request=page.waitForRequest(r=>r.method()==='POST'&&r.url().endsWith('/projects'));await page.getByRole('button',{name:'认领到账号',exact:true}).click();await request;
  await page.getByRole('button',{name:'继续当前编辑',exact:true}).click();await load(page,b);await dismissClaim(page);release();await saved(page);await page.waitForTimeout(250);
  await page.locator('.account-trigger').click();await expect(page.locator('.document-toolbar .primary')).toHaveText('保存当前文档');await page.locator('.document-toolbar .primary').click();
  await expect.poll(()=>writes).toEqual([{method:'POST',path:'/api/account/projects',title:'认领 A'},{method:'POST',path:'/api/account/projects',title:'新文档 B'}]);
});

function remoteStory(title:string,key:string,id:number,text:string){
  const items=[{id,nickname:'来源角色',IMUserId:'',time:id,message:text,isDice:false,commandId:0}];
  const value={document:storyFromLogItems(items,[],{title,sourceKey:key}),assets:new Map<string,Uint8Array>()};value.document.settings.theme='light';
  return{value,payload:{record:{client:'Lagrange',name:title,data:deflateSync(Buffer.from(JSON.stringify({version:105,items}))).toString('base64')},sourceKey:key}};
}
async function mockSync(page:Page,delaySource?:Promise<void>){
  await mockAccount(page);const a=remoteStory('云端 A','source-a',772,'A 原始消息'),updated=remoteStory('云端 A','source-a',772,'A 更新消息');
  await page.route('**/api/account/projects',r=>r.fulfill({json:[{id:'cloud-a',title:'云端 A',revision:4,sourceKey:'source-a',updatedAt:new Date().toISOString()}]}));
  await page.route('**/api/account/projects/cloud-a',async r=>r.fulfill({contentType:'application/vnd.lorana-tales.story+zip',headers:{'x-lorana-project-meta':Buffer.from(JSON.stringify({id:'cloud-a',revision:4})).toString('base64url')},body:await pack(a.value)}));
  await page.route('**/api/account/projects/cloud-a/source',async r=>{if(delaySource)await delaySource;await r.fulfill({json:updated.payload}).catch(()=>{});});
  return a;
}

test('sync opens its selected cloud document while preserving the previous local draft',async({page})=>{
  await mockSync(page);const b=remoteStory('正在编辑 B','source-b',991,'B 原有消息');
  await open(page);await load(page,b.value);await saved(page);await page.locator('.account-trigger').click();await page.getByRole('button',{name:'同步',exact:true}).click();
  await expect(page.locator('.story-title strong')).toHaveText('云端 A');await expect(page.locator('article.story-message')).toContainText(['A 更新消息']);
  const document=await stored(page);expect(document.source.key).toBe('source-a');
  const drafts=await allDrafts(page);expect(drafts.find(item=>item.title==='正在编辑 B')?.messages[0].text).toBe('B 原有消息');
  await page.locator('.account-trigger').click();await expect(page.locator('.document-toolbar .primary')).toHaveText('保存修订');
});

test('syncing the already-open project keeps unsaved edits instead of reloading its cloud revision',async({page})=>{
  await mockSync(page);await open(page);await page.locator('.account-trigger').click();await page.getByRole('button',{name:'打开',exact:true}).click();await expect(page.locator('.story-title strong')).toHaveText('云端 A');
  await page.getByRole('textbox',{name:'请输入文本'}).fill('本地尚未保存的新句子');await page.getByRole('button',{name:'发送',exact:true}).click();
  await page.locator('.account-trigger').click();await page.getByRole('button',{name:'同步',exact:true}).click();
  await expect(page.locator('article.story-message')).toContainText(['A 更新消息','本地尚未保存的新句子']);
});

test('closing the workspace and replacing a document invalidates a delayed sync',async({page})=>{
  let release:()=>void=()=>{};const pending=new Promise<void>(resolve=>release=resolve);await mockSync(page,pending);await open(page);await load(page,fixture('原文档'));
  await page.locator('.account-trigger').click();const request=page.waitForRequest(r=>r.url().endsWith('/cloud-a/source'));await page.getByRole('button',{name:'同步',exact:true}).click();await request;
  await page.getByRole('button',{name:'继续当前编辑',exact:true}).click();await load(page,fixture('等待期间切换的文档'));release();await saved(page);await page.waitForTimeout(250);
  await expect(page.locator('.story-title strong')).toHaveText('等待期间切换的文档');expect((await stored(page)).source.kind).toBe('none');
});

for(const operation of ['delete-role','change-sender'])test(operation+' preserves a readable SSP and converts invalid interaction targets to sender-only effects',async({page})=>{
  const a=fixture('角色关联测试',2);a.document.messages[0].performance={interaction:{effect:'throw',targetCharacterId:'bob'},effects:[{id:'magic',delayMs:0,interaction:{effect:'magic',targetCharacterId:'bob',reaction:'faint',color:'purple',speedPercent:75}}]};a.document.messages[1].characterId='bob';
  if(operation==='change-sender')await page.setViewportSize({width:390,height:844});
  await open(page);await load(page,a);
  if(operation==='delete-role'){page.on('dialog',d=>d.accept());await page.getByRole('button',{name:'选择角色 贝拉',exact:true}).click();await page.getByRole('button',{name:'选择角色 贝拉',exact:true}).click();await page.getByRole('button',{name:'删除角色',exact:true}).click();}
  else{await page.locator('article.story-message').first().getByRole('button',{name:'消息操作'}).click();await page.getByRole('menuitem',{name:'编辑'}).click();const sheet=page.locator('.message-edit-sheet');await sheet.locator('nav button').filter({hasText:'贝拉'}).click();await sheet.locator('.sheet-confirm').click();}
  const document=await stored(page),performance=document.messages[0].performance;expect(performance.effects[0].interaction).toMatchObject({effect:'magic',reaction:'faint',color:'purple',speedPercent:75});expect(performance.effects[0].interaction.targetCharacterId).toBeUndefined();
  const read=await readStoryPackage(new Uint8Array(await pack({document,assets:new Map()})));expect(read.document.messages.length).toBe(operation==='delete-role'?1:2);
});

test('structural cleanup removes stale replies, tracks and states without mutating the previous archive',async()=>{
  const source=fixture('关联清理',4);source.document.messages[0].performance={interaction:{effect:'throw',targetCharacterId:'bob'}};
  source.document.messages[2].replyToId='m1';source.document.messages[2].performance={replyPreview:{durationMs:1200},effects:[{id:'keep',delayMs:0,screen:{effect:'flash'},interaction:{effect:'heart',targetCharacterId:'alice',color:'pink'}}]};
  source.document.effectTracks=[{id:'bad',effect:'storm',startMessageId:'m1',endMessageId:'m2'},{id:'keep',effect:'snowfall',startMessageId:'m2',endMessageId:'m3'}];
  source.document.characterStateEvents=[{id:'deleted-role',characterId:'bob',afterMessageId:'m0',state:'gray'},{id:'deleted-message',characterId:'alice',afterMessageId:'m1',state:'injured'},{id:'keep',characterId:'alice',afterMessageId:'m3',state:'normal'}];
  const result=editStoryArchive(source,a=>{a.document.characters=a.document.characters.filter(c=>c.id!=='bob');a.document.messages=a.document.messages.filter(m=>m.id!=='m1');repairStoryReferences(a.document)});
  expect(source.document.messages[0].performance!.interaction!.targetCharacterId).toBe('bob');expect(source.document.messages[2].replyToId).toBe('m1');
  expect(result.document.messages[0].performance!.interaction!.targetCharacterId).toBeUndefined();expect(result.document.messages[1].replyToId).toBeUndefined();expect(result.document.messages[1].performance!.replyPreview).toBeUndefined();expect(result.document.messages[1].performance!.effects![0].screen!.effect).toBe('flash');
  expect(result.document.effectTracks.map(t=>t.id)).toEqual(['keep']);expect(result.document.characterStateEvents.map(t=>t.id)).toEqual(['keep']);await expect(readStoryPackage(new Uint8Array(await pack(result)))).resolves.toBeTruthy();
});

test('clicking the final message does not cancel playback completion',async({page})=>{
  const a=fixture('最后一句测试',1);a.document.settings.fixedDelayMs=1200;
  await open(page);await load(page,a);await page.getByRole('button',{name:'演出编辑',exact:true}).click();await page.getByRole('button',{name:'开始演出',exact:true}).click();await expect(page.locator('article.player-message')).toHaveCount(1);await page.locator('article.player-message .bubble').click();await page.locator('article.player-message .bubble').click();
  await expect(page.getByText('播放完成',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'重新演出',exact:true})).toBeVisible();await page.waitForTimeout(1600);await expect(page.getByRole('button',{name:'重新演出',exact:true})).toBeVisible();
});

test('offline reply preview leaves the live stream and cursor mounted',async({page})=>{
  const a=fixture('引用流式测试');a.document.messages[0].performance={stream:false};a.document.messages[1].replyToId='m0';a.document.settings.streamEnabled=true;
  await offline(page,a);await page.locator('#next').click();const message=page.locator('.message[data-id=m1] .message-text');await expect(page.locator('#counter')).toHaveText('2 / 3');await message.evaluate(el=>(window as any).liveMessage=el);
  await page.locator('.message[data-id=m1] .reply').click();expect(await message.evaluate(el=>el===(window as any).liveMessage)).toBe(true);expect((await message.innerText()).length).toBeLessThan((a.document.messages[1] as any).text.length);await expect(page.locator('.cursor')).toHaveCount(1);
  await page.waitForTimeout(2400);expect(await message.evaluate(el=>el===(window as any).liveMessage)).toBe(true);await expect(page.locator('.cursor')).toHaveCount(1);
  await page.locator('#next').click();await expect(message).toHaveText((a.document.messages[1] as any).text);
});

test('offline older reply preview remains bounded and rapid seeks cannot restore stale content',async({page})=>{
  const a=fixture('长文档引用',1000);a.document.messages[999].replyToId='m0';await offline(page,a);await page.locator('#autoplay').uncheck();await seek(page,1000);await expect(page.locator('.message')).toHaveCount(360);
  await page.locator('.message[data-id=m999] .reply').click();await expect(page.locator('.message[data-id=m0]')).toBeVisible();expect(await page.locator('.message').count()).toBeLessThanOrEqual(367);
  await seek(page,4);await page.waitForTimeout(2400);await expect(page.locator('#counter')).toHaveText('4 / 1000');await expect(page.locator('.message')).toHaveCount(4);
});

test('offline next skips typing once, respects pause, and remains valid after seeking',async({page})=>{
  const a=fixture('手动跳过正在输入');Object.assign(a.document.settings,{typingIndicatorEnabled:true,typingIndicatorMs:5000});
  await offline(page,a);await expect(page.locator('.typing')).toBeVisible();await page.locator('#toggle').click();await page.locator('#next').click();await expect(page.locator('#counter')).toHaveText('0 / 3');
  await page.locator('#toggle').click();await page.locator('#next').click();await expect(page.locator('#counter')).toHaveText('1 / 3');await expect(page.locator('.typing')).toHaveCount(0);
  await page.locator('#next').click();await expect(page.locator('.typing')).toBeVisible();await seek(page,0);await expect(page.locator('.typing')).toBeVisible();await page.locator('#next').click();await expect(page.locator('#counter')).toHaveText('1 / 3');await page.waitForTimeout(300);await expect(page.locator('#counter')).toHaveText('1 / 3');
});
