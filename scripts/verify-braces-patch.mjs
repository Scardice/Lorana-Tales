import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const advisoryId = "GHSA-vfj7-8cjw-p6xm";
export const dependencyPaths = [
  ".>tailwindcss>chokidar>braces",
  ".>tailwindcss>fast-glob>micromatch>braces",
  ".>tailwindcss>micromatch>braces",
  ".>unplugin-vue-components>chokidar>braces",
  ".>unplugin-vue-components>fast-glob>micromatch>braces",
  ".>unplugin-vue-components>unplugin>chokidar>braces",
];
// Pin the code actually loaded, not just the existence of a patch/config entry.
// Normalize CRLF only, so checks are identical on Windows and Linux.
const hashes = {
  "index.js": "332ea07c7b006361aad12aa994ca75dc1db8e8382b884909e2f38f10b85c88a4",
  "lib/compile.js": "88cf20f18b59c9b2741c2d9b0f0ac6b2967d8e174667edf817133ca57d76809e",
  "lib/constants.js": "c18ac5adb57308f1ce42a28552da3a31f5d83709743ebd9a636336813a744d4b",
  "lib/expand.js": "46a259d3f23c0cd441fa370f16d5d48fa71060dfe918eeba84f6e95d3a94d368",
  "lib/parse.js": "7efb28a66017d64eb8f5e294912a419cfb256a0b6a62fce8c2a138c36d9116cb",
  "lib/stringify.js": "1873e833b7cf757262c602e26ed4c65041aa2be3df96c8d83b8a2406d378f34a",
  "lib/utils.js": "413f80b36a704a4facf72b4441f57cf04a167c75e06c1b9ae25e3f2de8115b9f",
};

export function resolveDependencyPath(chain, projectRoot = root) {
  const names = chain.split(">");
  assert.equal(names.shift(), ".");
  assert.equal(names.at(-1), "braces");
  let manifest = path.join(projectRoot, "package.json");
  for (const name of names) {
    assert.match(name, /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i);
    const require = createRequire(manifest);
    try {
      manifest = require.resolve(name + "/package.json");
    } catch {
      let directory = path.dirname(require.resolve(name));
      while (true) {
        const candidate = path.join(directory, "package.json");
        if (fs.existsSync(candidate) && JSON.parse(fs.readFileSync(candidate, "utf8")).name === name) {
          manifest = candidate;
          break;
        }
        const parent = path.dirname(directory);
        assert.notEqual(parent, directory, "Cannot find manifest for " + name);
        directory = parent;
      }
    }
  }
  return fs.realpathSync(path.dirname(manifest));
}

export function verifyBracesDirectory(directory) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
  assert.equal(manifest.name, "braces");
  assert.equal(manifest.version, "3.0.3");
  assert.equal(manifest.main, "index.js");
  assert.equal(manifest.exports, undefined);
  for (const [file, expected] of Object.entries(hashes)) {
    const code = fs.readFileSync(path.join(directory, file), "utf8").replace(/\r\n/g, "\n");
    assert.equal(createHash("sha256").update(code).digest("hex"), expected, "Unpatched/changed braces code: " + file);
  }
  const require = createRequire(path.join(directory, "package.json"));
  const braces = require("./index.js");
  const guarded = error => error instanceof RangeError && error.code === "BRACES_MAX_DEPTH";
  // Balanced/unbalanced braces, parentheses, mixed nesting and attempts to disable limits.
  const patterns = [
    "{".repeat(4000) + "a,b" + "}".repeat(4000),
    "(".repeat(4000) + "x" + ")".repeat(4000),
    "{(".repeat(2000) + "x" + ")}".repeat(2000),
    "{".repeat(4000) + "x",
    "(".repeat(4000) + "x",
  ];
  for (const pattern of patterns) {
    for (const method of ["parse", "compile", "expand", "stringify"]) {
      assert.throws(() => braces[method](pattern, { maxDepth: Infinity, maxLength: Infinity }), guarded, method);
    }
    assert.throws(() => braces(pattern), guarded);
    assert.throws(() => braces([pattern], { expand: true }), guarded);
  }
  // Callers can supply an AST directly, bypassing parse; internal entry points need guards too.
  const makeAst = () => {
    let node = { type: "text", value: "x" };
    for (let n = 0; n < 4000; n++) node = { type: "root", nodes: [node] };
    return node;
  };
  for (const method of ["compile", "expand", "stringify"]) {
    assert.throws(() => require("./lib/" + method + ".js")(makeAst()), guarded, "AST " + method);
  }
  assert.equal(braces.compile("src/{web,server}/**/*.{js,ts}"), "src/(web|server)/**/*.(js|ts)");
  assert.deepEqual(braces.expand("x/{a,{b,c}}/{1..2}"), ["x/a/1", "x/a/2", "x/b/1", "x/b/2", "x/c/1", "x/c/2"]);
  assert.equal(braces.stringify(braces.parse("src/{a,b}/**/*.ts")), "src/{a,b}/**/*.ts");
  assert.deepEqual(braces.expand("x/\\{literal\\}"), ["x/{literal}"]);
  assert.doesNotThrow(() => braces.compile("{".repeat(64) + "x" + "}".repeat(64)));
  // Wide shallow trees and quoted literals must not be mistaken for excessive depth.
  assert.doesNotThrow(() => braces.compile("{a,b}".repeat(300)));
  assert.doesNotThrow(() => braces.parse('"' + "{".repeat(1000) + '"'));
  return directory;
}

export function verifyBracesPatch(paths = dependencyPaths) {
  const directories = new Set(paths.map(chain => resolveDependencyPath(chain)));
  assert.ok(directories.size > 0, "No installed braces dependency was verified");
  for (const directory of directories) verifyBracesDirectory(directory);
  return directories;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directories = verifyBracesPatch();
  console.log("braces depth patch: all " + dependencyPaths.length + " dependency paths verified (" + directories.size + " installed copies); attack and compatibility checks passed.");
}
