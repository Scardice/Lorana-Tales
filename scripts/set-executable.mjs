import fs from "node:fs/promises";

const target = process.argv[2];
if (!target) {
	throw new Error("Usage: node scripts/set-executable.mjs <file>");
}

if (process.platform !== "win32") {
	await fs.chmod(target, 0o755);
}
