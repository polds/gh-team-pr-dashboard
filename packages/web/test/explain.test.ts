import { describe, expect, test } from "vitest";
import { asLogin, asSha } from "@radar/core";
import type { Blocker, Reason } from "@radar/core";
import { explain, explainBlocker } from "../src/explain.ts";
import { NOW, hoursAgo } from "./fixtures.ts";

const ken = asLogin("ken");
const ana = asLogin("ana");

/** Keyed by kind, so adding a reason variant without a sentence test fails the typecheck. */
const CASES: { [K in Reason["kind"]]: [Extract<Reason, { kind: K }>, string][] } = {
	draft: [[{ kind: "draft" }, "Still a draft, so the author is working on it"]],
	no_reviewer_requested: [[{ kind: "no_reviewer_requested" }, "No reviewer has been requested yet"]],
	review_requested: [
		[{ kind: "review_requested", from: [ken], teams: [] }, "Review requested from ken"],
		[{ kind: "review_requested", from: [ken, ana], teams: ["Payments"] }, "Review requested from ken, ana, and the Payments team"],
		[{ kind: "review_requested", from: [], teams: ["Web team"] }, "Review requested from the Web team"],
		[{ kind: "review_requested", from: [], teams: [] }, "Review requested"],
	],
	rerequested: [[{ kind: "rerequested", from: [ken] }, "Review requested again from ken"]],
	changes_requested_by: [[{ kind: "changes_requested_by", reviewer: ken, at: hoursAgo(50) }, "ken requested changes 2 days ago"]],
	open_threads: [
		[{ kind: "open_threads", reviewer: ken, awaitingAuthor: 2, total: 3 }, "2 of 3 threads from ken still open"],
		[{ kind: "open_threads", reviewer: ken, awaitingAuthor: 1, total: 1 }, "1 of 1 thread from ken still open"],
	],
	new_commits_since_review: [[{ kind: "new_commits_since_review", reviewer: ken, reviewedSha: asSha("abc") }, "New commits since ken's review"]],
	threads_addressed: [
		[
			{ kind: "threads_addressed", reviewer: ken, resolved: 1, answered: 1, outdatedOnly: 0, total: 2 },
			"2 of 2 threads from ken resolved or answered",
		],
		[
			{ kind: "threads_addressed", reviewer: ken, resolved: 2, answered: 0, outdatedOnly: 1, total: 3 },
			"3 of 3 threads from ken resolved or answered, 1 only because the code under it changed",
		],
	],
	no_threads_on_change_request: [
		[{ kind: "no_threads_on_change_request", reviewer: ken }, "ken requested changes without leaving threads, so this guess is less certain"],
	],
	author_says_ready: [[{ kind: "author_says_ready" }, "The author says it is ready for another look"]],
	author_says_not_ready: [[{ kind: "author_says_not_ready" }, "The author says it is not ready yet"]],
	commented_by: [[{ kind: "commented_by", reviewer: ana, at: hoursAgo(3) }, "ana commented 3 hours ago"]],
	approved_by: [[{ kind: "approved_by", reviewers: [ken, ana] }, "Approved by ken and ana"]],
	blocked: [
		[{ kind: "blocked", blocker: "ci_failing", checks: ["build", "lint"] }, "Blocked: a required check is failing (build, lint)"],
		[{ kind: "blocked", blocker: "conflicts", checks: [] }, "Blocked: conflicts with the base branch"],
	],
	in_merge_queue: [[{ kind: "in_merge_queue" }, "In the merge queue"]],
	auto_merge_enabled: [[{ kind: "auto_merge_enabled" }, "Auto-merge is on, so it merges once it can"]],
};

describe("explain", () => {
	const rows = Object.values(CASES).flat();
	test.each(rows)("%j", (reason, sentence) => {
		expect(explain(reason, NOW)).toBe(sentence);
	});

	test("sentences carry no jargon a reviewer would have to look up", () => {
		for (const [reason] of rows) expect(explain(reason, NOW)).not.toMatch(/_|undefined|null|NaN|\[object/);
	});
});

describe("explainBlocker", () => {
	const BLOCKERS: Record<Blocker, string> = {
		conflicts: "Blocked: conflicts with the base branch",
		ci_failing: "Blocked: a required check is failing (build)",
		behind: "Blocked: the branch is behind the base branch",
		threads_unresolved: "Blocked: some review threads are unresolved",
		blocked_other: "Blocked: a branch rule is not met yet",
		ci_pending: "Waiting for required checks to finish (build)",
		review_missing: "Blocked: another required approval is missing",
		approval_dismissed: "Blocked: an approval was dismissed",
	};
	const kinds = [
		"conflicts",
		"ci_failing",
		"behind",
		"threads_unresolved",
		"blocked_other",
		"ci_pending",
		"review_missing",
		"approval_dismissed",
	] as const satisfies readonly Blocker[];
	test.each(kinds)("%s", (blocker) => {
		expect(explainBlocker(blocker, ["build"])).toBe(BLOCKERS[blocker]);
	});
});
