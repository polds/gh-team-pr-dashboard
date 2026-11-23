import { asLogin, asPrId, asSha, asTeamSlug, isIsoTime } from "@radar/core";
import type { BoardResponse, Card, Derived, IsoTime, Person } from "@radar/core";

export function iso(value: string): IsoTime {
	if (!isIsoTime(value)) throw new Error(`not a time: ${value}`);
	return value;
}

export const NOW = new Date("2026-11-23T12:00:00Z");

export function hoursAgo(hours: number): IsoTime {
	return iso(new Date(NOW.getTime() - hours * 3_600_000).toISOString());
}

export function person(login: string): Person {
	return { login: asLogin(login), avatarUrl: `https://avatars.test/${login}`, isBot: false };
}

export const team = (slug: string, name: string) => ({ slug: asTeamSlug(slug), name });

export function derived(facts: Partial<Derived> = {}): Derived {
	return {
		state: "needs_review",
		court: "reviewers",
		sinceEstimate: hoursAgo(5),
		actors: [],
		reviewers: [],
		reasons: [{ kind: "no_reviewer_requested" }],
		blockers: [],
		confidence: null,
		...facts,
	};
}

export function card(number: number, facts: Partial<Card> = {}): Card {
	return {
		id: asPrId(`PR_${number}`),
		repo: "web",
		number,
		url: `https://github.com/acme/web/pull/${number}`,
		title: `Pull request ${number}`,
		author: person("ana"),
		isBotPr: false,
		labels: [],
		areas: [],
		requestedTeams: [],
		additions: 10,
		deletions: 2,
		headSha: asSha(`sha${number}`),
		checks: { verdict: "passing", failing: [], pending: [], total: 3 },
		derived: derived(),
		since: hoursAgo(5),
		priority: false,
		helpWanted: null,
		...facts,
	};
}

export function board(cards: Card[]): BoardResponse {
	return {
		viewer: { login: asLogin("mira"), avatarUrl: "https://avatars.test/mira", name: "Mira", teams: [] },
		config: { org: "acme", priorityLabels: ["priority"], helpWantedAfterBusinessHours: 8, rerequestEnabled: false, demo: false },
		cards,
		presence: [],
		heuristic: { confirmed: 0, rejected: 0 },
		serverTime: iso(NOW.toISOString()),
	};
}
