import { describe, expect, it } from "vitest";
import type { AppAuth } from "../../src/github/appAuth.ts";
import { createGitHubSource, refKey } from "../../src/github/source.ts";
import type { PrRef } from "../../src/github/source.ts";
import { fakeFetch, graphqlBody, json, pullRequestAliases } from "./fakeGitHub.ts";
import type { SentRequest } from "./fakeGitHub.ts";
import { pullRequestNodeFor } from "./fixtures.ts";

const INSTALLATION_ID = 77;

function fakeAppAuth(): AppAuth & { tokensFor: number[] } {
	const tokensFor: number[] = [];
	return {
		tokensFor,
		appJwt: () => "app.jwt",
		installationToken: async (id) => {
			tokensFor.push(id);
			return "ghs_installation";
		},
	};
}

const repo = (name: string, archived = false) => ({ name, owner: { login: "acme" }, archived });
const REPOS_PAGE_2 = "https://api.github.com/installation/repositories?per_page=100&page=2";

const OPEN_NUMBERS: Record<string, Record<string, { numbers: number[]; after: string | null }>> = {
	api: { start: { numbers: [1, 2], after: "cursor-1" }, "cursor-1": { numbers: [3], after: null } },
	web: { start: { numbers: [7], after: null } },
};

function openNumbersPage(name: string, after: unknown) {
	const pages = OPEN_NUMBERS[name];
	const pageEntry = pages?.[typeof after === "string" ? after : "start"];
	if (pages === undefined || pageEntry === undefined) {
		return json({ data: { repository: null }, errors: [{ type: "NOT_FOUND", message: `Could not resolve to a Repository with the name 'acme/${name}'.` }] });
	}
	return json({
		data: {
			repository: {
				pullRequests: {
					pageInfo: { hasNextPage: pageEntry.after !== null, endCursor: pageEntry.after },
					nodes: pageEntry.numbers.map((number) => ({ number })),
				},
			},
		},
	});
}

const TEAM_PAGES: Record<string, unknown> = {
	start: {
		pageInfo: { hasNextPage: true, endCursor: "teams-1" },
		nodes: [{ slug: "platform", name: "Platform", members: { nodes: [{ login: "bob", avatarUrl: "https://avatars.example/bob" }, null] } }],
	},
	"teams-1": {
		pageInfo: { hasNextPage: false, endCursor: null },
		nodes: [{ slug: "web", name: "Web", members: { nodes: [] } }],
	},
};

/** A fake GitHub that knows the open pull requests in `existing` and answers 502 to any query that asks for a ref in `broken`. */
function fakeGitHub({ existing = [] as PrRef[], broken = [] as PrRef[] } = {}) {
	const existingKeys = new Set(existing.map(refKey));
	const brokenKeys = new Set(broken.map(refKey));
	return fakeFetch((request: SentRequest) => {
		if (request.url === "https://api.github.com/orgs/acme/installation") return json({ id: INSTALLATION_ID });
		if (request.url === REPOS_PAGE_2) return json({ repositories: [repo("web"), repo("gone")] });
		if (request.url.startsWith("https://api.github.com/installation/repositories")) {
			return json(
				{ repositories: [repo("api"), repo("legacy", true), repo("noisy")] },
				{ headers: { link: `<${REPOS_PAGE_2}>; rel="next"` } },
			);
		}
		if (request.url !== "https://api.github.com/graphql") return new Response("not found", { status: 404 });
		const { query, variables } = graphqlBody(request);
		if (query.startsWith("query OpenPullRequestNumbers")) return openNumbersPage(String(variables.name), variables.after);
		if (query.startsWith("query OrganizationTeams")) {
			return json({ data: { organization: { teams: TEAM_PAGES[typeof variables.after === "string" ? variables.after : "start"] } } });
		}
		const aliases = pullRequestAliases(query);
		if (aliases.some((ref) => brokenKeys.has(refKey(ref)))) return new Response("bad gateway", { status: 502 });
		const data: Record<string, unknown> = {};
		const errors: unknown[] = [];
		for (const { alias, ...ref } of aliases) {
			if (existingKeys.has(refKey(ref))) {
				data[alias] = { pullRequest: pullRequestNodeFor(ref) };
			} else {
				data[alias] = { pullRequest: null };
				errors.push({ type: "NOT_FOUND", path: [alias, "pullRequest"], message: `Could not resolve to a PullRequest with the number of ${ref.number}.` });
			}
		}
		return json(errors.length > 0 ? { data, errors } : { data });
	});
}

function source(github: ReturnType<typeof fakeGitHub>, options: { installationId?: number; batchSize?: number } = {}) {
	const appAuth = fakeAppAuth();
	const failures: string[] = [];
	const radar = createGitHubSource({
		org: "acme",
		appAuth,
		repoDenylist: ["Noisy"],
		fetch: github.fetch,
		onFetchError: (_error, ref) => failures.push(refKey(ref)),
		...options,
	});
	return { radar, appAuth, failures };
}

const graphqlQueries = (requests: SentRequest[]) =>
	requests.filter((request) => request.url === "https://api.github.com/graphql").map((request) => graphqlBody(request));

describe("createGitHubSource", () => {
	it("lists open pull requests across pages, skipping archived, denylisted, and vanished repositories", async () => {
		const github = fakeGitHub();
		const { radar } = source(github);
		await expect(radar.listOpen()).resolves.toEqual([
			{ owner: "acme", name: "api", number: 1 },
			{ owner: "acme", name: "api", number: 2 },
			{ owner: "acme", name: "api", number: 3 },
			{ owner: "acme", name: "web", number: 7 },
		]);
		const asked = graphqlQueries(github.requests).map(({ variables }) => [variables.name, variables.after]);
		expect(asked).toEqual([
			["api", null],
			["api", "cursor-1"],
			["web", null],
			["gone", null],
		]);
	});

	it("looks the installation up once and uses its token", async () => {
		const github = fakeGitHub({ existing: [{ owner: "acme", name: "api", number: 1 }] });
		const { radar, appAuth } = source(github);
		await radar.listOpen();
		await radar.fetch([{ owner: "acme", name: "api", number: 1 }]);
		await radar.teams();
		expect(github.requests.filter((request) => request.url.endsWith("/orgs/acme/installation"))).toHaveLength(1);
		expect(new Set(appAuth.tokensFor)).toEqual(new Set([INSTALLATION_ID]));
		expect(github.requests.every((request) => request.url.endsWith("/installation") || request.headers.get("authorization") === "Bearer ghs_installation")).toBe(true);
	});

	it("skips the installation lookup when the id is configured", async () => {
		const github = fakeGitHub();
		const { radar, appAuth } = source(github, { installationId: 5 });
		await radar.teams();
		expect(github.requests.some((request) => request.url.endsWith("/orgs/acme/installation"))).toBe(false);
		expect(new Set(appAuth.tokensFor)).toEqual(new Set([5]));
	});

	it("returns snapshots keyed by refKey and null for a pull request that does not exist", async () => {
		const github = fakeGitHub({ existing: [{ owner: "acme", name: "api", number: 1 }, { owner: "acme", name: "web", number: 7 }] });
		const { radar } = source(github);
		const snapshots = await radar.fetch([
			{ owner: "acme", name: "api", number: 1 },
			{ owner: "acme", name: "api", number: 404 },
			{ owner: "acme", name: "web", number: 7 },
		]);
		expect([...snapshots.keys()]).toEqual(["acme/api#1", "acme/api#404", "acme/web#7"]);
		expect(snapshots.get("acme/api#1")).toMatchObject({ repo: { owner: "acme", name: "api" }, number: 1 });
		expect(snapshots.get("acme/web#7")).toMatchObject({ repo: { owner: "acme", name: "web" }, number: 7 });
		expect(snapshots.get("acme/api#404")).toBeNull();
		expect(graphqlQueries(github.requests)).toHaveLength(1);
	});

	it("retries a failed batch one ref at a time and leaves out refs that still fail", async () => {
		const api1 = { owner: "acme", name: "api", number: 1 };
		const api404 = { owner: "acme", name: "api", number: 404 };
		const api3 = { owner: "acme", name: "api", number: 3 };
		const web7 = { owner: "acme", name: "web", number: 7 };
		const github = fakeGitHub({ existing: [api1, api3, web7], broken: [web7] });
		const { radar, failures } = source(github, { batchSize: 2 });
		const snapshots = await radar.fetch([api1, api404, api3, web7]);
		expect([...snapshots.keys()]).toEqual(["acme/api#1", "acme/api#404", "acme/api#3"]);
		expect(snapshots.get("acme/api#3")).toMatchObject({ number: 3 });
		expect(snapshots.get("acme/api#404")).toBeNull();
		expect(failures).toEqual(["acme/web#7"]);
		const batches = graphqlQueries(github.requests).map(({ query }) => pullRequestAliases(query).map(({ alias, ...ref }) => refKey(ref)));
		expect(batches).toEqual([["acme/api#1", "acme/api#404"], ["acme/api#3", "acme/web#7"], ["acme/api#3"], ["acme/web#7"]]);
	});

	it("returns an empty map without a request for no refs", async () => {
		const github = fakeGitHub();
		const { radar } = source(github, { installationId: INSTALLATION_ID });
		await expect(radar.fetch([])).resolves.toEqual(new Map());
		expect(github.requests).toHaveLength(0);
	});

	it("lists every team with its members", async () => {
		const github = fakeGitHub();
		const { radar } = source(github);
		await expect(radar.teams()).resolves.toEqual([
			{ slug: "platform", name: "Platform", members: [{ login: "bob", avatarUrl: "https://avatars.example/bob", isBot: false }] },
			{ slug: "web", name: "Web", members: [] },
		]);
	});
});
