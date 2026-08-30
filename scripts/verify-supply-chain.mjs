import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = relative => fs.readFileSync(path.join(root, relative), "utf8");
const manifest = JSON.parse(read("package.json"));
const workspace = read("pnpm-workspace.yaml");
const lockfile = read("pnpm-lock.yaml");

assert.match(manifest.packageManager, /^pnpm@11\.24\.0\+sha512\.[a-f0-9]{128}$/);
assert.equal(manifest.engines?.node, ">=24.20.0");
assert.match(workspace, /minimumReleaseAge:\s*1440/);
assert.match(workspace, /minimumReleaseAgeStrict:\s*true/);
assert.match(workspace, /minimumReleaseAgeIgnoreMissingTime:\s*false/);
assert.match(workspace, /trustPolicy:\s*no-downgrade/);
assert.match(workspace, /blockExoticSubdeps:\s*true/);

for (const unsafeSource of [/\btarball:/, /\bgit\+/, /\b(?:https?|git|ssh):\/\//]) {
	assert.doesNotMatch(lockfile, unsafeSource, "lockfile contains an exotic dependency source");
}
for (const line of lockfile.split(/\r?\n/).filter(value => /^\s+resolution:/.test(value))) {
	assert.match(line, /integrity:\s*sha512-/, `dependency resolution lacks SHA-512 integrity: ${line.trim()}`);
}

const expectedBuilds = new Set(["'@parcel/watcher'", "'@turbodocx/html-to-docx'", "better-sqlite3", "esbuild", "vue-demi"]);
const allowBuildsBlock = workspace.match(/allowBuilds:\s*\n((?:\s{2}.+\n?)+)/)?.[1] || "";
const actualBuilds = new Set([...allowBuildsBlock.matchAll(/^\s{2}([^:]+):/gm)].map(match => match[1].trim()));
assert.deepEqual(actualBuilds, expectedBuilds);
assert.match(allowBuildsBlock, /'@turbodocx\/html-to-docx':\s*false/);

for (const workflow of [".github/workflows/nightly-release.yml", ".github/workflows/release.yml"]) {
	const source = read(workflow);
	for (const match of source.matchAll(/uses:\s*[^\s@]+@([^\s#]+)/g)) {
		assert.match(match[1], /^[a-f0-9]{40}$/, `${workflow} contains an unpinned action`);
	}
	assert.match(source, /actions\/checkout@[a-f0-9]{40}[\s\S]{0,180}persist-credentials:\s*false/);
	assert.match(source, /pnpm install --frozen-lockfile/);
}

console.log("Supply-chain policy checks passed");
