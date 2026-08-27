import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./tests/e2e",
	fullyParallel: false,
	workers: 1,
	retries: 0,
	timeout: 90_000,
	expect: { timeout: 7_000 },
	use: {
		baseURL: process.env.LORANA_E2E_URL || "http://127.0.0.1:3100",
		browserName: "chromium",
		headless: true,
		launchOptions: {
			executablePath: process.env.LORANA_EDGE_PATH || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
		},
		screenshot: "only-on-failure",
		trace: "retain-on-failure",
	},
	webServer: {
		command: "node tests/e2e/start-server.mjs",
		url: process.env.LORANA_E2E_URL || "http://127.0.0.1:3100/",
		reuseExistingServer: !process.env.CI,
		timeout: 30_000,
	},
	reporter: [["line"], ["html", { outputFolder: "playwright-report", open: "never" }]],
});
