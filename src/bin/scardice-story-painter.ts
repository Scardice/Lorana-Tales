#!/usr/bin/env node
import { loadConfig } from "../config/load-config.js";
import { startServer } from "../server/main.js";
import { SqliteLogStore } from "../storage/sqlite-log-store.js";

let activeRuntime: Awaited<ReturnType<typeof startServer>> | undefined;
let stopping = false;

function stopServer(signal: NodeJS.Signals) {
	if (stopping || !activeRuntime) return;
	stopping = true;
	const runtime = activeRuntime;
	const fallback = setTimeout(() => runtime.server.closeAllConnections(), 5_000);
	fallback.unref();
	runtime.server.close(() => {
		clearTimeout(fallback);
		runtime.store.close();
	});
	console.error(`[server] ${signal}: draining active requests`);
}

process.once("SIGTERM", () => stopServer("SIGTERM"));
process.once("SIGINT", () => stopServer("SIGINT"));

function printHelp() {
	console.log(
		[
			"Usage:",
			"  scardice-story-painter                         Start the HTTP server",
			"  scardice-story-painter db-maintain [--vacuum]  Run SQLite integrity check and WAL checkpoint",
			"",
			"Configuration is read from SCARDICE_CONFIG, CONFIG_FILE, ./config.toml, or /etc paths.",
		].join("\n"),
	);
}

async function main() {
	const command = process.argv[2] || "serve";

	if (command === "help" || command === "--help" || command === "-h") {
		printHelp();
		return;
	}

	if (command === "db-maintain") {
		const config = loadConfig();
		const store = new SqliteLogStore(config.storage.sqlite_path, {
			maxTotalBytes: Math.max(1, Number(config.storage.max_total_mb || 4096)) * 1024 * 1024,
		});
		try {
			const result = await store.maintainDatabase({
				vacuum: process.argv.includes("--vacuum"),
			});
			console.log(JSON.stringify(result, null, 2));
		} finally {
			store.close();
		}
		return;
	}

	if (command !== "serve") {
		console.error(`Unknown command: ${command}`);
		printHelp();
		process.exitCode = 1;
		return;
	}

	activeRuntime = await startServer();
	await new Promise<void>((resolve, reject) => {
		activeRuntime?.server.once("close", resolve);
		activeRuntime?.server.once("error", reject);
	});
	activeRuntime = undefined;
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
