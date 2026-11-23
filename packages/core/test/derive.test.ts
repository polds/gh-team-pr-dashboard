import { describe, expect, it } from "vitest";
import { asSha, asTeamSlug, derive } from "../src/index.ts";
import type { PrSnapshot } from "../src/index.ts";
import {
	ana,
	asAuthor,
	bot,
	check,
	context,
	direct,
	hour,
	human,
	pr,
	requestOf,
	review,
	reviews,
	teamRequestOf,
	thread,
	viaTeam,
} from "./builders.ts";

const rex = human("rex");
const cora = human("cora");
const bea = human("bea");
const tom = human("tom");

const deriveOf = (facts: Partial<PrSnapshot>) => derive(pr(facts), context());

describe("reviewer status table", () => {
	it("requested: a pending review request, including a re-request after an earlier review", () => {
		expect(deriveOf({ reviewRequests: [requestOf(rex, { requestedAt: hour(1) })] }).reviewers).toEqual([
			{ reviewer: rex, kind: "requested", rerequested: false, since: hour(1) },
		]);
		const again = deriveOf({
			reviewRequests: [requestOf(rex, { requestedAt: hour(3) })],
			...reviews(review(rex, "CHANGES_REQUESTED", hour(2))),
		});
		expect(again.reviewers).toEqual([{ reviewer: rex, kind: "requested", rerequested: true, since: hour(3) }]);
	});

	it("approval_dismissed: the latest decisive review is DISMISSED", () => {
		expect(deriveOf(reviews(review(rex, "DISMISSED", hour(2)))).reviewers).toEqual([
			{ reviewer: rex, kind: "approval_dismissed", rerequested: false, since: hour(2) },
		]);
	});

	it("approved: the latest decisive review is APPROVED", () => {
		const snapshot = reviews(review(rex, "CHANGES_REQUESTED", hour(1)), review(rex, "APPROVED", hour(3)));
		expect(deriveOf(snapshot).reviewers).toEqual([{ reviewer: rex, kind: "approved", rerequested: false, since: hour(3) }]);
		const truncated = { decisiveReviews: [], latestReviews: [review(rex, "APPROVED", hour(3))] };
		expect(deriveOf(truncated).reviewers).toEqual([{ reviewer: rex, kind: "approved", rerequested: false, since: hour(3) }]);
	});

	it("feedback_outstanding: the reviewer has feedback the author has not addressed", () => {
		const snapshot = { ...reviews(review(rex, "CHANGES_REQUESTED", hour(2))), threads: [thread(rex, { startedAt: hour(2) })] };
		expect(deriveOf(snapshot).reviewers).toEqual([
			{ reviewer: rex, kind: "feedback_outstanding", rerequested: false, since: hour(2) },
		]);
	});

	it("feedback_addressed: every thread is addressed and the author pushed after the change request", () => {
		const snapshot = {
			headSha: asSha("c2"),
			headCommittedAt: hour(4),
			...reviews(review(rex, "CHANGES_REQUESTED", hour(2), "c1")),
			threads: [thread(rex, { startedAt: hour(2), isResolved: true })],
		};
		expect(deriveOf(snapshot).reviewers).toEqual([
			{ reviewer: rex, kind: "feedback_addressed", rerequested: false, since: hour(4) },
		]);
	});

	it("commented: a comment-only review and no thread", () => {
		expect(deriveOf(reviews(review(rex, "COMMENTED", hour(2)))).reviewers).toEqual([
			{ reviewer: rex, kind: "commented", rerequested: false, since: hour(2) },
		]);
	});
});

describe("fold table", () => {
	it("row 1: merged", () => {
		const derived = deriveOf({
			lifecycle: { kind: "merged", at: hour(9) },
			reviewDecision: "APPROVED",
			...reviews(review(rex, "APPROVED", hour(5))),
		});
		expect(derived).toMatchObject({ state: "merged", court: "nobody", actors: [], sinceEstimate: hour(9), confidence: null });
	});

	it("row 2: closed without merge", () => {
		const derived = deriveOf({
			lifecycle: { kind: "closed", at: hour(9) },
			reviewDecision: "CHANGES_REQUESTED",
			...reviews(review(rex, "CHANGES_REQUESTED", hour(5))),
		});
		expect(derived).toMatchObject({ state: "closed", court: "nobody", actors: [], sinceEstimate: hour(9) });
	});

	it("row 3: draft", () => {
		const derived = deriveOf({ isDraft: true, draftedAt: hour(2), reviewRequests: [requestOf(rex)] });
		expect(derived).toMatchObject({
			state: "draft",
			court: "author",
			actors: [asAuthor(ana, hour(2))],
			reasons: [{ kind: "draft" }],
			sinceEstimate: hour(2),
		});
	});

	it("row 4: a change request with feedback outstanding", () => {
		const derived = deriveOf({
			reviewDecision: "CHANGES_REQUESTED",
			...reviews(review(rex, "CHANGES_REQUESTED", hour(2))),
			threads: [thread(rex, { startedAt: hour(2) })],
		});
		expect(derived).toMatchObject({
			state: "changes_requested",
			court: "author",
			actors: [asAuthor(ana, hour(2))],
			sinceEstimate: hour(2),
			reasons: [
				{ kind: "changes_requested_by", reviewer: rex.login, at: hour(2) },
				{ kind: "open_threads", reviewer: rex.login, awaitingAuthor: 1, total: 1 },
			],
			blockers: [],
			confidence: null,
		});
	});

	it("row 4: GitHub reports a change request that the data does not include", () => {
		const derived = deriveOf({ reviewDecision: "CHANGES_REQUESTED", reviewRequests: [requestOf(rex)] });
		expect(derived).toMatchObject({ state: "changes_requested", court: "author", actors: [asAuthor(ana)] });
	});

	it("row 5: every change requester addressed the feedback or was re-requested", () => {
		const base: Partial<PrSnapshot> = {
			reviewDecision: "CHANGES_REQUESTED",
			headSha: asSha("c2"),
			headCommittedAt: hour(4),
			...reviews(review(rex, "CHANGES_REQUESTED", hour(2), "c1")),
		};
		expect(deriveOf({ ...base, threads: [thread(rex, { startedAt: hour(2), isResolved: true })] })).toMatchObject({
			state: "likely_ready_for_rereview",
			court: "reviewers",
			actors: [direct(rex, hour(4))],
		});
		expect(deriveOf({ ...base, reviewRequests: [requestOf(rex, { requestedAt: hour(5) })] })).toMatchObject({
			state: "in_review",
			court: "reviewers",
			actors: [direct(rex, hour(5))],
			reasons: [{ kind: "rerequested", from: [rex.login] }],
			confidence: null,
		});
	});

	it("row 6: approved with no merge blocker", () => {
		const derived = deriveOf({
			reviewDecision: "APPROVED",
			...reviews(review(rex, "APPROVED", hour(3))),
			checks: [check("build", "passing", true, hour(2))],
		});
		expect(derived).toMatchObject({
			state: "ready_to_merge",
			court: "author",
			actors: [asAuthor(ana, hour(3))],
			reasons: [{ kind: "approved_by", reviewers: [rex.login] }],
			blockers: [],
			sinceEstimate: hour(3),
		});
	});

	it("row 6: in the merge queue, the court is CI", () => {
		const derived = deriveOf({ reviewDecision: "APPROVED", inMergeQueue: true, ...reviews(review(rex, "APPROVED", hour(3))) });
		expect(derived).toMatchObject({
			state: "ready_to_merge",
			court: "ci",
			actors: [],
			reasons: [{ kind: "approved_by", reviewers: [rex.login] }, { kind: "in_merge_queue" }],
		});
	});

	it("row 7: approved with a merge blocker", () => {
		const derived = deriveOf({
			reviewDecision: "APPROVED",
			mergeable: "CONFLICTING",
			mergeStateStatus: "DIRTY",
			autoMerge: true,
			...reviews(review(rex, "APPROVED", hour(3))),
		});
		expect(derived).toMatchObject({
			state: "approved_blocked",
			court: "author",
			actors: [asAuthor(ana, hour(3))],
			blockers: ["conflicts"],
			reasons: [
				{ kind: "approved_by", reviewers: [rex.login] },
				{ kind: "blocked", blocker: "conflicts", checks: [] },
				{ kind: "auto_merge_enabled" },
			],
		});
	});

	it("row 8: an approval exists and reviewDecision is REVIEW_REQUIRED", () => {
		const missing = deriveOf({
			reviewDecision: "REVIEW_REQUIRED",
			mergeStateStatus: "BLOCKED",
			...reviews(review(rex, "APPROVED", hour(3))),
		});
		expect(missing).toMatchObject({ state: "approved_blocked", court: "reviewers", blockers: ["review_missing"], actors: [] });
		const dismissed = deriveOf({
			reviewDecision: "REVIEW_REQUIRED",
			mergeStateStatus: "BLOCKED",
			...reviews(review(cora, "DISMISSED", hour(2)), review(rex, "APPROVED", hour(3))),
		});
		expect(dismissed).toMatchObject({
			state: "approved_blocked",
			court: "reviewers",
			blockers: ["approval_dismissed"],
			actors: [direct(cora, hour(2))],
		});
	});

	it("row 9: comment threads with feedback outstanding", () => {
		const derived = deriveOf({
			reviewDecision: "REVIEW_REQUIRED",
			...reviews(review(cora, "COMMENTED", hour(2))),
			threads: [thread(cora, { startedAt: hour(2) })],
		});
		expect(derived).toMatchObject({
			state: "changes_requested",
			court: "author",
			actors: [asAuthor(ana, hour(2))],
			reasons: [{ kind: "open_threads", reviewer: cora.login, awaitingAuthor: 1, total: 1 }],
		});
	});

	it("row 10: comment feedback addressed", () => {
		const derived = deriveOf({
			reviewDecision: "REVIEW_REQUIRED",
			...reviews(review(cora, "COMMENTED", hour(2))),
			threads: [thread(cora, { startedAt: hour(2), lastCommentBy: ana, lastCommentAt: hour(3) })],
		});
		expect(derived).toMatchObject({
			state: "likely_ready_for_rereview",
			court: "reviewers",
			actors: [direct(cora, hour(3))],
			confidence: "high",
			sinceEstimate: hour(3),
			reasons: [{ kind: "threads_addressed", reviewer: cora.login, resolved: 0, answered: 1, outdatedOnly: 0, total: 1 }],
		});
	});

	it("row 11: a reviewer has reviewed or commented", () => {
		const derived = deriveOf({ reviewDecision: "REVIEW_REQUIRED", ...reviews(review(cora, "COMMENTED", hour(2))) });
		expect(derived).toMatchObject({
			state: "in_review",
			court: "reviewers",
			actors: [direct(cora, hour(2))],
			reasons: [{ kind: "commented_by", reviewer: cora.login, at: hour(2) }],
			sinceEstimate: hour(2),
		});
	});

	it("row 12: otherwise", () => {
		const derived = deriveOf({ readyAt: hour(1), reviewRequests: [requestOf(rex, { requestedAt: hour(1), asCodeOwner: true })] });
		expect(derived).toMatchObject({
			state: "needs_review",
			court: "reviewers",
			actors: [direct(rex, hour(1), true)],
			reasons: [{ kind: "review_requested", from: [rex.login], teams: [] }],
			sinceEstimate: hour(1),
		});
	});

	it("row 12: with nobody requested, nobody acts and the reason says so", () => {
		expect(deriveOf({})).toMatchObject({
			state: "needs_review",
			court: "reviewers",
			actors: [],
			reasons: [{ kind: "no_reviewer_requested" }],
			sinceEstimate: hour(0),
		});
	});

	it("rows 6 and 9: with no required review, one approval counts only while no feedback is outstanding", () => {
		const approval = reviews(review(rex, "APPROVED", hour(3)));
		expect(deriveOf({ reviewDecision: null, ...approval }).state).toBe("ready_to_merge");
		const withOpenThread = deriveOf({
			reviewDecision: null,
			...reviews(review(rex, "APPROVED", hour(3)), review(cora, "COMMENTED", hour(2))),
			threads: [thread(cora, { startedAt: hour(2) })],
		});
		expect(withOpenThread).toMatchObject({ state: "changes_requested", court: "author" });
	});
});

describe("merge blocker table", () => {
	const approved = (facts: Partial<PrSnapshot>) =>
		deriveOf({ reviewDecision: "APPROVED", ...reviews(review(rex, "APPROVED", hour(3))), ...facts });

	it("conflicts: mergeable is CONFLICTING", () => {
		expect(approved({ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" })).toMatchObject({
			state: "approved_blocked",
			court: "author",
			blockers: ["conflicts"],
		});
	});

	it("ci_failing: a required check failed", () => {
		const derived = approved({
			mergeStateStatus: "BLOCKED",
			checks: [check("build", "failing", true, hour(4)), check("lint", "failing", false, hour(4))],
		});
		expect(derived).toMatchObject({ state: "approved_blocked", court: "author", blockers: ["ci_failing"] });
		expect(derived.reasons).toContainEqual({ kind: "blocked", blocker: "ci_failing", checks: ["build"] });
	});

	it("ci_failing: when no check says whether it is required, any failed check counts", () => {
		expect(approved({ checks: [check("lint", "failing", null)] }).blockers).toEqual(["ci_failing"]);
	});

	it("ci_failing: when some checks say whether they are required, only required checks count", () => {
		const derived = approved({
			checks: [check("build", "passing", true), check("lint", "failing", false), check("docs", "pending", null)],
		});
		expect(derived).toMatchObject({ state: "ready_to_merge", blockers: [] });
	});

	it("behind: mergeStateStatus is BEHIND", () => {
		expect(approved({ mergeStateStatus: "BEHIND" })).toMatchObject({ court: "author", blockers: ["behind"] });
	});

	it("threads_unresolved: BLOCKED, nothing else explains it, and unresolved threads exist", () => {
		expect(approved({ mergeStateStatus: "BLOCKED", threads: [thread(rex)] })).toMatchObject({
			court: "author",
			blockers: ["threads_unresolved"],
		});
	});

	it("blocked_other: BLOCKED and nothing explains it", () => {
		expect(approved({ mergeStateStatus: "BLOCKED" })).toMatchObject({ court: "author", blockers: ["blocked_other"] });
	});

	it("ci_pending: a required check is running and no other blocker exists", () => {
		const running = approved({ mergeStateStatus: "BLOCKED", checks: [check("build", "pending", true)] });
		expect(running).toMatchObject({ state: "approved_blocked", court: "ci", actors: [], blockers: ["ci_pending"] });
		expect(running.reasons).toContainEqual({ kind: "blocked", blocker: "ci_pending", checks: ["build"] });
		const alsoBehind = approved({ mergeStateStatus: "BEHIND", checks: [check("build", "pending", true)] });
		expect(alsoBehind).toMatchObject({ court: "author", blockers: ["behind"] });
	});

	it("ci_pending: a running check explains BLOCKED before unresolved threads do", () => {
		const derived = approved({ mergeStateStatus: "BLOCKED", threads: [thread(rex)], checks: [check("build", "pending", true)] });
		expect(derived).toMatchObject({ court: "ci", blockers: ["ci_pending"] });
	});
});

describe("the change-request round trip", () => {
	it("follows a change request from two threads to a merge-ready approval", () => {
		const requested: Partial<PrSnapshot> = {
			reviewDecision: "CHANGES_REQUESTED",
			...reviews(review(rex, "CHANGES_REQUESTED", hour(2), "c1")),
		};
		const openThreads = [thread(rex, { startedAt: hour(2) }), thread(rex, { startedAt: hour(2) })];

		const reviewed = deriveOf({ ...requested, threads: openThreads });
		expect(reviewed).toMatchObject({ state: "changes_requested", court: "author", actors: [asAuthor(ana, hour(2))] });

		const pushed: Partial<PrSnapshot> = { ...requested, headSha: asSha("c2"), headCommittedAt: hour(4) };
		expect(deriveOf({ ...pushed, threads: openThreads })).toMatchObject({ state: "changes_requested", court: "author" });

		const answered = [
			thread(rex, { startedAt: hour(2), isResolved: true }),
			thread(rex, { startedAt: hour(2), lastCommentBy: ana, lastCommentAt: hour(5) }),
		];
		expect(deriveOf({ ...pushed, threads: answered })).toMatchObject({
			state: "likely_ready_for_rereview",
			court: "reviewers",
			actors: [direct(rex, hour(5))],
			confidence: "high",
			reasons: [
				{ kind: "new_commits_since_review", reviewer: rex.login, reviewedSha: asSha("c1") },
				{ kind: "threads_addressed", reviewer: rex.login, resolved: 1, answered: 1, outdatedOnly: 0, total: 2 },
			],
		});

		const rerequested = deriveOf({ ...pushed, threads: answered, reviewRequests: [requestOf(rex, { requestedAt: hour(6) })] });
		expect(rerequested).toMatchObject({
			state: "in_review",
			court: "reviewers",
			actors: [direct(rex, hour(6))],
			reasons: [{ kind: "rerequested", from: [rex.login] }],
			confidence: null,
		});

		const approved = deriveOf({
			...pushed,
			reviewDecision: "APPROVED",
			threads: answered,
			...reviews(review(rex, "CHANGES_REQUESTED", hour(2), "c1"), review(rex, "APPROVED", hour(7), "c2")),
		});
		expect(approved).toMatchObject({ state: "ready_to_merge", court: "author", actors: [asAuthor(ana, hour(7))] });
	});
});

describe("change request feedback", () => {
	it("stays with the author until a new commit lands, even when every thread is answered", () => {
		const derived = deriveOf({
			reviewDecision: "CHANGES_REQUESTED",
			...reviews(review(rex, "CHANGES_REQUESTED", hour(2), "c1")),
			threads: [thread(rex, { startedAt: hour(2), lastCommentBy: ana, lastCommentAt: hour(3) })],
		});
		expect(derived).toMatchObject({
			state: "changes_requested",
			court: "author",
			reasons: [
				{ kind: "changes_requested_by", reviewer: rex.login, at: hour(2) },
				{ kind: "open_threads", reviewer: rex.login, awaitingAuthor: 0, total: 1 },
			],
		});
	});
});

describe("comment-only feedback", () => {
	it("puts the ball with the author until every thread is answered, then with the reviewer", () => {
		const commented: Partial<PrSnapshot> = { reviewDecision: "REVIEW_REQUIRED", ...reviews(review(cora, "COMMENTED", hour(2))) };
		const open = deriveOf({ ...commented, threads: [thread(cora, { startedAt: hour(2) }), thread(cora, { startedAt: hour(2) })] });
		expect(open).toMatchObject({ state: "changes_requested", court: "author", actors: [asAuthor(ana, hour(2))] });

		const replies = [
			thread(cora, { startedAt: hour(2), lastCommentBy: ana, lastCommentAt: hour(3) }),
			thread(cora, { startedAt: hour(2), lastCommentBy: ana, lastCommentAt: hour(4) }),
		];
		expect(deriveOf({ ...commented, threads: replies })).toMatchObject({
			state: "likely_ready_for_rereview",
			court: "reviewers",
			actors: [direct(cora, hour(4))],
			confidence: "high",
		});
	});

	it("counts a new commit as author activity for comment feedback", () => {
		const derived = deriveOf({
			headSha: asSha("c2"),
			headCommittedAt: hour(4),
			...reviews(review(cora, "COMMENTED", hour(2), "c1")),
			threads: [thread(cora, { startedAt: hour(2), isResolved: true })],
		});
		expect(derived.state).toBe("likely_ready_for_rereview");
	});

	it("returns the ball to the reviewer when every comment thread is resolved, even with no commit or reply", () => {
		const derived = deriveOf({
			...reviews(review(cora, "COMMENTED", hour(2), "c1")),
			threads: [thread(cora, { startedAt: hour(2), isResolved: true })],
		});
		expect(derived).toMatchObject({ state: "likely_ready_for_rereview", court: "reviewers", actors: [direct(cora, hour(2))] });
	});

	it("keeps the ball with the author while one comment thread is open and the others are resolved", () => {
		const derived = deriveOf({
			...reviews(review(cora, "COMMENTED", hour(2), "c1")),
			threads: [thread(cora, { startedAt: hour(2), isResolved: true }), thread(cora, { startedAt: hour(2) })],
		});
		expect(derived).toMatchObject({ state: "changes_requested", court: "author" });
	});
});

describe("confidence", () => {
	it("is medium when a thread counts as addressed only because it is outdated, the weakest reviewer wins", () => {
		const derived = deriveOf({
			reviewDecision: "CHANGES_REQUESTED",
			headSha: asSha("c2"),
			headCommittedAt: hour(4),
			...reviews(review(rex, "CHANGES_REQUESTED", hour(2), "c1"), review(cora, "CHANGES_REQUESTED", hour(2), "c1")),
			threads: [thread(rex, { isResolved: true }), thread(cora, { isOutdated: true })],
		});
		expect(derived).toMatchObject({ state: "likely_ready_for_rereview", confidence: "medium" });
		expect(derived.reasons).toContainEqual({
			kind: "threads_addressed",
			reviewer: cora.login,
			resolved: 0,
			answered: 0,
			outdatedOnly: 1,
			total: 1,
		});
	});

	it("is medium when a change request had no threads and a new commit landed", () => {
		const derived = deriveOf({
			reviewDecision: "CHANGES_REQUESTED",
			headSha: asSha("c2"),
			headCommittedAt: hour(4),
			...reviews(review(rex, "CHANGES_REQUESTED", hour(2), "c1")),
		});
		expect(derived).toMatchObject({
			state: "likely_ready_for_rereview",
			confidence: "medium",
			reasons: [
				{ kind: "new_commits_since_review", reviewer: rex.login, reviewedSha: asSha("c1") },
				{ kind: "no_threads_on_change_request", reviewer: rex.login },
			],
		});
	});
});

describe("author signals", () => {
	const addressed: Partial<PrSnapshot> = {
		reviewDecision: "CHANGES_REQUESTED",
		headSha: asSha("c2"),
		headCommittedAt: hour(4),
		...reviews(review(rex, "CHANGES_REQUESTED", hour(2), "c1")),
		threads: [thread(rex, { isResolved: true })],
	};
	const outstanding: Partial<PrSnapshot> = {
		reviewDecision: "CHANGES_REQUESTED",
		...reviews(review(rex, "CHANGES_REQUESTED", hour(2), "c1")),
		threads: [thread(rex, { startedAt: hour(2) })],
	};

	it("not_ready puts addressed feedback back with the author", () => {
		const derived = derive(pr(addressed), context({ authorSignal: { kind: "not_ready", headSha: asSha("c2") } }));
		expect(derived).toMatchObject({ state: "changes_requested", court: "author", actors: [asAuthor(ana, hour(2))] });
		expect(derived.reviewers[0]?.kind).toBe("feedback_outstanding");
		expect(derived.reasons).toContainEqual({ kind: "author_says_not_ready" });
	});

	it("ready hands outstanding feedback to the reviewer with confirmed confidence", () => {
		const derived = derive(pr(outstanding), context({ authorSignal: { kind: "ready", headSha: asSha("c1") } }));
		expect(derived).toMatchObject({
			state: "likely_ready_for_rereview",
			court: "reviewers",
			actors: [direct(rex, hour(2))],
			confidence: "confirmed",
		});
		expect(derived.reasons).toContainEqual({ kind: "author_says_ready" });
	});

	it("ignores a signal sent for an older head commit", () => {
		const stale = derive(pr(addressed), context({ authorSignal: { kind: "not_ready", headSha: asSha("c1") } }));
		expect(stale).toEqual(deriveOf(addressed));
		expect(stale.state).toBe("likely_ready_for_rereview");
	});
});

describe("team requests", () => {
	it("makes every member an actor via the team, except the author and anyone already acting", () => {
		const teams = new Map([
			[asTeamSlug("web"), [ana.login, tom.login, rex.login, bea.login]],
			[asTeamSlug("api"), [tom.login]],
		]);
		const derived = derive(
			pr({
				reviewRequests: [
					requestOf(rex, { requestedAt: hour(1) }),
					teamRequestOf("web", { requestedAt: hour(2) }),
					teamRequestOf("api", { requestedAt: hour(2) }),
				],
			}),
			context({ teams }),
		);
		expect(derived.actors).toEqual([direct(rex, hour(1)), viaTeam(tom, "web", hour(2)), viaTeam(bea, "web", hour(2))]);
		expect(derived.reasons).toEqual([{ kind: "review_requested", from: [rex.login], teams: ["Team web", "Team api"] }]);
	});
});

describe("bots and the author", () => {
	const robot = bot("lint-bot[bot]");

	it("a bot reviewer or a bot-started thread never changes the result", () => {
		const humans: Partial<PrSnapshot> = {
			...reviews(review(cora, "COMMENTED", hour(2))),
			threads: [thread(cora, { startedAt: hour(2), lastCommentBy: ana, lastCommentAt: hour(3) })],
		};
		const withBots: Partial<PrSnapshot> = {
			reviewRequests: [requestOf(robot)],
			...reviews(review(cora, "COMMENTED", hour(2)), review(robot, "CHANGES_REQUESTED", hour(5))),
			threads: [...(humans.threads ?? []), thread(robot, { startedAt: hour(5) })],
		};
		expect(deriveOf(withBots)).toEqual(deriveOf(humans));

		const botOnly: Partial<PrSnapshot> = {
			reviewRequests: [requestOf(robot)],
			...reviews(review(robot, "CHANGES_REQUESTED", hour(5))),
			threads: [thread(robot, { startedAt: hour(5) })],
		};
		expect(deriveOf(botOnly)).toEqual(deriveOf({}));
	});

	it("the author's own review and threads never make them a reviewer", () => {
		const derived = deriveOf({ ...reviews(review(ana, "COMMENTED", hour(1))), threads: [thread(ana)] });
		expect(derived).toMatchObject({ state: "needs_review", reviewers: [], reasons: [{ kind: "no_reviewer_requested" }] });
	});
});

describe("time in state", () => {
	it("likely ready starts at the later of the new commit and the last author reply, never before the review", () => {
		const base: Partial<PrSnapshot> = {
			headSha: asSha("c2"),
			headCommittedAt: hour(3),
			...reviews(review(cora, "COMMENTED", hour(4), "c1")),
		};
		expect(deriveOf({ ...base, threads: [thread(cora, { startedAt: hour(4), isResolved: true })] }).sinceEstimate).toBe(hour(4));
		const replied = deriveOf({ ...base, threads: [thread(cora, { startedAt: hour(4), lastCommentBy: ana, lastCommentAt: hour(6) })] });
		expect(replied.sinceEstimate).toBe(hour(6));
	});

	it("approved states start at the latest of the approval, the head commit, and the deciding checks", () => {
		const derived = deriveOf({
			reviewDecision: "APPROVED",
			headCommittedAt: hour(1),
			...reviews(review(rex, "APPROVED", hour(3))),
			checks: [check("build", "passing", true, hour(5)), check("lint", "passing", false, hour(8))],
		});
		expect(derived).toMatchObject({ state: "ready_to_merge", sinceEstimate: hour(5) });
	});

	it("changes requested starts at the reviewer's latest comment on a thread awaiting the author", () => {
		const derived = deriveOf({
			reviewDecision: "CHANGES_REQUESTED",
			headSha: asSha("c2"),
			...reviews(review(rex, "CHANGES_REQUESTED", hour(2), "c1")),
			threads: [thread(rex, { startedAt: hour(2), lastCommentAt: hour(6) })],
		});
		expect(derived).toMatchObject({ state: "changes_requested", sinceEstimate: hour(6) });
	});
});
