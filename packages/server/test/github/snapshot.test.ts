import { describe, expect, it } from "vitest";
import { parsePullRequest } from "../../src/github/snapshot.ts";
import { HEAD_SHA, REVIEWED_SHA, pullRequestNode } from "./fixtures.ts";

const person = (login: string, isBot = false) => ({ login, avatarUrl: `https://avatars.example/${login}`, isBot });
const ghost = { login: "ghost", avatarUrl: "", isBot: false };

describe("parsePullRequest", () => {
	const snapshot = parsePullRequest(pullRequestNode);

	it("copies the pull request's own fields", () => {
		expect(snapshot).toMatchObject({
			id: "PR_kwDOAbc123",
			repo: { owner: "acme", name: "api" },
			number: 42,
			url: "https://github.com/acme/api/pull/42",
			title: "Bill annual plans in arrears",
			author: person("alice"),
			isDraft: false,
			createdAt: "2026-11-02T09:00:00Z",
			headSha: HEAD_SHA,
			baseRef: "main",
			additions: 120,
			deletions: 30,
			reviewDecision: "CHANGES_REQUESTED",
			mergeable: "MERGEABLE",
			mergeStateStatus: "BLOCKED",
			inMergeQueue: false,
			autoMerge: true,
		});
	});

	it("skips null connection nodes and keeps label names and file paths", () => {
		expect(snapshot.labels).toEqual(["priority", "billing"]);
		expect(snapshot.paths).toEqual(["services/billing/invoice.ts", "README.md"]);
	});

	it("reads a deleted author as the ghost user", () => {
		expect(parsePullRequest({ ...pullRequestNode, author: null }).author).toEqual(ghost);
	});

	it("marks Bot typenames and [bot] logins as bots", () => {
		expect(parsePullRequest({ ...pullRequestNode, author: { __typename: "Bot", login: "dependabot", avatarUrl: "a" } }).author.isBot).toBe(true);
		expect(snapshot.decisiveReviews.find((review) => review.reviewer.login === "renovate[bot]")?.reviewer.isBot).toBe(true);
	});

	it("maps state and its timestamp to the lifecycle", () => {
		expect(snapshot.lifecycle).toEqual({ kind: "open" });
		const at = "2026-11-05T10:00:00Z";
		expect(parsePullRequest({ ...pullRequestNode, state: "MERGED", mergedAt: at, closedAt: at }).lifecycle).toEqual({ kind: "merged", at });
		expect(parsePullRequest({ ...pullRequestNode, state: "CLOSED", closedAt: at }).lifecycle).toEqual({ kind: "closed", at });
	});

	it("takes readyAt and draftedAt from the latest matching timeline events", () => {
		expect(snapshot.readyAt).toBe("2026-11-03T09:00:00Z");
		expect(snapshot.draftedAt).toBe("2026-11-03T08:00:00Z");
		const quiet = parsePullRequest({ ...pullRequestNode, timelineItems: { nodes: [] } });
		expect(quiet.readyAt).toBeNull();
		expect(quiet.draftedAt).toBeNull();
	});

	it("dates each review request from its latest request event and drops requests with no reviewer", () => {
		expect(snapshot.reviewRequests).toEqual([
			{ kind: "user", reviewer: person("bob"), asCodeOwner: false, requestedAt: "2026-11-04T14:00:00Z" },
			{ kind: "team", slug: "platform", name: "Platform", asCodeOwner: true, requestedAt: "2026-11-02T11:02:00Z" },
			{ kind: "user", reviewer: person("copilot-reviewer", true), asCodeOwner: false, requestedAt: "2026-11-04T14:05:00Z" },
			{ kind: "user", reviewer: person("dana"), asCodeOwner: false, requestedAt: null },
		]);
	});

	it("keeps only decisive states from the latest opinionated reviews", () => {
		expect(snapshot.decisiveReviews).toEqual([
			{ reviewer: person("carol"), state: "CHANGES_REQUESTED", submittedAt: "2026-11-03T15:00:00Z", commitSha: REVIEWED_SHA },
			{ reviewer: person("renovate[bot]", true), state: "APPROVED", submittedAt: "2026-11-03T16:00:00Z", commitSha: null },
			{ reviewer: person("erin"), state: "DISMISSED", submittedAt: "2026-11-03T17:00:00Z", commitSha: REVIEWED_SHA },
		]);
	});

	it("keeps comments in latest reviews and drops pending, unsubmitted, and authorless ones", () => {
		expect(snapshot.latestReviews.map((review) => [review.reviewer.login, review.state])).toEqual([
			["carol", "CHANGES_REQUESTED"],
			["renovate[bot]", "APPROVED"],
			["erin", "DISMISSED"],
			["frank", "COMMENTED"],
		]);
	});

	it("reads threads from their first and last comments, with the ghost for deleted authors", () => {
		expect(snapshot.threads).toEqual([
			{
				startedBy: person("carol"),
				startedAt: "2026-11-03T15:00:00Z",
				isResolved: false,
				isOutdated: false,
				lastCommentBy: person("alice"),
				lastCommentAt: "2026-11-04T09:00:00Z",
			},
			{
				startedBy: ghost,
				startedAt: "2026-11-03T15:05:00Z",
				isResolved: true,
				isOutdated: true,
				lastCommentBy: ghost,
				lastCommentAt: "2026-11-03T15:05:00Z",
			},
		]);
	});

	it("maps check runs and status contexts to verdicts", () => {
		const completedAt = "2026-11-04T08:40:00Z";
		const statusAt = "2026-11-04T08:35:00Z";
		expect(snapshot.checks).toEqual([
			{ name: "build", verdict: "passing", required: true, completedAt },
			{ name: "lint", verdict: "passing", required: false, completedAt },
			{ name: "docs", verdict: "passing", required: false, completedAt },
			{ name: "test", verdict: "failing", required: true, completedAt },
			{ name: "preview", verdict: "failing", required: false, completedAt },
			{ name: "e2e", verdict: "pending", required: false, completedAt: null },
			{ name: "deploy", verdict: "pending", required: false, completedAt: null },
			{ name: "ci/legacy", verdict: "passing", required: false, completedAt: statusAt },
			{ name: "ci/pending", verdict: "pending", required: false, completedAt: statusAt },
			{ name: "ci/expected", verdict: "pending", required: false, completedAt: statusAt },
			{ name: "ci/failure", verdict: "failing", required: false, completedAt: statusAt },
			{ name: "ci/error", verdict: "failing", required: false, completedAt: statusAt },
		]);
	});

	it("takes headCommittedAt from the last commit and falls back to createdAt", () => {
		expect(snapshot.headCommittedAt).toBe("2026-11-04T08:30:00Z");
		const empty = parsePullRequest({ ...pullRequestNode, commits: { nodes: [] } });
		expect(empty.headCommittedAt).toBe("2026-11-02T09:00:00Z");
		expect(empty.checks).toEqual([]);
	});

	it("reads no auto-merge request as auto-merge off", () => {
		expect(parsePullRequest({ ...pullRequestNode, autoMergeRequest: null }).autoMerge).toBe(false);
	});

	it.each([
		["review threads", { ...pullRequestNode, reviewThreads: { ...pullRequestNode.reviewThreads, pageInfo: { hasNextPage: true, endCursor: "c" } } }],
		["review requests", { ...pullRequestNode, reviewRequests: { ...pullRequestNode.reviewRequests, pageInfo: { hasNextPage: true, endCursor: "c" } } }],
	])("refuses to build a snapshot when the %s stop short of their end", (_label, node) => {
		expect(() => parsePullRequest(node)).toThrow(/missing later pages/);
	});

	it.each([
		["a timestamp that is not ISO", { ...pullRequestNode, createdAt: "last Tuesday" }],
		["a number sent as a string", { ...pullRequestNode, number: "42" }],
		["a missing field", { ...pullRequestNode, headRefOid: undefined }],
		["an unknown state", { ...pullRequestNode, state: "DRAFTED" }],
		["a merged state without mergedAt", { ...pullRequestNode, state: "MERGED" }],
		["a user reviewer without a login", { ...pullRequestNode, reviewRequests: { nodes: [{ asCodeOwner: false, requestedReviewer: { __typename: "User" } }] } }],
		["a non-object", "PR_kwDOAbc123"],
	])("throws on %s", (_label, node) => {
		expect(() => parsePullRequest(node)).toThrow();
	});
});
