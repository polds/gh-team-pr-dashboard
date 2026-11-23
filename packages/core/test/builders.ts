import { asLogin, asPrId, asSha, asTeamSlug, isIsoTime } from "../src/index.ts";
import type {
	Actor,
	Card,
	Check,
	CheckVerdict,
	Derived,
	DeriveContext,
	IsoTime,
	Login,
	Person,
	PrSnapshot,
	Review,
	ReviewRequest,
	ReviewState,
	ReviewThread,
} from "../src/index.ts";

export function iso(value: string): IsoTime {
	if (!isIsoTime(value)) throw new Error(`not a time: ${value}`);
	return value;
}

const BASE_MS = Date.parse("2026-11-02T17:00:00Z");

/** A time `n` hours after Monday 2026-11-02 09:00 in Los Angeles. */
export function hour(n: number): IsoTime {
	return iso(new Date(BASE_MS + n * 3_600_000).toISOString());
}

export function human(login: string): Person {
	return { login: asLogin(login), avatarUrl: `https://avatars.test/${login}`, isBot: false };
}

export function bot(login: string): Person {
	return { login: asLogin(login), avatarUrl: `https://avatars.test/${login}`, isBot: true };
}

export const ana = human("ana");

export function pr(facts: Partial<PrSnapshot> = {}): PrSnapshot {
	return {
		id: asPrId("PR_1"),
		repo: { owner: "acme", name: "web" },
		number: 1,
		url: "https://github.com/acme/web/pull/1",
		title: "Add billing export",
		author: ana,
		lifecycle: { kind: "open" },
		isDraft: false,
		createdAt: hour(0),
		readyAt: null,
		draftedAt: null,
		headSha: asSha("c1"),
		headCommittedAt: hour(0),
		baseRef: "main",
		labels: [],
		paths: [],
		additions: 10,
		deletions: 2,
		reviewDecision: null,
		reviewRequests: [],
		decisiveReviews: [],
		latestReviews: [],
		threads: [],
		checks: [],
		mergeable: "MERGEABLE",
		mergeStateStatus: "CLEAN",
		inMergeQueue: false,
		autoMerge: false,
		...facts,
	};
}

export function review(reviewer: Person, state: ReviewState, submittedAt: IsoTime, commitSha: string | null = "c1"): Review {
	return { reviewer, state, submittedAt, commitSha: commitSha === null ? null : asSha(commitSha) };
}

/** GitHub's two review lists, given every review in the order it was submitted. */
export function reviews(...history: Review[]): Pick<PrSnapshot, "decisiveReviews" | "latestReviews"> {
	const latest = new Map<Login, Review>();
	const decisive = new Map<Login, Review>();
	for (const entry of history) {
		latest.set(entry.reviewer.login, entry);
		if (entry.state !== "COMMENTED") decisive.set(entry.reviewer.login, entry);
	}
	return { decisiveReviews: [...decisive.values()], latestReviews: [...latest.values()] };
}

export function thread(startedBy: Person, facts: Partial<ReviewThread> = {}): ReviewThread {
	const startedAt = facts.startedAt ?? hour(1);
	return {
		startedBy,
		startedAt,
		isResolved: false,
		isOutdated: false,
		lastCommentBy: startedBy,
		lastCommentAt: startedAt,
		...facts,
	};
}

export function requestOf(reviewer: Person, facts: { asCodeOwner?: boolean; requestedAt?: IsoTime | null } = {}): ReviewRequest {
	return { kind: "user", reviewer, asCodeOwner: facts.asCodeOwner ?? false, requestedAt: facts.requestedAt ?? null };
}

export function teamRequestOf(slug: string, facts: { asCodeOwner?: boolean; requestedAt?: IsoTime | null } = {}): ReviewRequest {
	return {
		kind: "team",
		slug: asTeamSlug(slug),
		name: `Team ${slug}`,
		asCodeOwner: facts.asCodeOwner ?? false,
		requestedAt: facts.requestedAt ?? null,
	};
}

export function check(name: string, verdict: CheckVerdict, required: boolean | null = true, completedAt: IsoTime | null = null): Check {
	return { name, verdict, required, completedAt: verdict === "pending" ? null : completedAt ?? hour(0) };
}

export function context(facts: Partial<DeriveContext> = {}): DeriveContext {
	return { teams: new Map(), authorSignal: null, ...facts };
}

export function asAuthor(person: Person, since: IsoTime = hour(0)): Actor {
	return { login: person.login, via: { kind: "author" }, since };
}

export function direct(person: Person, since: IsoTime = hour(0), asCodeOwner = false): Actor {
	return { login: person.login, via: { kind: "direct", asCodeOwner }, since };
}

export function viaTeam(person: Person, slug: string, since: IsoTime = hour(0)): Actor {
	return { login: person.login, via: { kind: "team", slug: asTeamSlug(slug), name: `Team ${slug}`, asCodeOwner: false }, since };
}

export function card(facts: Partial<Omit<Card, "derived">> & { derived?: Partial<Derived> } = {}): Card {
	const { derived, ...rest } = facts;
	const number = rest.number ?? 1;
	return {
		id: asPrId(`PR_${number}`),
		repo: "acme/web",
		number,
		url: `https://github.com/acme/web/pull/${number}`,
		title: `Change ${number}`,
		author: ana,
		isBotPr: false,
		labels: [],
		areas: [],
		requestedTeams: [],
		additions: 1,
		deletions: 0,
		headSha: asSha("c1"),
		checks: { verdict: "none", failing: [], pending: [], total: 0 },
		derived: {
			state: "needs_review",
			court: "reviewers",
			sinceEstimate: hour(0),
			actors: [],
			reviewers: [],
			reasons: [],
			blockers: [],
			confidence: null,
			...derived,
		},
		since: hour(0),
		priority: false,
		helpWanted: null,
		...rest,
	};
}
