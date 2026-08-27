import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import vm from "node:vm";
import Database from "better-sqlite3";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

import { AccountStore } from "../src/accounts/account-store";
import { storyFromLogItems } from "../web/src/story/model";
import { createStoryPackage, readStoryPackage } from "../web/src/story/package";
import { createPerformanceHtml } from "../web/src/story/standalone-performance";
import type { StoryArchive, StoryCharacter } from "../web/src/story/types";

async function rejects(action: () => Promise<unknown>, pattern: RegExp) {
	await assert.rejects(action, pattern);
}

const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
const document = storyFromLogItems([], [], { title: "安全往返 </script> 测试" });
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
			stream: true,
			tokenDelays: { 0: -20, 1: 80 },
			tokenGroups: [{ start: 0, end: 2 }],
			tokenAnimation: "impact",
			screenEffect: "damage",
			screenEffectColor: "purple",
			interaction: { effect: "heart", targetCharacterId: "character-narrator", emoji: "❤" },
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
const archive: StoryArchive = { document, assets: new Map([["avatar-one", bytes], ["image-two", bytes]]) };

const blob = await createStoryPackage(archive);
const packed = new Uint8Array(await blob.arrayBuffer());
const entries = unzipSync(packed);
assert.ok(entries["manifest.lorana"]);
assert.ok(entries["story.lorana"]);
assert.equal(Object.keys(entries).filter((name) => name.startsWith("assets/")).length, 1, "相同内容必须只保存一份");
assert.doesNotMatch(strFromU8(entries["story.lorana"]), /\{\s*"/);

const restored = await readStoryPackage(packed);
assert.equal(restored.document.title, document.title);
assert.equal(restored.document.updatedAt, document.updatedAt);
assert.equal(restored.document.source.kind, document.source.kind);
assert.equal(restored.document.source.name, document.source.name);
assert.equal(restored.document.source.revision, document.source.revision);
assert.equal(restored.document.characters.find((item) => item.id === "alice")?.avatarSource, "package");
assert.equal(restored.document.messages[0].performance?.screenEffect, "damage");
assert.equal(restored.document.messages[0].performance?.screenEffectColor, "purple");
assert.equal(restored.document.effectTracks[0]?.color, "orange");
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
database.close();

const withUnknownFile = { ...entries, "unlisted.bin": new Uint8Array([1]) };
await rejects(() => readStoryPackage(zipSync(withUnknownFile)), /清单外文件/);
await rejects(() => readStoryPackage(zipSync({ ...entries, "../escape.bin": new Uint8Array([1]) })), /不安全路径/);

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
);
assert.match(html, /Content-Security-Policy/);
assert.match(html, /id="next"/);
assert.match(html, /id="volume"/);
assert.match(html, /id="fullscreen"/);
assert.match(html, /persistent-layer/);
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
const largeHtml = await createPerformanceHtml({ document: largeDocument, assets: new Map() }, async () => "", async () => "");
assert.match(largeHtml, /const windowSize=360/);
assert.match(largeHtml, /"id":"large-9999"/);

console.log(`SSP v2 round-trip, deduplication, validation, offline HTML and 10,000-message generation checks passed (${packed.byteLength} bytes).`);
