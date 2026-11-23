import { businessHoursBetween } from "./businessHours.ts";
import type { Check, Derived, IsoTime, Person, PrSnapshot } from "./model.ts";
import type { Card } from "./protocol.ts";

export interface CardConfig {
	priorityLabels: string[];
	helpWantedAfterBusinessHours: number;
	timeZone: string;
	botLogins: string[];
}

const MAX_AREAS = 6;

export function areasOf(paths: string[]): string[] {
	const counts = new Map<string, number>();
	for (const path of paths) {
		const directories = path.split("/").slice(0, -1);
		const area = directories.length === 0 ? "(root)" : directories.slice(0, 2).join("/");
		counts.set(area, (counts.get(area) ?? 0) + 1);
	}
	return [...counts]
		.sort(([, a], [, b]) => b - a)
		.slice(0, MAX_AREAS)
		.map(([area]) => area);
}

export function isBotAuthor(person: Person, botLogins: readonly string[]): boolean {
	const login = person.login.toLowerCase();
	return person.isBot || login.endsWith("[bot]") || botLogins.some((bot) => bot.toLowerCase() === login);
}

function checkSummary(checks: Check[]): Card["checks"] {
	const failing = checks.filter((c) => c.verdict === "failing").map((c) => c.name);
	const pending = checks.filter((c) => c.verdict === "pending").map((c) => c.name);
	const verdict = checks.length === 0 ? "none" : failing.length > 0 ? "failing" : pending.length > 0 ? "pending" : "passing";
	return { verdict, failing, pending, total: checks.length };
}

export function buildCard(input: {
	snapshot: PrSnapshot;
	derived: Derived;
	since: IsoTime;
	now: Date;
	config: CardConfig;
	suggested: Person[];
}): Card {
	const { snapshot, derived, since, now, config } = input;
	const isBotPr = isBotAuthor(snapshot.author, config.botLogins);
	const priorityLabels = new Set(config.priorityLabels.map((label) => label.toLowerCase()));
	const waitingOnReviewers = derived.court === "reviewers" && !isBotPr;
	return {
		id: snapshot.id,
		repo: `${snapshot.repo.owner}/${snapshot.repo.name}`,
		number: snapshot.number,
		url: snapshot.url,
		title: snapshot.title,
		author: snapshot.author,
		isBotPr,
		labels: snapshot.labels,
		areas: areasOf(snapshot.paths),
		requestedTeams: snapshot.reviewRequests.flatMap((r) => (r.kind === "team" ? [{ slug: r.slug, name: r.name }] : [])),
		additions: snapshot.additions,
		deletions: snapshot.deletions,
		headSha: snapshot.headSha,
		checks: checkSummary(snapshot.checks),
		derived,
		since,
		priority: snapshot.labels.some((label) => priorityLabels.has(label.toLowerCase())),
		helpWanted:
			waitingOnReviewers && businessHoursBetween(new Date(since), now, config.timeZone) > config.helpWantedAfterBusinessHours
				? { suggested: input.suggested }
				: null,
	};
}
