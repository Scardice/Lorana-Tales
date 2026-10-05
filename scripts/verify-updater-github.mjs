import assert from "node:assert/strict";
import { test } from "node:test";
import http from "node:http";
import { once } from "node:events";
import {
	createGitHubReleaseClient, createUpdatePoller, fetchReleaseAsset, GitHubUpdateError,
	redactUpdaterDiagnostic, selectRelease, updateIntervalMs, updaterToken,
} from "./rolling-launcher.mjs";

const baseTime = Date.parse("2026-10-05T00:00:00Z");
const release = (commit="a".repeat(40)) => ({ tag_name:"nightly", target_commitish:commit, prerelease:true, draft:false, assets:[] });
const json = (body, status=200, headers={}) => new Response(JSON.stringify(body), {status, headers:{"content-type":"application/json",...headers}});
async function caught(operation) { try { await operation(); assert.fail("expected rejection"); } catch(error) { assert.ok(error instanceof GitHubUpdateError); return error; } }
function clock() {
	let time=baseTime, sequence=0;const timers=new Map();
	return {
		now:()=>time,
		jump:ms=>{time+=ms;},
		setTimer:(callback,ms)=>{const id=++sequence;assert.ok(Number.isFinite(ms)&&ms>=0&&ms<=2_147_483_647);timers.set(id,{callback,at:time+ms});return id;},
		clearTimer:id=>timers.delete(id),
		get size(){return timers.size;},
		get nextAt(){return [...timers.values()].sort((a,b)=>a.at-b.at)[0]?.at;},
		async next(){const [id,entry]=[...timers].sort((a,b)=>a[1].at-b[1].at)[0]||[];assert.ok(entry,"expected scheduled check");timers.delete(id);time=Math.max(time,entry.at);await entry.callback();},
	};
}

test("token opt-in and interval validation do not reuse unrelated deployment credentials",()=>{
	assert.equal(updaterToken({github_token:" fileToken "},{}),"fileToken");
	assert.equal(updaterToken({github_token:"fileToken"},{LORANA_GITHUB_TOKEN:" envToken "}),"envToken");
	assert.equal(updaterToken({github_token:"fileToken"},{LORANA_GITHUB_TOKEN:""}),"");
	assert.equal(updaterToken({}, {GITHUB_TOKEN:"broadCiSecret",GH_TOKEN:"broadCliSecret"}),"");
	for(const value of [undefined,"bad",Infinity,NaN,0,-1])assert.equal(updateIntervalMs(value),300_000);
	assert.equal(updateIntervalMs(1),60_000);assert.equal(updateIntervalMs(6000),6_000_000);
	assert.equal(updateIntervalMs(1e20),2_147_483_647);
});

test("Nightly checks a single official tag, sends opt-in auth only there, and reuses ETag on 304",async()=>{
	const requests=[];let count=0;const fakeToken="ghp_TEST_ONLY_not_a_real_token";
	const client=createGitHubReleaseClient({channel:"nightly",token:fakeToken,fetchImpl:async(url,init)=>{
		requests.push({url,init});return ++count===1?json(release(),200,{etag:'W/"first"'}):new Response(null,{status:304});
	}});
	const first=await client.getReleases(),second=await client.getReleases();
	assert.deepEqual(second,first);assert.equal(count,2);
	assert.equal(requests[0].url,"https://api.github.com/repos/Scardice/Lorana-Tales/releases/tags/nightly");
	assert.equal(requests[0].init.headers.Authorization,"Bearer "+fakeToken);
	assert.equal(requests[0].init.redirect,"error");
	assert.equal(requests[1].init.headers["If-None-Match"],'W/"first"');
	assert.equal(selectRelease(second,"nightly","0.1.0-testify.1","a".repeat(40)),null);
});

test("stable/test requests keep release selection and never gain auth implicitly",async()=>{
	for(const channel of ["test","stable"]){
		const entries=[{tag_name:"v1.0.0",draft:false,prerelease:false},{tag_name:"v1.1.0-testify.1",draft:false,prerelease:true}];
		const client=createGitHubReleaseClient({channel,fetchImpl:async(url,init)=>{
			assert.equal(url,"https://api.github.com/repos/Scardice/Lorana-Tales/releases?per_page=30");
			assert.equal(init.headers.Authorization,undefined);return json(entries);
		}});
		assert.equal(selectRelease(await client.getReleases(),channel,"0.1.0")?.tag_name,channel==="stable"?"v1.0.0":"v1.1.0-testify.1");
	}
});

test("ETag invalidation notices a replaced Nightly even when its version number is unchanged",async()=>{
	let count=0;const client=createGitHubReleaseClient({channel:"nightly",fetchImpl:async()=>json(release((++count===1?"a":"b").repeat(40)),200,{etag:'"'+count+'"'})});
	await client.getReleases();const releases=await client.getReleases();
	assert.equal(selectRelease(releases,"nightly","0.1.0-testify.1","a".repeat(40))?.target_commitish,"b".repeat(40));
});

test("403 primary limit respects the later reset deadline and makes no request while blocked",async()=>{
	const time=clock();let calls=0;const reset=(baseTime+600_000)/1000;
	const client=createGitHubReleaseClient({channel:"nightly",now:time.now,fetchImpl:async()=>{calls++;return json({message:"API rate limit exceeded"},403,{"x-ratelimit-remaining":"0","x-ratelimit-limit":"60","x-ratelimit-reset":String(reset),"retry-after":"30","x-github-request-id":"TEST:LIMIT"});}});
	const error=await caught(()=>client.getReleases());assert.equal(error.kind,"rate-limit");assert.equal(error.retryAt,baseTime+601_000);
	assert.match(error.message,/remaining=0/);assert.match(error.message,/TEST:LIMIT/);assert.match(error.message,/anonymous/);
	assert.equal((await caught(()=>client.getReleases())).kind,"deferred");assert.equal(calls,1);
	time.jump(601_000);await caught(()=>client.getReleases());assert.equal(calls,2);
});

test("secondary limits without headers back off exponentially and successful checks reset the count",async()=>{
	const time=clock();let status=429;
	const client=createGitHubReleaseClient({channel:"nightly",now:time.now,fetchImpl:async()=>status===200?json(release()):json({message:"secondary rate limit"},status)});
	for(const expected of [60,120,240,480,960,1920,3600,3600]){
		const before=time.now(),error=await caught(()=>client.getReleases());assert.equal(error.retryAt-before,expected*1000);time.jump(expected*1000);
	}
	status=200;await client.getReleases();status=403;
	assert.equal((await caught(()=>client.getReleases())).retryAt-time.now(),60_000);
});

test("Retry-After HTTP dates and successful-response poll limits are honored on 200 and 304",async()=>{
	const time=clock();let count=0;
	const client=createGitHubReleaseClient({channel:"nightly",now:time.now,fetchImpl:async()=>{
		count++;if(count===1)return json({message:"slow down"},429,{"retry-after":new Date(baseTime+120_000).toUTCString()});
		if(count===2)return json(release(),200,{etag:'"cache"',"x-poll-interval":"300"});
		return new Response(null,{status:304,headers:{"x-poll-interval":"600"}});
	}});
	assert.equal((await caught(()=>client.getReleases())).retryAt,baseTime+121_000);time.jump(121_000);
	await client.getReleases();assert.equal(client.retryAt,time.now()+300_000);time.jump(300_000);
	await client.getReleases();assert.equal(client.retryAt,time.now()+600_000);
	assert.equal((await caught(()=>client.getReleases())).kind,"deferred");assert.equal(count,3);
});

test("permission 403 is not mislabeled as quota exhaustion; diagnostics redact credentials and control characters",async()=>{
	const token="ghp_TEST_ONLY_sensitive_token";
	const client=createGitHubReleaseClient({channel:"nightly",token,now:()=>baseTime,fetchImpl:async()=>json({message:"Resource not accessible: "+token+"\n\u001b[31m"},403,{"x-ratelimit-remaining":"4999","x-github-request-id":"TEST:FORBIDDEN"})});
	const error=await caught(()=>client.getReleases());assert.equal(error.kind,"forbidden");assert.doesNotMatch(error.message,new RegExp(token));assert.doesNotMatch(error.message,/[\r\n\u001b]/);assert.match(error.message,/\[redacted\]/);assert.match(error.message,/authenticated/);
	assert.equal(redactUpdaterDiagnostic("token=abcdef", "abcdef"),"token=[redacted]");
});

test("invalid/revoked credentials and malformed configuration cannot flood or leak the token",async()=>{
	let calls=0;const bad=createGitHubReleaseClient({channel:"nightly",token:"bad\r\nHeader: injected",now:()=>baseTime,fetchImpl:async()=>{calls++;}});
	const invalid=await caught(()=>bad.getReleases());assert.equal(invalid.kind,"configuration");assert.equal(calls,0);assert.doesNotMatch(invalid.message,/injected/);
	const revoked=createGitHubReleaseClient({channel:"nightly",token:"github_pat_TEST_ONLY",now:()=>baseTime,fetchImpl:async()=>json({message:"Bad credentials"},401)});
	const error=await caught(()=>revoked.getReleases());assert.equal(error.kind,"authentication");assert.equal(error.retryAt-baseTime,3_600_000);
});

test("non-JSON proxy denial and large/invalid API bodies remain bounded and preserve useful status",async()=>{
	const denied=createGitHubReleaseClient({channel:"nightly",fetchImpl:async()=>new Response("<html>private proxy diagnostics</html>",{status:403})});
	const error=await caught(()=>denied.getReleases());assert.equal(error.status,403);assert.match(error.message,/网关/);assert.doesNotMatch(error.message,/private proxy/);
	for(const response of [json({wrong:"shape"}),new Response("x".repeat(2*1024*1024+1)),json(release(),200,{"content-length":String(3*1024*1024)}),new Response(null,{status:304})]){
		await caught(()=>createGitHubReleaseClient({channel:"nightly",fetchImpl:async()=>response}).getReleases());
	}
});

test("network/redirect failures are sanitized and concurrent API calls share a single request",async()=>{
	const token="customTESTsecret";
	const failed=createGitHubReleaseClient({channel:"nightly",token,fetchImpl:async()=>{throw new Error("redirect included "+token);}});
	assert.doesNotMatch((await caught(()=>failed.getReleases())).message,/customTESTsecret/);
	let releaseRequest;let calls=0;const client=createGitHubReleaseClient({channel:"nightly",fetchImpl:async(_url,init)=>{calls++;assert.equal(init.redirect,"error");await new Promise(resolve=>releaseRequest=resolve);return json(release());}});
	const one=client.getReleases(),two=client.getReleases();assert.equal(one,two);assert.equal(calls,1);releaseRequest();await one;
});

test("asset redirects never carry GitHub API credentials",async()=>{
	const original=globalThis.fetch;const requests=[];
	try{
		globalThis.fetch=async(url,init)=>{requests.push({url:String(url),init});return requests.length===1?new Response(null,{status:302,headers:{location:"https://release-assets.githubusercontent.com/test/package.tar.gz"}}):new Response("package");};
		await fetchReleaseAsset("https://github.com/Scardice/Lorana-Tales/releases/download/nightly/package.tar.gz","nightly","package.tar.gz");
		assert.equal(requests.length,2);
		for(const request of requests)assert.equal(new Headers(request.init.headers).has("authorization"),false);
	}finally{globalThis.fetch=original;}
});

test("poller uses completion-based scheduling, never overlaps, and logs retry details",async()=>{
	const time=clock(),logs=[];let calls=0,finish;
	const poller=createUpdatePoller(async()=>{calls++;if(calls===1)await new Promise(resolve=>finish=resolve);else throw new GitHubUpdateError("GitHub API 403 [rate-limit]",403,"rate-limit",time.now()+900_000);},{...time,intervalMs:60_000,log:line=>logs.push(line)});
	poller.start(0);const pending=time.next();assert.equal(calls,1);assert.equal(time.size,0);poller.start(0);time.jump(600_000);assert.equal(calls,1);finish();await pending;assert.equal(time.nextAt,time.now()+60_000);
	await time.next();assert.equal(time.nextAt,time.now()+900_000);assert.match(logs[0],/900 秒/);poller.stop();assert.equal(time.size,0);
});

test("stopping during a check never re-arms; malformed deadlines and huge delays cannot busy-loop",async()=>{
	const time=clock();let finish;const poller=createUpdatePoller(()=>new Promise(resolve=>finish=resolve),{...time,intervalMs:60_000});poller.start(0);const pending=time.next();poller.stop();finish();await pending;assert.equal(time.size,0);
	const other=clock();const bad=createUpdatePoller(async()=>{throw {retryAt:NaN};},{...other,notBefore:()=>NaN,log:()=>{}});bad.start(0);await other.next();assert.equal(other.nextAt,other.now()+300_000);bad.stop();
	const long=clock();let attempts=0;const longPoller=createUpdatePoller(async()=>{attempts++;throw new GitHubUpdateError("wait",429,"rate-limit",long.now()+4_000_000_000);},{...long,log:()=>{}});longPoller.start(0);await long.next();await long.next();assert.equal(attempts,1);longPoller.stop();
});

test("a running HTTP service remains available during failed update checks and recovery",async()=>{
	const server=http.createServer((_request,response)=>{response.writeHead(200,{"content-type":"application/json"});response.end('{"ok":true}');});
	server.listen(0,"127.0.0.1");await once(server,"listening");
	const time=clock(),logs=[];let success=false,applied=0;
	const api=createGitHubReleaseClient({channel:"nightly",now:time.now,fetchImpl:async()=>success?json(release()):json({message:"API rate limit exceeded"},403,{"x-ratelimit-remaining":"0","x-ratelimit-reset":String((time.now()+120_000)/1000)})});
	const poller=createUpdatePoller(async()=>{await api.getReleases();applied++;},{...time,intervalMs:60_000,notBefore:()=>api.retryAt,log:line=>logs.push(line)});
	try{
		poller.start(0);await time.next();assert.equal(applied,0);assert.match(logs[0],/保持当前服务/);
		const endpoint="http://127.0.0.1:"+server.address().port;
		assert.equal((await fetch(endpoint)).status,200);
		success=true;await time.next();assert.equal(applied,1);assert.equal((await fetch(endpoint)).status,200);
	}finally{poller.stop();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
