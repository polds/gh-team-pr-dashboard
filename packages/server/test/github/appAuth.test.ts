import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createAppAuth } from "../../src/github/appAuth.ts";
import { GitHubApiError } from "../../src/github/http.ts";
import { fakeFetch, json } from "./fakeGitHub.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	privateKeyEncoding: { type: "pkcs1", format: "pem" },
	publicKeyEncoding: { type: "spki", format: "pem" },
});

const START = Date.parse("2026-11-23T12:00:00Z");
const START_SECONDS = START / 1000;

function decodeSegment(segment: string | undefined): unknown {
	return JSON.parse(Buffer.from(segment ?? "", "base64url").toString());
}

function setup(respond: Parameters<typeof fakeFetch>[0]) {
	const clock = { now: START };
	const github = fakeFetch(respond);
	const auth = createAppAuth({ appId: "12345", privateKeyPem: privateKey, fetch: github.fetch, now: () => clock.now });
	return { auth, clock, requests: github.requests };
}

describe("createAppAuth", () => {
	it("signs an RS256 app JWT that the app's public key verifies", () => {
		const { auth } = setup(() => json({}));
		const [header, payload, signature] = auth.appJwt().split(".");
		expect(verify("sha256", Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature ?? "", "base64url"))).toBe(true);
		expect(decodeSegment(header)).toEqual({ alg: "RS256", typ: "JWT" });
		expect(decodeSegment(payload)).toEqual({ iss: "12345", iat: START_SECONDS - 60, exp: START_SECONDS + 9 * 60 });
	});

	it("exchanges the app JWT for an installation token", async () => {
		const { auth, requests } = setup(() => json({ token: "ghs_one", expires_at: "2026-11-23T13:00:00Z" }, { status: 201 }));
		await expect(auth.installationToken(77)).resolves.toBe("ghs_one");
		expect(requests).toHaveLength(1);
		expect(requests[0]?.method).toBe("POST");
		expect(requests[0]?.url).toBe("https://api.github.com/app/installations/77/access_tokens");
		const jwt = requests[0]?.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
		const [header, payload, signature] = jwt.split(".");
		expect(verify("sha256", Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature ?? "", "base64url"))).toBe(true);
	});

	it("reuses the token until 60 seconds before it expires", async () => {
		let issued = 0;
		const { auth, clock, requests } = setup(() => {
			issued += 1;
			return json({ token: `ghs_${issued}`, expires_at: "2026-11-23T13:00:00Z" }, { status: 201 });
		});
		await expect(auth.installationToken(77)).resolves.toBe("ghs_1");
		clock.now = Date.parse("2026-11-23T12:58:59Z");
		await expect(auth.installationToken(77)).resolves.toBe("ghs_1");
		expect(requests).toHaveLength(1);
		clock.now = Date.parse("2026-11-23T12:59:00Z");
		await expect(auth.installationToken(77)).resolves.toBe("ghs_2");
		expect(requests).toHaveLength(2);
	});

	it("shares one request between concurrent callers", async () => {
		const { auth, requests } = setup(() => json({ token: "ghs_shared", expires_at: "2026-11-23T13:00:00Z" }, { status: 201 }));
		await expect(Promise.all([auth.installationToken(77), auth.installationToken(77)])).resolves.toEqual(["ghs_shared", "ghs_shared"]);
		expect(requests).toHaveLength(1);
	});

	it("does not cache a failed exchange", async () => {
		const responses = [new Response("boom", { status: 500 }), json({ token: "ghs_retry", expires_at: "2026-11-23T13:00:00Z" }, { status: 201 })];
		const { auth, requests } = setup(() => responses.shift() ?? new Response(null, { status: 599 }));
		await expect(auth.installationToken(77)).rejects.toBeInstanceOf(GitHubApiError);
		await expect(auth.installationToken(77)).resolves.toBe("ghs_retry");
		expect(requests).toHaveLength(2);
	});
});
