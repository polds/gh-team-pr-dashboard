import { describe, expect, test } from "vitest";
import { NO_FILTERS, applyFilters, filterOptions, isFiltering } from "../src/filters.ts";
import { card, person, team } from "./fixtures.ts";

const payments = team("payments", "Payments");
const platform = team("platform", "Platform");

const cards = [
	card(1, { repo: "web", title: "Add billing export", areas: ["services/billing"], requestedTeams: [payments] }),
	card(2, { repo: "api", title: "Fix login redirect", author: person("ken"), areas: ["services/auth"] }),
	card(412, { repo: "web", title: "Refresh the billing page", areas: ["services/billing", "apps/site"], requestedTeams: [platform] }),
];

const numbers = (filters: Parameters<typeof applyFilters>[1]) => applyFilters(cards, filters).map((c) => c.number);

describe("applyFilters", () => {
	test("no filters keeps every card", () => {
		expect(numbers(NO_FILTERS)).toEqual([1, 2, 412]);
		expect(isFiltering(NO_FILTERS)).toBe(false);
	});

	test("repository, area, and team each narrow the board", () => {
		expect(numbers({ ...NO_FILTERS, repo: "web" })).toEqual([1, 412]);
		expect(numbers({ ...NO_FILTERS, area: "services/billing" })).toEqual([1, 412]);
		expect(numbers({ ...NO_FILTERS, team: platform.slug })).toEqual([412]);
	});

	test("filters combine", () => {
		expect(numbers({ ...NO_FILTERS, repo: "web", team: payments.slug })).toEqual([1]);
		expect(numbers({ ...NO_FILTERS, repo: "api", area: "services/billing" })).toEqual([]);
	});

	test("text matches title, repo, number, and author, ignoring case", () => {
		expect(numbers({ ...NO_FILTERS, text: "BILLING" })).toEqual([1, 412]);
		expect(numbers({ ...NO_FILTERS, text: "api" })).toEqual([2]);
		expect(numbers({ ...NO_FILTERS, text: "#412" })).toEqual([412]);
		expect(numbers({ ...NO_FILTERS, text: "web#1" })).toEqual([1]);
		expect(numbers({ ...NO_FILTERS, text: "ken" })).toEqual([2]);
	});

	test("every word of the text must match", () => {
		expect(numbers({ ...NO_FILTERS, text: "billing page" })).toEqual([412]);
		expect(numbers({ ...NO_FILTERS, text: "  billing   ana " })).toEqual([1, 412]);
		expect(isFiltering({ ...NO_FILTERS, text: "   " })).toBe(false);
	});
});

describe("filterOptions", () => {
	test("offers each repository, area, and requested team once, sorted", () => {
		expect(filterOptions(cards)).toEqual({
			repos: ["api", "web"],
			areas: ["apps/site", "services/auth", "services/billing"],
			teams: [payments, platform],
		});
	});
});
