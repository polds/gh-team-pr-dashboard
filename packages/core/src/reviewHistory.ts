import { areasOf, isBotAuthor } from "./card.ts";
import type { Login, Person, PrSnapshot, TeamSlug } from "./model.ts";

/** When each person last reviewed each area of each repository. */
export interface ReviewHistory {
	readonly lastReviewed: Map<string, Map<string, Map<Login, number>>>;
}

export function emptyHistory(): ReviewHistory {
	return { lastReviewed: new Map() };
}

const repoOf = (snapshot: PrSnapshot) => `${snapshot.repo.owner}/${snapshot.repo.name}`;

function entry<K, V>(map: Map<K, V>, key: K, create: () => V): V {
	const found = map.get(key);
	if (found !== undefined) return found;
	const created = create();
	map.set(key, created);
	return created;
}

function keepLatest(times: Map<Login, number>, login: Login, at: number): void {
	times.set(login, Math.max(times.get(login) ?? at, at));
}

export function recordReviews(history: ReviewHistory, snapshot: PrSnapshot): void {
	const reviewedAt = new Map<Login, number>();
	for (const { reviewer, submittedAt } of [...snapshot.decisiveReviews, ...snapshot.latestReviews]) {
		if (reviewer.isBot || reviewer.login === snapshot.author.login) continue;
		keepLatest(reviewedAt, reviewer.login, Date.parse(submittedAt));
	}
	if (reviewedAt.size === 0) return;
	const areas = entry(history.lastReviewed, repoOf(snapshot), () => new Map<string, Map<Login, number>>());
	for (const area of areasOf(snapshot.paths)) {
		const reviewers = entry(areas, area, () => new Map<Login, number>());
		for (const [login, at] of reviewedAt) keepLatest(reviewers, login, at);
	}
}

export function suggestReviewers(input: {
	snapshot: PrSnapshot;
	history: ReviewHistory;
	teams: ReadonlyMap<TeamSlug, readonly Login[]>;
	people: ReadonlyMap<Login, Person>;
	limit: number;
}): Person[] {
	const { snapshot, history, teams, people, limit } = input;
	const involved = new Set<Login>([
		snapshot.author.login,
		...snapshot.reviewRequests.flatMap((r) => (r.kind === "user" ? [r.reviewer.login] : [])),
		...[...snapshot.decisiveReviews, ...snapshot.latestReviews].map((r) => r.reviewer.login),
		...snapshot.threads.map((t) => t.startedBy.login),
	]);
	const areas = history.lastReviewed.get(repoOf(snapshot));
	const lastReviewed = new Map<Login, number>();
	for (const area of areasOf(snapshot.paths)) {
		for (const [login, at] of areas?.get(area) ?? []) keepLatest(lastReviewed, login, at);
	}
	const recentReviewers = [...lastReviewed].sort(([, a], [, b]) => b - a).map(([login]) => login);
	const teamMembers = snapshot.reviewRequests.flatMap((r) => (r.kind === "team" ? (teams.get(r.slug) ?? []) : []));
	const suggested: Person[] = [];
	for (const login of new Set([...recentReviewers, ...teamMembers])) {
		if (suggested.length >= limit) break;
		const person = people.get(login);
		if (person !== undefined && !involved.has(login) && !isBotAuthor(person, [])) suggested.push(person);
	}
	return suggested;
}
