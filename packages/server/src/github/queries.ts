import type { PagedConnection } from "./snapshot.ts";
import type { PrRef } from "./source.ts";

const NAME = /^[A-Za-z0-9._-]+$/;

const ACTOR = "{ __typename login avatarUrl }";
const COMMENT = `{ nodes { createdAt author ${ACTOR} } }`;
const REVIEW_REQUEST = "{ asCodeOwner requestedReviewer { __typename ... on User { login avatarUrl } ... on Bot { login avatarUrl } ... on Mannequin { login avatarUrl } ... on Team { slug name } } }";
const REVIEW = `{ state submittedAt author ${ACTOR} commit { oid } }`;
const THREAD = `{ isResolved isOutdated first: comments(first: 1) ${COMMENT} last: comments(last: 1) ${COMMENT} }`;

/** `number` is the pull request number as GraphQL text: a literal or a variable. */
function checkContext(number: string): string {
	return `{ __typename ... on CheckRun { name status conclusion completedAt isRequired(pullRequestNumber: ${number}) } ... on StatusContext { context state createdAt isRequired(pullRequestNumber: ${number}) } }`;
}

function paged(field: string, args: string, node: string): string {
	return `${field}(${args}) { pageInfo { hasNextPage endCursor } nodes ${node} }`;
}

/**
 * The five connections that feed the derived state select `pageInfo`, and the source pages the rest of any
 * that has more. `labels`, `files`, and the timeline feed only display fields, so their first page is enough.
 */
function pullRequestFields(number: number): string {
	return `
		id number url title state isDraft createdAt closedAt mergedAt
		repository { name owner { login } isArchived }
		author ${ACTOR}
		headRefOid baseRefName additions deletions
		labels(first: 20) { nodes { name } }
		files(first: 100) { nodes { path } }
		reviewDecision mergeable mergeStateStatus isInMergeQueue
		autoMergeRequest { enabledAt }
		${paged("reviewRequests", "first: 30", REVIEW_REQUEST)}
		${paged("latestOpinionatedReviews", "first: 50", REVIEW)}
		${paged("latestReviews", "first: 50", REVIEW)}
		${paged("reviewThreads", "first: 100", THREAD)}
		timelineItems(last: 60, itemTypes: [READY_FOR_REVIEW_EVENT, CONVERT_TO_DRAFT_EVENT, REVIEW_REQUESTED_EVENT]) { nodes { __typename ... on ReadyForReviewEvent { createdAt } ... on ConvertToDraftEvent { createdAt } ... on ReviewRequestedEvent { createdAt requestedReviewer { __typename ... on User { login } ... on Bot { login } ... on Mannequin { login } ... on Team { slug } } } } }
		commits(last: 1) { nodes { commit { oid committedDate statusCheckRollup { ${paged("contexts", "first: 100", checkContext(String(number)))} } } } }`;
}

const NEXT_PAGE = "first: 100, after: $after";

function pullRequestPageQuery(operation: string, field: string, node: string): string {
	return `query ${operation}($owner: String!, $name: String!, $number: Int!, $after: String!) {
	repository(owner: $owner, name: $name) { pullRequest(number: $number) { connection: ${paged(field, NEXT_PAGE, node)} } }
}`;
}

/** The page after `$after` of one connection of one pull request. Check contexts are read from the commit the first page named. */
export const CONNECTION_PAGE_QUERIES = {
	reviewRequests: pullRequestPageQuery("ReviewRequestsPage", "reviewRequests", REVIEW_REQUEST),
	latestOpinionatedReviews: pullRequestPageQuery("LatestOpinionatedReviewsPage", "latestOpinionatedReviews", REVIEW),
	latestReviews: pullRequestPageQuery("LatestReviewsPage", "latestReviews", REVIEW),
	reviewThreads: pullRequestPageQuery("ReviewThreadsPage", "reviewThreads", THREAD),
	checkContexts: `query CheckContextsPage($owner: String!, $name: String!, $number: Int!, $oid: GitObjectID!, $after: String!) {
	repository(owner: $owner, name: $name) { object(oid: $oid) { ... on Commit { statusCheckRollup { connection: ${paged("contexts", NEXT_PAGE, checkContext("$number"))} } } } }
}`,
} satisfies Record<PagedConnection, string>;

export function pullRequestAlias(index: number): string {
	return `p${index}`;
}

/**
 * One aliased block per ref, `p0` to `pN` in input order. `isRequired` takes the
 * pull request number, so the selection is inlined per ref instead of shared.
 */
export function buildPullRequestsQuery(refs: readonly PrRef[]): string {
	if (refs.length === 0) throw new Error("buildPullRequestsQuery needs at least one ref");
	const blocks = refs.map((ref, index) => {
		if (!NAME.test(ref.owner) || !NAME.test(ref.name)) {
			throw new Error(`Invalid repository in ref: ${JSON.stringify(`${ref.owner}/${ref.name}`)}`);
		}
		if (!Number.isSafeInteger(ref.number) || ref.number <= 0) {
			throw new Error(`Invalid pull request number in ref: ${ref.number}`);
		}
		return `${pullRequestAlias(index)}: repository(owner: "${ref.owner}", name: "${ref.name}") { pullRequest(number: ${ref.number}) {${pullRequestFields(ref.number)}
	} }`;
	});
	return `query PullRequests {\n${blocks.join("\n")}\n}`;
}

export const OPEN_PULL_REQUESTS_QUERY = `query OpenPullRequests($owner: String!, $name: String!, $after: String) {
	repository(owner: $owner, name: $name) {
		pullRequests(states: OPEN, first: 100, after: $after) {
			pageInfo { hasNextPage endCursor }
			nodes {
				number updatedAt headRefOid isDraft reviewDecision mergeable mergeStateStatus
				reviewRequests(first: 1) { totalCount }
				commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
			}
		}
	}
}`;

export const ORG_TEAMS_QUERY = `query OrganizationTeams($org: String!, $after: String) {
	organization(login: $org) {
		teams(first: 50, after: $after) {
			pageInfo { hasNextPage endCursor }
			nodes { slug name members(first: 100) { pageInfo { hasNextPage endCursor } nodes { login avatarUrl } } }
		}
	}
}`;

export const TEAM_MEMBERS_QUERY = `query TeamMembers($org: String!, $slug: String!, $after: String) {
	organization(login: $org) {
		team(slug: $slug) {
			members(first: 100, after: $after) {
				pageInfo { hasNextPage endCursor }
				nodes { login avatarUrl }
			}
		}
	}
}`;
