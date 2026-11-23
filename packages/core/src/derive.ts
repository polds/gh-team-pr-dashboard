import type {
	Actor,
	AuthorSignal,
	Blocker,
	Check,
	Confidence,
	Court,
	Derived,
	DeriveContext,
	IsoTime,
	Login,
	Person,
	PrSnapshot,
	PrState,
	Reason,
	Review,
	ReviewRequest,
	ReviewThread,
	ReviewerStatus,
	ReviewerStatusKind,
	Sha,
	TeamSlug,
} from "./model.ts";

type UserRequest = Extract<ReviewRequest, { kind: "user" }>;
type Signal = Pick<AuthorSignal, "kind" | "at"> | null;

export function derive(snapshot: PrSnapshot, context: DeriveContext): Derived {
	const signal = context.authorSignal?.headSha === snapshot.headSha ? context.authorSignal : null;
	const reviewers = reviewerFactsOf(snapshot, signal).flatMap((facts) => assess(facts) ?? []);
	const facts = foldFactsOf(snapshot, reviewers, signal?.kind ?? null);
	const outcome = fold(facts);
	const sinceEstimate = STATE_SINCE[outcome.state](facts, outcome);
	return {
		state: outcome.state,
		court: outcome.court,
		sinceEstimate,
		actors: actorsOf(outcome.court, facts, context.teams, sinceEstimate),
		reviewers: reviewers.map((r) => r.status),
		reasons: STATE_REASONS[outcome.state](facts, outcome),
		blockers: outcome.blockers,
		confidence: outcome.state === "likely_ready_for_rereview" ? weakest(withStatus(reviewers, "feedback_addressed")) : null,
	};
}

interface ReviewerFacts {
	snapshot: PrSnapshot;
	person: Person;
	request: UserRequest | null;
	decisive: Review | null;
	latest: Review | null;
	threads: ReviewThread[];
	feedback: Feedback | null;
}

type ThreadState = "resolved" | "answered" | "outdated" | "open";

interface Feedback {
	changeRequest: Review | null;
	reviewedSha: Sha | null;
	counts: Record<ThreadState, number>;
	total: number;
	headMoved: boolean;
	addressed: boolean;
	confidence: Confidence;
	outstandingSince: IsoTime;
	addressedSince: IsoTime;
}

interface StatusRow {
	since: IsoTime;
	reasons: Reason[];
	confidence: Confidence | null;
}

const settled = (since: IsoTime): StatusRow => ({ since, reasons: [], confidence: null });

const REVIEWER_STATUS_TABLE: readonly { kind: ReviewerStatusKind; match: (r: ReviewerFacts) => StatusRow | null }[] = [
	{
		kind: "requested",
		match: (r) =>
			r.request === null
				? null
				: settled(r.request.requestedAt ?? latest(openedAt(r.snapshot), [r.decisive?.submittedAt, r.latest?.submittedAt])),
	},
	{ kind: "approval_dismissed", match: (r) => (r.decisive?.state === "DISMISSED" ? settled(r.decisive.submittedAt) : null) },
	{ kind: "approved", match: (r) => (r.decisive?.state === "APPROVED" ? settled(r.decisive.submittedAt) : null) },
	{
		kind: "feedback_outstanding",
		match: (r) =>
			r.feedback?.addressed === false
				? { since: r.feedback.outstandingSince, reasons: outstandingReasons(r.person.login, r.feedback), confidence: null }
				: null,
	},
	{
		kind: "feedback_addressed",
		match: (r) =>
			r.feedback?.addressed === true
				? { since: r.feedback.addressedSince, reasons: addressedReasons(r.person.login, r.feedback), confidence: r.feedback.confidence }
				: null,
	},
	{
		kind: "commented",
		match: (r) =>
			r.latest === null
				? null
				: { since: r.latest.submittedAt, reasons: [{ kind: "commented_by", reviewer: r.person.login, at: r.latest.submittedAt }], confidence: null },
	},
];

const BALL_WITH: Record<ReviewerStatusKind, "reviewer" | "author" | "nobody"> = {
	requested: "reviewer",
	approval_dismissed: "reviewer",
	approved: "nobody",
	feedback_outstanding: "author",
	feedback_addressed: "reviewer",
	commented: "reviewer",
};

interface Assessment {
	status: ReviewerStatus;
	request: UserRequest | null;
	changeRequested: boolean;
	approvedAt: IsoTime | null;
	reviewed: boolean;
	confidence: Confidence | null;
	reasons: Reason[];
}

function assess(r: ReviewerFacts): Assessment | null {
	const reviewed = r.decisive !== null || r.latest !== null || r.threads.length > 0;
	for (const { kind, match } of REVIEWER_STATUS_TABLE) {
		const row = match(r);
		if (row === null) continue;
		return {
			status: { reviewer: r.person, kind, rerequested: kind === "requested" && reviewed, since: row.since },
			request: r.request,
			changeRequested: r.decisive?.state === "CHANGES_REQUESTED",
			approvedAt: r.decisive?.state === "APPROVED" ? r.decisive.submittedAt : null,
			reviewed,
			confidence: row.confidence,
			reasons: row.reasons,
		};
	}
	return null;
}

function reviewerFactsOf(snapshot: PrSnapshot, signal: Signal): ReviewerFacts[] {
	const people = new Map<Login, Person>();
	const candidates = [
		...snapshot.reviewRequests.flatMap((request) => (request.kind === "user" ? [request.reviewer] : [])),
		...snapshot.decisiveReviews.map((r) => r.reviewer),
		...snapshot.latestReviews.map((r) => r.reviewer),
		...snapshot.threads.map((t) => t.startedBy),
	];
	for (const person of candidates) {
		if (!person.isBot && person.login !== snapshot.author.login && !people.has(person.login)) people.set(person.login, person);
	}
	return [...people.values()].map((person) => {
		const isThem = (other: Person) => other.login === person.login;
		const latest = snapshot.latestReviews.find((r) => isThem(r.reviewer)) ?? null;
		const facts = {
			snapshot,
			person,
			request: snapshot.reviewRequests.flatMap((q) => (q.kind === "user" && isThem(q.reviewer) ? [q] : []))[0] ?? null,
			decisive: snapshot.decisiveReviews.find((r) => isThem(r.reviewer)) ?? (latest?.state === "COMMENTED" ? null : latest),
			latest,
			threads: snapshot.threads.filter((t) => isThem(t.startedBy)),
		};
		return { ...facts, feedback: feedbackOf(facts, signal) };
	});
}

function threadState(thread: ReviewThread, author: Login): ThreadState {
	if (thread.isResolved) return "resolved";
	if (thread.lastCommentBy.login === author) return "answered";
	return thread.isOutdated ? "outdated" : "open";
}

function feedbackOf(r: Omit<ReviewerFacts, "feedback">, signal: Signal): Feedback | null {
	const changeRequest = r.decisive?.state === "CHANGES_REQUESTED" ? r.decisive : null;
	if (changeRequest === null && r.threads.length === 0) return null;
	const { snapshot } = r;
	const author = snapshot.author.login;
	const review = changeRequest ?? r.latest;
	const states = r.threads.map((t) => threadState(t, author));
	const count = (state: ThreadState) => states.filter((s) => s === state).length;
	const counts = { resolved: count("resolved"), answered: count("answered"), outdated: count("outdated"), open: count("open") };
	const givenAt = latest(snapshot.createdAt, [review?.submittedAt, ...r.threads.map((t) => t.startedAt)]);
	const headMoved =
		review === null ? Date.parse(snapshot.headCommittedAt) > Date.parse(givenAt) : review.commitSha !== snapshot.headSha;
	const authorReplies = r.threads.filter((t) => t.lastCommentBy.login === author);
	const everyThreadResolved = counts.resolved === r.threads.length;
	const authorActed = headMoved || (changeRequest === null && (authorReplies.length > 0 || everyThreadResolved));
	const awaitingAuthor = r.threads.filter((_, i) => states[i] === "open" || states[i] === "outdated");
	const estimated = (changeRequest !== null && r.threads.length === 0) || counts.outdated > 0 ? "medium" : "high";
	const reviewerSpokeAt = latest(givenAt, r.threads.filter((t) => t.lastCommentBy.login !== author).map((t) => t.lastCommentAt));
	const said = signal !== null && (signal.kind === "not_ready" || Date.parse(reviewerSpokeAt) <= Date.parse(signal.at)) ? signal.kind : null;
	return {
		changeRequest,
		reviewedSha: review?.commitSha ?? null,
		counts,
		total: r.threads.length,
		headMoved,
		addressed: said === null ? counts.open === 0 && authorActed : said === "ready",
		confidence: said === "ready" ? "confirmed" : estimated,
		outstandingSince: latest(givenAt, awaitingAuthor.map((t) => t.lastCommentAt)),
		addressedSince: latest(givenAt, [snapshot.headCommittedAt, ...authorReplies.map((t) => t.lastCommentAt)]),
	};
}

function outstandingReasons(reviewer: Login, feedback: Feedback): Reason[] {
	const reasons: Reason[] = [];
	if (feedback.changeRequest !== null) {
		reasons.push({ kind: "changes_requested_by", reviewer, at: feedback.changeRequest.submittedAt });
	}
	if (feedback.total > 0) {
		const awaitingAuthor = feedback.counts.open + feedback.counts.outdated;
		reasons.push({ kind: "open_threads", reviewer, awaitingAuthor, total: feedback.total });
	}
	return reasons;
}

function addressedReasons(reviewer: Login, feedback: Feedback): Reason[] {
	const reasons: Reason[] = [];
	if (feedback.changeRequest !== null) {
		reasons.push({ kind: "changes_requested_by", reviewer, at: feedback.changeRequest.submittedAt });
	}
	if (feedback.headMoved) reasons.push({ kind: "new_commits_since_review", reviewer, reviewedSha: feedback.reviewedSha });
	if (feedback.changeRequest !== null && feedback.total === 0) reasons.push({ kind: "no_threads_on_change_request", reviewer });
	if (feedback.total > 0) {
		const { resolved, answered, outdated } = feedback.counts;
		reasons.push({ kind: "threads_addressed", reviewer, resolved, answered, outdatedOnly: outdated, total: feedback.total });
	}
	return reasons;
}

interface Gates {
	deciding: Check[];
	failing: Check[];
	pending: Check[];
	conflicting: boolean;
	behind: boolean;
	blocked: boolean;
	unresolvedThreads: boolean;
}

function gatesOf(snapshot: PrSnapshot): Gates {
	const { checks } = snapshot;
	const deciding = checks.every((c) => c.required === null) ? checks : checks.filter((c) => c.required === true);
	return {
		deciding,
		failing: deciding.filter((c) => c.verdict === "failing"),
		pending: deciding.filter((c) => c.verdict === "pending"),
		conflicting: snapshot.mergeable === "CONFLICTING",
		behind: snapshot.mergeStateStatus === "BEHIND",
		blocked: snapshot.mergeStateStatus === "BLOCKED",
		unresolvedThreads: snapshot.threads.some((t) => !t.isResolved),
	};
}

/** GitHub reports BLOCKED while a required check runs, so a running check also explains BLOCKED. */
const BLOCKER_TABLE: readonly { blocker: Blocker; when: (g: Gates, found: readonly Blocker[]) => boolean }[] = [
	{ blocker: "conflicts", when: (g) => g.conflicting },
	{ blocker: "ci_failing", when: (g) => g.failing.length > 0 },
	{ blocker: "behind", when: (g) => g.behind },
	{ blocker: "threads_unresolved", when: (g, found) => g.blocked && found.length === 0 && g.pending.length === 0 && g.unresolvedThreads },
	{ blocker: "blocked_other", when: (g, found) => g.blocked && found.length === 0 && g.pending.length === 0 },
	{ blocker: "ci_pending", when: (g, found) => g.pending.length > 0 && found.length === 0 },
];

const BLOCKER_COURT: Record<Blocker, Court> = {
	conflicts: "author",
	ci_failing: "author",
	behind: "author",
	threads_unresolved: "author",
	blocked_other: "author",
	ci_pending: "ci",
	review_missing: "reviewers",
	approval_dismissed: "reviewers",
};

function blockersOf(gates: Gates, seed: readonly Blocker[]): Blocker[] {
	return BLOCKER_TABLE.reduce<Blocker[]>((found, row) => (row.when(gates, found) ? [...found, row.blocker] : found), [...seed]);
}

interface FoldFacts {
	snapshot: PrSnapshot;
	signal: AuthorSignal["kind"] | null;
	reviewers: readonly Assessment[];
	changeRequesters: readonly Assessment[];
	approvals: readonly { login: Login; at: IsoTime }[];
	approved: boolean;
	gates: Gates;
	mergeBlockers: Blocker[];
	mergeCourt: Court | null;
}

function foldFactsOf(snapshot: PrSnapshot, reviewers: readonly Assessment[], signal: AuthorSignal["kind"] | null): FoldFacts {
	const approvals = reviewers.flatMap((r) => (r.approvedAt === null ? [] : [{ login: r.status.reviewer.login, at: r.approvedAt }]));
	const gates = gatesOf(snapshot);
	const mergeBlockers = blockersOf(gates, []);
	const [firstBlocker] = mergeBlockers;
	return {
		snapshot,
		signal,
		reviewers,
		changeRequesters: reviewers.filter((r) => r.changeRequested),
		approvals,
		approved:
			snapshot.reviewDecision === "APPROVED" ||
			(snapshot.reviewDecision === null && approvals.length > 0 && !has(reviewers, "feedback_outstanding")),
		gates,
		mergeBlockers,
		mergeCourt: firstBlocker === undefined ? null : BLOCKER_COURT[firstBlocker],
	};
}

interface Outcome {
	state: PrState;
	court: Court;
	blockers: Blocker[];
}

const outcome = (state: PrState, court: Court, blockers: Blocker[] = []): Outcome => ({ state, court, blockers });

const has = (reviewers: readonly Assessment[], kind: ReviewerStatusKind) => reviewers.some((r) => r.status.kind === kind);

const FOLD_TABLE: readonly ((f: FoldFacts) => Outcome | null)[] = [
	(f) => (f.snapshot.lifecycle.kind === "merged" ? outcome("merged", "nobody") : null),
	(f) => (f.snapshot.lifecycle.kind === "closed" ? outcome("closed", "nobody") : null),
	(f) => (f.snapshot.isDraft ? outcome("draft", "author") : null),
	(f) =>
		has(f.changeRequesters, "feedback_outstanding") ||
		(f.snapshot.reviewDecision === "CHANGES_REQUESTED" && f.changeRequesters.length === 0)
			? outcome("changes_requested", "author")
			: null,
	(f) =>
		f.snapshot.reviewDecision === "CHANGES_REQUESTED"
			? outcome(has(f.changeRequesters, "feedback_addressed") ? "likely_ready_for_rereview" : "in_review", "reviewers")
			: null,
	(f) => (f.approved && f.mergeCourt === null ? outcome("ready_to_merge", f.snapshot.inMergeQueue ? "ci" : "author") : null),
	(f) => (f.approved && f.mergeCourt !== null ? outcome("approved_blocked", f.mergeCourt, f.mergeBlockers) : null),
	(f) =>
		f.approvals.length > 0 && f.snapshot.reviewDecision === "REVIEW_REQUIRED"
			? outcome("approved_blocked", "reviewers", blockersOf(f.gates, [has(f.reviewers, "approval_dismissed") ? "approval_dismissed" : "review_missing"]))
			: null,
	(f) => (has(f.reviewers, "feedback_outstanding") ? outcome("changes_requested", "author") : null),
	(f) => (has(f.reviewers, "feedback_addressed") ? outcome("likely_ready_for_rereview", "reviewers") : null),
	(f) => (f.reviewers.some((r) => r.reviewed) ? outcome("in_review", "reviewers") : null),
];

function fold(facts: FoldFacts): Outcome {
	for (const row of FOLD_TABLE) {
		const matched = row(facts);
		if (matched !== null) return matched;
	}
	return outcome("needs_review", "reviewers");
}

const withStatus = (reviewers: readonly Assessment[], kind: ReviewerStatusKind) => reviewers.filter((r) => r.status.kind === kind);
const holdingBall = (reviewers: readonly Assessment[]) => reviewers.filter((r) => BALL_WITH[r.status.kind] === "reviewer");

function latest(floor: IsoTime, times: readonly (IsoTime | null | undefined)[]): IsoTime {
	let result = floor;
	for (const time of times) if (time != null && Date.parse(time) > Date.parse(result)) result = time;
	return result;
}

const openedAt = (snapshot: PrSnapshot): IsoTime => snapshot.readyAt ?? snapshot.createdAt;
const endedAt = (snapshot: PrSnapshot): IsoTime => (snapshot.lifecycle.kind === "open" ? snapshot.createdAt : snapshot.lifecycle.at);
const latestSince = (f: FoldFacts, reviewers: readonly Assessment[]) => latest(openedAt(f.snapshot), reviewers.map((r) => r.status.since));

function approvalSince(f: FoldFacts, blockers: readonly Blocker[]): IsoTime {
	const deciding = blockers.includes("ci_failing") ? f.gates.failing : f.gates.deciding;
	return latest(f.snapshot.headCommittedAt, [...f.approvals.map((a) => a.at), ...deciding.map((c) => c.completedAt)]);
}

const STATE_SINCE: Record<PrState, (f: FoldFacts, o: Outcome) => IsoTime> = {
	merged: (f) => endedAt(f.snapshot),
	closed: (f) => endedAt(f.snapshot),
	draft: (f) => f.snapshot.draftedAt ?? f.snapshot.createdAt,
	needs_review: (f) => openedAt(f.snapshot),
	in_review: (f) => latestSince(f, holdingBall(f.reviewers)),
	changes_requested: (f) => latestSince(f, withStatus(f.reviewers, "feedback_outstanding")),
	likely_ready_for_rereview: (f) => latestSince(f, withStatus(f.reviewers, "feedback_addressed")),
	approved_blocked: (f, o) => approvalSince(f, o.blockers),
	ready_to_merge: (f, o) => approvalSince(f, o.blockers),
};

function requestReasons(f: FoldFacts): Reason[] {
	const requested = withStatus(f.reviewers, "requested");
	const first = requested.filter((r) => !r.status.rerequested).map((r) => r.status.reviewer.login);
	const again = requested.filter((r) => r.status.rerequested).map((r) => r.status.reviewer.login);
	const teams = f.snapshot.reviewRequests.flatMap((q) => (q.kind === "team" ? [q.name] : []));
	const reasons: Reason[] = [];
	if (first.length > 0 || teams.length > 0) reasons.push({ kind: "review_requested", from: first, teams });
	if (again.length > 0) reasons.push({ kind: "rerequested", from: again });
	return reasons;
}

function approvedBy(f: FoldFacts): Reason[] {
	return f.approvals.length === 0 ? [] : [{ kind: "approved_by", reviewers: f.approvals.map((a) => a.login) }];
}

function blockedBy(blocker: Blocker, gates: Gates): Reason {
	const checks = blocker === "ci_failing" ? gates.failing : blocker === "ci_pending" ? gates.pending : [];
	return { kind: "blocked", blocker, checks: checks.map((c) => c.name) };
}

const flag = (on: boolean, reason: Reason): Reason[] => (on ? [reason] : []);

const STATE_REASONS: Record<PrState, (f: FoldFacts, o: Outcome) => Reason[]> = {
	merged: () => [],
	closed: () => [],
	draft: () => [{ kind: "draft" }],
	needs_review: (f) => {
		const requests = requestReasons(f);
		return requests.length > 0 ? requests : [{ kind: "no_reviewer_requested" }];
	},
	in_review: (f) => [...requestReasons(f), ...holdingBall(f.reviewers).flatMap((r) => r.reasons)],
	changes_requested: (f) => [
		...withStatus(f.reviewers, "feedback_outstanding").flatMap((r) => r.reasons),
		...flag(f.signal === "not_ready", { kind: "author_says_not_ready" }),
	],
	likely_ready_for_rereview: (f) => [
		...withStatus(f.reviewers, "feedback_addressed").flatMap((r) => r.reasons),
		...flag(f.signal === "ready", { kind: "author_says_ready" }),
	],
	approved_blocked: (f, o) => [
		...approvedBy(f),
		...o.blockers.map((b) => blockedBy(b, f.gates)),
		...flag(f.snapshot.autoMerge, { kind: "auto_merge_enabled" }),
	],
	ready_to_merge: (f) => [
		...approvedBy(f),
		...flag(f.snapshot.inMergeQueue, { kind: "in_merge_queue" }),
		...flag(f.snapshot.autoMerge, { kind: "auto_merge_enabled" }),
	],
};

function actorsOf(court: Court, f: FoldFacts, teams: ReadonlyMap<TeamSlug, readonly Login[]>, since: IsoTime): Actor[] {
	switch (court) {
		case "author":
			return [{ login: f.snapshot.author.login, via: { kind: "author" }, since }];
		case "reviewers": {
			const actors: Actor[] = holdingBall(f.reviewers).map((r) => ({
				login: r.status.reviewer.login,
				via: { kind: "direct", asCodeOwner: r.request?.asCodeOwner ?? false },
				since: r.status.since,
			}));
			const listed = new Set<Login>([f.snapshot.author.login, ...actors.map((a) => a.login)]);
			for (const request of f.snapshot.reviewRequests) {
				if (request.kind !== "team") continue;
				for (const login of teams.get(request.slug) ?? []) {
					if (listed.has(login)) continue;
					listed.add(login);
					const via = { kind: "team", slug: request.slug, name: request.name, asCodeOwner: request.asCodeOwner } as const;
					actors.push({ login, via, since: request.requestedAt ?? since });
				}
			}
			return actors;
		}
		case "ci":
		case "nobody":
			return [];
		default: {
			const unhandled: never = court;
			return unhandled;
		}
	}
}

const CONFIDENCE_RANK: Record<Confidence, number> = { medium: 0, high: 1, confirmed: 2 };

function weakest(reviewers: readonly Assessment[]): Confidence | null {
	let result: Confidence | null = null;
	for (const { confidence } of reviewers) {
		if (confidence !== null && (result === null || CONFIDENCE_RANK[confidence] < CONFIDENCE_RANK[result])) result = confidence;
	}
	return result;
}
