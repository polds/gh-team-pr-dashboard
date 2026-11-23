import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { asLogin, asSha } from "@radar/core";
import type { AuthorSignalResponse, BoardResponse, CardConfig, PrSnapshot } from "@radar/core";
import { createBoard } from "../src/board.ts";
import { systemClock } from "../src/clock.ts";
import type { GitHubConfig } from "../src/config.ts";
import type { PrRef } from "../src/github/source.ts";
import { SESSION_COOKIE, STATE_COOKIE, createApp } from "../src/http.ts";
import { createHub } from "../src/hub.ts";
import { createPresence } from "../src/presence.ts";
import { createSessionCodec } from "../src/session.ts";
import { createStore } from "../src/store.ts";
import type { ReviewRequester } from "../src/writer.ts";
import { fakeFetch, json } from "./github/fakeGitHub.ts";
import { hour, likelyReadyPr, refOf, requestedPr } from "./builders.ts";
import { jsonOf, recordingLogger } from "./helpers.ts";

const SECRET = "x".repeat(64);
const WEBHOOK_SECRET = "hook-secret";
const NOW = new Date(hour(5));
const CARD_CONFIG: CardConfig = { priorityLabels: [], helpWantedAfterBusinessHours: 24, timeZone: "UTC", botLogins: [] };

function githubConfig(webDist: string, overrides: Partial<GitHubConfig> = {}): GitHubConfig {
	return {
		mode: "github",
		port: 0,
		org: "acme",
		baseUrl: "https://radar.test",
		timeZone: "UTC",
		priorityLabels: [],
		botLogins: [],
		repoDenylist: ["sandbox"],
		helpWantedAfterBusinessHours: 24,
		reconcileSeconds: 300,
		fullSweepEvery: 12,
		rerequestEnabled: false,
		dataDir: "",
		webDist,
		sessionSecret: SECRET,
		github: { appId: "1", clientId: "Iv1.test", clientSecret: "client-secret", privateKeyPem: "", webhookSecret: WEBHOOK_SECRET, installationId: 1 },
		...overrides,
	};
}

/** GitHub as the sign-in flow sees it: `members` are the organization's members. */
function signInGitHub(login: string, members: string[]) {
	return fakeFetch((request) => {
		if (request.url === "https://github.com/login/oauth/access_token") return json({ access_token: "ghu_user_token", expires_in: 3600 });
		if (request.url === "https://api.github.com/user") return json({ login, avatar_url: `https://avatars.test/${login}`, name: null });
		if (request.url === `https://api.github.com/orgs/acme/members/${login}`) return new Response(null, { status: members.includes(login) ? 204 : 404 });
		return new Response("unexpected", { status: 500 });
	});
}

function harness({
	prs = [likelyReadyPr],
	config = {},
	fetch = signInGitHub("ana", ["ana"]).fetch,
	refuse = false,
}: { prs?: PrSnapshot[]; config?: Partial<GitHubConfig>; fetch?: typeof globalThis.fetch; refuse?: boolean } = {}) {
	const webDist = mkdtempSync(join(tmpdir(), "radar-web-"));
	const store = createStore({ file: null, clock: systemClock, log: recordingLogger().log });
	const board = createBoard({ store, cardConfig: CARD_CONFIG });
	for (const pr of prs) board.apply(refOf(pr), pr, NOW);
	const hub = createHub({ clock: systemClock });
	const presence = createPresence({ clock: systemClock, onChange: (list) => hub.broadcast({ kind: "presence", presence: list }) });
	const marks: PrRef[] = [];
	const rerequests: Parameters<ReviewRequester["requestReviewers"]>[0][] = [];
	const requester: ReviewRequester = {
		async requestReviewers(input) {
			if (refuse) throw new Error("GitHub responded 403");
			rerequests.push(input);
		},
	};
	const sessions = createSessionCodec(SECRET);
	const logger = recordingLogger();
	const app = createApp({
		config: githubConfig(webDist, config),
		github: { fetch, installationToken: async () => "ghs_installation" },
		board,
		hub,
		presence,
		refresher: { mark: (ref) => marks.push(ref) },
		requester,
		sessions,
		clock: systemClock,
		lastSweepAt: () => null,
		log: logger.log,
	});
	const cookie = (login: string) =>
		`${SESSION_COOKIE}=${sessions.seal({ login: asLogin(login), avatarUrl: `https://avatars.test/${login}`, name: null, userToken: `ghu_${login}`, expiresAt: Date.now() + 3_600_000 })}`;
	const post = (path: string, body: unknown, login = "ana") =>
		app.request(path, { method: "POST", headers: { Cookie: cookie(login), "X-Radar": "1", "Content-Type": "application/json" }, body: JSON.stringify(body) });
	const getBoard = async (login = "ana") => jsonOf<BoardResponse>(await app.request("/api/board", { headers: { Cookie: cookie(login) } }));
	const signal = async (kind: string, login = "ana", id: string = likelyReadyPr.id) =>
		jsonOf<AuthorSignalResponse>(await post(`/api/prs/${id}/signal`, { kind }, login));
	return { app, board, hub, marks, rerequests, cookie, post, getBoard, signal, webDist, logger, cleanup: () => rmSync(webDist, { recursive: true, force: true }) };
}

const sign = (body: string) => `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex")}`;

const setCookies = (response: Response) => response.headers.getSetCookie();

describe("HTTP app", () => {
	let h: ReturnType<typeof harness>;

	afterEach(() => {
		h?.cleanup();
	});

	describe("guards", () => {
		it("answers every /api route without a session with 401 and the login URL", async () => {
			h = harness();
			for (const [method, path] of [
				["GET", "/api/board"],
				["GET", "/api/events"],
			] as const) {
				const response = await h.app.request(path, { method });
				expect(response.status).toBe(401);
				expect(await response.json()).toEqual({ error: "unauthenticated", loginUrl: "/auth/login" });
			}
			const tampered = await h.app.request("/api/board", { headers: { Cookie: `${SESSION_COOKIE}=forged` } });
			expect(tampered.status).toBe(401);
		});

		it("refuses a POST under /api without X-Radar: 1", async () => {
			h = harness();
			const response = await h.app.request("/api/presence", {
				method: "POST",
				headers: { Cookie: h.cookie("ana"), "Content-Type": "application/json" },
				body: JSON.stringify({ viewing: null, active: true }),
			});
			expect(response.status).toBe(403);
		});

		it("rejects a body that does not parse", async () => {
			h = harness();
			expect((await h.post("/api/presence", { viewing: 3, active: "yes" })).status).toBe(400);
			expect((await h.post(`/api/prs/${likelyReadyPr.id}/signal`, { kind: "maybe" })).status).toBe(400);
		});

		it("reports health without a session", async () => {
			h = harness();
			const response = await h.app.request("/healthz");
			expect(await response.json()).toEqual({ ok: true, lastSweepAt: null });
		});
	});

	describe("webhook", () => {
		const body = JSON.stringify({ action: "submitted", repository: { name: "web", owner: { login: "acme" } }, pull_request: { number: 1 } });

		it("answers 401 to a bad signature and marks nothing", async () => {
			h = harness();
			const response = await h.app.request("/webhooks/github", {
				method: "POST",
				headers: { "X-GitHub-Event": "pull_request_review", "X-Hub-Signature-256": sign(`${body} `) },
				body,
			});
			expect(response.status).toBe(401);
			expect(h.marks).toEqual([]);
		});

		it("answers 202 to a good signature and marks the pull request", async () => {
			h = harness();
			const response = await h.app.request("/webhooks/github", {
				method: "POST",
				headers: { "X-GitHub-Event": "pull_request_review", "X-Hub-Signature-256": sign(body) },
				body,
			});
			expect(response.status).toBe(202);
			expect(h.marks).toEqual([{ owner: "acme", name: "web", number: 1 }]);
		});

		it("resolves a status event through the head SHA index, and drops a denylisted repository", async () => {
			h = harness();
			const status = JSON.stringify({ repository: { name: "web", owner: { login: "acme" } }, sha: likelyReadyPr.headSha, state: "success" });
			await h.app.request("/webhooks/github", { method: "POST", headers: { "X-GitHub-Event": "status", "X-Hub-Signature-256": sign(status) }, body: status });
			const denied = JSON.stringify({ repository: { name: "Sandbox", owner: { login: "acme" } }, pull_request: { number: 9 } });
			await h.app.request("/webhooks/github", { method: "POST", headers: { "X-GitHub-Event": "pull_request", "X-Hub-Signature-256": sign(denied) }, body: denied });
			expect(h.marks).toEqual([refOf(likelyReadyPr)]);
		});
	});

	describe("sign-in", () => {
		async function signIn(app: ReturnType<typeof harness>["app"]) {
			const login = await app.request("/auth/login");
			const location = new URL(login.headers.get("location") ?? "");
			const state = location.searchParams.get("state") ?? "";
			return { login, location, state, callback: (query: string, cookie = `${STATE_COOKIE}=${state}`) => app.request(`/auth/callback?${query}`, { headers: { Cookie: cookie } }) };
		}

		it("redirects to GitHub with the client id, the callback URL, and a state that also sits in a cookie", async () => {
			h = harness();
			const { login, location, state } = await signIn(h.app);
			expect(login.status).toBe(302);
			expect(`${location.origin}${location.pathname}`).toBe("https://github.com/login/oauth/authorize");
			expect(location.searchParams.get("client_id")).toBe("Iv1.test");
			expect(location.searchParams.get("redirect_uri")).toBe("https://radar.test/auth/callback");
			expect(state.length).toBeGreaterThan(16);
			expect(setCookies(login).some((cookie) => cookie.startsWith(`${STATE_COOKIE}=${state}`) && cookie.includes("HttpOnly"))).toBe(true);
		});

		it("gives a non-member a 403 page that names the organization, and no session", async () => {
			const github = signInGitHub("mallory", ["ana"]);
			h = harness({ fetch: github.fetch });
			const { state, callback } = await signIn(h.app);
			const response = await callback(`code=c0de&state=${state}`);
			expect(response.status).toBe(403);
			expect(await response.text()).toContain("acme");
			expect(setCookies(response).some((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`))).toBe(false);
			const membership = github.requests.find((request) => request.url.endsWith("/orgs/acme/members/mallory"));
			expect(membership?.headers.get("authorization")).toBe("Bearer ghs_installation");
		});

		it("signs a member in with a secure, HttpOnly, SameSite=Lax session cookie", async () => {
			h = harness();
			const { state, callback } = await signIn(h.app);
			const response = await callback(`code=c0de&state=${state}`);
			expect(response.status).toBe(302);
			expect(response.headers.get("location")).toBe("/");
			const session = setCookies(response).find((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`)) ?? "";
			expect(session).toMatch(/HttpOnly/);
			expect(session).toMatch(/SameSite=Lax/);
			expect(session).toMatch(/Secure/);
			expect(session).toMatch(/Path=\//);
			expect(session).not.toContain("ghu_user_token");
			const board = await h.app.request("/api/board", { headers: { Cookie: session.split(";")[0] ?? "" } });
			expect((await jsonOf<BoardResponse>(board)).viewer.login).toBe("ana");
			expect(JSON.stringify(h.logger.lines)).not.toContain("ghu_user_token");
		});

		it("refuses a callback whose state does not match the cookie", async () => {
			h = harness();
			const { callback } = await signIn(h.app);
			const response = await callback("code=c0de&state=forged");
			expect(response.status).toBe(400);
			expect(setCookies(response).some((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`))).toBe(false);
		});

		it("has no demo sign-in in GitHub mode", async () => {
			h = harness();
			expect((await h.app.request("/auth/demo?login=ana")).status).toBe(404);
		});

		it("clears the session on logout", async () => {
			h = harness();
			const response = await h.app.request("/auth/logout", { method: "POST", headers: { Cookie: h.cookie("ana") } });
			expect(response.status).toBe(303);
			expect(setCookies(response).find((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`))).toMatch(/Max-Age=0/);
		});
	});

	describe("author signal", () => {
		it("answers not_author to anyone but the author", async () => {
			h = harness();
			expect(await h.signal("not_ready", "bob")).toEqual({ ok: false, error: "not_author" });
			expect(await h.signal("not_ready", "ana", "PR_404")).toEqual({ ok: false, error: "not_found" });
		});

		it("moves a likely-ready card to changes requested on not_ready, and the next head SHA clears it", async () => {
			h = harness();
			expect((await h.getBoard()).cards[0]?.derived.state).toBe("likely_ready_for_rereview");
			expect(await h.signal("not_ready")).toEqual({ ok: true, wroteToGitHub: false });
			const after = await h.getBoard();
			expect(after.cards[0]?.derived.state).toBe("changes_requested");
			expect(after.heuristic).toEqual({ confirmed: 0, rejected: 1 });
			const pushed: PrSnapshot = { ...likelyReadyPr, headSha: asSha("c3"), headCommittedAt: hour(6) };
			h.board.apply(refOf(pushed), pushed, NOW);
			expect((await h.getBoard()).cards[0]?.derived.state).toBe("likely_ready_for_rereview");
		});

		it("stores ready without the write permission, and clear takes it back", async () => {
			h = harness();
			expect(await h.signal("ready")).toEqual({ ok: true, wroteToGitHub: false });
			expect((await h.getBoard()).cards[0]?.derived.reasons).toContainEqual({ kind: "author_says_ready" });
			expect(await h.signal("clear")).toEqual({ ok: true, wroteToGitHub: false });
			expect((await h.getBoard()).cards[0]?.derived.reasons).not.toContainEqual({ kind: "author_says_ready" });
		});

		it("re-requests the reviewers with feedback, with the author's token, then marks the pull request", async () => {
			h = harness({ config: { rerequestEnabled: true } });
			expect(await h.signal("ready")).toEqual({ ok: true, wroteToGitHub: true });
			expect(h.rerequests).toEqual([{ ref: refOf(likelyReadyPr), logins: ["bob"], userToken: "ghu_ana" }]);
			expect(h.marks).toEqual([refOf(likelyReadyPr)]);
		});

		it("reports nothing_to_rerequest and github_refused", async () => {
			h = harness({ prs: [requestedPr], config: { rerequestEnabled: true } });
			expect(await h.signal("ready", "ana", requestedPr.id)).toEqual({ ok: false, error: "nothing_to_rerequest" });
			h.cleanup();
			h = harness({ config: { rerequestEnabled: true }, refuse: true });
			expect(await h.signal("ready")).toEqual({ ok: false, error: "github_refused" });
			expect(h.marks).toEqual([]);
		});
	});

	describe("presence", () => {
		beforeEach(() => {
			vi.useFakeTimers({ now: NOW });
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it("shows a heartbeat on the board until it expires", async () => {
			h = harness();
			expect((await h.post("/api/presence", { viewing: likelyReadyPr.id, active: true }, "bob")).status).toBe(204);
			expect((await h.getBoard()).presence).toEqual([{ person: { login: "bob", avatarUrl: "https://avatars.test/bob", isBot: false }, viewing: likelyReadyPr.id }]);
			await vi.advanceTimersByTimeAsync(50_000);
			expect((await h.getBoard()).presence).toEqual([]);
		});
	});

	describe("events", () => {
		it("streams resync first, then a card after an apply", async () => {
			h = harness({ prs: [] });
			const response = await h.app.request("/api/events", { headers: { Cookie: h.cookie("ana") } });
			expect(response.headers.get("content-type")).toMatch(/^text\/event-stream/);
			const reader = response.body?.getReader();
			if (reader === undefined) throw new Error("no body");
			const read = async () => new TextDecoder().decode((await reader.read()).value);
			expect(await read()).toBe('event: resync\ndata: {"kind":"resync"}\n\n');
			for (const event of h.board.apply(refOf(requestedPr), requestedPr, NOW)) h.hub.broadcast(event);
			const frame = await read();
			expect(frame.startsWith("event: card\ndata: ")).toBe(true);
			expect(JSON.parse(frame.slice(frame.indexOf("data: ") + 6))).toMatchObject({ kind: "card", card: { id: requestedPr.id } });
			await reader.cancel();
			expect(h.hub.subscribers()).toBe(0);
		});
	});

	describe("web build", () => {
		it("says the build is missing when there is none", async () => {
			h = harness();
			rmSync(h.webDist, { recursive: true, force: true });
			const response = await h.app.request("/");
			expect(response.status).toBe(503);
			expect(await response.text()).toMatch(/web build is missing/);
		});

		it("serves assets, falls back to index.html, and leaves reserved paths alone", async () => {
			h = harness();
			writeFileSync(join(h.webDist, "index.html"), "<!doctype html><title>Radar</title>");
			mkdirSync(join(h.webDist, "assets"));
			writeFileSync(join(h.webDist, "assets", "app.js"), "console.log('radar')");
			const asset = await h.app.request("/assets/app.js");
			expect(asset.headers.get("content-type")).toMatch(/javascript/);
			expect(await asset.text()).toBe("console.log('radar')");
			expect(await (await h.app.request("/pr/123")).text()).toContain("<title>Radar</title>");
			expect((await h.app.request("/auth/nope")).status).toBe(404);
			expect((await h.app.request("/demo/step")).status).toBe(404);
			expect((await h.app.request("/webhooks/github")).status).toBe(404);
		});
	});
});
