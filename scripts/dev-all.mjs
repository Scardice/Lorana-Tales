import { spawn } from "node:child_process";

const pnpmEntry = process.env.npm_execpath;
const command = pnpmEntry ? process.execPath : "pnpm";
const pnpmArgs = (script) => pnpmEntry ? [pnpmEntry, script] : [script];

const children = [
	spawn(command, pnpmArgs("dev:server"), { stdio: "inherit" }),
	spawn(command, pnpmArgs("dev"), { stdio: "inherit" }),
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
