import { describe, expect, test } from "vitest";
import { parseBoard, parseEvent, parseSignalResponse } from "../src/api.ts";
import { board, card, person } from "./fixtures.ts";

describe("parseEvent", () => {
	test("reads the server's frame, which repeats the kind in the data", () => {
		const value = card(1);
		expect(parseEvent("card", JSON.stringify({ kind: "card", card: value }))).toEqual({ kind: "card", card: value });
		expect(parseEvent("remove", JSON.stringify({ kind: "remove", id: "PR_1" }))).toEqual({ kind: "remove", id: "PR_1" });
		expect(parseEvent("resync", "")).toEqual({ kind: "resync" });
	});

	test("the event name wins over a kind in the data", () => {
		expect(parseEvent("remove", JSON.stringify({ kind: "card", id: "PR_1" }))).toEqual({ kind: "remove", id: "PR_1" });
	});

	test("celebrate keeps who unblocked it, or nobody", () => {
		const body = { id: "PR_1", repo: "acme/web", number: 1, title: "Fix", by: person("ken") };
		expect(parseEvent("celebrate", JSON.stringify(body))).toEqual({ kind: "celebrate", ...body });
		expect(parseEvent("celebrate", JSON.stringify({ ...body, by: null }))).toMatchObject({ by: null });
	});

	test("unknown kinds, bad JSON, and cards this page cannot draw are dropped", () => {
		expect(parseEvent("ping", "{}")).toBeNull();
		expect(parseEvent("card", "{nope")).toBeNull();
		const future = { ...card(1), derived: { ...card(1).derived, state: "awaiting_robot" } };
		expect(parseEvent("card", JSON.stringify({ card: future }))).toBeNull();
	});
});

describe("parseBoard", () => {
	test("reads a board the server sends", () => {
		const value = board([card(1), card(2)]);
		expect(parseBoard(JSON.parse(JSON.stringify(value)))).toEqual(value);
	});

	test("a card it cannot read is left out, not the whole board", () => {
		const raw = JSON.parse(JSON.stringify(board([card(1), card(2)])));
		raw.cards[0].derived.court = "robots";
		expect(parseBoard(raw)?.cards.map((c) => c.number)).toEqual([2]);
	});

	test("a board without a viewer or time is not a board", () => {
		expect(parseBoard({ ...board([]), viewer: null })).toBeNull();
		expect(parseBoard({ ...board([]), serverTime: "yesterday" })).toBeNull();
		expect(parseBoard("<html>")).toBeNull();
	});
});

describe("parseSignalResponse", () => {
	test("reads each outcome", () => {
		expect(parseSignalResponse({ ok: true, wroteToGitHub: true })).toEqual({ ok: true, wroteToGitHub: true });
		for (const error of ["not_author", "not_found", "github_refused", "nothing_to_rerequest"] as const) {
			expect(parseSignalResponse({ ok: false, error })).toEqual({ ok: false, error });
		}
		expect(parseSignalResponse({ ok: false, error: "teapot" })).toBeNull();
	});
});
