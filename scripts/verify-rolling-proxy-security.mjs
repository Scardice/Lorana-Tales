import assert from "node:assert/strict";
import {
	checksumForAsset,
	compareSemver,
	healthCheckHost,
	isAllowedHostHeader,
	isTrustedProxyAddress,
	normalizedHostHeader,
	parseSemver,
	sanitizedForwarding,
	sanitizedProxyHeaders,
	selectRelease,
	validateDownloadUrl,
	validateTarPaths,
} from "./rolling-launcher.mjs";

assert.equal(healthCheckHost(["story-painter.example"]), "story-painter.example");
assert.equal(healthCheckHost([]), "127.0.0.1");
assert.equal(isAllowedHostHeader(healthCheckHost(["story-painter.example"]), ["story-painter.example"]), true);

const config = {
	trustProxy: true,
	trustedProxyCidrs: ["127.0.0.1/32", "10.20.0.0/16", "::1/128"],
};

assert.equal(isTrustedProxyAddress("::ffff:127.0.0.1", config.trustedProxyCidrs), true);
assert.equal(isTrustedProxyAddress("10.20.4.8", config.trustedProxyCidrs), true);
assert.equal(isTrustedProxyAddress("203.0.113.50", config.trustedProxyCidrs), false);

const directAttacker = sanitizedForwarding({
	headers: {
		"cf-connecting-ip": "127.0.0.1",
		"x-real-ip": "10.0.0.1",
		"x-forwarded-for": "192.168.1.2",
		"x-forwarded-proto": "https",
	},
	socket: { remoteAddress: "203.0.113.50", encrypted: false },
}, config);
assert.deepEqual(directAttacker, { clientIp: "203.0.113.50", protocol: "http" });

const trustedProxy = sanitizedForwarding({
	headers: {
		"cf-connecting-ip": "198.51.100.24",
		"x-forwarded-for": "192.0.2.90",
		"x-forwarded-proto": "https",
	},
	socket: { remoteAddress: "10.20.4.8", encrypted: false },
}, config);
assert.deepEqual(trustedProxy, { clientIp: "198.51.100.24", protocol: "https" });

const malformedForwarding = sanitizedForwarding({
	headers: {
		"cf-connecting-ip": "not-an-ip",
		"x-forwarded-for": "also-invalid, 198.51.100.31",
		"x-forwarded-proto": "javascript",
	},
	socket: { remoteAddress: "10.20.4.8", encrypted: false },
}, config);
assert.deepEqual(malformedForwarding, { clientIp: "198.51.100.31", protocol: "http" });

const proxyHeaders = sanitizedProxyHeaders({
	host: "example.test",
	connection: "keep-alive, x-remove-me",
	"x-remove-me": "secret",
	"transfer-encoding": "chunked",
	"x-forwarded-for": "127.0.0.1",
	"content-type": "application/json",
});
assert.deepEqual(proxyHeaders, { host: "example.test", "content-type": "application/json" });

assert.equal(normalizedHostHeader("Example.Test:443"), "example.test");
assert.equal(normalizedHostHeader("[::1]:3000"), "::1");
assert.equal(normalizedHostHeader("example.test:65536"), "");
assert.equal(normalizedHostHeader("evil.example,localhost"), "");
assert.equal(normalizedHostHeader("user@localhost"), "");
assert.equal(isAllowedHostHeader("example.test:3000", ["example.test"]), true);
assert.equal(isAllowedHostHeader("evil.example", ["example.test"]), false);

assert.equal(
	validateDownloadUrl("https://github.com/Scardice/Lorana-Tales/releases/download/v1.2.3/package.tar.gz", "v1.2.3", "package.tar.gz", true).hostname,
	"github.com",
);
assert.throws(() => validateDownloadUrl("http://github.com/Scardice/Lorana-Tales/releases/download/v1.2.3/package.tar.gz", "v1.2.3", "package.tar.gz", true), /不受信任/);
assert.throws(() => validateDownloadUrl("https://github.com/attacker/repo/releases/download/v1.2.3/package.tar.gz", "v1.2.3", "package.tar.gz", true), /不匹配/);
assert.throws(() => validateDownloadUrl("https://evil.example/package.tar.gz", "v1.2.3", "package.tar.gz", false), /不受信任/);

assert.equal(parseSemver("v0.1.0-testify.2")?.prerelease[1], 2);
assert.equal(parseSemver("01.1.0"), null);
assert.equal(compareSemver("1.0.0", "1.0.0-testify.99"), 1);
assert.equal(compareSemver("1.0.0-testify.10", "1.0.0-testify.2"), 1);
assert.equal(compareSemver("1.0.0-testify.1", "1.0.0-testify.beta"), -1);

const releases = [
	{ tag_name: "nightly", draft: false, prerelease: true },
	{ tag_name: "v0.2.0-testify.2", draft: false, prerelease: true },
	{ tag_name: "v0.2.0-testify.10", draft: false, prerelease: true },
	{ tag_name: "v0.1.9", draft: false, prerelease: false },
	{ tag_name: "v9.0.0", draft: true, prerelease: false },
];
assert.equal(selectRelease(releases, "test", "0.1.0-testify.1")?.tag_name, "v0.2.0-testify.10");
assert.equal(selectRelease(releases, "stable", "0.1.0-testify.1")?.tag_name, "v0.1.9");

const digest = "a".repeat(64);
assert.equal(checksumForAsset(`${digest}  package.tar.gz\n`, "package.tar.gz"), digest);
assert.throws(() => checksumForAsset(`${digest}  package.tar.gz\n${digest} *package.tar.gz\n`, "package.tar.gz"), /唯一匹配项/);
assert.throws(() => checksumForAsset(`${digest.slice(1)}  package.tar.gz\n`, "package.tar.gz"), /唯一匹配项/);
assert.equal(validateTarPaths(["package/", "package/dist/app.js"]), 2);
for (const unsafe of ["../escape", "/absolute", "package\\escape", "package/../escape", "package/bad\nname"]) {
	assert.throws(() => validateTarPaths([unsafe]), /不安全路径/);
}
assert.throws(() => validateTarPaths(["package/file", "package/file"]), /重复路径/);

console.log("Rolling proxy and updater security checks passed");
