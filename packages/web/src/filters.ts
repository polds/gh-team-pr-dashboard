import type { Card, TeamSlug } from "@radar/core";

export interface Filters {
	repo: string | null;
	area: string | null;
	team: TeamSlug | null;
	text: string;
}

export const NO_FILTERS: Filters = { repo: null, area: null, team: null, text: "" };

export function isFiltering(filters: Filters): boolean {
	return filters.repo !== null || filters.area !== null || filters.team !== null || filters.text.trim() !== "";
}

/** The cards that pass every filter. Each word of the text must appear in the title, repo, number, or author. */
export function applyFilters(cards: readonly Card[], filters: Filters): Card[] {
	const words = filters.text.toLowerCase().split(/\s+/).filter((word) => word !== "");
	return cards.filter(
		(card) =>
			(filters.repo === null || card.repo === filters.repo) &&
			(filters.area === null || card.areas.includes(filters.area)) &&
			(filters.team === null || card.requestedTeams.some((team) => team.slug === filters.team)) &&
			words.every((word) => searchText(card).includes(word)),
	);
}

function searchText(card: Card): string {
	return `${card.title} ${card.repo} #${card.number} ${card.repo}#${card.number} ${card.author.login}`.toLowerCase();
}

export interface FilterOptions {
	repos: string[];
	areas: string[];
	teams: { slug: TeamSlug; name: string }[];
}

export function filterOptions(cards: readonly Card[]): FilterOptions {
	const repos = new Set<string>();
	const areas = new Set<string>();
	const teams = new Map<TeamSlug, string>();
	for (const card of cards) {
		repos.add(card.repo);
		for (const area of card.areas) areas.add(area);
		for (const team of card.requestedTeams) teams.set(team.slug, team.name);
	}
	const byText = (a: string, b: string) => a.localeCompare(b);
	return {
		repos: [...repos].sort(byText),
		areas: [...areas].sort(byText),
		teams: [...teams].map(([slug, name]) => ({ slug, name })).sort((a, b) => byText(a.name, b.name)),
	};
}
