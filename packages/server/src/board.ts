import { isDeepStrictEqual } from "node:util";
import { buildCard, derive, emptyHistory, isBotAuthor, isIsoTime, recordReviews, suggestReviewers } from "@radar/core";
import type {
	AuthorSignal,
	Card,
	CardConfig,
	Derived,
	HeuristicStats,
	IsoTime,
	Login,
	Person,
	PrId,
	PrSnapshot,
	Review,
	ServerEvent,
	Sha,
	TeamSlug,
} from "@radar/core";
import { refKey } from "./github/source.ts";
import type { PrRef, TeamInfo } from "./github/source.ts";
import type { Store } from "./store.ts";

export interface HeldPr {
	ref: PrRef;
	snapshot: PrSnapshot;
	derived: Derived;
	card: Card;
}

interface Entry extends HeldPr {
	/** When this server first saw the pull request merged or closed. Null while it is open. */
	endedSeenAt: number | null;
	/** True once the current `likely_ready_for_rereview` spell has counted toward the heuristic. */
	outcomeCounted: boolean;
}

export interface Board {
	/** Derives and builds the card, and returns the events to broadcast. A null snapshot means the pull request is gone. */
	apply(ref: PrRef, snapshot: PrSnapshot | null, now: Date): ServerEvent[];
	/** Rebuilds every card for the new time, and drops merged and closed pull requests that have lingered long enough. */
	tick(now: Date): ServerEvent[];
	setTeams(teams: TeamInfo[], now: Date): ServerEvent[];
	/** Stores the author's signal against the held head SHA, or clears it, and re-applies the pull request. */
	setSignal(id: PrId, kind: AuthorSignal["kind"] | null, now: Date): ServerEvent[];
	/** The author re-requested review on GitHub through Radar. */
	noteRerequest(id: PrId): void;
	get(id: PrId): HeldPr | undefined;
	cards(): Card[];
	openRefs(): PrRef[];
	refsForSha(repo: { owner: string; name: string }, sha: Sha): PrRef[];
	teamsOf(login: Login): { slug: TeamSlug; name: string }[];
	heuristic(): HeuristicStats;
	/** Drops stored records of pull requests the board no longer holds. */
	pruneStore(): void;
}

export const ENDED_LINGER_MS = 15 * 60_000;
const SUGGESTIONS = 3;

function refOf(snapshot: PrSnapshot): PrRef {
	return { owner: snapshot.repo.owner, name: snapshot.repo.name, number: snapshot.number };
}

const isHeuristicLikelyReady = (derived: Derived) =>
	derived.state === "likely_ready_for_rereview" && derived.confidence !== "confirmed";

function reviewsOf(snapshot: PrSnapshot): Review[] {
	return [...snapshot.decisiveReviews, ...snapshot.latestReviews];
}

export function createBoard({ store, cardConfig }: { store: Store; cardConfig: CardConfig }): Board {
	const entries = new Map<PrId, Entry>();
	const history = emptyHistory();
	const people = new Map<Login, Person>();
	let teamInfos: TeamInfo[] = [];
	let teamMembers: ReadonlyMap<TeamSlug, readonly Login[]> = new Map();

	function learn(person: Person): void {
		people.set(person.login, person);
	}

	function learnPeople(snapshot: PrSnapshot): void {
		learn(snapshot.author);
		for (const review of reviewsOf(snapshot)) learn(review.reviewer);
		for (const request of snapshot.reviewRequests) if (request.kind === "user") learn(request.reviewer);
	}

	function remove(id: PrId): ServerEvent[] {
		store.forget(id);
		return entries.delete(id) ? [{ kind: "remove", id }] : [];
	}

	function currentSignal(snapshot: PrSnapshot): AuthorSignal | null {
		const signal = store.signal(snapshot.id);
		if (signal === null || signal.headSha === snapshot.headSha) return signal;
		store.setSignal(snapshot.id, null);
		return null;
	}

	function sinceFor(id: PrId, held: Entry | undefined, derived: Derived, now: Date): IsoTime {
		if (held !== undefined) return held.derived.state === derived.state ? held.card.since : nowIso(now);
		const stored = store.stateEntry(id);
		return stored?.state === derived.state ? stored.since : derived.sinceEstimate;
	}

	function card(snapshot: PrSnapshot, derived: Derived, since: IsoTime, now: Date): Card {
		const suggested = suggestReviewers({ snapshot, history, teams: teamMembers, people, limit: SUGGESTIONS });
		return buildCard({ snapshot, derived, since, now, config: cardConfig, suggested });
	}

	/** Human reviews in `snapshot` newer than every review the board held, newest first. */
	function newReviews(held: Entry, snapshot: PrSnapshot): Review[] {
		const seen = Math.max(Number.NEGATIVE_INFINITY, ...reviewsOf(held.snapshot).map((review) => Date.parse(review.submittedAt)));
		return reviewsOf(snapshot)
			.filter(
				(review) =>
					Date.parse(review.submittedAt) > seen &&
					review.reviewer.login !== snapshot.author.login &&
					!isBotAuthor(review.reviewer, cardConfig.botLogins),
			)
			.sort((a, b) => Date.parse(b.submittedAt) - Date.parse(a.submittedAt));
	}

	function countOutcome(entry: Entry, outcome: keyof HeuristicStats): void {
		if (!isHeuristicLikelyReady(entry.derived) || entry.outcomeCounted) return;
		store.count(outcome);
		entry.outcomeCounted = true;
	}

	function apply(ref: PrRef, snapshot: PrSnapshot | null, now: Date): ServerEvent[] {
		if (snapshot === null) {
			const key = refKey(ref);
			const held = [...entries.values()].find((entry) => refKey(entry.ref) === key);
			return held === undefined ? [] : remove(held.snapshot.id);
		}
		const { id } = snapshot;
		const held = entries.get(id);
		const ended = snapshot.lifecycle.kind !== "open";
		if (ended && held === undefined) return [];
		const endedSeenAt = ended ? (held?.endedSeenAt ?? now.getTime()) : null;
		if (endedSeenAt !== null && now.getTime() - endedSeenAt >= ENDED_LINGER_MS) return remove(id);

		learnPeople(snapshot);
		recordReviews(history, snapshot);
		const derived = derive(snapshot, { teams: teamMembers, authorSignal: currentSignal(snapshot) });
		const since = sinceFor(id, held, derived, now);
		const built = card(snapshot, derived, since, now);
		const events: ServerEvent[] = [];
		if (held === undefined || !isDeepStrictEqual(held.card, built)) events.push({ kind: "card", card: built });

		const fresh = held === undefined ? [] : newReviews(held, snapshot);
		const [newest] = fresh;
		if (held !== undefined && newest !== undefined && held.derived.court === "reviewers" && derived.court !== "reviewers") {
			events.push({ kind: "celebrate", id, repo: built.repo, number: snapshot.number, title: snapshot.title, by: newest.reviewer });
		}
		if (held !== undefined && fresh.some((review) => held.derived.actors.some((actor) => actor.login === review.reviewer.login))) {
			countOutcome(held, "confirmed");
		}

		const sameSpell = derived.state === "likely_ready_for_rereview" && held?.derived.state === "likely_ready_for_rereview";
		entries.set(id, {
			ref: refOf(snapshot),
			snapshot,
			derived,
			card: built,
			endedSeenAt,
			outcomeCounted: sameSpell && held.outcomeCounted,
		});
		if (!ended) store.setStateEntry(id, { state: derived.state, since });
		return events;
	}

	return {
		apply,

		tick(now) {
			const events: ServerEvent[] = [];
			for (const entry of [...entries.values()]) {
				const { id } = entry.snapshot;
				if (entry.endedSeenAt !== null && now.getTime() - entry.endedSeenAt >= ENDED_LINGER_MS) {
					events.push(...remove(id));
					continue;
				}
				const rebuilt = card(entry.snapshot, entry.derived, entry.card.since, now);
				if (isDeepStrictEqual(rebuilt, entry.card)) continue;
				entries.set(id, { ...entry, card: rebuilt });
				events.push({ kind: "card", card: rebuilt });
			}
			return events;
		},

		setTeams(teams, now) {
			teamInfos = teams;
			for (const team of teams) for (const member of team.members) if (!people.has(member.login)) learn(member);
			const next = new Map(teams.map((team) => [team.slug, team.members.map((member) => member.login)]));
			if (isDeepStrictEqual(next, teamMembers)) return [];
			teamMembers = next;
			return [...entries.values()].flatMap((entry) => apply(entry.ref, entry.snapshot, now));
		},

		setSignal(id, kind, now) {
			const held = entries.get(id);
			if (held === undefined) return [];
			const signal = kind === null ? null : { kind, headSha: held.snapshot.headSha };
			const prior = store.signal(id);
			if (prior?.kind === signal?.kind && (signal === null || prior?.headSha === signal.headSha)) return [];
			if (kind !== null) countOutcome(held, kind === "ready" ? "confirmed" : "rejected");
			store.setSignal(id, signal);
			return apply(held.ref, held.snapshot, now);
		},

		noteRerequest(id) {
			const held = entries.get(id);
			if (held !== undefined) countOutcome(held, "confirmed");
		},

		get: (id) => entries.get(id),
		cards: () => [...entries.values()].map((entry) => entry.card),
		openRefs: () => [...entries.values()].filter((entry) => entry.snapshot.lifecycle.kind === "open").map((entry) => entry.ref),
		refsForSha: (repo, sha) =>
			[...entries.values()]
				.filter(({ snapshot }) => snapshot.headSha === sha && snapshot.repo.owner === repo.owner && snapshot.repo.name === repo.name)
				.map((entry) => entry.ref),
		teamsOf: (login) => teamInfos.filter((team) => team.members.some((member) => member.login === login)).map(({ slug, name }) => ({ slug, name })),
		heuristic: () => store.heuristic(),
		pruneStore: () => store.retain(new Set(entries.keys())),
	};
}

export function nowIso(now: Date): IsoTime {
	const value = now.toISOString();
	if (!isIsoTime(value)) throw new Error(`Date produced a non-ISO string: ${value}`);
	return value;
}
