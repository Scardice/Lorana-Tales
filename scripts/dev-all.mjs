import { spawn } from "node:child_process";

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

const children = [
	spawn(pnpm, ["dev:server"], { stdio: "inherit" }),
	spawn(pnpm, ["dev"], { stdio: "inherit" }),
];

let shuttingDown = false;

function stopAll(signal = "SIGTERM") {
	if (shuttingDown) return;
	shuttingDown = true;
	for (const child of children) {
		if (!child.killed) {
			child.kill(signal);
		}
	}
}

for (const child of children) {
	child.on("exit", (code, signal) => {
		if (shuttingDown) return;
		stopAll();
		process.exitCode = code ?? (signal ? 1 : 0);
	});
}

process.on("SIGINT", () => stopAll("SIGINT"));
process.on("SIGTERM", () => stopAll("SIGTERM"));
