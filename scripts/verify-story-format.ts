import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import vm from "node:vm";
import Database from "better-sqlite3";
import express from "express";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

import { AccountStore } from "../src/accounts/account-store";
import { AccountService } from "../src/accounts/router";
import { getClientIp } from "../src/server/client-ip";
import { storyFromLogItems, storyStreamingText } from "../web/src/story/model";
import { isStoryAudioMessage, isStoryCqMessage, isStoryImageMessage, isStoryMessageFiltered, isStoryOffTopicText } from "../web/src/story/message-filter";
import { createStoryPackage, readStoryPackage } from "../web/src/story/package";
import { createPerformanceHtml } from "../web/src/story/standalone-performance";
import type { StoryArchive, StoryCharacter, StoryMessage } from "../web/src/story/types";

const forwardedRequest = (remoteAddress: string, forwardedFor: string) => ({
	headers: { "x-forwarded-for": forwardedFor },
	socket: { remoteAddress },
});
assert.equal(
	getClientIp(forwardedRequest("203.0.113.10", "198.51.100.20") as never, ["127.0.0.1/32"]),
	"203.0.113.10",
	"不可信直连请求不能伪造 X-Forwarded-For",
);
assert.equal(isStoryOffTopicText("(场外)"),true);
assert.equal(isStoryOffTopicText("[CQ:face,id=14](场外)"),true);
assert.equal(isStoryOffTopicText("[CQ:at,qq=123] （场外）"),true);
assert.equal(isStoryOffTopicText("[CQ:face,id=14] [CQ:image,file=a]   (off topic)"),true);
assert.equal(isStoryOffTopicText("[CQ:face,id=14] 正文"),false);
const cqText = (text: string): StoryMessage => ({ id: `cq-${text}`, characterId: "character-narrator", kind: "text", text });
const imageMessage: StoryMessage = { id: "filter-image", characterId: "character-narrator", kind: "image", asset: { id: "image", mime: "image/png", name: "image.png" } };
const audioMessage: StoryMessage = { id: "filter-audio", characterId: "character-narrator", kind: "audio", asset: { id: "audio", mime: "audio/ogg", name: "audio.ogg" } };
assert.equal(isStoryImageMessage(imageMessage), true);
assert.equal(isStoryImageMessage(cqText("说明 [CQ:image,file=a]")), true);
assert.equal(isStoryAudioMessage(audioMessage), true);
assert.equal(isStoryAudioMessage(cqText("[CQ:record,file=a] 转写")), true);
assert.equal(isStoryCqMessage(cqText("正文 [CQ:at,qq=123]")), true);
assert.equal(isStoryCqMessage(cqText("普通正文")), false);
assert.equal(isStoryCqMessage(imageMessage), true, "所有 CQ 过滤应覆盖导入后已结构化的图片");
assert.equal(isStoryMessageFiltered(audioMessage, { hideAudio: true }), true);
assert.equal(isStoryMessageFiltered(cqText("[CQ:face,id=14]"), { hideCqCodes: true }), true);
assert.equal(
	getClientIp(forwardedRequest("127.0.0.1", "198.51.100.20") as never, ["127.0.0.1/32"]),
	"198.51.100.20",
	"可信反代应传递客户端 IP",
);

async function rejects(action: () => Promise<unknown>, pattern: RegExp) {
	await assert.rejects(action, pattern);
}

const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
const document = storyFromLogItems([], [], { title: "安全往返 </script> 测试" });
document.author = "雪桃 & Lorana Tales";
document.id = "document-roundtrip";
document.createdAt = "2026-08-27T00:00:00.000Z";
document.updatedAt = "2026-08-27T01:02:03.000Z";
document.source = { kind: "file", name: "原日志.txt", revision: "r2" };
document.settings.autoplay = true;
document.settings.streamEnabled = true;
document.characters.push({
	id: "alice",
	name: "爱丽丝",
	imUserId: "12345678",
	position: "left",
	color: "#22aa88",
	paletteId: "ocean",
	bubblePaletteId: "forest",
	avatar: { id: "avatar-one", mime: "image/png", name: "avatar.png", width: 100, height: 100 },
	avatarSource: "package",
	narratorAvatar: false,
	isNarrator: false,
	isDice: false,
	hidden: false,
});
document.messages.push(
	{
		id: "message-text",
		characterId: "alice",
		time: 123,
		timeText: "00:00:00",
		sourceFingerprint: "source-1",
		sourcePartText: "原始分段",
		locallyInserted: true,
		kind: "text",
		text: "你好，世界！",
		performance: {
			durationMs: 1200,
			typingDurationMs: 480,
			stream: true,
			tokenDelays: { 0: -20, 1: 80 },
			tokenGroups: [{ start: 0, end: 2 }],
			effects: [
				{ id: "message-effect-1", delayMs: 0, textAnimation: "impact", screen: { effect: "damage", color: "purple", durationMs: 500, speedPercent: 120, repeat: 1 } },
				{ id: "message-effect-2", delayMs: 420, interaction: { effect: "heart", targetCharacterId: "character-narrator", emoji: "❤", reaction: "affection", color: "pink", speedPercent: 135 } },
			],
		},
	},
	{
		id: "message-image",
		characterId: "alice",
		time: 456,
		kind: "image",
		asset: { id: "image-two", mime: "image/png", name: "same.png", width: 640, height: 480 },
		alt: "测试图片",
		performance: { imagePreview: { openAfterMs: 100, durationMs: 1500 }, replyPreview: { durationMs: 800 } },
		replyToId: "message-text",
	},
);
document.effectTracks.push({ id: "effect-one", effect: "low-health", color: "orange", startMessageId: "message-text", endMessageId: "message-image" });
document.characterStateEvents.push({ id: "state-one", characterId: "alice", state: "dead", afterMessageId: "message-text", label: "阵亡" });
const archive: StoryArchive = { document, assets: new Map([["avatar-one", bytes], ["image-two", bytes]]) };

assert.equal(
	storyStreamingText("开始[CQ:at,qq=12345678] [CQ:face,id=14] [CQ:image,file=expired] [CQ:unknown,payload=very-long]结束", document.characters, true),
	"开始@爱丽丝 【表情】 【图片】 【消息资源】结束",
	"所有 CQ 码都应在流式输出前原子化为最终可见内容",
);

const blob = await createStoryPackage(archive);
const packed = new Uint8Array(await blob.arrayBuffer());
const entries = unzipSync(packed);
assert.ok(entries["manifest.lorana"]);
assert.ok(entries["metadata.lorana"]);
assert.ok(entries["story.lorana"]);
const storySource = strFromU8(entries["story.lorana"]);
const manifestSource = strFromU8(entries["manifest.lorana"]);
const metadataSource = strFromU8(entries["metadata.lorana"]);
assert.doesNotMatch(storySource, /\b(?:title|author)="/);
assert.match(manifestSource, /<package [^>]*metadata="metadata\.lorana"/);
assert.match(metadataSource, /<metadata [^>]*title="安全往返 <\/script> 测试" author="雪桃 & Lorana Tales"/);
assert.match(storySource, /<roles>[\s\S]*<\/roles>/, "角色应使用缩进包裹结构");
assert.match(storySource, /<effects>[\s\S]*delay="420ms"[\s\S]*<msg [^>]+>[\s\S]*<\/msg>[\s\S]*<\/effects>/, "叠加特效应包裹对应消息");
assert.match(storySource, /<time duration="1200ms"\s*\/>/, "停留时间应使用自闭合结构");
assert.equal(Object.keys(entries).filter((name) => name.startsWith("assets/")).length, 1, "相同内容必须只保存一份");
assert.doesNotMatch(strFromU8(entries["story.lorana"]), /\{\s*"/);

const restored = await readStoryPackage(packed);
assert.equal(restored.document.title, document.title);
assert.equal(restored.document.author, document.author);
assert.equal(restored.document.updatedAt, document.updatedAt);
assert.equal(restored.document.source.kind, document.source.kind);
assert.equal(restored.document.source.name, document.source.name);
assert.equal(restored.document.source.revision, document.source.revision);
assert.equal(restored.document.characters.find((item) => item.id === "alice")?.avatarSource, "package");
assert.equal(restored.document.messages[0].performance?.effects?.length, 2);
assert.equal(restored.document.messages[0].performance?.effects?.[0]?.screen?.effect, "damage");
assert.equal(restored.document.messages[0].performance?.typingDurationMs, 480);
assert.equal(restored.document.messages[0].performance?.effects?.[0]?.screen?.color, "purple");
assert.equal(restored.document.effectTracks[0]?.color, "orange");
assert.equal(restored.document.messages[0].performance?.effects?.[1]?.interaction?.reaction, "affection");
assert.equal(restored.document.messages[0].performance?.effects?.[1]?.delayMs, 420);
assert.equal(restored.document.characterStateEvents[0]?.state, "dead");
assert.equal(restored.document.characterStateEvents[0]?.label, "阵亡");
assert.equal(restored.document.messages[0].sourcePartText, "原始分段");
assert.equal(restored.document.messages[1].performance?.imagePreview?.durationMs, 1500);
assert.equal(restored.assets.get("avatar-one")?.byteLength, bytes.byteLength);
assert.equal(restored.assets.get("image-two")?.byteLength, bytes.byteLength);

const database = new Database(":memory:");
const accountStore = new AccountStore(database);
const testUser = await accountStore.createUser({ email: "format-test@example.invalid", username: "format-test", nickname: "格式测试", password: "not-a-real-password" });
const binaryProject = accountStore.createProject(testUser.id, "二进制工程", Buffer.from(packed));
assert.ok(Buffer.isBuffer(binaryProject?.document));
assert.deepEqual(new Uint8Array(binaryProject!.document as Buffer), packed);
const legacyProject = accountStore.createProject(testUser.id, "旧工程", { language: "legacy", assets: [] });
assert.deepEqual(legacyProject?.document, { language: "legacy", assets: [] });
assert.equal(accountStore.updateUser(testUser.id, { retentionDaysOverride: 14, authorSignature: "格式测试作者" })?.retentionDaysOverride, 14);
assert.equal(accountStore.getUserById(testUser.id)?.authorSignature, "格式测试作者");
database.prepare("UPDATE editor_projects SET last_activity_at = ? WHERE id = ?").run("2020-01-01T00:00:00.000Z", legacyProject!.id);
const cleanupResult = accountStore.cleanupInactiveProjects((user) => user.retentionDaysOverride ?? 30);
assert.equal(cleanupResult.deletedProjects, 1);
assert.equal(accountStore.getProject(testUser.id, legacyProject!.id), null);
assert.ok(accountStore.getProject(testUser.id, binaryProject!.id));

const trustedDeviceAgent = "Lorana-Trusted-Device-Test";
const trustedDevicePrefix = "127.0.0.0/24";
const trustedDevice = accountStore.createTrustedDevice(testUser.id, trustedDevicePrefix, trustedDeviceAgent, 90);
const trustedSession = accountStore.createSession(testUser, {
	sessionDays: 30,
	deviceToken: trustedDevice,
	ipPrefix: trustedDevicePrefix,
	userAgent: trustedDeviceAgent,
});
const accountService = new AccountService(accountStore, {
	session_days: 30,
	trusted_device_days: 90,
	cookie_same_site: "lax",
	captcha_provider: "image",
	encryption_key: "test-only-encryption-key-that-is-long-enough",
});
const accountApp = express();
accountApp.use(express.raw({ type: "application/json", limit: "1mb" }));
accountService.register(accountApp);
const accountServer = accountApp.listen(0, "127.0.0.1");
await once(accountServer, "listening");
try {
	const address = accountServer.address();
	assert.ok(address && typeof address === "object");
	const accountBase = `http://127.0.0.1:${address.port}`;
	const authCookie = `scardice_account_session=${trustedSession.token}; scardice_account_device=${trustedDevice}; scardice_account_csrf=${trustedSession.csrfToken}`;
	const shareResponse = await fetch(`${accountBase}/api/account/projects/${binaryProject!.id}/share`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"user-agent": trustedDeviceAgent,
			"x-csrf-token": trustedSession.csrfToken,
			cookie: authCookie,
		},
		body: JSON.stringify({ expiryMode: "fixed", durationDays: 1 }),
	});
	assert.equal(shareResponse.status, 200);
	const share = await shareResponse.json() as { token: string };
	const publicShareResponse = await fetch(`${accountBase}/api/shared-projects/${share.token}`);
	assert.equal(publicShareResponse.status, 200, "有效分享链接应直接返回播放器工程");
	const permanentShareResponse = await fetch(`${accountBase}/api/account/projects/${binaryProject!.id}/share`, {
		method: "POST",
		headers: { "content-type": "application/json", "user-agent": trustedDeviceAgent, "x-csrf-token": trustedSession.csrfToken, cookie: authCookie },
		body: JSON.stringify({ expiryMode: "never" }),
	});
	assert.equal(permanentShareResponse.status, 400, "服务端必须拒绝永久分享模式");
	const overlongShareResponse = await fetch(`${accountBase}/api/account/projects/${binaryProject!.id}/share`, {
		method: "POST",
		headers: { "content-type": "application/json", "user-agent": trustedDeviceAgent, "x-csrf-token": trustedSession.csrfToken, cookie: authCookie },
		body: JSON.stringify({ expiryMode: "fixed", durationDays: 30 }),
	});
	assert.equal(overlongShareResponse.status, 400, "固定分享期限不得超过工程到期时间");
	database.prepare("UPDATE editor_project_shares SET expiry_mode = ?, expires_at = ? WHERE project_id = ?").run("never", "2099-01-01T00:00:00.000Z", binaryProject!.id);
	const legacyPermanentShareResponse = await fetch(`${accountBase}/api/shared-projects/${share.token}`);
	assert.equal(legacyPermanentShareResponse.status, 410, "历史永久分享记录不得继续公开访问");
	accountStore.updateUser(testUser.id, { retentionDaysOverride: 0 });
	const permanentProjectFollowResponse = await fetch(`${accountBase}/api/account/projects/${binaryProject!.id}/share`, {
		method: "POST",
		headers: { "content-type": "application/json", "user-agent": trustedDeviceAgent, "x-csrf-token": trustedSession.csrfToken, cookie: authCookie },
		body: JSON.stringify({ expiryMode: "project" }),
	});
	assert.equal(permanentProjectFollowResponse.status, 400, "永久保留工程不得创建无期限的跟随分享");
	database.prepare("UPDATE editor_project_shares SET expiry_mode = ?, expires_at = ? WHERE project_id = ?").run("fixed", "2020-01-01T00:00:00.000Z", binaryProject!.id);
	const expiredShareResponse = await fetch(`${accountBase}/api/shared-projects/${share.token}`);
	assert.equal(expiredShareResponse.status, 410, "过期分享链接应明确返回 410");

	const logoutResponse = await fetch(`${accountBase}/api/account/logout`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"user-agent": trustedDeviceAgent,
			"x-csrf-token": trustedSession.csrfToken,
			cookie: `scardice_account_session=${trustedSession.token}; scardice_account_device=${trustedDevice}; scardice_account_csrf=${trustedSession.csrfToken}`,
		},
		body: "{}",
	});
	assert.equal(logoutResponse.status, 200);
	const logoutCookies = logoutResponse.headers.getSetCookie();
	assert.ok(logoutCookies.some((value) => value.startsWith("scardice_account_session=")));
	assert.ok(logoutCookies.some((value) => value.startsWith("scardice_account_csrf=")));
	assert.ok(!logoutCookies.some((value) => value.startsWith("scardice_account_device=")), "登出不应忘记受信任设备");

	const reloginResponse = await fetch(`${accountBase}/api/account/login`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"user-agent": trustedDeviceAgent,
			cookie: `scardice_account_device=${trustedDevice}`,
		},
		body: JSON.stringify({ email: testUser.email, password: "not-a-real-password" }),
	});
	assert.equal(reloginResponse.status, 200, "同一浏览器和网段再次登录不应要求邮件验证码");
} finally {
	accountServer.close();
	await once(accountServer, "close");
}
database.close();

const withUnknownFile = { ...entries, "unlisted.bin": new Uint8Array([1]) };
await rejects(() => readStoryPackage(zipSync(withUnknownFile)), /清单外文件/);
await rejects(() => readStoryPackage(zipSync({ ...entries, "../escape.bin": new Uint8Array([1]) })), /不安全路径/);
const compressedBomb = zipSync({ "story.lorana": new Uint8Array(2 * 1024 * 1024) }, { level: 9 });
await rejects(() => readStoryPackage(compressedBomb), /压缩率异常/);

const executableStoryEntries = { ...entries };
executableStoryEntries["story.lorana"] = strToU8(`${strFromU8(entries["story.lorana"])}\n<script src="https://example.invalid/evil.js">\n`);
await rejects(() => readStoryPackage(zipSync(executableStoryEntries)), /无法识别/);

const badHashEntries = { ...entries };
badHashEntries["manifest.lorana"] = strToU8(strFromU8(entries["manifest.lorana"]).replace(/sha256:[a-f0-9]{64}/, `sha256:${"0".repeat(64)}`));
await rejects(() => readStoryPackage(zipSync(badHashEntries)), /完整性校验失败/);

const html = await createPerformanceHtml(
	restored,
	async (ref) => ref && restored.assets.has(ref.id) ? "data:image/png;base64,iVBORw0KGgo=" : "",
	async (character: StoryCharacter) => character.avatar ? "data:image/png;base64,iVBORw0KGgo=" : "",
	Object.fromEntries(["arcaneParry","bloodLensOverlay","bloodSplatter01","bloodSplatter02","bulletStrip","crescentSlash","electricImpact","lensRaindrops","magicalProjectile","radiantHeal","rainField","rainOverlay"].map((key)=>[key,"data:image/png;base64,iVBORw0KGgo="])),
);
assert.match(html, /Content-Security-Policy/);
assert.match(html, /"author":"雪桃 & Lorana Tales"/);
assert.match(html, /作者：/);
assert.match(html, /id="next"/);
assert.match(html, /id="volume"/);
assert.match(html, /id="fullscreen"/);
assert.match(html, /fullscreenButton&&fullscreenButton\.remove\(\)/, "离线播放器应在启动后移除废弃的全屏按钮");
assert.match(html, /这个演出没有开启自动播放/, "离线播放器应提示手动推进");
assert.match(html, /播放完成/, "离线播放器应在末条消息稳定显示后展示完成态");
assert.match(html, /persistent-layer/);
assert.match(html, /characterStateByMessage/);
assert.match(html, /reaction-affection/);
assert.match(html, /typingDurationMs/);
assert.match(html, /function scheduleEffects\(m\)/, "离线播放器必须调度多段特效");
assert.match(html, /v5-html-snow/, "离线播放器必须包含连续飘雪动画");
assert.match(html, /lensRaindrops/, "离线播放器必须内嵌镜头雨痕资源");
assert.match(html, /bloodLensOverlay/, "离线播放器必须内嵌镜头血迹资源");
assert.match(html, /html-game-rain/, "离线播放器必须包含动态降雨运行时");
assert.match(html, /html-game-snow/, "离线播放器必须包含分层飘雪运行时");
assert.match(html, /html-magic-plane/, "离线播放器必须包含侧前方法阵运行时");
assert.doesNotMatch(html, /<\/script>\s*测试/);
assert.doesNotMatch(html, /https?:\/\//);
const scripts = [...html.matchAll(/<script(?: [^>]*)?>([\s\S]*?)<\/script>/g)];
assert.ok(scripts.length >= 2, "离线 HTML 应包含数据载荷和播放器运行时");
new vm.Script(scripts.at(-1)![1], { filename: "lorana-offline-runtime.js" });
if (process.env.LORANA_QA_HTML) await writeFile(process.env.LORANA_QA_HTML, html, "utf-8");

const largeDocument = structuredClone(restored.document);
largeDocument.messages = Array.from({ length: 10_000 }, (_, index) => ({
	id: `large-${index}`,
	characterId: "alice",
	time: index,
	kind: "text" as const,
	text: `第 ${index + 1} 条性能验证消息`,
}));
largeDocument.effectTracks = [];
largeDocument.characterStateEvents = [];
const largeHtml = await createPerformanceHtml({ document: largeDocument, assets: new Map() }, async () => "", async () => "");
assert.match(largeHtml, /const windowSize=360/);
assert.match(largeHtml, /"id":"large-9999"/);

const tutorialDirectory = resolve("web/public/tutorials");
const tutorialCatalog = JSON.parse(await readFile(resolve(tutorialDirectory, "catalog.json"), "utf8")) as {
	categories: Array<{ id: string }>;
	tutorials: Array<{ id: string; category: string; file: string }>;
};
assert.equal(tutorialCatalog.categories.length, 4, "内置教程应保持四个清晰分类");
assert.equal(tutorialCatalog.tutorials.length, 12, "内置教程包数量不完整");
for (const tutorial of tutorialCatalog.tutorials) {
	assert.ok(tutorialCatalog.categories.some((category) => category.id === tutorial.category), `${tutorial.id} 的分类不存在`);
	const tutorialArchive = await readStoryPackage(await readFile(resolve(tutorialDirectory, tutorial.file)));
	assert.ok(tutorialArchive.document.messages.length >= 3, `${tutorial.id} 没有足够的演示消息`);
	const avatarRefs = tutorialArchive.document.characters.map((character) => character.avatar).filter(Boolean);
	assert.ok(avatarRefs.length >= 3, `${tutorial.id} 缺少多角色头像`);
	for (const avatar of avatarRefs) assert.ok(tutorialArchive.assets.has(avatar!.id), `${tutorial.id} 未内嵌头像 ${avatar!.id}`);
	assert.equal(tutorialArchive.document.settings.typingIndicatorEnabled, tutorial.id === "record", `${tutorial.id} 的输入提示策略错误`);
}

console.log(`SSP v2 round-trip, validation, offline HTML, 10,000-message and ${tutorialCatalog.tutorials.length}-tutorial package checks passed (${packed.byteLength} bytes).`);
