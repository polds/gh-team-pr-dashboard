import { createHmac, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardResponse } from "@radar/core";
import { systemClock } from "../src/clock.ts";
import { loadConfig } from "../src/config.ts";
import { SESSION_COOKIE } from "../src/http.ts";
import { createRadar } from "../src/radar.ts";
import type { Radar } from "../src/radar.ts";
import { createSessionCodec } from "../src/session.ts";
import { asLogin } from "@radar/core";
import { fakeFetch, graphqlBody, json, pullRequestAliases } from "./github/fakeGitHub.ts";
import { pullRequestNodeFor } from "./github/fixtures.ts";
import { jsonOf, recordingLogger } from "./helpers.ts";

const SESSION_SECRET = "s".repeat(64);
const WEBHOOK_SECRET = "hook-secret";
const CLIENT_SECRET = "client-secret-value";
const INSTALLATION_TOKEN = "ghs_installation_token";

function fakeGitHub() {
	return fakeFetch((request) => {
		if (request.url === "https://api.github.com/app/installations/9/access_tokens") {
			return json({ token: INSTALLATION_TOKEN, expires_at: "2099-01-01T00:00:00Z" });
		}
		if (request.url.startsWith("https://api.github.com/installation/repositories")) {
			return json({ repositories: [{ name: "api", owner: { login: "acme" }, archived: false }] });
		}
		if (request.url !== "https://api.github.com/graphql") return new Response("not found", { status: 404 });
		const { query } = graphqlBody(request);
		if (query.startsWith("query OrganizationTeams")) {
			return json({ data: { organization: { teams: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } });
		}
		if (query.startsWith("query OpenPullRequests")) {
			const node = { number: 42, updatedAt: "2026-11-04T10:00:00Z", headRefOid: "abc", isDraft: false, reviewDecision: null, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewRequests: { totalCount: 0 }, commits: { nodes: [] } };
			return json({ data: { repository: { pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [node] } } } });
		}
		const data = Object.fromEntries(pullRequestAliases(query).map(({ alias, ...ref }) => [alias, { pullRequest: pullRequestNodeFor(ref) }]));
		return json({ data });
	});
}

describe("GitHub mode wiring", () => {
	let radar: Radar;
	let dataDir: string;

	beforeEach(() => {
		vi.useFakeTimers({ now: new Date("2026-11-05T10:00:00Z") });
		dataDir = mkdtempSync(join(tmpdir(), "radar-data-"));
	});

	afterEach(() => {
		vi.useRealTimers();
		rmSync(dataDir, { recursive: true, force: true });
	});

	function githubConfig() {
		const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
		return loadConfig({
			RADAR_ORG: "acme",
			RADAR_BASE_URL: "https://radar.test",
			RADAR_SESSION_SECRET: SESSION_SECRET,
			RADAR_DATA_DIR: dataDir,
			GITHUB_APP_ID: "123",
			GITHUB_APP_CLIENT_ID: "Iv1.test",
			GITHUB_APP_CLIENT_SECRET: CLIENT_SECRET,
			GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
			GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
			GITHUB_INSTALLATION_ID: "9",
		});
	}

	const cookieFor = (login: string) =>
		`${SESSION_COOKIE}=${createSessionCodec(SESSION_SECRET).seal({ login: asLogin(login), avatarUrl: "", name: null, userToken: `ghu_${login}`, expiresAt: Date.now() + 60_000 })}`;

	const deliver = (event: string, payload: unknown) => {
		const body = JSON.stringify(payload);
		const signature = `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex")}`;
		return radar.app.request("/webhooks/github", { method: "POST", headers: { "X-GitHub-Event": event, "X-Hub-Signature-256": signature }, body });
	};

	it("sweeps, serves the board, refreshes on a signed webhook, and writes the state file on stop, with no secret in the log", async () => {
		const config = githubConfig();
		const github = fakeGitHub();
		const logger = recordingLogger();
		radar = createRadar({ config, clock: systemClock, log: logger.log, fetch: github.fetch });

		await radar.reconciler.sweep();
		const health = await jsonOf<{ ok: boolean; lastSweepAt: string | null }>(await radar.app.request("/healthz"));
		expect(health).toEqual({ ok: true, lastSweepAt: "2026-11-05T10:00:00.000Z" });

		const cookie = cookieFor("alice");
		const board = await jsonOf<BoardResponse>(await radar.app.request("/api/board", { headers: { Cookie: cookie } }));
		expect(board.cards.map((card) => `${card.repo}#${card.number}`)).toEqual(["acme/api#42"]);
		expect(board.config).toMatchObject({ org: "acme", demo: false, rerequestEnabled: false });

		const fetchesBefore = github.requests.filter((request) => request.body.includes("query PullRequests")).length;
		const hook = await deliver("pull_request", { action: "synchronize", repository: { name: "api", owner: { login: "acme" } }, pull_request: { number: 42 } });
		expect(hook.status).toBe(202);
		await vi.advanceTimersByTimeAsync(1500);
		expect(github.requests.filter((request) => request.body.includes("query PullRequests")).length).toBe(fetchesBefore + 1);

		radar.stop();
		const stored = JSON.parse(readFileSync(join(dataDir, "state.json"), "utf8"));
		expect(Object.keys(stored.states)).toEqual(["PR_acme_api_42"]);

		const logged = JSON.stringify(logger.lines);
		for (const secret of [INSTALLATION_TOKEN, CLIENT_SECRET, WEBHOOK_SECRET, SESSION_SECRET, "PRIVATE KEY", "ghu_alice"]) {
			expect(logged).not.toContain(secret);
		}
	});

	it("keeps a pull request from a repository outside the organization off the board after a signed webhook and a sweep", async () => {
		radar = createRadar({ config: githubConfig(), clock: systemClock, log: recordingLogger().log, fetch: fakeGitHub().fetch });
		await radar.reconciler.sweep();
		await deliver("pull_request", { action: "opened", repository: { name: "anything", owner: { login: "someone-else" } }, pull_request: { number: 7 } });
		await vi.advanceTimersByTimeAsync(1500);
		await radar.reconciler.sweep();
		const board = await jsonOf<BoardResponse>(await radar.app.request("/api/board", { headers: { Cookie: cookieFor("alice") } }));
		radar.stop();
		expect(board.cards.map((card) => `${card.repo}#${card.number}`)).toEqual(["acme/api#42"]);
	});
});
