import { asLogin, asPrId, asSha, asTeamSlug, isIsoTime } from "@radar/core";
import type { Check, IsoTime, Person, PrSnapshot, Review, ReviewRequest, ReviewThread } from "@radar/core";
import type { PrRef, TeamInfo } from "../github/source.ts";

function avatar(login: string, color: string): string {
	const initial = login.charAt(0).toUpperCase();
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="20" fill="${color}"/><text x="20" y="26" font-family="sans-serif" font-size="18" fill="#fff" text-anchor="middle">${initial}</text></svg>`;
	return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const human = (login: string, color: string): Person => ({ login: asLogin(login), avatarUrl: avatar(login, color), isBot: false });

export const ada = human("ada", "#7c3aed");
export const grace = human("grace", "#0891b2");
export const linus = human("linus", "#ca8a04");
export const margaret = human("margaret", "#db2777");
export const ken = human("ken", "#16a34a");
export const barbara = human("barbara", "#ea580c");
export const renovate: Person = { login: asLogin("renovate[bot]"), avatarUrl: avatar("renovate", "#475569"), isBot: true };

export const CAST: readonly Person[] = [ada, grace, linus, margaret, ken, barbara, renovate];

export const TEAMS: readonly TeamInfo[] = [
	{ slug: asTeamSlug("platform"), name: "Platform", members: [ada, grace, ken] },
	{ slug: asTeamSlug("payments"), name: "Payments", members: [linus, margaret] },
	{ slug: asTeamSlug("web"), name: "Web", members: [barbara, margaret] },
];

const team = (slug: string) => {
	const found = TEAMS.find((candidate) => candidate.slug === slug);
	if (found === undefined) throw new Error(`no demo team ${slug}`);
	return found;
};

type Repo = "monorepo" | "infra" | "mobile";

export type Clockwork = (hoursAgo: number) => IsoTime;

export function clockwork(start: Date): Clockwork {
	return (hoursAgo) => {
		const value = new Date(start.getTime() - hoursAgo * 3_600_000).toISOString();
		if (!isIsoTime(value)) throw new Error(`not a time: ${value}`);
		return value;
	};
}

const sha = (label: string) => asSha(label.padEnd(40, "0"));

const passing = (name: string, at: IsoTime): Check => ({ name, verdict: "passing", required: true, completedAt: at });
const failing = (name: string, at: IsoTime): Check => ({ name, verdict: "failing", required: true, completedAt: at });
const running = (name: string): Check => ({ name, verdict: "pending", required: true, completedAt: null });

const reviewBy = (reviewer: Person, state: Review["state"], submittedAt: IsoTime, commit: string): Review => ({
	reviewer,
	state,
	submittedAt,
	commitSha: sha(commit),
});

const userRequest = (reviewer: Person, requestedAt: IsoTime): ReviewRequest => ({ kind: "user", reviewer, asCodeOwner: false, requestedAt });

const teamRequest = (slug: string, requestedAt: IsoTime, asCodeOwner = true): ReviewRequest => {
	const { name } = team(slug);
	return { kind: "team", slug: asTeamSlug(slug), name, asCodeOwner, requestedAt };
};

const thread = (startedBy: Person, startedAt: IsoTime, last: { by: Person; at: IsoTime; resolved?: boolean }): ReviewThread => ({
	startedBy,
	startedAt,
	isResolved: last.resolved ?? false,
	isOutdated: false,
	lastCommentBy: last.by,
	lastCommentAt: last.at,
});

interface PrFacts extends Partial<Omit<PrSnapshot, "repo">> {
	repo: Repo;
	number: number;
	title: string;
	author: Person;
	createdAt: IsoTime;
	head: string;
}

function pr({ repo, number, head, ...facts }: PrFacts): PrSnapshot {
	return {
		id: asPrId(`PR_atum_${repo}_${number}`),
		repo: { owner: "atum", name: repo },
		number,
		url: `https://github.com/atum/${repo}/pull/${number}`,
		lifecycle: { kind: "open" },
		isDraft: false,
		readyAt: null,
		draftedAt: null,
		headSha: sha(head),
		headCommittedAt: facts.createdAt,
		baseRef: "main",
		labels: [],
		paths: [],
		additions: 40,
		deletions: 8,
		reviewDecision: "REVIEW_REQUIRED",
		reviewRequests: [],
		decisiveReviews: [],
		latestReviews: [],
		threads: [],
		checks: [],
		mergeable: "MERGEABLE",
		mergeStateStatus: "BLOCKED",
		inMergeQueue: false,
		autoMerge: false,
		...facts,
	};
}

export const refOf = (snapshot: PrSnapshot): PrRef => ({ owner: snapshot.repo.owner, name: snapshot.repo.name, number: snapshot.number });

export function initialPullRequests(ago: Clockwork): PrSnapshot[] {
	return [
		pr({
			repo: "monorepo",
			number: 4102,
			title: "Move invoice rounding into the billing service",
			author: linus,
			createdAt: ago(146),
			head: "a4102",
			paths: ["services/billing/invoice.ts", "services/billing/rounding.ts", "services/billing/rounding.test.ts"],
			additions: 182,
			deletions: 64,
			reviewRequests: [userRequest(grace, ago(146)), teamRequest("platform", ago(146))],
			checks: [passing("build", ago(145)), passing("test", ago(145))],
		}),
		pr({
			repo: "infra",
			number: 318,
			title: "Raise the ingress timeout for the event stream",
			author: ada,
			createdAt: ago(1),
			head: "i318",
			labels: ["hotfix"],
			paths: ["k8s/ingress/backend-config.yaml"],
			additions: 3,
			deletions: 1,
			reviewRequests: [userRequest(linus, ago(1))],
			checks: [passing("kubeconform", ago(0.9))],
		}),
		pr({
			repo: "monorepo",
			number: 4110,
			title: "Rank search results by recency",
			author: barbara,
			createdAt: ago(6),
			head: "a4110",
			paths: ["services/search/ranker.ts", "services/search/ranker.test.ts"],
			decisiveReviews: [],
			latestReviews: [reviewBy(margaret, "COMMENTED", ago(2), "a4110")],
			checks: [passing("build", ago(5.8)), passing("test", ago(5.8))],
		}),
		pr({
			repo: "mobile",
			number: 77,
			title: "Cache the offline queue on disk",
			author: grace,
			createdAt: ago(9),
			head: "m77a",
			paths: ["app/sync/queue.ts", "app/sync/storage.ts"],
			reviewDecision: "CHANGES_REQUESTED",
			decisiveReviews: [reviewBy(barbara, "CHANGES_REQUESTED", ago(4), "m77a")],
			latestReviews: [reviewBy(barbara, "CHANGES_REQUESTED", ago(4), "m77a")],
			threads: [
				thread(barbara, ago(4), { by: barbara, at: ago(4) }),
				thread(barbara, ago(4), { by: barbara, at: ago(3.5) }),
			],
			checks: [passing("ios", ago(8.5)), passing("android", ago(8.5))],
		}),
		pr({
			repo: "monorepo",
			number: 4115,
			title: "Extract the button primitives",
			author: margaret,
			createdAt: ago(7),
			head: "a4115",
			paths: ["libs/ui/button.tsx", "libs/ui/icon-button.tsx"],
			latestReviews: [reviewBy(ada, "COMMENTED", ago(3), "a4115")],
			threads: [thread(ada, ago(3), { by: ada, at: ago(3) }), thread(ada, ago(3), { by: ada, at: ago(3) })],
			checks: [passing("build", ago(6.8)), passing("storybook", ago(6.8))],
		}),
		pr({
			repo: "monorepo",
			number: 4098,
			title: "Retry failed payouts with backoff",
			author: linus,
			createdAt: ago(10),
			head: "a4098b",
			headCommittedAt: ago(1),
			paths: ["services/billing/payouts.ts", "services/billing/backoff.ts"],
			reviewDecision: "CHANGES_REQUESTED",
			decisiveReviews: [reviewBy(ken, "CHANGES_REQUESTED", ago(5), "a4098a")],
			latestReviews: [reviewBy(ken, "CHANGES_REQUESTED", ago(5), "a4098a")],
			threads: [
				thread(ken, ago(5), { by: linus, at: ago(1.5), resolved: true }),
				thread(ken, ago(5), { by: linus, at: ago(1) }),
				thread(ken, ago(5), { by: linus, at: ago(1) }),
			],
			checks: [passing("build", ago(0.8)), passing("test", ago(0.8))],
		}),
		pr({
			repo: "infra",
			number: 312,
			title: "Pin the Terraform provider versions",
			author: ken,
			createdAt: ago(8),
			head: "i312",
			paths: ["terraform/providers.tf"],
			reviewDecision: "APPROVED",
			decisiveReviews: [reviewBy(ada, "APPROVED", ago(4), "i312")],
			latestReviews: [reviewBy(ada, "APPROVED", ago(4), "i312")],
			checks: [passing("lint", ago(7.5)), failing("terraform plan", ago(3))],
		}),
		pr({
			repo: "monorepo",
			number: 4104,
			title: "Add a loading state to the checkout page",
			author: barbara,
			createdAt: ago(5),
			head: "a4104",
			paths: ["web/app/checkout/page.tsx", "web/app/checkout/spinner.tsx"],
			reviewDecision: "APPROVED",
			decisiveReviews: [reviewBy(margaret, "APPROVED", ago(2), "a4104")],
			latestReviews: [reviewBy(margaret, "APPROVED", ago(2), "a4104")],
			checks: [passing("build", ago(1.9)), running("e2e")],
		}),
		pr({
			repo: "monorepo",
			number: 4090,
			title: "Split the search indexer into shards",
			author: grace,
			createdAt: ago(12),
			head: "a4090",
			paths: ["services/search/indexer.ts", "services/search/shards.ts"],
			additions: 410,
			deletions: 122,
			reviewRequests: [userRequest(margaret, ago(11))],
			decisiveReviews: [reviewBy(linus, "APPROVED", ago(5), "a4090")],
			latestReviews: [reviewBy(linus, "APPROVED", ago(5), "a4090")],
			checks: [passing("build", ago(11.5)), passing("test", ago(11.5))],
		}),
		pr({
			repo: "mobile",
			number: 74,
			title: "Show the sync status in the header",
			author: margaret,
			createdAt: ago(20),
			head: "m74",
			paths: ["app/header/sync-status.tsx"],
			reviewDecision: "APPROVED",
			decisiveReviews: [reviewBy(barbara, "APPROVED", ago(3), "m74")],
			latestReviews: [reviewBy(barbara, "APPROVED", ago(3), "m74")],
			checks: [passing("ios", ago(19)), passing("android", ago(19))],
			mergeStateStatus: "CLEAN",
		}),
		pr({
			repo: "monorepo",
			number: 4120,
			title: "Prototype the new search filters",
			author: ada,
			createdAt: ago(8),
			head: "a4120",
			isDraft: true,
			paths: ["web/app/search/filters.tsx"],
			reviewDecision: null,
			mergeStateStatus: "DRAFT",
		}),
		pr({
			repo: "monorepo",
			number: 4119,
			title: "Update dependency zod to v4.6.8",
			author: renovate,
			createdAt: ago(4),
			head: "a4119",
			paths: ["package.json", "package-lock.json"],
			additions: 12,
			deletions: 12,
			checks: [passing("build", ago(3.8)), passing("test", ago(3.8))],
		}),
	];
}

export interface ScriptStep {
	description: string;
	ref: PrRef;
	/** The pull request as it is before this step, or undefined when the step opens it. */
	change(before: PrSnapshot | undefined, at: IsoTime): PrSnapshot;
}

function existing(before: PrSnapshot | undefined): PrSnapshot {
	if (before === undefined) throw new Error("the demo step needs a pull request that exists");
	return before;
}

const monorepo = (number: number): PrRef => ({ owner: "atum", name: "monorepo", number });
const mobile = (number: number): PrRef => ({ owner: "atum", name: "mobile", number });

export const SCRIPT: readonly ScriptStep[] = [
	{
		description: "grace pushes a fix to atum/mobile#77 and answers barbara's threads. The card moves to likely ready for re-review.",
		ref: mobile(77),
		change(before, at) {
			const pr = existing(before);
			return {
				...pr,
				headSha: sha("m77b"),
				headCommittedAt: at,
				threads: pr.threads.map((t) => ({ ...t, lastCommentBy: grace, lastCommentAt: at })),
			};
		},
	},
	{
		description: "barbara approves atum/mobile#77. It is ready to merge, and the board celebrates.",
		ref: mobile(77),
		change(before, at) {
			const pr = existing(before);
			const approval = reviewBy(barbara, "APPROVED", at, "m77b");
			return {
				...pr,
				reviewDecision: "APPROVED",
				decisiveReviews: [approval],
				latestReviews: [approval],
				threads: pr.threads.map((t) => ({ ...t, isResolved: true })),
				mergeStateStatus: "CLEAN",
			};
		},
	},
	{
		description: "CI finishes on atum/monorepo#4104. It moves from approved and blocked to ready to merge.",
		ref: monorepo(4104),
		change(before, at) {
			const pr = existing(before);
			return { ...pr, checks: pr.checks.map((check) => passing(check.name, check.completedAt ?? at)), mergeStateStatus: "CLEAN" };
		},
	},
	{
		description: "margaret requests changes on atum/monorepo#4110. The ball goes back to barbara.",
		ref: monorepo(4110),
		change(before, at) {
			const pr = existing(before);
			const changes = reviewBy(margaret, "CHANGES_REQUESTED", at, "a4110");
			return {
				...pr,
				reviewDecision: "CHANGES_REQUESTED",
				decisiveReviews: [changes],
				latestReviews: [changes],
				threads: [thread(margaret, at, { by: margaret, at })],
			};
		},
	},
	{
		description: "margaret merges atum/mobile#74. The card shows as merged, then leaves the board after 15 minutes.",
		ref: mobile(74),
		change: (before, at) => ({ ...existing(before), lifecycle: { kind: "merged", at } }),
	},
	{
		description: "ken opens atum/monorepo#4121 and requests a review from the payments team.",
		ref: monorepo(4121),
		change: (_before, at) =>
			pr({
				repo: "monorepo",
				number: 4121,
				title: "Record refunds in the ledger",
				author: ken,
				createdAt: at,
				head: "a4121",
				paths: ["services/billing/ledger.ts", "services/billing/refunds.ts"],
				reviewRequests: [teamRequest("payments", at)],
				checks: [running("build"), running("test")],
			}),
	},
	{
		description: "linus re-requests a review from ken on atum/monorepo#4098. It leaves likely ready and waits on ken in review.",
		ref: monorepo(4098),
		change: (before, at) => {
			const pr = existing(before);
			return { ...pr, reviewRequests: [...pr.reviewRequests, userRequest(ken, at)] };
		},
	},
];
