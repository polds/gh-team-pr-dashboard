export type Login = string & { readonly __brand: "Login" };
export type PrId = string & { readonly __brand: "PrId" };
export type TeamSlug = string & { readonly __brand: "TeamSlug" };
export type Sha = string & { readonly __brand: "Sha" };
export type IsoTime = string & { readonly __brand: "IsoTime" };

export const asLogin = (value: string): Login => value as Login;
export const asPrId = (value: string): PrId => value as PrId;
export const asTeamSlug = (value: string): TeamSlug => value as TeamSlug;
export const asSha = (value: string): Sha => value as Sha;

export function isIsoTime(value: string): value is IsoTime {
	return !Number.isNaN(Date.parse(value));
}

export interface Person {
	login: Login;
	avatarUrl: string;
	isBot: boolean;
}

export type ReviewRequest =
	| { kind: "user"; reviewer: Person; asCodeOwner: boolean; requestedAt: IsoTime | null }
	| { kind: "team"; slug: TeamSlug; name: string; asCodeOwner: boolean; requestedAt: IsoTime | null };

export type DecisiveReviewState = "APPROVED" | "CHANGES_REQUESTED" | "DISMISSED";
export type ReviewState = DecisiveReviewState | "COMMENTED";

export interface Review {
	reviewer: Person;
	state: ReviewState;
	submittedAt: IsoTime;
	commitSha: Sha | null;
}

export interface ReviewThread {
	startedBy: Person;
	startedAt: IsoTime;
	isResolved: boolean;
	isOutdated: boolean;
	lastCommentBy: Person;
	lastCommentAt: IsoTime;
}

export type CheckVerdict = "passing" | "failing" | "pending";

export interface Check {
	name: string;
	verdict: CheckVerdict;
	required: boolean | null;
	completedAt: IsoTime | null;
}

export type ReviewDecision = "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
export type Mergeable = "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
export type MergeStateStatus =
	| "CLEAN"
	| "BLOCKED"
	| "BEHIND"
	| "DIRTY"
	| "DRAFT"
	| "HAS_HOOKS"
	| "UNKNOWN"
	| "UNSTABLE";

export type Lifecycle =
	| { kind: "open" }
	| { kind: "merged"; at: IsoTime }
	| { kind: "closed"; at: IsoTime };

/**
 * One pull request as GitHub describes it at one moment. Every field comes
 * from GitHub.
 */
export interface PrSnapshot {
	id: PrId;
	repo: { owner: string; name: string };
	number: number;
	url: string;
	title: string;
	author: Person;
	lifecycle: Lifecycle;
	isDraft: boolean;
	createdAt: IsoTime;
	/** When the pull request last became ready for review. Null if it never left draft or was never a draft. */
	readyAt: IsoTime | null;
	/** When the pull request was last converted to draft. Null if it was opened as a draft or never was one. */
	draftedAt: IsoTime | null;
	headSha: Sha;
	headCommittedAt: IsoTime;
	baseRef: string;
	labels: string[];
	/** Changed file paths, capped by the fetcher. */
	paths: string[];
	additions: number;
	deletions: number;
	reviewDecision: ReviewDecision;
	reviewRequests: ReviewRequest[];
	/** The latest decisive review from each reviewer. */
	decisiveReviews: Review[];
	/** The latest review of any state from each reviewer. */
	latestReviews: Review[];
	threads: ReviewThread[];
	checks: Check[];
	mergeable: Mergeable;
	mergeStateStatus: MergeStateStatus;
	inMergeQueue: boolean;
	autoMerge: boolean;
}

export type PrState =
	| "draft"
	| "needs_review"
	| "in_review"
	| "changes_requested"
	| "likely_ready_for_rereview"
	| "approved_blocked"
	| "ready_to_merge"
	| "merged"
	| "closed";

export type Court = "author" | "reviewers" | "ci" | "nobody";

export type ReviewerStatusKind =
	| "requested"
	| "approval_dismissed"
	| "approved"
	| "feedback_outstanding"
	| "feedback_addressed"
	| "commented";

export interface ReviewerStatus {
	reviewer: Person;
	kind: ReviewerStatusKind;
	/** True when the reviewer reviewed before and has a pending request again. */
	rerequested: boolean;
	/** When this status began, estimated from GitHub timestamps. */
	since: IsoTime;
}

export type ActorVia =
	| { kind: "author" }
	| { kind: "direct"; asCodeOwner: boolean }
	| { kind: "team"; slug: TeamSlug; name: string; asCodeOwner: boolean };

export interface Actor {
	login: Login;
	via: ActorVia;
	since: IsoTime;
}

export type Blocker =
	| "conflicts"
	| "ci_failing"
	| "behind"
	| "threads_unresolved"
	| "blocked_other"
	| "ci_pending"
	| "review_missing"
	| "approval_dismissed";

export type Confidence = "high" | "medium" | "confirmed";

/** Why a pull request is in its state. */
export type Reason =
	| { kind: "draft" }
	| { kind: "no_reviewer_requested" }
	| { kind: "review_requested"; from: Login[]; teams: string[] }
	| { kind: "rerequested"; from: Login[] }
	| { kind: "changes_requested_by"; reviewer: Login; at: IsoTime }
	| { kind: "open_threads"; reviewer: Login; awaitingAuthor: number; total: number }
	| { kind: "new_commits_since_review"; reviewer: Login; reviewedSha: Sha | null }
	| { kind: "threads_addressed"; reviewer: Login; resolved: number; answered: number; outdatedOnly: number; total: number }
	| { kind: "no_threads_on_change_request"; reviewer: Login }
	| { kind: "author_says_ready" }
	| { kind: "author_says_not_ready" }
	| { kind: "commented_by"; reviewer: Login; at: IsoTime }
	| { kind: "approved_by"; reviewers: Login[] }
	| { kind: "blocked"; blocker: Blocker; checks: string[] }
	| { kind: "in_merge_queue" }
	| { kind: "auto_merge_enabled" };

export interface Derived {
	state: PrState;
	court: Court;
	/** Estimate of when the pull request entered this state, from GitHub timestamps alone. */
	sinceEstimate: IsoTime;
	actors: Actor[];
	reviewers: ReviewerStatus[];
	reasons: Reason[];
	blockers: Blocker[];
	/** Set only for `likely_ready_for_rereview`. */
	confidence: Confidence | null;
}

/**
 * A signal the author sent from the card. It applies only while the head SHA matches.
 * A `ready` signal stops covering a reviewer who gives feedback after `at`.
 */
export interface AuthorSignal {
	kind: "ready" | "not_ready";
	headSha: Sha;
	at: IsoTime;
}

export interface DeriveContext {
	/** Members of each team that can appear in a review request. */
	teams: ReadonlyMap<TeamSlug, readonly Login[]>;
	authorSignal: AuthorSignal | null;
}
