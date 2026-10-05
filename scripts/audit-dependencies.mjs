import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { advisoryId, root, verifyBracesPatch } from "./verify-braces-patch.mjs";

// No audit ignore list: retain the registry report, and accept only this exact
// locally mitigated advisory after verifying every affected installed path.
export function evaluateAudit(report, verify = verifyBracesPatch) {
  assert.ok(report && typeof report === "object" && !report.error, "Audit registry error");
  assert.ok(report.advisories && typeof report.advisories === "object" && !Array.isArray(report.advisories), "Missing audit advisories");
  const counts = report.metadata?.vulnerabilities;
  const severities = ["info", "low", "moderate", "high", "critical"];
  assert.ok(counts && severities.every(key => Number.isInteger(counts[key]) && counts[key] >= 0), "Invalid vulnerability counts");
  const advisories = Object.values(report.advisories);
  for (const severity of severities) {
    assert.equal(advisories.filter(item => item.severity === severity).length, counts[severity], "Incomplete audit report: " + severity);
  }
  assert.ok(advisories.every(item => severities.includes(item.severity)), "Unknown vulnerability severity");
  const accepted = [], blocked = [];
  for (const item of advisories) {
    if (item.github_advisory_id !== advisoryId || item.module_name !== "braces" ||
        item.patched_versions !== null || item.patched_versions_unpublished !== true ||
        !Array.isArray(item.findings) || item.findings.length === 0 ||
        !item.findings.every(finding => finding.version === "3.0.3" && finding.dev === true &&
          Array.isArray(finding.paths) && finding.paths.length > 0 && finding.paths.every(value => typeof value === "string"))) {
      blocked.push(item);
      continue;
    }
    verify(item.findings.flatMap(finding => finding.paths));
    accepted.push(item);
  }
  return { accepted, blocked };
}

export function runAudit() {
  // Always verify our expected consumers, even if the registry reports no CVEs.
  verifyBracesPatch();
  const pnpm = process.env.npm_execpath;
  assert.ok(pnpm && /(?:\.[cm]?js|\.exe|[/\\]pnpm)$/.test(pnpm), "Run through pnpm audit:dependencies");
  const isScript = /\.[cm]?js$/.test(pnpm);
  const result = spawnSync(isScript ? process.execPath : pnpm, [...(isScript ? [pnpm] : []), "audit", "--json"], {
    cwd: root, encoding: "utf8", windowsHide: true, timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
  });
  assert.ok(!result.error && !result.signal && [0, 1].includes(result.status), "pnpm audit failed to run");
  let report;
  try { report = JSON.parse(result.stdout); } catch { throw new Error("pnpm audit returned invalid/non-JSON output; refusing release"); }
  const { accepted, blocked } = evaluateAudit(report);
  assert.ok(result.status === 0 || Object.keys(report.advisories).length > 0, "Audit failed without a vulnerability report");
  for (const item of accepted) console.log("[audit] Locally patched and verified: " + item.github_advisory_id + " (" + item.module_name + "@3.0.3, build-only). Upstream still has no fixed release.");
  for (const item of blocked) console.error("[audit] BLOCKED: " + JSON.stringify({ id: item.github_advisory_id, package: item.module_name, severity: item.severity, findings: item.findings }));
  assert.equal(blocked.length, 0, "Unmitigated dependency advisories block the release");
  console.log("[audit] Full dependency audit passed: " + accepted.length + " verified local mitigation(s), no unmitigated advisories.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runAudit();
