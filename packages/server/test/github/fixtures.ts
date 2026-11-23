export const HEAD_SHA = "1111111111111111111111111111111111111111";
export const REVIEWED_SHA = "0000000000000000000000000000000000000000";

const avatar = (login: string) => `https://avatars.example/${login}`;
const user = (login: string) => ({ __typename: "User", login, avatarUrl: avatar(login) });

const carolChangesRequested = {
	state: "CHANGES_REQUESTED",
	submittedAt: "2026-11-03T15:00:00Z",
	author: user("carol"),
	commit: { oid: REVIEWED_SHA },
};
const renovateApproved = {
	state: "APPROVED",
	submittedAt: "2026-11-03T16:00:00Z",
	author: user("renovate[bot]"),
	commit: null,
};
const erinDismissed = {
	state: "DISMISSED",
	submittedAt: "2026-11-03T17:00:00Z",
	author: user("erin"),
	commit: { oid: REVIEWED_SHA },
};

const checkRun = (name: string, status: string, conclusion: string | null, isRequired = false) => ({
	__typename: "CheckRun",
	name,
	status,
	conclusion,
	completedAt: status === "COMPLETED" ? "2026-11-04T08:40:00Z" : null,
	isRequired,
});
const statusContext = (context: string, state: string) => ({
	__typename: "StatusContext",
	context,
	state,
	createdAt: "2026-11-04T08:35:00Z",
	isRequired: false,
});

/** An open pull request node in the shape `buildPullRequestsQuery` selects. */
export const pullRequestNode = {
	id: "PR_kwDOAbc123",
	number: 42,
	url: "https://github.com/acme/api/pull/42",
	title: "Bill annual plans in arrears",
	state: "OPEN",
	isDraft: false,
	createdAt: "2026-11-02T09:00:00Z",
	closedAt: null,
	mergedAt: null,
	repository: { name: "api", owner: { login: "acme" }, isArchived: false },
	author: user("alice"),
	headRefOid: HEAD_SHA,
	baseRefName: "main",
	additions: 120,
	deletions: 30,
	labels: { nodes: [{ name: "priority" }, null, { name: "billing" }] },
	files: { nodes: [{ path: "services/billing/invoice.ts" }, { path: "README.md" }] },
	reviewDecision: "CHANGES_REQUESTED",
	mergeable: "MERGEABLE",
	mergeStateStatus: "BLOCKED",
	isInMergeQueue: false,
	autoMergeRequest: { enabledAt: "2026-11-04T12:00:00Z" },
	reviewRequests: {
		nodes: [
			{ asCodeOwner: false, requestedReviewer: user("bob") },
			{ asCodeOwner: true, requestedReviewer: { __typename: "Team", slug: "platform", name: "Platform" } },
			{
				asCodeOwner: false,
				requestedReviewer: { __typename: "Bot", login: "copilot-reviewer", avatarUrl: avatar("copilot-reviewer") },
			},
			{ asCodeOwner: false, requestedReviewer: user("dana") },
			{ asCodeOwner: false, requestedReviewer: null },
			{ asCodeOwner: false, requestedReviewer: { __typename: "EnterpriseTeam" } },
		],
	},
	latestOpinionatedReviews: {
		nodes: [
			carolChangesRequested,
			renovateApproved,
			erinDismissed,
			{ state: "COMMENTED", submittedAt: "2026-11-03T18:00:00Z", author: user("jack"), commit: null },
		],
	},
	latestReviews: {
		nodes: [
			carolChangesRequested,
			renovateApproved,
			erinDismissed,
			{ state: "COMMENTED", submittedAt: "2026-11-04T10:00:00Z", author: user("frank"), commit: { oid: HEAD_SHA } },
			{ state: "PENDING", submittedAt: null, author: user("gina"), commit: { oid: HEAD_SHA } },
			{ state: "COMMENTED", submittedAt: "2026-11-04T10:30:00Z", author: null, commit: { oid: HEAD_SHA } },
			{ state: "COMMENTED", submittedAt: null, author: user("ivan"), commit: { oid: HEAD_SHA } },
		],
	},
	reviewThreads: {
		nodes: [
			{
				isResolved: false,
				isOutdated: false,
				first: { nodes: [{ createdAt: "2026-11-03T15:00:00Z", author: user("carol") }] },
				last: { nodes: [{ createdAt: "2026-11-04T09:00:00Z", author: user("alice") }] },
			},
			{
				isResolved: true,
				isOutdated: true,
				first: { nodes: [{ createdAt: "2026-11-03T15:05:00Z", author: null }] },
				last: { nodes: [{ createdAt: "2026-11-03T15:05:00Z", author: null }] },
			},
			{ isResolved: false, isOutdated: false, first: { nodes: [] }, last: { nodes: [] } },
		],
	},
	timelineItems: {
		nodes: [
			{ __typename: "ConvertToDraftEvent", createdAt: "2026-11-02T10:00:00Z" },
			{ __typename: "ReadyForReviewEvent", createdAt: "2026-11-02T11:00:00Z" },
			{ __typename: "ReviewRequestedEvent", createdAt: "2026-11-02T11:01:00Z", requestedReviewer: { __typename: "User", login: "bob" } },
			{ __typename: "ReviewRequestedEvent", createdAt: "2026-11-02T11:02:00Z", requestedReviewer: { __typename: "Team", slug: "platform" } },
			{ __typename: "ReviewRequestedEvent", createdAt: "2026-11-02T11:03:00Z", requestedReviewer: null },
			{ __typename: "ConvertToDraftEvent", createdAt: "2026-11-03T08:00:00Z" },
			{ __typename: "ReadyForReviewEvent", createdAt: "2026-11-03T09:00:00Z" },
			{ __typename: "ReviewRequestedEvent", createdAt: "2026-11-04T14:00:00Z", requestedReviewer: { __typename: "User", login: "bob" } },
			{
				__typename: "ReviewRequestedEvent",
				createdAt: "2026-11-04T14:05:00Z",
				requestedReviewer: { __typename: "Bot", login: "copilot-reviewer" },
			},
			{ __typename: "ReviewRequestedEvent", createdAt: "2026-11-04T14:06:00Z", requestedReviewer: { __typename: "EnterpriseTeam" } },
		],
	},
	commits: {
		nodes: [
			{
				commit: {
					oid: HEAD_SHA,
					committedDate: "2026-11-04T08:30:00Z",
					statusCheckRollup: {
						state: "FAILURE",
						contexts: {
							nodes: [
								checkRun("build", "COMPLETED", "SUCCESS", true),
								checkRun("lint", "COMPLETED", "NEUTRAL"),
								checkRun("docs", "COMPLETED", "SKIPPED"),
								checkRun("test", "COMPLETED", "FAILURE", true),
								checkRun("preview", "COMPLETED", "CANCELLED"),
								checkRun("e2e", "IN_PROGRESS", null),
								checkRun("deploy", "QUEUED", null),
								statusContext("ci/legacy", "SUCCESS"),
								statusContext("ci/pending", "PENDING"),
								statusContext("ci/expected", "EXPECTED"),
								statusContext("ci/failure", "FAILURE"),
								statusContext("ci/error", "ERROR"),
							],
						},
					},
				},
			},
		],
	},
};

export function pullRequestNodeFor({ owner, name, number }: { owner: string; name: string; number: number }) {
	return {
		...pullRequestNode,
		id: `PR_${owner}_${name}_${number}`,
		number,
		url: `https://github.com/${owner}/${name}/pull/${number}`,
		repository: { name, owner: { login: owner }, isArchived: false },
	};
}
