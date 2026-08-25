import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultOutput = path.join(
	repoRoot,
	"release",
	"scardice-story-painter-nightly",
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
const runtimePackage = {
	name: sourcePackage.name,
	version: sourcePackage.version,
	private: true,
	type: sourcePackage.type,
	engines: sourcePackage.engines || { node: ">=20.19" },
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
await fs.writeFile(
	path.join(outputDir, "package.json"),
	`${JSON.stringify(runtimePackage, null, "\t")}\n`,
);

const nightlyReadme = [
	"# Scardice Story Painter Nightly",
	"",
	`This Linux x64 package is prebuilt for Node.js ${runtimePackage.engines.node}.`,
	"Edit `config.toml` and run `npm start`.",
	"The package already contains the compiled server, frontend, and production dependencies; no build or dependency installation step is required.",
	"",
	"- Edit `config.toml` before the first start.",
	"- Keep the SQLite path and security audit path on persistent storage.",
	"- Set `trust_proxy = true` only when every proxy/CDN hop is trusted and overwrites forwarding headers.",
	"- Set `allowed_hosts` and `frontend_url` to the public host when deploying behind a proxy or CDN.",
	"",
].join("\n");
await fs.writeFile(path.join(outputDir, "NIGHTLY-README.md"), nightlyReadme);

console.log(`Nightly package staged at ${outputDir}`);
