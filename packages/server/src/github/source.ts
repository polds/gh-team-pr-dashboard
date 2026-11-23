import { z } from "zod";
import { asLogin, asTeamSlug } from "@radar/core";
import type { Person, PrSnapshot, TeamSlug } from "@radar/core";
import type { AppAuth } from "./appAuth.ts";
import { collectPages, connection, graphqlRequest, isNotFound, page } from "./graphql.ts";
import type { Fetch } from "./http.ts";
import { CONNECTION_PAGE_QUERIES, ORG_TEAMS_QUERY, OPEN_PULL_REQUESTS_QUERY, TEAM_MEMBERS_QUERY, buildPullRequestsQuery, pullRequestAlias } from "./queries.ts";
import { findOrgInstallation, listInstallationRepos } from "./rest.ts";
import { pagedNodeSchemas, parsePullRequestNode, toSnapshot } from "./snapshot.ts";
import type { Page, PagedConnection, PagedNode, Pages, PullRequestNode } from "./snapshot.ts";

export interface PrRef {
	owner: string;
	name: string;
	number: number;
}

export function refKey(ref: PrRef): string {
	return `${ref.owner}/${ref.name}#${ref.number}`;
}

/** An open pull request from the listing. Equal fingerprints mean the cheap fields did not move since the last listing. */
export type OpenPr = PrRef & { fingerprint: string };

export interface TeamInfo {
	slug: TeamSlug;
	name: string;
	members: Person[];
}

export interface PullRequestSource {
	listOpen(): Promise<OpenPr[]>;
	/** Keyed by `refKey`. Null when the pull request does not exist. A ref that failed to load is absent, so the caller keeps its old data. */
	fetch(refs: PrRef[]): Promise<Map<string, PrSnapshot | null>>;
	teams(): Promise<TeamInfo[]>;
}

const openPullRequestSchema = z
	.object({
		number: z.number().int().positive(),
		updatedAt: z.string(),
		headRefOid: z.string(),
		isDraft: z.boolean(),
		reviewDecision: z.string().nullable(),
		mergeable: z.string(),
		mergeStateStatus: z.string(),
		reviewRequests: z.object({ totalCount: z.number().int() }).nullable(),
		commits: connection(z.object({ commit: z.object({ statusCheckRollup: z.object({ state: z.string() }).nullable() }) })),
	})
	.transform(({ number, reviewRequests, commits, ...fields }) => ({
		number,
		fingerprint: JSON.stringify([
			fields.updatedAt,
			fields.headRefOid,
			fields.isDraft,
			fields.reviewDecision,
			fields.mergeable,
			fields.mergeStateStatus,
			reviewRequests?.totalCount ?? 0,
			commits.at(-1)?.commit.statusCheckRollup?.state ?? null,
		]),
	}));

const openPullRequestsSchema = z.object({
	repository: z.object({ pullRequests: page(openPullRequestSchema) }).nullable(),
});

const memberSchema = z.object({ login: z.string(), avatarUrl: z.string() });

const orgTeamsSchema = z.object({
	organization: z.object({
		teams: page(z.object({ slug: z.string(), name: z.string(), members: page(memberSchema) })),
	}),
});

const teamMembersSchema = z.object({
	organization: z.object({ team: z.object({ members: page(memberSchema) }).nullable() }),
});

const pullRequestsSchema = z.record(z.string(), z.object({ pullRequest: z.unknown() }).nullable());

function pullRequestPageSchema<T extends z.ZodType>(node: T) {
	return z
		.object({ repository: z.object({ pullRequest: z.object({ connection: page(node) }).nullable() }).nullable() })
		.transform((data) => data.repository?.pullRequest?.connection ?? null);
}

const checkContextsPageSchema = z
	.object({
		repository: z
			.object({ object: z.object({ statusCheckRollup: z.object({ connection: page(pagedNodeSchemas.checkContexts) }).nullish() }).nullable() })
			.nullable(),
	})
	.transform((data) => data.repository?.object?.statusCheckRollup?.connection ?? null);

/** Null when the pull request, or the commit its checks belong to, is gone. */
const pageSchemas: { [K in PagedConnection]: z.ZodType<Page<PagedNode<K>> | null> } = {
	reviewRequests: pullRequestPageSchema(pagedNodeSchemas.reviewRequests),
	latestOpinionatedReviews: pullRequestPageSchema(pagedNodeSchemas.latestOpinionatedReviews),
	latestReviews: pullRequestPageSchema(pagedNodeSchemas.latestReviews),
	reviewThreads: pullRequestPageSchema(pagedNodeSchemas.reviewThreads),
	checkContexts: checkContextsPageSchema,
};

export interface GitHubSource extends PullRequestSource {
	/** The installation token the source itself uses. */
	installationToken(): Promise<string>;
}

export function createGitHubSource({
	org,
	appAuth,
	installationId,
	repoDenylist,
	fetch = globalThis.fetch,
	batchSize = 10,
	onFetchError = () => {},
}: {
	org: string;
	appAuth: AppAuth;
	installationId?: number;
	repoDenylist: string[];
	fetch?: Fetch;
	batchSize?: number;
	/** Called once for each ref left out of a `fetch` result, with the error from its last attempt. */
	onFetchError?: (error: unknown, ref: PrRef) => void;
}): GitHubSource {
	const denied = new Set(repoDenylist.map((name) => name.toLowerCase()));
	let installation: Promise<number> | null = installationId === undefined ? null : Promise.resolve(installationId);

	function installationIdOnce(): Promise<number> {
		installation ??= findOrgInstallation({ token: appAuth.appJwt(), org, fetch }).catch((error: unknown) => {
			installation = null;
			throw error;
		});
		return installation;
	}

	async function token(): Promise<string> {
		return appAuth.installationToken(await installationIdOnce());
	}

	async function openPullRequests(owner: string, name: string): Promise<OpenPr[]> {
		const pulls = await collectPages(async (after) => {
			const data = await graphqlRequest({
				token: await token(),
				query: OPEN_PULL_REQUESTS_QUERY,
				variables: { owner, name, after },
				schema: openPullRequestsSchema,
				allowErrors: isNotFound,
				fetch,
			});
			return data.repository?.pullRequests ?? { nodes: [], after: null };
		});
		return pulls.map(({ number, fingerprint }) => ({ owner, name, number, fingerprint }));
	}

	async function teamMembers(slug: string, after: string | null) {
		const data = await graphqlRequest({
			token: await token(),
			query: TEAM_MEMBERS_QUERY,
			variables: { org, slug, after },
			schema: teamMembersSchema,
			fetch,
		});
		return data.organization.team?.members ?? { nodes: [], after: null };
	}

	async function rest<K extends PagedConnection>(ref: PrRef, pr: PullRequestNode, field: K): Promise<Page<PagedNode<K>>> {
		const first: Page<PagedNode<K>> = pr.pages[field];
		if (first.after === null) return first;
		const { headOid } = pr;
		if (field === "checkContexts" && headOid === null) throw new Error(`${refKey(ref)} has check contexts but no head commit`);
		const more = await collectPages(async (after) => {
			const next = await graphqlRequest({
				token: await token(),
				query: CONNECTION_PAGE_QUERIES[field],
				variables: { owner: ref.owner, name: ref.name, number: ref.number, after, ...(field === "checkContexts" ? { oid: headOid } : {}) },
				schema: pageSchemas[field],
				fetch,
			});
			if (next === null) throw new Error(`${refKey(ref)} vanished while paging its ${field}`);
			return next;
		}, first.after);
		return { nodes: [...first.nodes, ...more], after: null };
	}

	async function snapshotOf(ref: PrRef, node: unknown): Promise<PrSnapshot> {
		const pr = parsePullRequestNode(node);
		const pages: Pages = {
			reviewRequests: await rest(ref, pr, "reviewRequests"),
			latestOpinionatedReviews: await rest(ref, pr, "latestOpinionatedReviews"),
			latestReviews: await rest(ref, pr, "latestReviews"),
			reviewThreads: await rest(ref, pr, "reviewThreads"),
			checkContexts: await rest(ref, pr, "checkContexts"),
		};
		return toSnapshot({ ...pr, pages });
	}

	async function fetchBatch(refs: PrRef[]): Promise<[string, PrSnapshot | null][]> {
		const data = await graphqlRequest({
			token: await token(),
			query: buildPullRequestsQuery(refs),
			schema: pullRequestsSchema,
			allowErrors: isNotFound,
			fetch,
		});
		const entries: [string, PrSnapshot | null][] = [];
		for (const [index, ref] of refs.entries()) {
			const entry = data[pullRequestAlias(index)];
			if (entry === undefined) throw new Error(`GraphQL response has no entry for ${refKey(ref)}`);
			entries.push([refKey(ref), entry === null || entry.pullRequest === null ? null : await snapshotOf(ref, entry.pullRequest)]);
		}
		return entries;
	}

	async function fetchBatchOrEach(batch: PrRef[]): Promise<[string, PrSnapshot | null][]> {
		try {
			return await fetchBatch(batch);
		} catch {
			const entries: [string, PrSnapshot | null][] = [];
			for (const ref of batch) {
				try {
					entries.push(...(await fetchBatch([ref])));
				} catch (error) {
					onFetchError(error, ref);
				}
			}
			return entries;
		}
	}

	return {
		installationToken: token,

		async listOpen() {
			const repos = await listInstallationRepos({ token: await token(), fetch });
			const open: OpenPr[] = [];
			for (const { owner, name, archived } of repos) {
				if (archived || denied.has(name.toLowerCase())) continue;
				open.push(...(await openPullRequests(owner, name)));
			}
			return open;
		},

		async fetch(refs) {
			const unique = [...new Map(refs.map((ref) => [refKey(ref), ref])).values()];
			const snapshots = new Map<string, PrSnapshot | null>();
			for (let start = 0; start < unique.length; start += batchSize) {
				for (const [key, snapshot] of await fetchBatchOrEach(unique.slice(start, start + batchSize))) {
					snapshots.set(key, snapshot);
				}
			}
			return snapshots;
		},

		async teams() {
			const teams = await collectPages(async (after) => {
				const data = await graphqlRequest({
					token: await token(),
					query: ORG_TEAMS_QUERY,
					variables: { org, after },
					schema: orgTeamsSchema,
					fetch,
				});
				return data.organization.teams;
			});
			const infos: TeamInfo[] = [];
			for (const { slug, name, members } of teams) {
				const rest = members.after === null ? [] : await collectPages((after) => teamMembers(slug, after), members.after);
				infos.push({
					slug: asTeamSlug(slug),
					name,
					members: [...members.nodes, ...rest].map((member) => ({ login: asLogin(member.login), avatarUrl: member.avatarUrl, isBot: false })),
				});
			}
			return infos;
		},
	};
}
