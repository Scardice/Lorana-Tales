import { serializeStoryScript } from "./raw-script";
import { storyPalette } from "./palette";
import type { StoryArchive, StoryAssetRef, StoryCharacter, StoryMessage } from "./types";

const escapeHtml = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);

function messageDelay(message: StoryMessage, archive: StoryArchive): number {
	if (message.performance?.durationMs != null) return Math.max(250, message.performance.durationMs);
	const settings = archive.document.settings;
	if (settings.playbackTiming === "fixed") return Math.max(250, settings.fixedDelayMs);
	const length = message.kind === "text" ? message.text.replace(/\s+/g, "").length : 16;
	return Math.max(900, Math.round(length * 60_000 / Math.max(80, settings.chineseCharsPerMinute)));
}

export async function createPerformanceHtml(
	archive: StoryArchive,
	resolveAsset: (asset?: StoryAssetRef) => Promise<string>,
	resolveAvatar: (character: StoryCharacter) => Promise<string>,
): Promise<string> {
	const avatars = new Map<string, string>();
	for (const character of archive.document.characters) avatars.set(character.id, await resolveAvatar(character));
	const messages: string[] = [];
	for (const message of archive.document.messages) {
		const character = archive.document.characters.find((item) => item.id === message.characterId);
		const side = character?.position || "left";
		const palette = storyPalette(character?.bubblePaletteId || character?.paletteId);
		const avatar = avatars.get(message.characterId) || "";
		let body = "";
		if (message.kind === "text") body = `<div class="text">${escapeHtml(message.text).replace(/\n/g, "<br>")}</div>`;
		else if (message.kind === "image") {
			const source = await resolveAsset(message.asset);
			body = source ? `<button class="image-button" type="button"><img src="${source}" alt="${escapeHtml(message.alt || "图片")}"></button>` : '<div class="placeholder">【图片】</div>';
		} else {
			const source = await resolveAsset(message.asset);
			body = `${source ? `<audio controls preload="metadata" src="${source}"></audio>` : '<div class="placeholder">【语音】</div>'}${message.caption ? `<p class="audio-caption">${escapeHtml(message.caption).replace(/\n/g, "<br>")}</p>` : ""}`;
		}
		const identity = character && !character.isNarrator ? `<small style="color:${escapeHtml(palette?.nameDark || character.color)}">${escapeHtml(character.name)}${archive.document.settings.showQqInPreview && character.imUserId ? ` · ${escapeHtml(character.imUserId)}` : ""}</small>` : "";
		const avatarHtml = side !== "narrator" ? `<span class="avatar">${avatar ? `<img src="${avatar}" alt="">` : escapeHtml(character?.name.slice(0, 1) || "角")}</span>` : "";
		messages.push(`<article class="message ${escapeHtml(side)}" data-delay="${messageDelay(message, archive)}" hidden>${avatarHtml}<div class="content">${identity}<div class="bubble" style="--bubble:${escapeHtml(palette?.bubbleDark || "#182120")};--bubble-text:${escapeHtml(palette?.textDark || "#ffffff")}">${body}</div></div></article>`);
	}
	const source = serializeStoryScript(archive).replace(/<\/script/gi, "<\\/script");
	const title = escapeHtml(archive.document.title);
	return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="dark"><title>${title}</title><style>[hidden]{display:none!important}
*{box-sizing:border-box}html{background:#0b1110}body{margin:0;background:#0b1110;color:#eef2f1;font:16px/1.55 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;user-select:none}.stage{width:min(${archive.document.settings.canvasWidth}px,100%);min-height:100dvh;margin:auto;padding:72px 14px 110px}.story-title{position:fixed;z-index:5;top:0;right:0;left:0;margin:0;padding:14px 64px;background:#101817e8;backdrop-filter:blur(10px);overflow:hidden;text-align:center;text-overflow:ellipsis;white-space:nowrap;font-size:1rem}.message{display:flex;gap:10px;align-items:flex-start;margin:10px 0;opacity:0;transform:translateY(28px) scale(.985)}.message.show{animation:message-in .42s cubic-bezier(.2,.78,.2,1) forwards}.message.right{flex-direction:row-reverse;text-align:right}.message.narrator{justify-content:center;text-align:center}.avatar{display:grid;place-items:center;flex:0 0 ${archive.document.settings.avatarSize}px;width:${archive.document.settings.avatarSize}px;height:${archive.document.settings.avatarSize}px;overflow:hidden;border-radius:50%;background:#334342}.avatar img{width:100%;height:100%;object-fit:cover}.content{max-width:${archive.document.settings.bubbleMaxWidth}%}.content small{display:block;margin:0 6px 3px;font-weight:650}.bubble{padding:12px 16px;border-radius:18px;background:var(--bubble);color:var(--bubble-text);white-space:pre-wrap;overflow-wrap:anywhere}.narrator .bubble{border-radius:10px}.image-button{display:block;max-width:100%;padding:0;border:0;background:transparent;cursor:zoom-in}.bubble img{display:block;max-width:100%;max-height:${archive.document.settings.imageMaxHeightVh}vh;border-radius:12px}.bubble audio{width:min(360px,72vw)}.audio-caption{margin:8px 0 0;padding-top:7px;border-top:1px solid #ffffff2b;text-align:left}.placeholder{color:#b7c1bf}.controls{position:fixed;z-index:10;right:12px;bottom:max(12px,env(safe-area-inset-bottom));left:12px;display:flex;align-items:center;justify-content:center;gap:7px;width:max-content;max-width:calc(100% - 24px);margin:auto;padding:7px;border:1px solid #41504d;border-radius:15px;background:#182120ed;box-shadow:0 12px 42px #000a;backdrop-filter:blur(12px)}.controls button{display:grid;min-width:42px;height:38px;place-items:center;border:0;border-radius:9px;padding:0 10px;background:#2a3534;color:#eef2f1;font:inherit;cursor:pointer}.controls button:hover{background:#354240}.controls .primary{background:#167f86}.counter,.speed{min-width:52px;color:#aeb9b7;text-align:center;font-size:.76rem}.viewer{position:fixed;z-index:20;inset:0;display:grid;place-items:center;padding:54px 12px 12px;background:#000d;opacity:0;pointer-events:none;transition:.2s}.viewer.open{opacity:1;pointer-events:auto}.viewer img{max-width:100%;max-height:100%;object-fit:contain;transform:scale(.96);transition:.25s}.viewer.open img{transform:scale(1)}@keyframes message-in{to{opacity:1;transform:none}}@media(max-width:600px){.stage{padding:62px 8px 96px}.content{max-width:82%}.story-title{padding:12px 48px}.controls{gap:4px}.controls button{min-width:36px;height:36px;padding:0 8px}}@media(prefers-reduced-motion:reduce){.message.show{animation:none;opacity:1;transform:none}.viewer,.viewer img{transition:none}}
</style></head><body><h1 class="story-title">${title}</h1><main class="stage">${messages.join("")}</main><div class="controls" role="toolbar" aria-label="演出控制"><button id="restart" title="重新播放">↺</button><button id="slower" title="减速">−</button><span class="speed">1.00×</span><button id="faster" title="加速">＋</button><button id="toggle" class="primary">暂停</button><span class="counter">0 / ${messages.length}</span></div><div class="viewer" role="dialog" aria-label="图片预览"><img alt=""><button hidden>关闭</button></div><script id="lorana-story-source" type="text/lorana-story">${source}</script><script>
(()=>{const items=[...document.querySelectorAll('.message')],stage=document.querySelector('.stage'),toggle=document.querySelector('#toggle'),speedLabel=document.querySelector('.speed'),counter=document.querySelector('.counter'),viewer=document.querySelector('.viewer'),viewerImage=viewer.querySelector('img');let index=0,running=true,speed=1,timer=0;const speeds=[.5,.75,1,1.25,1.5,2];function render(){speedLabel.textContent=speed.toFixed(2)+'×';counter.textContent=index+' / '+items.length;toggle.textContent=running?'暂停':'继续'}function schedule(){clearTimeout(timer);if(!running||index>=items.length)return;const delay=index===0?420:Number(items[index-1]?.dataset.delay||1800)/speed;timer=setTimeout(next,delay)}function next(){if(index>=items.length){running=false;render();return}const item=items[index++];item.hidden=false;requestAnimationFrame(()=>item.classList.add('show'));requestAnimationFrame(()=>item.scrollIntoView({behavior:'smooth',block:'end'}));render();schedule()}function reset(){clearTimeout(timer);for(const item of items){item.hidden=true;item.classList.remove('show')}index=0;running=true;scrollTo({top:0,behavior:'smooth'});render();schedule()}toggle.onclick=()=>{running=!running;render();schedule()};document.querySelector('#restart').onclick=reset;document.querySelector('#slower').onclick=()=>{speed=speeds[Math.max(0,speeds.findIndex(value=>value===speed)-1)];render();schedule()};document.querySelector('#faster').onclick=()=>{speed=speeds[Math.min(speeds.length-1,speeds.findIndex(value=>value===speed)+1)];render();schedule()};for(const button of document.querySelectorAll('.image-button'))button.onclick=()=>{viewerImage.src=button.querySelector('img').src;viewer.classList.add('open')};viewer.onclick=()=>viewer.classList.remove('open');render();schedule()})();
</script></body></html>`;
}
