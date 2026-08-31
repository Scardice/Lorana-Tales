import { expect, test, type Page } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { deflateSync } from "node:zlib";

const errors: string[] = [];

async function openCleanStory(page: Page) {
	errors.length = 0;
	page.on("console", message => {
		if (message.type() === "error" && !message.text().includes("status of 404")) errors.push(message.text());
	});
	page.on("pageerror", error => errors.push(error.message));
	page.on("response", response => {
		if (response.status() >= 400 && !response.url().includes("/api/editor/cq-face/") && !response.url().endsWith("/api/account/config")) errors.push(`${response.status()} ${response.url()}`);
	});
	await page.addInitScript(() => {
		localStorage.clear();
		indexedDB.deleteDatabase("lorana-story-drafts");
		document.cookie = "lorana_tutorial_prompt_seen=1; Path=/; Max-Age=315360000; SameSite=Lax";
	});
	await page.goto("/story?e2e=1", { waitUntil: "networkidle" });
	await expect(page.getByText("还没有消息。请从下方选择角色并开始写作。")).toBeVisible();
}

async function assertViewportIntegrity(page: Page) {
	const result = await page.evaluate(() => {
		const root = document.documentElement;
		const visibleControls = [...document.querySelectorAll<HTMLElement>("button,input,textarea,select,[role=menu],[role=dialog]")]
			.filter(element => {
				const style = getComputedStyle(element);
				const rect = element.getBoundingClientRect();
				if (style.visibility === "hidden" || style.display === "none" || rect.width <= 0 || rect.height <= 0) return false;
				const x = Math.min(innerWidth - 1, Math.max(0, rect.left + Math.min(rect.width / 2, 12)));
				const y = Math.min(innerHeight - 1, Math.max(0, rect.top + Math.min(rect.height / 2, 12)));
				const topmost = document.elementFromPoint(x, y);
				return !!topmost && (topmost === element || element.contains(topmost));
			});
		const clipped = visibleControls.filter(element => {
			const rect = element.getBoundingClientRect();
			let parent = element.parentElement;
			while (parent) {
				if (["auto", "scroll"].includes(getComputedStyle(parent).overflowX)) return false;
				parent = parent.parentElement;
			}
			return rect.right > innerWidth + 2 || rect.left < -2;
		}).map(element => ({ text: element.innerText || element.getAttribute("aria-label"), rect: element.getBoundingClientRect().toJSON() }));
		return {
			documentOverflow: root.scrollWidth - root.clientWidth,
			bodyOverflow: document.body.scrollWidth - document.body.clientWidth,
			clipped,
		};
	});
	expect(result.documentOverflow).toBeLessThanOrEqual(1);
	expect(result.bodyOverflow).toBeLessThanOrEqual(1);
	expect(result.clipped).toEqual([]);
}

async function setDarkTheme(page: Page, dark: boolean) {
	const html = page.locator("html");
	const current = await html.evaluate(element => element.classList.contains("dark"));
	if (current !== dark) {
		await page.getByRole("navigation", { name: "作品工具栏" }).getByRole("button", { name: "更多" }).click();
		await page.getByText("界面与输入设置", { exact: true }).click();
		const settings = page.locator(".settings-modal");
		const appearance = settings.locator(".settings-group").filter({ hasText: "外观" });
		await appearance.locator(".n-select").click();
		await page.getByText(dark ? "深色" : "浅色", { exact: true }).last().click();
		await page.getByRole("button", { name: "关闭设置" }).click();
	}
	if (dark) await expect(html).toHaveClass(/dark/);
	else await expect(html).not.toHaveClass(/dark/);
}

async function addTextMessage(page: Page, text: string) {
	const input = page.getByRole("textbox", { name: "请输入文本" });
	await input.fill(text);
	const send = page.getByRole("button", { name: "发送" });
	await expect(send).toBeVisible();
	await send.click();
	await expect(page.getByText(text, { exact: true })).toBeVisible();
}

test.describe("Lorana Tales story editor", () => {
	test("desktop edit, theme, menus, source and player", async ({ page }) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		await openCleanStory(page);
		await setDarkTheme(page, true);
		await expect(page.getByText(/0 条消息 · 0 个角色 · 0 字/)).toBeVisible();
		await assertViewportIntegrity(page);

		await page.getByRole("button", { name: "修改故事名" }).click();
		const title = page.getByLabel("故事名");
		await title.fill("端到端测试故事");
		await title.press("Enter");
		await expect(page.locator(".story-title strong")).toHaveText("端到端测试故事");

		await addTextMessage(page, "第一条测试消息");
		await expect(page.getByText(/1 条消息 · 0 个角色 · 7 字/)).toBeVisible();
		const firstMessage = page.locator("article.story-message").first();
		await firstMessage.getByRole("button", { name: "消息操作" }).click();
		await page.getByRole("menuitem", { name: "编辑" }).click();
		const inlineEditor = firstMessage.locator(".bubble--editing textarea");
		await expect(inlineEditor).toBeVisible();
		expect(await firstMessage.locator(".bubble--editing").evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThanOrEqual(250);
		await expect(firstMessage.getByRole("button", { name: "确认" })).toBeVisible();
		await expect(firstMessage.getByRole("button", { name: "取消" })).toBeVisible();
		await page.locator(".story-title").click();
		await expect(inlineEditor).toBeHidden();
		await firstMessage.getByRole("button", { name: "消息操作" }).click();
		await page.getByRole("menuitem", { name: "编辑" }).click();
		await inlineEditor.fill("第一条测试消息（已编辑）");
		await inlineEditor.press("Enter");
		await expect(firstMessage.getByText("第一条测试消息（已编辑）", { exact: true })).toBeVisible();

		await page.getByRole("button", { name: "新增角色" }).click();
		await expect(page.getByRole("heading", { name: "创建角色" })).toBeVisible();
		await page.getByPlaceholder("输入角色名").fill("测试角色");
		await page.getByRole("button", { name: "保存" }).click();
		await expect(page.getByText("测试角色", { exact: true })).toBeVisible();

		await page.getByRole("navigation", { name: "作品工具栏" }).getByRole("button", { name: "更多" }).click();
		await expect(page.getByText("教程中心", { exact: true })).toBeVisible();
		await expect(page.getByText("界面与输入设置", { exact: true })).toBeVisible();
		await page.getByText("界面与输入设置", { exact: true }).click();
		await expect(page.getByText("界面设置", { exact: true })).toBeVisible();
		await expect(page.locator(".settings-modal").getByRole("button", { name: "教程", exact: true })).toHaveCount(0);
		await assertViewportIntegrity(page);
		await page.getByRole("button", { name: "关闭设置" }).click();

		await page.getByRole("button", { name: "编辑原始语法" }).click();
		await expect(page.getByText("原始语法", { exact: true })).toBeVisible();
		await expect(page.getByText("已实时同步到图形预览")).toBeVisible();
		await page.locator(".raw-pane button.primary").click();
		await page.waitForTimeout(300);

		await expect(page.getByRole("button", { name: /全屏编辑/ })).toHaveCount(0);

		await setDarkTheme(page, false);
		await assertViewportIntegrity(page);
		await page.screenshot({ path: "test-results/story-desktop-light.png", fullPage: true });

		await page.getByRole("button", { name: "演出编辑" }).click();
		await expect(page.getByRole("button", { name: "← 返回" })).toBeVisible();
		await expect(page.locator(".player>header").getByText("端到端测试故事", { exact: true })).toBeVisible();
		await assertViewportIntegrity(page);
		await page.getByRole("button", { name: "演出设置", exact: true }).click();
		await page.waitForTimeout(300);
		const performanceSettings = page.getByLabel("演出设置", { exact: true });
		await expect(performanceSettings.getByText("播放与计时", { exact: true })).toBeVisible();
		await expect(performanceSettings.getByText("流式输出", { exact: true })).toBeVisible();
		await expect(performanceSettings.getByText("输入提示", { exact: true })).toBeVisible();
		const performanceInputBackground = await performanceSettings.locator(".n-input").first().evaluate(element => getComputedStyle(element).backgroundColor);
		const performanceInputRgb = performanceInputBackground.match(/\d+(?:\.\d+)?/g)?.slice(0, 3).map(Number) || [];
		expect(performanceInputRgb).toHaveLength(3);
		expect(Math.min(...performanceInputRgb)).toBeGreaterThan(220);
		await assertViewportIntegrity(page);
		await page.screenshot({ path: "test-results/story-performance-settings-light.png", fullPage: true });
		await page.getByRole("button", { name: "关闭演出设置" }).click();
		await page.getByRole("button", { name: "界面设置", exact: true }).click();
		const playerDisplaySettings = page.getByLabel("演出界面设置");
		for (const heading of ["画布与排版", "头像与消息", "内容过滤", "外观"]) await expect(playerDisplaySettings.getByText(heading, { exact: true })).toBeVisible();
		await page.screenshot({ path: "test-results/story-player-display-settings-light.png", fullPage: true });
		await playerDisplaySettings.getByRole("button", { name: "关闭界面设置" }).click();

		await page.getByRole("banner").getByRole("button", { name: "演出编辑", exact: true }).click();
		await page.locator("article.player-message").first().click();
		const performanceModal = page.locator(".performance-modal");
		await expect(performanceModal.getByText("消息演出编排", { exact: true })).toBeVisible();
		await page.waitForTimeout(300);
		await expect(performanceModal.getByRole("button", { name: "关闭消息演出编排" })).toBeVisible();
		await expect(performanceModal.getByRole("button", { name: "清除编排" })).toBeVisible();
		await expect(performanceModal.getByRole("button", { name: "保存" })).toBeVisible();
		await performanceModal.getByRole("button", { name: "添加一段" }).click();
		await performanceModal.getByRole("button", { name: "选择特效" }).click();
		const effectSelectionModal = page.locator(".effect-selection-modal");
		const effectPicker = effectSelectionModal.getByLabel("特效选择");
		await effectPicker.getByRole("button", { name: "屏幕特效" }).click();
		await effectPicker.getByRole("button", { name: /中心绽放/ }).click();
		await effectPicker.getByRole("button", { name: "绯红" }).click();
		await effectPicker.getByRole("button", { name: "互动特效" }).click();
		await expect(effectPicker.getByText("双方头像会在独立动画层中互动，不推动消息布局", { exact: true })).toBeVisible();
		await expect(effectPicker.getByText("发送者", { exact: true })).toBeVisible();
		const interactionTargetSelect = effectPicker.locator(".brush-interaction-target .n-base-selection");
		await interactionTargetSelect.click();
		await page.locator(".n-base-select-option").filter({ hasText: "测试角色" }).click();
		await expect(effectPicker.getByRole("button", { name: /投掷 Emoji/ })).toBeVisible();
		await expect(effectPicker.getByRole("button", { name: /晕倒/ })).toBeVisible();
		for (const [effect, reaction] of [
			["投掷 Emoji", "踉跄"],
			["贴近爱心", "贴近回应"],
			["施放法术", "踉跄"],
			["展开法阵", "不回应"],
			["突然惊吓", "跳起来"],
			["近身冲击", "踉跄"],
			["高速子弹", "晕倒"],
			["飞掷刀刃", "晕倒"],
		] as const) {
			await effectPicker.getByRole("button", { name: new RegExp(effect) }).click();
			await expect(effectPicker.getByRole("button", { name: new RegExp(reaction) })).toHaveClass(/active/);
		}
		await effectPicker.getByRole("button", { name: /施放法术/ }).click();
		await expect(effectPicker.getByRole("button", { name: /踉跄/ })).toHaveClass(/active/);
		await effectPicker.getByRole("button", { name: "重播互动特效" }).click();
		await effectPicker.locator(".interaction-preview").evaluate(element => {
			const source = element.querySelector(".interaction-preview__actor--source") as HTMLElement;
			const target = element.querySelector(".interaction-preview__actor--target") as HTMLElement;
			const projectile = element.querySelector(".interaction-preview__projectile") as HTMLElement;
			for (const node of [source, target, projectile]) { const animation=node.getAnimations()[0]; if(animation){ animation.pause(); const duration=Number(animation.effect?.getTiming().duration)||2600; animation.currentTime=duration*.05; } }
		});
		await page.waitForTimeout(20);
		const interactionLayers = await effectPicker.locator(".interaction-preview").evaluate(element => {
			const source = element.querySelector(".interaction-preview__actor--source") as HTMLElement;
			const target = element.querySelector(".interaction-preview__actor--target") as HTMLElement;
			const projectile = element.querySelector(".interaction-preview__projectile") as HTMLElement;
			return { sourceOpacity:Number(getComputedStyle(source).opacity),targetOpacity:Number(getComputedStyle(target).opacity),sourceZ:getComputedStyle(source).zIndex,targetZ:getComputedStyle(target).zIndex,projectileZ:getComputedStyle(projectile).zIndex,sourceAnimation:getComputedStyle(source).animationName,targetAnimation:getComputedStyle(target).animationName,targetDelay:getComputedStyle(target).animationDelay };
		});
		expect(interactionLayers.sourceAnimation).toContain("v10-preview-source");
		expect(interactionLayers.targetAnimation).toContain("v10-preview-target-stagger");
		expect(interactionLayers.targetDelay).toBe("0s");
		expect(interactionLayers.sourceOpacity).toBeGreaterThan(.8);
		expect(interactionLayers.targetOpacity).toBeGreaterThan(.8);
		expect(interactionLayers.sourceZ).toBe(interactionLayers.targetZ);
		expect(Number(interactionLayers.projectileZ)).toBeGreaterThan(Number(interactionLayers.targetZ));
		const playerInteraction = page.locator(".interaction-scene");
		await expect(playerInteraction).toBeVisible();
		await playerInteraction.evaluate(element => {
			for (const node of element.querySelectorAll<HTMLElement>(".interaction-character,.interaction-projectile")) { const animation=node.getAnimations()[0]; if(animation){ animation.pause(); const duration=Number(animation.effect?.getTiming().duration)||2600; animation.currentTime=duration*.05; } }
		});
		await page.waitForTimeout(20);
		const playerLayers = await playerInteraction.evaluate(element => {
			const source=element.querySelector(".interaction-character--source") as HTMLElement,target=element.querySelector(".interaction-character--target") as HTMLElement,projectile=element.querySelector(".interaction-projectile") as HTMLElement;
			return {sourceOpacity:Number(getComputedStyle(source).opacity),targetOpacity:Number(getComputedStyle(target).opacity),sourceZ:getComputedStyle(source).zIndex,targetZ:getComputedStyle(target).zIndex,projectileZ:getComputedStyle(projectile).zIndex,sourceAnimation:getComputedStyle(source).animationName,targetAnimation:getComputedStyle(target).animationName};
		});
		expect(playerLayers.sourceOpacity).toBeGreaterThan(.8);
		expect(playerLayers.targetOpacity).toBeGreaterThan(.8);
		expect(playerLayers.sourceZ).toBe(playerLayers.targetZ);
		expect(Number(playerLayers.projectileZ)).toBeGreaterThan(Number(playerLayers.targetZ));
		expect(playerLayers.sourceAnimation).toContain("v10-player-source");
		expect(playerLayers.targetAnimation).toContain("v10-target-stagger");
		await effectPicker.getByRole("button", { name: "重播互动特效" }).click();
		await page.waitForTimeout(120);
		await effectPicker.locator(".interaction-preview__projectile").evaluate(element => { const animation=element.getAnimations()[0]; if(animation){animation.pause();const duration=Number(animation.effect?.getTiming().duration)||2600;animation.currentTime=duration*.21;} });
		await expect(effectPicker.locator(".magic-array")).toBeVisible();
		expect(Number(await effectPicker.locator(".magic-array").evaluate((element) => getComputedStyle(element).opacity))).toBeGreaterThan(0.5);
		const magicGeometry = await effectPicker.locator(".interaction-preview").evaluate(element => {
			const avatar = element.querySelector(".interaction-preview__actor--source img,.interaction-preview__actor--source>i")!.getBoundingClientRect();
			const array = element.querySelector(".magic-array")!.getBoundingClientRect();
			return { avatarHeight: avatar.height, arrayHeight: array.height, centerDelta: Math.abs((avatar.top + avatar.height / 2) - (array.top + array.height / 2)) };
		});
		expect(magicGeometry.arrayHeight).toBeLessThanOrEqual(magicGeometry.avatarHeight * 1.8);
		expect(magicGeometry.centerDelta).toBeLessThan(10);
		const magicLaunch = await effectPicker.locator(".interaction-preview").evaluate(element => {
			const array = element.querySelector(".magic-array")!.getBoundingClientRect();
			const orb = element.querySelector(".interaction-magic-orb")!.getBoundingClientRect();
			const projectile = element.querySelector(".interaction-preview__projectile")!;
			return { distance: Math.hypot(array.left + array.width / 2 - (orb.left + orb.width / 2), array.top + array.height / 2 - (orb.top + orb.height / 2)), array:{left:array.left,top:array.top,width:array.width,height:array.height},orb:{left:orb.left,top:orb.top,width:orb.width,height:orb.height}, animationName: getComputedStyle(projectile).animationName, animationDuration: getComputedStyle(projectile).animationDuration, transform:getComputedStyle(projectile).transform,translate:getComputedStyle(projectile).translate,currentTime: projectile.getAnimations()[0]?.currentTime };
		});
		expect(magicLaunch.distance).toBeLessThan(16);
		await effectPicker.locator(".interaction-preview").screenshot({ path: "test-results/story-magic-25d-light.png" });
		await effectPicker.getByRole("button", { name: /贴近爱心/ }).click();
		await expect(effectPicker.getByRole("button", { name: /贴近回应/ })).toHaveClass(/active/);
		await effectPicker.getByRole("button", { name: "重播互动特效" }).click();
		await page.waitForTimeout(1100);
		await expect(effectPicker.locator(".interaction-heart-particles")).toHaveCount(1);
		await effectPicker.locator(".interaction-preview").screenshot({ path: "test-results/story-interaction-heart-light.png" });
		await interactionTargetSelect.click();
		await page.locator(".n-base-select-option").filter({ hasText: "无目标" }).click();
		await effectPicker.getByRole("button", { name: /突然惊吓/ }).click();
		await expect(effectPicker.locator(".interaction-surprise-mark")).toHaveText("!");
		await expect(effectPicker.locator(".interaction-preview")).toHaveClass(/interaction-preview--source-only/);
		const targetlessSurpriseOffset = await effectPicker.locator(".interaction-preview").evaluate(element => {
			const sender = element.querySelector(".interaction-preview__actor--source img,.interaction-preview__actor--source>i")!.getBoundingClientRect();
			const mark = element.querySelector(".interaction-preview__projectile")!.getBoundingClientRect();
			return Math.hypot(sender.left + sender.width / 2 - (mark.left + mark.width / 2), sender.top + sender.height / 2 - (mark.top + mark.height / 2));
		});
		expect(targetlessSurpriseOffset).toBeLessThan(26);
		await effectPicker.getByRole("button", { name: /近身冲击/ }).click();
		await effectPicker.getByRole("button", { name: "重播互动特效" }).click();
		await page.waitForTimeout(260);
		expect(await effectPicker.locator(".interaction-preview__actor--source").evaluate(element => getComputedStyle(element).animationName)).toContain("v8-preview-impact-dash");
		expect(await effectPicker.locator(".interaction-preview__projectile").evaluate(element => getComputedStyle(element).animationName)).toContain("v8-preview-impact-contact");
		await effectPicker.getByRole("button", { name: /高速子弹/ }).click();
		const bulletShape = await effectPicker.locator(".interaction-bullet-core").evaluate(element => ({ width: element.getBoundingClientRect().width, clipPath: getComputedStyle(element).clipPath }));
		expect(bulletShape.width).toBeLessThan(50);
		expect(bulletShape.clipPath).not.toBe("none");
		await effectPicker.getByRole("button", { name: /飞掷刀刃/ }).click();
		expect(await effectPicker.locator(".interaction-preview__actor--source").evaluate(element => getComputedStyle(element).animationName)).toContain("v10-preview-source");
		expect(await effectPicker.locator(".interaction-preview__projectile").evaluate(element => getComputedStyle(element).animationName)).toContain("v9-preview-blade");
		const bladeShape = await effectPicker.locator(".interaction-preview__sprite").evaluate(element => ({ background: getComputedStyle(element).backgroundImage, clipPath: getComputedStyle(element).clipPath }));
		expect(bladeShape.background).toContain("linear-gradient");
		expect(bladeShape.clipPath).not.toBe("none");
		await effectPicker.getByRole("button", { name: "重播互动特效" }).click();
		await page.waitForTimeout(850);
		await effectPicker.locator(".interaction-preview").screenshot({ path: "test-results/story-interaction-blade-light.png" });
		await page.screenshot({ path: "test-results/story-interaction-effect-picker-light.png", fullPage: true });
		await effectPicker.getByRole("button", { name: "文本特效" }).click();
		await effectSelectionModal.getByRole("button", { name: "完成" }).click();
		const splittableToken = performanceModal.locator(".token-chip-list button").filter({ hasText: /../ }).first();
		await expect(splittableToken).toBeVisible();
		const tokenCount = await performanceModal.locator(".token-chip-list button").count();
		await splittableToken.click();
		await expect(performanceModal.getByRole("button", { name: "拆分词组" })).toBeEnabled();
		await performanceModal.getByRole("button", { name: "拆分词组" }).click();
		expect(await performanceModal.locator(".token-chip-list button").count()).toBeGreaterThan(tokenCount);
		await assertViewportIntegrity(page);
		await page.screenshot({ path: "test-results/story-performance-message-light.png", fullPage: true });
		await performanceModal.getByRole("button", { name: "取消" }).click();
		await page.setViewportSize({ width: 390, height: 844 });
		await page.getByRole("button", { name: "特效笔刷" }).click();
		await page.getByRole("button", { name: "选择特效", exact: true }).click();
		const brushModal = page.locator(".effect-brush-modal");
		await expect(brushModal.getByText("文字特效", { exact: true })).toBeVisible();
		await expect(brushModal.getByText("屏幕特效", { exact: true })).toBeVisible();
		const brushTabs = await brushModal.locator(".effect-brush-switch-card").evaluateAll(elements => elements.map(element => element.getBoundingClientRect()));
		expect(brushTabs).toHaveLength(3);
		expect(Math.max(...brushTabs.map(rect => rect.top)) - Math.min(...brushTabs.map(rect => rect.top))).toBeLessThan(3);
		expect(brushTabs.at(-1)!.right).toBeLessThanOrEqual(390);
		await brushModal.getByRole("switch", { name: "启用屏幕特效" }).click();
		await expect(brushModal.getByRole("button", { name: "重播特效" }).first()).toBeVisible();
		await page.screenshot({ path: "test-results/story-effect-brush-mobile-light.png", fullPage: true });
		await brushModal.getByRole("button", { name: "完成" }).click();
		await page.setViewportSize({ width: 1280, height: 720 });
		await page.getByRole("button", { name: "持续区间" }).click();
		await page.getByRole("button", { name: "选择区间屏幕特效" }).click();
		const rangeEffectModal = page.getByRole("dialog", { name: "区间屏幕特效" });
		for (const [label, file] of [["下雨", "rain"], ["镜头雨痕", "rain-glass"], ["镜头血迹", "blood"], ["动态飘雪", "snow"]] as const) {
			await rangeEffectModal.getByRole("button", { name: new RegExp(label) }).click();
			await page.waitForTimeout(label === "下雨" || label === "动态飘雪" ? 520 : 900);
			if (label === "下雨" || label === "动态飘雪") {
				const weatherLayer = rangeEffectModal.locator(".preview-weather i").first();
				const before = await weatherLayer.evaluate(element => ({ name: getComputedStyle(element).animationName, animations: element.getAnimations().map(animation => ({ currentTime: Number(animation.currentTime), playState: animation.playState })) }));
				await page.waitForTimeout(240);
				const after = await weatherLayer.evaluate(element => ({ name: getComputedStyle(element).animationName, animations: element.getAnimations().map(animation => ({ currentTime: Number(animation.currentTime), playState: animation.playState })) }));
				expect(after.name).toContain(label === "下雨" ? "v8-preview-rain" : "v7-preview-snow");
				expect(after.animations.some(animation => animation.playState === "running" && animation.currentTime > before.animations[0].currentTime)).toBe(true);
			} else {
				const overlayStyle = await rangeEffectModal.locator(".effect-preview__screen").evaluate(element => ({ animationName: getComputedStyle(element).animationName, backgroundImage: getComputedStyle(element).backgroundImage }));
				expect(overlayStyle.animationName).toContain("v4-preview-overlay-in");
			}
			await rangeEffectModal.locator(".effect-preview").screenshot({ path: `test-results/story-persistent-${file}-light.png` });
		}
		await rangeEffectModal.getByRole("button", { name: "完成" }).click();
		await page.screenshot({ path: "test-results/story-player-light.png", fullPage: true });
		await page.getByRole("button", { name: "← 返回" }).click();
		await expect(page.getByRole("button", { name: "演出编辑" })).toBeVisible();

		await page.getByRole("button", { name: "下载与导出" }).click();
		const sspDownloadPromise = page.waitForEvent("download");
		await page.getByRole("button", { name: /SSP 工程包/ }).click();
		const sspDownload = await sspDownloadPromise;
		expect(sspDownload.suggestedFilename()).toBe("端到端测试故事.ssp");
		const sspPath = await sspDownload.path();
		expect(sspPath).toBeTruthy();
		const sspBytes = await readFile(sspPath!);
		expect(sspBytes.subarray(0, 2).toString("binary")).toBe("PK");

		await page.getByRole("button", { name: "下载与导出" }).click();
		page.once("dialog", async (dialog) => {
			expect(dialog.type()).toBe("prompt");
			expect(dialog.message()).toContain("作者署名");
			await dialog.accept("端到端作者");
		});
		const htmlDownloadPromise = page.waitForEvent("download");
		await page.getByRole("button", { name: "内嵌 HTML" }).click();
		const htmlDownload = await htmlDownloadPromise;
		const htmlPath = await htmlDownload.path();
		expect(htmlPath).toBeTruthy();
		const html = await readFile(htmlPath!, "utf8");
		expect(html).toContain("Content-Security-Policy");
		expect(html).toContain("lorana-performance");
		const offlineHtmlPath = resolve("test-results/lorana-tales-offline.html");
		await writeFile(offlineHtmlPath, html, "utf8");
		const offline = await page.context().newPage();
		await offline.goto(pathToFileURL(offlineHtmlPath).href, { waitUntil: "load" });
		await expect(offline.getByRole("button", { name: "开始演出" })).toBeVisible();
		await expect(offline.locator("#start-title")).toHaveText("端到端测试故事");
		await expect(offline.locator("#start-author")).toHaveText("作者：端到端作者");
		await offline.getByRole("button", { name: "开始演出" }).click();
		await expect(offline.getByText("这个演出没有开启自动播放，请点击画布播放下一句。", { exact: true })).toBeVisible();
		await offline.getByText("这个演出没有开启自动播放，请点击画布播放下一句。", { exact: true }).click();
		await expect(offline.locator("#toggle")).toBeVisible();
		await expect(offline.locator("#autoplay")).toBeVisible();
		await offline.locator("#autoplay").check();
		await expect(offline.locator("#autoplay")).toBeChecked();
		await offline.locator("#autoplay").uncheck();
		await expect(offline.locator("#autoplay")).not.toBeChecked();
		await expect(offline.locator("#counter")).toContainText("/ 1");
		await offline.close();

		expect(errors).toEqual([]);
	});

	test("mobile composer, emoji keyboard, resource popover and message actions", async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await openCleanStory(page);
		await setDarkTheme(page, true);
		await assertViewportIntegrity(page);

		await page.getByRole("button", { name: "表情" }).click();
		const keyboard = page.getByLabel("表情键盘", { exact: true });
		await expect(keyboard.getByText("选择表情", { exact: true })).toBeVisible();
		await keyboard.getByRole("button", { name: "QQ 表情" }).click();
		await expect(keyboard.getByTitle("QQ 表情 0")).toBeVisible();
		await keyboard.getByRole("button", { name: "Emoji" }).click();
		await keyboard.getByRole("button", { name: "😀" }).click();
		await expect(page.getByRole("textbox", { name: "请输入文本" })).toHaveText("😀");
		await keyboard.getByRole("button", { name: "收起表情键盘" }).click();
		await expect(keyboard).toBeHidden();
		await page.getByRole("button", { name: "发送" }).click();
		await expect(page.locator("article.story-message").getByText("😀", { exact: true })).toBeVisible();

		await page.getByRole("button", { name: "添加资源" }).click();
		await expect(page.getByRole("navigation", { name: "添加资源" })).toBeVisible();
		await assertViewportIntegrity(page);
		await page.screenshot({ path: "test-results/story-mobile-resource.png", fullPage: true });
		await page.locator(".story-editor main").click();
		await expect(page.getByRole("navigation", { name: "添加资源" })).toBeHidden();

		for (let index = 1; index <= 8; index += 1) await addTextMessage(page, `底部菜单回归 ${index}`);
		const lastMessage = page.locator("article.story-message").last();
		await lastMessage.getByRole("button", { name: "消息操作" }).click();
		const messageMenu = page.getByRole("menu", { name: "消息操作" });
		await expect(messageMenu).toBeVisible();
		await expect.poll(async () => {
			const menu = await messageMenu.boundingBox();
			const canvas = await page.locator(".story-editor main").boundingBox();
			const composer = await page.locator(".composer").boundingBox();
			return !!menu && !!canvas && !!composer && menu.y + menu.height <= canvas.y + canvas.height && menu.y + menu.height < composer.y;
		}).toBe(true);
		await assertViewportIntegrity(page);
		await page.getByRole("menuitem", { name: /上插/ }).click();
		await expect(page.getByText("上插", { exact: true })).toBeVisible();
		await expect(page.getByRole("button", { name: "插入表情" })).toBeVisible();
		await assertViewportIntegrity(page);
		await page.getByRole("button", { name: "关闭插入" }).click();

		await setDarkTheme(page, false);
		await assertViewportIntegrity(page);
		await page.screenshot({ path: "test-results/story-mobile-light.png", fullPage: true });
		await page.getByRole("button", { name: "演出编辑" }).click();
		await page.getByRole("button", { name: "演出设置", exact: true }).click();
		await page.waitForTimeout(300);
		const mobilePerformanceSettings = page.getByLabel("演出设置", { exact: true });
		await expect(mobilePerformanceSettings.getByText("播放与计时", { exact: true })).toBeVisible();
		await expect(mobilePerformanceSettings.getByText("流式输出", { exact: true })).toBeVisible();
		await expect(mobilePerformanceSettings.getByText("输入提示", { exact: true })).toBeVisible();
		await assertViewportIntegrity(page);
		await page.screenshot({ path: "test-results/story-mobile-performance-settings-light.png", fullPage: true });
		expect(errors).toEqual([]);
	});

	test("built-in tutorial SSPs and playback-only route work on desktop and mobile", async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		await openCleanStory(page);
		await setDarkTheme(page, false);
		await page.getByRole("navigation", { name: "作品工具栏" }).getByRole("button", { name: "更多" }).click();
		await page.getByText("教程中心", { exact: true }).click();
		const center = page.getByRole("dialog", { name: "教程中心" });
		await expect(center.getByText("基本使用教程", { exact: true })).toBeVisible();
		await expect(center.locator(".tutorial-categories button")).toHaveCount(4);
		const welcome = center.locator("article").filter({ hasText: "一分钟认识编辑器" });
		await welcome.getByRole("button", { name: "开始教程" }).click();
		await expect(page.locator(".player--playback-only")).toBeVisible();
		await expect(page.getByText("点击画布可以下一句，自动播放状态下也可以哦~", { exact: true })).toBeVisible();
		await page.getByText("点击画布可以下一句，自动播放状态下也可以哦~", { exact: true }).click();
		await expect(page.getByRole("button", { name: "暂停演出" })).toBeVisible();
		await expect(page.getByText(/自动播放中/)).toBeVisible();
		await expect(page.locator('.player--playback-only img[src^="blob:"]').first()).toBeVisible();
		await assertViewportIntegrity(page);
		await page.getByRole("button", { name: "← 返回" }).click();
		await expect(center).toBeVisible();
		await center.getByRole("button", { name: "关闭教程" }).click();

		await page.goto("/play?src=/tutorials/characters.ssp", { waitUntil: "networkidle" });
		await expect(page.locator(".player--playback-only")).toBeVisible();
		await expect(page.getByRole("dialog", { name: "创建第一个角色" })).toContainText("作者：Lorana Tales 学院");
		await expect(page.locator(".player--playback-only .player-avatar img").first()).toHaveAttribute("src", /^blob:/);
		await page.getByRole("button", { name: "开始演出" }).click();
		await expect(page.getByText("点击画布可以下一句，自动播放状态下也可以哦~", { exact: true })).toBeVisible();
		await page.getByText("点击画布可以下一句，自动播放状态下也可以哦~", { exact: true }).click();
		await expect(page.getByText(/点击画布播放下一条|自动播放中/)).toBeVisible();
		await page.getByRole("button", { name: "关闭演出" }).click();
		await expect(page.locator(".player--playback-only")).toBeVisible();

		await page.setViewportSize({ width: 390, height: 844 });
		await page.getByRole("button", { name: "← 返回" }).click();
		await expect(page.getByRole("heading", { name: "SSP 播放器" })).toBeVisible();
		await page.getByRole("button", { name: "浏览内置教程" }).click();
		await expect(page.getByRole("dialog", { name: "教程中心" })).toBeVisible();
		await assertViewportIntegrity(page);
		expect(errors).toEqual([]);
	});

	test("linked-story and tutorial hints stay in the viewport and point to their controls", async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		await page.addInitScript(() => {
			localStorage.clear();
			document.cookie = "lorana_legacy_link_hint_seen=; Path=/; Max-Age=0; SameSite=Lax";
			document.cookie = "lorana_tutorial_prompt_seen=; Path=/; Max-Age=0; SameSite=Lax";
		});
		const accountMe = { authenticated: true, user: { id: "claim-user", username: "claim_user", nickname: "认领验收", email: "claim@example.test", avatarUrl: "", mustChangePassword: false, group: "default", role: "user" }, storage: { group: "default", usedBytes: 0, quotaBytes: 268435456, remainingBytes: 268435456, projectCount: 0, maxProjects: 100, retentionDays: 180, retentionSource: "group" } };
		let claimRequests = 0;
		let claimedMetaHeader = "";
		await page.route("**/api/account/config", route => route.fulfill({ json: { enabled: true, registrationEnabled: true, captchaProvider: "image", turnstileSiteKey: "", hcaptchaSiteKey: "" } }));
		await page.route("**/api/account/me", route => route.fulfill({ json: accountMe }));
		await page.route("**/api/account/projects", async route => {
			if (route.request().method() === "POST") {
				claimRequests += 1;
				claimedMetaHeader = route.request().headers()["x-lorana-project-meta"] || "";
				return route.fulfill({ status: 201, json: { id: "claimed-copy", revision: 1 } });
			}
			return route.fulfill({ json: [] });
		});
		const packed = deflateSync(Buffer.from(JSON.stringify({ version: 105, items: [{ id: 1, nickname: "雪桃", IMUserId: "732899935", time: 1, message: "头像重试验收", isDice: false, commandId: 0 }] }))).toString("base64");
		let avatarRequests = 0;
		await page.route("**/api/editor/avatar/qq/732899935*", route => {
			avatarRequests += 1;
			if (avatarRequests === 1) return route.fulfill({ status: 503, body: "temporary avatar failure" });
			return route.fulfill({ status: 200, contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="30" fill="#14b8a6"/></svg>' });
		});
		await page.route("**/api/dice/load_data", route => route.fulfill({ json: { client: "Lagrange", data: packed, name: "提示定位验收" } }));
		await page.goto("/story?key=hint-position-qa#test-password", { waitUntil: "networkidle" });
		await expect(page.locator(".story-editor .avatar img").first()).toBeVisible();
		expect(avatarRequests).toBeGreaterThanOrEqual(2);
		const claimPrompt = page.getByRole("dialog", { name: "认领这个故事？" });
		await expect(claimPrompt).toBeVisible();
		await claimPrompt.getByRole("button", { name: "暂不认领" }).click();

		const legacyHint = page.getByRole("dialog", { name: "经典染色器提示" });
		await expect(legacyHint).toBeVisible();
		const legacyBounds = await legacyHint.boundingBox();
		expect(legacyBounds).not.toBeNull();
		expect(legacyBounds!.x).toBeGreaterThanOrEqual(0);
		expect(legacyBounds!.x + legacyBounds!.width).toBeLessThanOrEqual(1280);
		expect(await legacyHint.evaluate(element => getComputedStyle(element, "::before").content)).not.toBe("none");
		await legacyHint.getByRole("button", { name: "知道了" }).click();

		const tutorialHint = page.getByRole("dialog", { name: "第一次使用 Lorana Tales 吗？" });
		await expect(tutorialHint).toContainText("点击“更多”打开教程");
		const tutorialBounds = await tutorialHint.boundingBox();
		expect(tutorialBounds).not.toBeNull();
		expect(tutorialBounds!.x).toBeGreaterThanOrEqual(0);
		expect(tutorialBounds!.x + tutorialBounds!.width).toBeLessThanOrEqual(1280);
		expect(await tutorialHint.evaluate(element => getComputedStyle(element, "::after").content)).not.toBe("none");
		await tutorialHint.getByRole("button", { name: "暂时不用" }).click();

		const claimButton = page.getByRole("button", { name: "认领到账号" });
		await expect(claimButton).toBeVisible();
		await claimButton.click();
		await expect.poll(() => claimRequests).toBe(1);
		await expect(page.getByRole("dialog", { name: "个人中心" })).toContainText("已认领为账号副本；原日志和原链接没有改动。");
		expect(JSON.parse(Buffer.from(claimedMetaHeader, "base64url").toString("utf8"))).toMatchObject({ title: "提示定位验收", sourceKey: "hint-position-qa", revision: 0 });
		await expect(claimButton).toBeHidden();
	});

	test("account tutorial cards open above the account workspace", async ({ page }) => {
		await page.addInitScript(() => { document.cookie = "lorana_tutorial_prompt_seen=1; Path=/; Max-Age=315360000; SameSite=Lax"; });
		await page.route("**/api/account/config", route => route.fulfill({ json: { enabled: true, registrationEnabled: true, captchaProvider: "image", turnstileSiteKey: "", hcaptchaSiteKey: "" } }));
		await page.route("**/api/account/me", route => route.fulfill({ json: { authenticated: true, user: { id: "qa-user", username: "qa_user", nickname: "界面验收", email: "qa@example.test", avatarUrl: "", mustChangePassword: false, group: "default", role: "user" }, storage: { group: "default", usedBytes: 0, quotaBytes: 268435456, remainingBytes: 268435456, projectCount: 0, maxProjects: 100 } } }));
		await page.route("**/api/account/projects", route => route.fulfill({ json: [] }));
		await page.goto("/story?account-tutorial-qa=1", { waitUntil: "networkidle" });
		await page.getByRole("button", { name: /界面验收/ }).click();
		await page.getByRole("button", { name: "教程", exact: true }).first().click();
		const tutorialPage = page.locator(".account-tutorial-page");
		await expect(tutorialPage.getByText("基本使用教程", { exact: true })).toBeVisible();
		await expect(tutorialPage.getByText("选择一节短演出，边看故事边熟悉创作工具。", { exact: true })).toHaveCount(0);
		const start = tutorialPage.getByRole("button", { name: "开始教程" }).first();
		expect(await start.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
		await start.click();
		const player = page.locator(".player--playback-only");
		await expect(player).toBeVisible();
		const layers = await page.evaluate(() => ({ player: Number(getComputedStyle(document.querySelector<HTMLElement>(".player")!).zIndex), account: Number(getComputedStyle(document.querySelector<HTMLElement>(".account-overlay")!).zIndex) }));
		expect(layers.player).toBeGreaterThan(layers.account);
	});

	test("account workspace survives rapid section switching", async ({ page }) => {
		const pageErrors: string[] = [];
		page.on("pageerror", error => pageErrors.push(error.message));
		await page.addInitScript(() => { document.cookie = "lorana_tutorial_prompt_seen=1; Path=/; Max-Age=315360000; SameSite=Lax"; });
		await page.route("**/api/account/config", route => route.fulfill({ json: { enabled: true, registrationEnabled: true, captchaProvider: "image", turnstileSiteKey: "", hcaptchaSiteKey: "" } }));
		await page.route("**/api/account/me", route => route.fulfill({ json: { authenticated: true, user: { id: "qa-admin", username: "qa_admin", nickname: "快速切换验收", email: "qa@example.test", avatarUrl: "", mustChangePassword: false, group: "admin", role: "admin", canAdmin: true }, storage: { group: "admin", usedBytes: 1024, quotaBytes: 8589934592, remainingBytes: 8589933568, projectCount: 1, maxProjects: 5000, retentionDays: 0, retentionSource: "group" } } }));
		await page.route("**/api/account/projects", route => route.fulfill({ json: [] }));
		await page.route("**/api/account/effect-presets", route => route.fulfill({ json: { items: [], folders: [], limit: 100 } }));
		await page.goto("/story?account-switch-qa=1", { waitUntil: "networkidle" });
		await page.getByRole("button", { name: /快速切换验收/ }).click();
		const panel = page.getByRole("dialog", { name: "个人中心" });
		await expect(panel).toBeVisible();

		await page.evaluate(() => {
			const labels = ["教程", "特效预设", "我的", "文档", "我的", "教程", "文档", "我的"];
			const buttons = [...document.querySelectorAll<HTMLButtonElement>(".workspace-nav nav button")];
			for (const label of labels) buttons.find(button => button.textContent?.trim() === label)?.click();
		});
		await expect(panel.locator(".account-page")).toBeVisible();
		for (const label of ["账号安全", "外观", "个人资料", "外观", "个人资料"]) {
			await panel.getByRole("button", { name: label, exact: true }).click();
		}
		await expect(panel.getByText("快速切换验收", { exact: true }).first()).toBeVisible();
		await expect(panel.getByRole("link", { name: "进入管理员面板" })).toBeVisible();
		expect(pageErrors).toEqual([]);
	});


	test("tutorial prompt repeats until the user opts out", async ({ page }) => {
		await page.context().clearCookies();
		await page.addInitScript(() => {
			localStorage.clear();
			indexedDB.deleteDatabase("lorana-story-drafts");
		});
		await page.goto("/story?first-tutorial=1", { waitUntil: "networkidle" });
		await expect(page.getByRole("dialog", { name: "第一次使用 Lorana Tales 吗？" })).toBeVisible();
		await page.getByRole("button", { name: "暂时不用" }).click();
		await page.reload({ waitUntil: "networkidle" });
		await expect(page.getByRole("dialog", { name: "第一次使用 Lorana Tales 吗？" })).toBeVisible();
		await page.getByRole("checkbox", { name: "以后不再显示" }).check();
		await page.getByRole("button", { name: "暂时不用" }).click();
		await page.reload({ waitUntil: "networkidle" });
		await expect(page.getByRole("dialog", { name: "第一次使用 Lorana Tales 吗？" })).toHaveCount(0);
	});
});
