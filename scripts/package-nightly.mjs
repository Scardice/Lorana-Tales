import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultOutput = path.join(
	repoRoot,
	"release",
	"lorana-tales-nightly",
);
const outputDir = path.resolve(process.argv[2] || defaultOutput);

async function exists(target) {
	try {
		await fs.access(target);
		return true;
	} catch {
		return false;
	}
}

const requiredPaths = [
	"dist",
	"out",
	"package.json",
	"config.toml.example",
	"README.md",
	"VERSION",
	"LICENSE",
	"THIRD_PARTY_NOTICES.md",
	"scripts/rolling-launcher.mjs",
];

for (const relativePath of requiredPaths) {
	const sourcePath = path.join(repoRoot, relativePath);
	if (!(await exists(sourcePath))) {
		throw new Error(
			`Missing ${relativePath}; run the server and web build before packaging`,
		);
	}
}

if (await exists(outputDir)) {
	throw new Error(`Output directory already exists: ${outputDir}`);
}

const sourcePackage = JSON.parse(
	await fs.readFile(path.join(repoRoot, "package.json"), "utf8"),
);
const releaseVersion = (
	await fs.readFile(path.join(repoRoot, "VERSION"), "utf8")
).trim();
const runtimePackage = {
	name: sourcePackage.name,
	version: releaseVersion,
	private: true,
	type: sourcePackage.type,
	engines: sourcePackage.engines || { node: ">=24.20.0 <25" },
	bin: sourcePackage.bin,
	scripts: { start: sourcePackage.scripts.start },
	dependencies: sourcePackage.dependencies,
};

await fs.mkdir(outputDir, { recursive: true });
await fs.cp(path.join(repoRoot, "dist"), path.join(outputDir, "dist"), {
	recursive: true,
});
await fs.cp(path.join(repoRoot, "out"), path.join(outputDir, "out"), {
	recursive: true,
});
await fs.mkdir(path.join(outputDir, "scripts"), { recursive: true });
await fs.copyFile(path.join(repoRoot, "scripts/rolling-launcher.mjs"), path.join(outputDir, "scripts/rolling-launcher.mjs"));
await fs.copyFile(
	path.join(repoRoot, "config.toml.example"),
	path.join(outputDir, "config.toml.example"),
);
await fs.copyFile(
	path.join(repoRoot, "config.toml.example"),
	path.join(outputDir, "config.toml"),
);
await fs.copyFile(
	path.join(repoRoot, "README.md"),
	path.join(outputDir, "README.md"),
);
await fs.copyFile(
	path.join(repoRoot, "VERSION"),
	path.join(outputDir, "VERSION"),
);
await fs.copyFile(
	path.join(repoRoot, "LICENSE"),
	path.join(outputDir, "LICENSE"),
);
await fs.copyFile(
	path.join(repoRoot, "THIRD_PARTY_NOTICES.md"),
	path.join(outputDir, "THIRD_PARTY_NOTICES.md"),
);
await fs.writeFile(
	path.join(outputDir, "package.json"),
	`${JSON.stringify(runtimePackage, null, "\t")}\n`,
);

await fs.writeFile(path.join(outputDir, "OFFICIAL_BUILD.json"), `${JSON.stringify({ repository: process.env.GITHUB_REPOSITORY || "source-build", commit: process.env.GITHUB_SHA || "", version: releaseVersion, channel: String(process.env.LORANA_RELEASE_CHANNEL || "Source") }, null, 2)}\n`);

const releaseChannel = process.env.LORANA_RELEASE_CHANNEL || "Nightly";
const packageReadme = [
	`# Lorana Tales ${releaseChannel}`,
	"",
	`This Linux x64 package is prebuilt for Node.js ${runtimePackage.engines.node}.`,
	"Edit `config.toml` and run `npm start`.",
	"The package already contains the compiled server, frontend, and production dependencies; no build or dependency installation step is required.",
	"",
	"- Edit `config.toml` before the first start.",
	"- Keep the SQLite path and security audit path on persistent storage.",
	"- Set `trust_proxy = true` only when every proxy/CDN hop is trusted and overwrites forwarding headers.",
	"- Set `allowed_hosts` and `frontend_url` to the public host when deploying behind a proxy or CDN.",
	"- Protect the official GitHub repository and Release workflow with strong authentication; they are the automatic updater's trust root.",
	"- Restart the service manager once after a release changes the rolling launcher itself, so later checks use the new updater engine.",
	"- See `THIRD_PARTY_NOTICES.md` for bundled DOCX-export dependency notices.",
	"- This project is distributed under the MIT License; see `LICENSE`.",
	"",
].join("\n");
await fs.writeFile(path.join(outputDir, "PACKAGE-README.md"), packageReadme);

console.log(`${releaseChannel} package staged at ${outputDir}`);
