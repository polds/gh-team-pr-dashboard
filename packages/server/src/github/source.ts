import { z } from "zod";
import { asLogin, asTeamSlug } from "@radar/core";
import type { Person, PrSnapshot, TeamSlug } from "@radar/core";
import type { AppAuth } from "./appAuth.ts";
import { collectPages, connection, graphqlRequest, isNotFound, page } from "./graphql.ts";
import type { Fetch } from "./http.ts";
import { ORG_TEAMS_QUERY, OPEN_PULL_REQUESTS_QUERY, buildPullRequestsQuery, pullRequestAlias } from "./queries.ts";
import { findOrgInstallation, listInstallationRepos } from "./rest.ts";
import { parsePullRequest } from "./snapshot.ts";

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

const orgTeamsSchema = z.object({
	organization: z.object({
		teams: page(
			z.object({
				slug: z.string(),
				name: z.string(),
				members: connection(z.object({ login: z.string(), avatarUrl: z.string() })),
			}),
		),
	}),
});

const pullRequestsSchema = z.record(z.string(), z.object({ pullRequest: z.unknown() }).nullable());

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

	async function fetchBatch(refs: PrRef[]): Promise<[string, PrSnapshot | null][]> {
		const data = await graphqlRequest({
			token: await token(),
			query: buildPullRequestsQuery(refs),
			schema: pullRequestsSchema,
			allowErrors: isNotFound,
			fetch,
		});
		return refs.map((ref, index) => {
			const entry = data[pullRequestAlias(index)];
			if (entry === undefined) throw new Error(`GraphQL response has no entry for ${refKey(ref)}`);
			return [refKey(ref), entry === null || entry.pullRequest === null ? null : parsePullRequest(entry.pullRequest)];
		});
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
			return teams.map(({ slug, name, members }) => ({
				slug: asTeamSlug(slug),
				name,
				members: members.map((member) => ({ login: asLogin(member.login), avatarUrl: member.avatarUrl, isBot: false })),
			}));
		},
	};
}
