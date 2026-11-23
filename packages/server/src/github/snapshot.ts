import { z } from "zod";
import { asLogin, asPrId, asSha, asTeamSlug, isIsoTime } from "@radar/core";
import type {
	Check,
	CheckVerdict,
	DecisiveReviewState,
	IsoTime,
	Lifecycle,
	Person,
	PrSnapshot,
	Review,
	ReviewRequest,
	ReviewState,
	ReviewThread,
} from "@radar/core";
import { connection } from "./graphql.ts";

const isoTimeSchema = z.iso.datetime({ offset: true }).transform((value, ctx): IsoTime => {
	if (isIsoTime(value)) return value;
	ctx.addIssue({ code: "custom", message: `Not a timestamp: ${value}` });
	return z.NEVER;
});

const actorSchema = z.object({ __typename: z.string(), login: z.string(), avatarUrl: z.string() });
type ActorNode = z.infer<typeof actorSchema>;

const GHOST: ActorNode = { __typename: "User", login: "ghost", avatarUrl: "" };

function toPerson(actor: ActorNode | null): Person {
	const { __typename, login, avatarUrl } = actor ?? GHOST;
	return { login: asLogin(login), avatarUrl, isBot: __typename === "Bot" || login.endsWith("[bot]") };
}

const MODELED_REVIEWERS = new Set(["User", "Bot", "Mannequin", "Team"]);

/** `RequestedReviewer` members this model has no shape for, such as `EnterpriseTeam`, read as no reviewer. */
const unmodeledReviewerSchema = z
	.object({ __typename: z.string().refine((name) => !MODELED_REVIEWERS.has(name)) })
	.transform(() => null);

const userReviewerTypename = z.enum(["User", "Bot", "Mannequin"]);

const requestedReviewerSchema = z
	.union([
		actorSchema.extend({ __typename: userReviewerTypename }),
		z.object({ __typename: z.literal("Team"), slug: z.string(), name: z.string() }),
		unmodeledReviewerSchema,
	])
	.nullable();

const timelineReviewerSchema = z
	.union([
		z.object({ __typename: userReviewerTypename, login: z.string() }),
		z.object({ __typename: z.literal("Team"), slug: z.string() }),
		unmodeledReviewerSchema,
	])
	.nullable();

const timelineItemSchema = z.discriminatedUnion("__typename", [
	z.object({ __typename: z.literal("ReadyForReviewEvent"), createdAt: isoTimeSchema }),
	z.object({ __typename: z.literal("ConvertToDraftEvent"), createdAt: isoTimeSchema }),
	z.object({
		__typename: z.literal("ReviewRequestedEvent"),
		createdAt: isoTimeSchema,
		requestedReviewer: timelineReviewerSchema,
	}),
]);
type TimelineItem = z.infer<typeof timelineItemSchema>;

const reviewSchema = z.object({
	state: z.enum(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"]),
	submittedAt: isoTimeSchema.nullable(),
	author: actorSchema.nullable(),
	commit: z.object({ oid: z.string() }).nullable(),
});
type ReviewNode = z.infer<typeof reviewSchema>;

const commentSchema = z.object({ createdAt: isoTimeSchema, author: actorSchema.nullable() });

const threadSchema = z.object({
	isResolved: z.boolean(),
	isOutdated: z.boolean(),
	first: connection(commentSchema),
	last: connection(commentSchema),
});
type ThreadNode = z.infer<typeof threadSchema>;

const statusStateSchema = z.enum(["ERROR", "EXPECTED", "FAILURE", "PENDING", "SUCCESS"]);

const checkContextSchema = z.discriminatedUnion("__typename", [
	z.object({
		__typename: z.literal("CheckRun"),
		name: z.string(),
		status: z.string(),
		conclusion: z.string().nullable(),
		completedAt: isoTimeSchema.nullable(),
		isRequired: z.boolean(),
	}),
	z.object({
		__typename: z.literal("StatusContext"),
		context: z.string(),
		state: statusStateSchema,
		createdAt: isoTimeSchema,
		isRequired: z.boolean(),
	}),
]);
type CheckContext = z.infer<typeof checkContextSchema>;

const pullRequestBaseSchema = z.object({
	id: z.string(),
	number: z.number().int().positive(),
	url: z.string(),
	title: z.string(),
	isDraft: z.boolean(),
	createdAt: isoTimeSchema,
	repository: z.object({ name: z.string(), owner: z.object({ login: z.string() }) }),
	author: actorSchema.nullable(),
	headRefOid: z.string(),
	baseRefName: z.string(),
	additions: z.number().int(),
	deletions: z.number().int(),
	labels: connection(z.object({ name: z.string() })),
	files: connection(z.object({ path: z.string() })),
	reviewDecision: z.enum(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"]).nullable(),
	mergeable: z.enum(["MERGEABLE", "CONFLICTING", "UNKNOWN"]),
	mergeStateStatus: z.enum(["BEHIND", "BLOCKED", "CLEAN", "DIRTY", "DRAFT", "HAS_HOOKS", "UNKNOWN", "UNSTABLE"]),
	isInMergeQueue: z.boolean(),
	autoMergeRequest: z.object({}).nullable(),
	reviewRequests: connection(z.object({ asCodeOwner: z.boolean(), requestedReviewer: requestedReviewerSchema })),
	latestOpinionatedReviews: connection(reviewSchema),
	latestReviews: connection(reviewSchema),
	reviewThreads: connection(threadSchema),
	timelineItems: connection(timelineItemSchema),
	commits: connection(
		z.object({
			commit: z.object({
				committedDate: isoTimeSchema,
				statusCheckRollup: z.object({ contexts: connection(checkContextSchema) }).nullable(),
			}),
		}),
	),
});

export const pullRequestNodeSchema = z.discriminatedUnion("state", [
	pullRequestBaseSchema.extend({ state: z.literal("OPEN") }),
	pullRequestBaseSchema.extend({ state: z.literal("MERGED"), mergedAt: isoTimeSchema }),
	pullRequestBaseSchema.extend({ state: z.literal("CLOSED"), closedAt: isoTimeSchema }),
]);
type PullRequestNode = z.infer<typeof pullRequestNodeSchema>;

export function parsePullRequest(node: unknown): PrSnapshot {
	return toSnapshot(pullRequestNodeSchema.parse(node));
}

function toSnapshot(pr: PullRequestNode): PrSnapshot {
	const latest = latestEventTimes(pr.timelineItems);
	const lastCommit = pr.commits.at(-1)?.commit ?? null;
	return {
		id: asPrId(pr.id),
		repo: { owner: pr.repository.owner.login, name: pr.repository.name },
		number: pr.number,
		url: pr.url,
		title: pr.title,
		author: toPerson(pr.author),
		lifecycle: lifecycleOf(pr),
		isDraft: pr.isDraft,
		createdAt: pr.createdAt,
		readyAt: latest.get(READY) ?? null,
		draftedAt: latest.get(DRAFTED) ?? null,
		headSha: asSha(pr.headRefOid),
		headCommittedAt: lastCommit?.committedDate ?? pr.createdAt,
		baseRef: pr.baseRefName,
		labels: pr.labels.map((label) => label.name),
		paths: pr.files.map((file) => file.path),
		additions: pr.additions,
		deletions: pr.deletions,
		reviewDecision: pr.reviewDecision,
		reviewRequests: pr.reviewRequests.flatMap(({ asCodeOwner, requestedReviewer }): ReviewRequest[] => {
			if (requestedReviewer === null) return [];
			const requestedAt = latest.get(reviewerKey(requestedReviewer)) ?? null;
			if (requestedReviewer.__typename === "Team") {
				const { slug, name } = requestedReviewer;
				return [{ kind: "team", slug: asTeamSlug(slug), name, asCodeOwner, requestedAt }];
			}
			return [{ kind: "user", reviewer: toPerson(requestedReviewer), asCodeOwner, requestedAt }];
		}),
		decisiveReviews: toReviews(pr.latestOpinionatedReviews, DECISIVE_STATES),
		latestReviews: toReviews(pr.latestReviews, [...DECISIVE_STATES, "COMMENTED"]),
		threads: pr.reviewThreads.flatMap(toThread),
		checks: (lastCommit?.statusCheckRollup?.contexts ?? []).map(toCheck),
		mergeable: pr.mergeable,
		mergeStateStatus: pr.mergeStateStatus,
		inMergeQueue: pr.isInMergeQueue,
		autoMerge: pr.autoMergeRequest !== null,
	};
}

function lifecycleOf(pr: PullRequestNode): Lifecycle {
	switch (pr.state) {
		case "OPEN":
			return { kind: "open" };
		case "MERGED":
			return { kind: "merged", at: pr.mergedAt };
		case "CLOSED":
			return { kind: "closed", at: pr.closedAt };
	}
}

const READY = "ready";
const DRAFTED = "drafted";

function reviewerKey(reviewer: { __typename: "Team"; slug: string } | { __typename: "User" | "Bot" | "Mannequin"; login: string }): string {
	return reviewer.__typename === "Team" ? `team:${reviewer.slug}` : `user:${reviewer.login}`;
}

function eventKey(item: TimelineItem): string | null {
	switch (item.__typename) {
		case "ReadyForReviewEvent":
			return READY;
		case "ConvertToDraftEvent":
			return DRAFTED;
		case "ReviewRequestedEvent":
			return item.requestedReviewer === null ? null : reviewerKey(item.requestedReviewer);
	}
}

function latestEventTimes(timeline: TimelineItem[]): Map<string, IsoTime> {
	const latest = new Map<string, IsoTime>();
	for (const item of timeline) {
		const key = eventKey(item);
		if (key === null) continue;
		const seen = latest.get(key);
		if (seen === undefined || Date.parse(item.createdAt) > Date.parse(seen)) latest.set(key, item.createdAt);
	}
	return latest;
}

const DECISIVE_STATES: readonly DecisiveReviewState[] = ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"];

function toReviews(reviews: ReviewNode[], keep: readonly ReviewState[]): Review[] {
	return reviews.flatMap(({ state, submittedAt, author, commit }): Review[] => {
		if (state === "PENDING" || !keep.includes(state) || submittedAt === null || author === null) return [];
		return [{ reviewer: toPerson(author), state, submittedAt, commitSha: commit === null ? null : asSha(commit.oid) }];
	});
}

function toThread({ isResolved, isOutdated, first, last }: ThreadNode): ReviewThread[] {
	const opening = first[0];
	const newest = last[0] ?? opening;
	if (opening === undefined || newest === undefined) return [];
	return [
		{
			startedBy: toPerson(opening.author),
			startedAt: opening.createdAt,
			isResolved,
			isOutdated,
			lastCommentBy: toPerson(newest.author),
			lastCommentAt: newest.createdAt,
		},
	];
}

const PASSING_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

const STATUS_VERDICTS = {
	SUCCESS: "passing",
	PENDING: "pending",
	EXPECTED: "pending",
	FAILURE: "failing",
	ERROR: "failing",
} as const satisfies Record<z.infer<typeof statusStateSchema>, CheckVerdict>;

function toCheck(context: CheckContext): Check {
	if (context.__typename === "StatusContext") {
		return {
			name: context.context,
			verdict: STATUS_VERDICTS[context.state],
			required: context.isRequired,
			completedAt: context.createdAt,
		};
	}
	return {
		name: context.name,
		verdict: checkRunVerdict(context.status, context.conclusion),
		required: context.isRequired,
		completedAt: context.completedAt,
	};
}

function checkRunVerdict(status: string, conclusion: string | null): CheckVerdict {
	if (status !== "COMPLETED") return "pending";
	return conclusion !== null && PASSING_CONCLUSIONS.has(conclusion) ? "passing" : "failing";
}
