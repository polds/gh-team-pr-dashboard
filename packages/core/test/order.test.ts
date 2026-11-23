import { describe, expect, it } from "vitest";
import { LANES, compareCards, layoutBoard } from "../src/index.ts";
import type { Card, PrState } from "../src/index.ts";
import { card, hour } from "./builders.ts";

const numbers = (cards: Card[]) => cards.map((c) => c.number);
const inState = (number: number, state: PrState, facts: Partial<Card> = {}) => card({ number, derived: { state }, ...facts });

describe("LANES", () => {
	it("lists the six open states in board order", () => {
		expect(LANES.map((lane) => [lane.id, lane.title])).toEqual([
			["needs_review", "Needs review"],
			["in_review", "In review"],
			["changes_requested", "Author addressing"],
			["likely_ready_for_rereview", "Likely ready for re-review"],
			["approved_blocked", "Approved, blocked"],
			["ready_to_merge", "Ready to merge"],
		]);
	});
});

describe("compareCards", () => {
	it("puts priority first, then the longest wait, then repository and number", () => {
		const cards = [
			card({ number: 1, since: hour(5) }),
			card({ number: 2, since: hour(1) }),
			card({ number: 3, since: hour(9), priority: true }),
			card({ number: 4, since: hour(1), repo: "acme/api" }),
			card({ number: 0, since: hour(1) }),
		];
		expect(numbers([...cards].sort(compareCards))).toEqual([3, 4, 0, 2, 1]);
	});
});

describe("layoutBoard", () => {
	it("places each card once by state, keeps bots and drafts apart, and repeats help wanted in its lane", () => {
		const layout = layoutBoard([
			inState(1, "needs_review", { since: hour(3) }),
			inState(2, "needs_review", { since: hour(1), helpWanted: { suggested: [] } }),
			inState(3, "changes_requested"),
			inState(4, "draft"),
			inState(5, "needs_review", { isBotPr: true, helpWanted: { suggested: [] } }),
			inState(6, "merged"),
			inState(7, "closed"),
			inState(8, "merged", { isBotPr: true }),
		]);
		expect(numbers(layout.helpWanted)).toEqual([2]);
		expect(numbers(layout.lanes.needs_review)).toEqual([2, 1]);
		expect(numbers(layout.lanes.changes_requested)).toEqual([3]);
		expect(numbers(layout.lanes.in_review)).toEqual([]);
		expect(numbers(layout.drafts)).toEqual([4]);
		expect(numbers(layout.bots)).toEqual([5, 8]);
		expect(numbers(layout.done)).toEqual([6, 7]);
	});
});
