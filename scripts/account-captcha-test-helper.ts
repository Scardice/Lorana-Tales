import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export async function solveAccountCaptcha(base: string, scope: string, agent: string) {
 const headers = { "content-type": "application/json", "user-agent": agent };
 const challengeResponse = await fetch(base + "/api/account/captcha/challenge", { method: "POST", headers, body: "{}" });
 assert.equal(challengeResponse.status, 200);
 const data = await challengeResponse.json() as any;
 assert.equal(data.provider, "altcha");
 const challenge = data.challenge;
 let number = 0;
 while (createHash("sha256").update(challenge.salt + number).digest("hex") !== challenge.challenge) {
   if (++number > 1000000) throw new Error("Test challenge exceeds work limit");
 }
 const payload = Buffer.from(JSON.stringify({ ...challenge, number })).toString("base64");
 const response = await fetch(base + "/api/account/captcha/verify", { method: "POST", headers, body: JSON.stringify({ id: data.id, payload, scope }) });
 assert.equal(response.status, 200);
 return { ...await response.json() as { clearance: string; mailClearance: string }, challengeId: data.id, payload };
}
