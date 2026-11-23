import type { PrRef } from "./source.ts";

const NAME = /^[A-Za-z0-9._-]+$/;

const ACTOR = "{ __typename login avatarUrl }";
const REVIEWS = `(first: 50) { nodes { state submittedAt author ${ACTOR} commit { oid } } }`;
const COMMENT = `{ nodes { createdAt author ${ACTOR} } }`;

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
		reviewRequests(first: 30) { nodes { asCodeOwner requestedReviewer { __typename ... on User { login avatarUrl } ... on Bot { login avatarUrl } ... on Mannequin { login avatarUrl } ... on Team { slug name } } } }
		latestOpinionatedReviews${REVIEWS}
		latestReviews${REVIEWS}
		reviewThreads(first: 100) { nodes { isResolved isOutdated first: comments(first: 1) ${COMMENT} last: comments(last: 1) ${COMMENT} } }
		timelineItems(last: 60, itemTypes: [READY_FOR_REVIEW_EVENT, CONVERT_TO_DRAFT_EVENT, REVIEW_REQUESTED_EVENT]) { nodes { __typename ... on ReadyForReviewEvent { createdAt } ... on ConvertToDraftEvent { createdAt } ... on ReviewRequestedEvent { createdAt requestedReviewer { __typename ... on User { login } ... on Bot { login } ... on Mannequin { login } ... on Team { slug } } } } }
		commits(last: 1) { nodes { commit { oid committedDate statusCheckRollup { state contexts(first: 100) { nodes { __typename ... on CheckRun { name status conclusion completedAt isRequired(pullRequestNumber: ${number}) } ... on StatusContext { context state createdAt isRequired(pullRequestNumber: ${number}) } } } } } } }`;
}

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
			nodes { slug name members(first: 100) { nodes { login avatarUrl } } }
		}
	}
}`;
