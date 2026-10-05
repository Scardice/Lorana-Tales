import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { evaluateAudit } from "./audit-dependencies.mjs";
import { advisoryId, dependencyPaths, verifyBracesDirectory, verifyBracesPatch } from "./verify-braces-patch.mjs";

const finding = () => ({
  github_advisory_id: advisoryId, module_name: "braces", severity: "high",
  patched_versions: null, patched_versions_unpublished: true,
  findings: [{ version: "3.0.3", dev: true, paths: [dependencyPaths[0]] }],
});
function report(...items) {
  const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
  for (const item of items) counts[item.severity]++;
  return { advisories: Object.fromEntries(items.map((item, n) => [n, item])), metadata: { vulnerabilities: counts } };
}
test("installed parser and walkers resist deep patterns and direct AST inputs across all consumers", () => {
  assert.ok(verifyBracesPatch().size > 0);
});
test("only exact build-only advisory is accepted, after verifying all affected paths", () => {
  let paths;
  const result = evaluateAudit(report(finding()), value => { paths = value; });
  assert.deepEqual(paths, [dependencyPaths[0]]);
  assert.equal(result.accepted.length, 1);
  assert.equal(result.blocked.length, 0);
});
test("other advisories, versions, runtime exposure and published fixes remain blocking", () => {
  for (const mutate of [
    item => { item.github_advisory_id = "GHSA-other"; },
    item => { item.module_name = "other"; },
    item => { item.findings[0].version = "3.0.2"; },
    item => { item.findings[0].dev = false; },
    item => { item.findings = []; },
    item => { item.findings[0].paths = []; },
    item => { item.patched_versions = ">=3.0.4"; },
    item => { item.patched_versions_unpublished = false; },
  ]) {
    const item = finding(); mutate(item);
    assert.equal(evaluateAudit(report(item), () => assert.fail("must not be exempted")).blocked.length, 1);
  }
});
test("missing/tampered patch, unexpected dependency path and audit outage fail closed", () => {
  assert.throws(() => evaluateAudit(report(finding()), () => { throw new Error("missing patch"); }), /missing patch/);
  assert.throws(() => verifyBracesPatch([".>../outside>braces"]));
  assert.throws(() => evaluateAudit({ error: "registry offline" }));
  assert.throws(() => evaluateAudit({}));
  const incomplete = report(finding()); incomplete.advisories = {};
  assert.throws(() => evaluateAudit(incomplete), /Incomplete/);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lorana-braces-tamper-"));
  // Only create/remove the two known test files; never mutate installed dependencies.
  try {
    fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name: "braces", version: "3.0.3", main: "index.js" }));
    fs.writeFileSync(path.join(directory, "index.js"), "throw new Error('must never execute');");
    assert.throws(() => verifyBracesDirectory(directory), /Unpatched\/changed braces code/);
  } finally {
    for (const file of ["package.json", "index.js"]) if (fs.existsSync(path.join(directory, file))) fs.unlinkSync(path.join(directory, file));
    fs.rmdirSync(directory);
  }
});
test("an additional vulnerability is not hidden by the locally patched finding", () => {
  const other = { ...finding(), github_advisory_id: "GHSA-another", severity: "low" };
  const result = evaluateAudit(report(finding(), other), () => {});
  assert.equal(result.accepted.length, 1); assert.deepEqual(result.blocked, [other]);
  assert.deepEqual(evaluateAudit(report()), { accepted: [], blocked: [] });
});
