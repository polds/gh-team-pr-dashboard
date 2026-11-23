import { asLogin, asPrId, asSha } from "@radar/core";
import type { IsoTime, Person, PrSnapshot, Review, ReviewState } from "@radar/core";
import type { OpenPr, PrRef, PullRequestSource, TeamInfo } from "../src/github/source.ts";
import { refKey } from "../src/github/source.ts";
import { iso } from "./helpers.ts";

export function person(login: string, isBot = false): Person {
	return { login: asLogin(login), avatarUrl: `https://avatars.test/${login}`, isBot };
}

/** `n` hours after 2026-11-02T17:00:00Z, a Monday at 09:00 in Los Angeles. */
export function hour(n: number): IsoTime {
	return iso(new Date(Date.parse("2026-11-02T17:00:00Z") + n * 3_600_000).toISOString());
}

export function review(reviewer: Person, state: ReviewState, submittedAt: IsoTime, commitSha = "c1"): Review {
	return { reviewer, state, submittedAt, commitSha: asSha(commitSha) };
}

export function refOf(snapshot: PrSnapshot): PrRef {
	return { owner: snapshot.repo.owner, name: snapshot.repo.name, number: snapshot.number };
}

export function snapshot(facts: Partial<PrSnapshot> & { number?: number } = {}): PrSnapshot {
	const number = facts.number ?? 1;
	return {
		id: asPrId(`PR_${number}`),
		repo: { owner: "acme", name: "web" },
		number,
		url: `https://github.com/acme/web/pull/${number}`,
		title: `Change ${number}`,
		author: person("ana"),
		lifecycle: { kind: "open" },
		isDraft: false,
		createdAt: hour(0),
		readyAt: null,
		draftedAt: null,
		headSha: asSha("c1"),
		headCommittedAt: hour(0),
		baseRef: "main",
		labels: [],
		paths: ["src/index.ts"],
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

/** A pull request source over a mutable map, recording every call. A ref in `failing` is left out of fetch results. */
export function memorySource(initial: PrSnapshot[] = [], teams: TeamInfo[] = []) {
	const prs = new Map(initial.map((pr) => [refKey(refOf(pr)), pr]));
	const failing = new Set<string>();
	const fetches: string[][] = [];
	let lists = 0;
	let gate: Promise<void> | null = null;

	const source: PullRequestSource = {
		async listOpen(): Promise<OpenPr[]> {
			lists += 1;
			if (gate !== null) await gate;
			return [...prs.values()]
				.filter((pr) => pr.lifecycle.kind === "open")
				.map((pr) => ({ ...refOf(pr), fingerprint: JSON.stringify(pr) }));
		},
		async fetch(refs) {
			fetches.push(refs.map(refKey));
			const result = new Map<string, PrSnapshot | null>();
			for (const ref of refs) {
				const key = refKey(ref);
				if (!failing.has(key)) result.set(key, prs.get(key) ?? null);
			}
			return result;
		},
		teams: async () => teams,
	};

	return {
		source,
		fetches,
		lists: () => lists,
		failing,
		set(pr: PrSnapshot) {
			prs.set(refKey(refOf(pr)), pr);
		},
		delete(ref: PrRef) {
			prs.delete(refKey(ref));
		},
		/** Holds every `listOpen` call until the returned function runs. */
		hold(): () => void {
			let release = () => {};
			gate = new Promise((resolve) => {
				release = () => {
					gate = null;
					resolve();
				};
			});
			return release;
		},
	};
}

export const bob = person("bob");

/** Ana's pull request through one review round with bob. */
export const requestedPr = snapshot({ reviewRequests: [{ kind: "user", reviewer: bob, asCodeOwner: false, requestedAt: hour(0) }] });
export const changesRequestedPr = snapshot({
	reviewDecision: "CHANGES_REQUESTED",
	decisiveReviews: [review(bob, "CHANGES_REQUESTED", hour(2))],
	latestReviews: [review(bob, "CHANGES_REQUESTED", hour(2))],
});
export const likelyReadyPr: PrSnapshot = { ...changesRequestedPr, headSha: asSha("c2"), headCommittedAt: hour(3) };
export const approvedPr: PrSnapshot = {
	...likelyReadyPr,
	reviewDecision: "APPROVED",
	decisiveReviews: [review(bob, "APPROVED", hour(4), "c2")],
	latestReviews: [review(bob, "APPROVED", hour(4), "c2")],
};
