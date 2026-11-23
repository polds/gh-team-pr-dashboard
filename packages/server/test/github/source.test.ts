import { describe, expect, it } from "vitest";
import type { AppAuth } from "../../src/github/appAuth.ts";
import { createGitHubSource, refKey } from "../../src/github/source.ts";
import type { PrRef } from "../../src/github/source.ts";
import { answerQuery, fakeFetch, graphqlBody, json, pullRequestAliases, repositoryWorld, worldOf } from "./fakeGitHub.ts";
import type { SentRequest, World } from "./fakeGitHub.ts";
import { HEAD_SHA, pullRequestNodeFor } from "./fixtures.ts";

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

function openPullRequestNode(number: number, changes: Record<string, unknown> = {}) {
	return {
		number,
		updatedAt: "2026-11-04T10:00:00Z",
		headRefOid: "abc",
		isDraft: false,
		reviewDecision: null,
		mergeable: "MERGEABLE",
		mergeStateStatus: "CLEAN",
		reviewRequests: { totalCount: 1 },
		commits: { nodes: [{ commit: { statusCheckRollup: { state: "PENDING" } } }] },
		...changes,
	};
}

function openPullRequestsPage(name: string, after: unknown, nodes: (number: number) => unknown = openPullRequestNode) {
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
					nodes: pageEntry.numbers.map(nodes),
				},
			},
		},
	});
}

const TEAM_PAGES: Record<string, unknown> = {
	start: {
		pageInfo: { hasNextPage: true, endCursor: "teams-1" },
		nodes: [
			{
				slug: "platform",
				name: "Platform",
				members: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ login: "bob", avatarUrl: "https://avatars.example/bob" }, null] },
			},
		],
	},
	"teams-1": {
		pageInfo: { hasNextPage: false, endCursor: null },
		nodes: [{ slug: "web", name: "Web", members: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } }],
	},
};

/** A fake GitHub that knows the open pull requests in `existing` and answers 502 to any query that asks for a ref in `broken`. */
function fakeGitHub({
	existing = [] as PrRef[],
	broken = [] as PrRef[],
	listing = openPullRequestNode as (number: number) => unknown,
} = {}) {
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
		if (query.startsWith("query OpenPullRequests")) return openPullRequestsPage(String(variables.name), variables.after, listing);
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
		const open = await radar.listOpen();
		expect(open.map(({ fingerprint: _fingerprint, ...ref }) => ref)).toEqual([
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

	it.each([
		["updatedAt", { updatedAt: "2026-11-04T11:00:00Z" }],
		["headRefOid", { headRefOid: "def" }],
		["isDraft", { isDraft: true }],
		["reviewDecision", { reviewDecision: "APPROVED" }],
		["mergeable", { mergeable: "CONFLICTING" }],
		["mergeStateStatus", { mergeStateStatus: "BLOCKED" }],
		["the review request count", { reviewRequests: { totalCount: 2 } }],
		["the check rollup state", { commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] } }],
	])("moves the fingerprint when %s changes and keeps it otherwise", async (_label, changes) => {
		const fingerprints = async (listing: (number: number) => unknown) =>
			(await source(fakeGitHub({ listing })).radar.listOpen()).map((pr) => pr.fingerprint);
		const before = await fingerprints((number) => openPullRequestNode(number));
		const again = await fingerprints((number) => openPullRequestNode(number));
		const after = await fingerprints((number) => openPullRequestNode(number, number === 2 ? changes : {}));
		expect(again).toEqual(before);
		expect(after.filter((fingerprint, index) => fingerprint !== before[index])).toHaveLength(1);
		expect(after[1]).not.toBe(before[1]);
	});

	it("reads a pull request with no commits and no rollup", async () => {
		const github = fakeGitHub({ listing: (number) => openPullRequestNode(number, { commits: { nodes: [] }, reviewRequests: null }) });
		await expect(source(github).radar.listOpen()).resolves.toHaveLength(4);
	});

	it("looks the installation up once and uses its token", async () => {
		const github = fakeGitHub({ existing: [{ owner: "acme", name: "api", number: 1 }] });
		const { radar, appAuth } = source(github);
		await radar.listOpen();
		await radar.fetch([{ owner: "acme", name: "api", number: 1 }]);
		await radar.teams();
		await expect(radar.installationToken()).resolves.toBe("ghs_installation");
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

	it("pages the members of a team past the first page, one team at a time", async () => {
		const developers = Array.from({ length: 250 }, (_, index) => ({ login: `dev${index + 1}`, avatarUrl: "" }));
		const membersPage = (after: unknown) => {
			const start = typeof after === "string" ? Number(after) : 0;
			const end = start + 100;
			return { pageInfo: { hasNextPage: end < developers.length, endCursor: String(end) }, nodes: developers.slice(start, end) };
		};
		const github = fakeFetch((request) => {
			const { query, variables } = graphqlBody(request);
			if (query.startsWith("query OrganizationTeams")) {
				const web = { slug: "web", name: "Web", members: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } };
				const platform = { slug: "platform", name: "Platform", members: membersPage(null) };
				return json({ data: { organization: { teams: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [platform, web] } } } });
			}
			if (query.startsWith("query TeamMembers")) return json({ data: { organization: { team: { members: membersPage(variables.after) } } } });
			return new Response("unexpected", { status: 500 });
		});
		const [platform, web] = await source(github, { installationId: INSTALLATION_ID }).radar.teams();
		expect(platform?.members.map((member) => member.login)).toEqual(developers.map((developer) => developer.login));
		expect(web?.members).toEqual([]);
		const memberQueries = graphqlQueries(github.requests).filter(({ query }) => query.startsWith("query TeamMembers"));
		expect(memberQueries.map(({ variables }) => [variables.slug, variables.after])).toEqual([
			["platform", "100"],
			["platform", "200"],
		]);
	});

	describe("the connections that feed the state", () => {
		const ref = { owner: "acme", name: "api", number: 1 };
		const user = (login: string) => ({ __typename: "User", login, avatarUrl: "" });
		const many = <T>(count: number, make: (index: number) => T) => Array.from({ length: count }, (_, index) => make(index));
		const at = (index: number) => new Date(Date.parse("2026-11-03T00:00:00Z") + index * 60_000).toISOString().replace(".000", "");
		const review = (index: number) => ({ state: "CHANGES_REQUESTED", submittedAt: at(index), author: user(`reviewer-${index}`), commit: { oid: HEAD_SHA } });

		function pullRequestWorld(changes: (pr: World) => World = (pr) => pr): World {
			return changes({ ...(worldOf(pullRequestNodeFor(ref)) as World), updatedAt: "2026-11-04T10:00:00Z" });
		}

		/** GitHub over one repository holding `pr`. With `failAfter`, every GraphQL request past that many answers 502. */
		function github(pr: World, failAfter = Number.POSITIVE_INFINITY) {
			let answered = 0;
			return fakeFetch((request) => {
				if (request.url !== "https://api.github.com/graphql") return new Response("not found", { status: 404 });
				answered += 1;
				if (answered > failAfter) return new Response("bad gateway", { status: 502 });
				const { query, variables } = graphqlBody(request);
				const repository = ({ owner, name }: { owner: string; name: string }) => (owner === ref.owner && name === ref.name ? repositoryWorld([pr]) : null);
				return json(answerQuery(query, variables, { repository }));
			});
		}

		const fetchOne = async (fake: ReturnType<typeof github>) => {
			const { radar, failures } = source(fake, { installationId: INSTALLATION_ID });
			return { snapshots: await radar.fetch([ref]), failures };
		};

		const withChecks = (contexts: unknown[]) => (pr: World): World => {
			const [head] = pr.commits as { commit: World }[];
			return { ...pr, commits: [{ commit: { ...head!.commit, statusCheckRollup: { state: "SUCCESS", contexts } } }] };
		};

		it.each([
			["review threads", 230, (pr: World) => ({ ...pr, reviewThreads: many(230, (index) => ({ isResolved: false, isOutdated: false, comments: [{ createdAt: at(index), author: user("carol") }] })) })],
			["latest reviews", 130, (pr: World) => ({ ...pr, latestReviews: many(130, review) })],
			["latest opinionated reviews", 130, (pr: World) => ({ ...pr, latestOpinionatedReviews: many(130, review) })],
			["review requests", 130, (pr: World) => ({ ...pr, reviewRequests: many(130, (index) => ({ asCodeOwner: false, requestedReviewer: user(`requested-${index}`) })) })],
			[
				"check contexts",
				230,
				withChecks(many(230, (index) => ({ __typename: "CheckRun", name: `check-${index}`, status: "COMPLETED", conclusion: "SUCCESS", completedAt: at(index), isRequired: false }))),
			],
		])("holds all %s past the first page", async (label, count, changes) => {
			const { snapshots, failures } = await fetchOne(github(pullRequestWorld(changes)));
			const snapshot = snapshots.get(refKey(ref));
			const held = {
				"review threads": snapshot?.threads,
				"latest reviews": snapshot?.latestReviews,
				"latest opinionated reviews": snapshot?.decisiveReviews,
				"review requests": snapshot?.reviewRequests,
				"check contexts": snapshot?.checks,
			}[label];
			expect(failures).toEqual([]);
			expect(held).toHaveLength(count);
		});

		it("asks one query when every connection fits on its first page", async () => {
			const fake = github(pullRequestWorld());
			const { snapshots } = await fetchOne(fake);
			expect(snapshots.get(refKey(ref))).toMatchObject({ number: 1 });
			expect(fake.requests).toHaveLength(1);
		});

		it("leaves out a pull request whose next page fails, so the caller keeps its old data", async () => {
			const threads = many(130, (index) => ({ isResolved: true, isOutdated: false, comments: [{ createdAt: at(index), author: user("carol") }] }));
			const { snapshots, failures } = await fetchOne(github(pullRequestWorld((pr) => ({ ...pr, reviewThreads: threads })), 1));
			expect(snapshots.has(refKey(ref))).toBe(false);
			expect(failures).toEqual([refKey(ref)]);
		});
	});
});
