import { expect, test } from "@playwright/test";

test("administrator can edit account groups, quotas and retention", async ({ page }) => {
	const updates: Array<Record<string, unknown>> = [];
	const users = [
		{ id:"user-1", email:"user@example.test", username:"regular_user", nickname:"普通用户", displayName:"普通用户", role:"user", group:"default", quotaMbOverride:null, retentionDaysOverride:null, status:"active", banReason:"", banUntil:"", storage:{ group:"default", usedBytes:1024, quotaBytes:268435456, maxProjects:100, projectCount:1, retentionDays:180, quotaSource:"group", retentionSource:"group" } },
		{ id:"admin-1", email:"storypainter@example.test", username:"storypainter", nickname:"storypainter", displayName:"storypainter", role:"admin", group:"admin", quotaMbOverride:null, retentionDaysOverride:null, status:"active", banReason:"", banUntil:"", storage:{ group:"admin", usedBytes:0, quotaBytes:8589934592, maxProjects:5000, projectCount:0, retentionDays:0, quotaSource:"group", retentionSource:"group" } },
	];
	await page.route("**/admin/api/**", async route => {
		const url = new URL(route.request().url());
		const path = url.pathname;
		if (path === "/admin/api/session") return route.fulfill({ json:{ authenticated:true, accountMode:true, mode:"account" } });
		if (path === "/admin/api/logs") return route.fulfill({ json:{ items:[], page:1, pageSize:20, total:0, totalPages:1, query:"" } });
		if (path === "/admin/api/account-policies") return route.fulfill({ json:{ defaultGroup:"default", adminGroup:"admin", groups:[
			{ name:"default", quota_mb:256, max_projects:100, retention_days:180 },
			{ name:"advanced", quota_mb:2048, max_projects:1000, retention_days:365 },
			{ name:"admin", quota_mb:8192, max_projects:5000, retention_days:0 },
		] } });
		if (path === "/admin/api/users" && route.request().method() === "GET") return route.fulfill({ json:{ items:users } });
		if (path === "/admin/api/projects") return route.fulfill({ json:{ items:[] } });
		if (path.startsWith("/admin/api/users/") && route.request().method() === "PATCH") {
			updates.push(route.request().postDataJSON());
			return route.fulfill({ json:{ ok:true } });
		}
		return route.fulfill({ status:404, json:{ error:"not_mocked" } });
	});

	await page.goto("/admin", { waitUntil:"networkidle" });
	await expect(page.getByRole("heading", { name:"账户管理" })).toBeVisible();
	await expect(page.locator("#newUserGroup option")).toHaveText(["default", "advanced", "admin"]);

	const regular = page.locator('[data-user-id="user-1"]');
	await regular.getByRole("button", { name:"编辑" }).click();
	const editor = page.getByRole("dialog", { name:"编辑账户" });
	await expect(editor).toBeVisible();
	await editor.locator("#editUserGroup").selectOption("advanced");
	await editor.locator("#editUserQuota").fill("4096");
	await editor.locator("#editUserRetention").fill("45");
	await expect(editor.locator("#editPolicyPreview")).toContainText("advanced");
	await editor.getByRole("button", { name:"保存账户" }).click();
	await expect(editor).toBeHidden();

	const administrator = page.locator('[data-user-id="admin-1"]');
	await administrator.getByRole("button", { name:"编辑" }).click();
	await expect(editor.locator("#editUserGroup")).toBeDisabled();
	await expect(editor.locator("#editUserGroup")).toHaveValue("admin");
	await editor.locator("#editUserQuota").fill("16384");
	await editor.locator("#editUserRetention").fill("0");
	await editor.getByRole("button", { name:"保存账户" }).click();

	expect(updates).toHaveLength(2);
	expect(updates[0]).toMatchObject({ role:"user", group:"advanced", quotaMbOverride:4096, retentionDaysOverride:45 });
	expect(updates[1]).toMatchObject({ role:"admin", group:"admin", quotaMbOverride:16384, retentionDaysOverride:0 });
});
