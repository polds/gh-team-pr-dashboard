import { describe, expect, test } from "vitest";
import { asPrId } from "@radar/core";
import type { Card, ServerEvent } from "@radar/core";
import { INITIAL_STATE, MAX_TOASTS, reduce } from "../src/state.ts";
import type { Action, ClientState } from "../src/state.ts";
import { NOW, board, card, derived, person } from "./fixtures.ts";

function run(...actions: Action[]): ClientState {
	return actions.reduce(reduce, INITIAL_STATE);
}

const loaded = (cards: Card[]): Action => ({ type: "loaded", board: board(cards), receivedAtMs: NOW.getTime() });
const event = (value: ServerEvent): Action => ({ type: "event", event: value });
const celebrate = (number: number): ServerEvent => ({
	kind: "celebrate",
	id: asPrId(`PR_${number}`),
	repo: "web",
	number,
	title: `Pull request ${number}`,
	by: person("ken"),
});

function ready(state: ClientState) {
	if (state.status !== "ready") throw new Error(`expected ready, got ${state.status}`);
	return state;
}

const numbers = (state: ClientState) => [...ready(state).cards.values()].map((c) => c.number);

describe("loading the board", () => {
	test("starts loading, then holds the board's cards by id", () => {
		expect(INITIAL_STATE.status).toBe("loading");
		const state = ready(run({ type: "load_started" }, loaded([card(1), card(2)])));
		expect(state.board.viewer.login).toBe("mira");
		expect(state.cards.get(asPrId("PR_2"))?.number).toBe(2);
		expect(state.inFlight).toBeNull();
	});

	test("a 401 shows the sign-in screen with the server's login URL", () => {
		const state = run({ type: "load_started" }, { type: "signed_out", loginUrl: "/auth/login" });
		expect(state).toMatchObject({ status: "signed_out", loginUrl: "/auth/login" });
	});

	test("a failed first load is an error that a retry clears", () => {
		const failed = run({ type: "load_started" }, { type: "load_failed", message: "The server answered 502." });
		expect(failed).toMatchObject({ status: "error", message: "The server answered 502." });
		expect(reduce(failed, { type: "load_started" }).status).toBe("loading");
	});

	test("a failed reload keeps the board on screen", () => {
		const state = run(loaded([card(1)]), { type: "load_started" }, { type: "load_failed", message: "x" });
		expect(numbers(state)).toEqual([1]);
	});

	test("the server clock offset is kept so time in state does not drift", () => {
		const state = ready(run({ type: "loaded", board: board([]), receivedAtMs: NOW.getTime() - 90_000 }));
		expect(state.clockOffsetMs).toBe(90_000);
	});
});

describe("server events", () => {
	test("card replaces the card with the same id", () => {
		const moved = card(1, { derived: derived({ state: "in_review" }) });
		const state = ready(run(loaded([card(1), card(2)]), event({ kind: "card", card: moved })));
		expect(state.cards.get(moved.id)?.derived.state).toBe("in_review");
		expect(state.cards.size).toBe(2);
	});

	test("card for a pull request the board does not hold adds it", () => {
		expect(numbers(run(loaded([card(1)]), event({ kind: "card", card: card(9) })))).toEqual([1, 9]);
	});

	test("remove deletes the card", () => {
		expect(numbers(run(loaded([card(1), card(2)]), event({ kind: "remove", id: asPrId("PR_1") })))).toEqual([2]);
	});

	test("remove of an unknown id changes nothing", () => {
		const before = run(loaded([card(1)]));
		expect(reduce(before, { type: "event", event: { kind: "remove", id: asPrId("PR_404") } })).toBe(before);
	});

	test("presence replaces the list", () => {
		const presence = [{ person: person("ken"), viewing: asPrId("PR_1") }];
		const state = ready(run(loaded([card(1)]), event({ kind: "presence", presence })));
		expect(state.presence).toEqual(presence);
	});

	test("celebrate adds one toast per pull request, and the newest few stay", () => {
		const state = run(loaded([]), event(celebrate(1)), event(celebrate(2)), event(celebrate(1)));
		expect(state.toasts.map((t) => t.number)).toEqual([2, 1]);
		const many = run(loaded([]), ...[1, 2, 3, 4, 5].map((n) => event(celebrate(n))));
		expect(many.toasts.map((t) => t.number)).toEqual([5 - MAX_TOASTS + 1, 4, 5]);
	});

	test("a toast leaves when it expires", () => {
		const state = run(loaded([]), event(celebrate(1)), { type: "toast_expired", id: asPrId("PR_1") });
		expect(state.toasts).toEqual([]);
	});

	test("resync leaves state alone; the page reloads the board instead", () => {
		const before = run(loaded([card(1)]));
		expect(reduce(before, { type: "event", event: { kind: "resync" } })).toBe(before);
	});

	test("connection changes are tracked", () => {
		expect(run({ type: "connection", connection: "reconnecting" }).connection).toBe("reconnecting");
	});
});

describe("events that race a board load", () => {
	test("events that arrive before the first load lands are replayed onto it", () => {
		const fresh = card(1, { derived: derived({ state: "approved_blocked" }) });
		const state = ready(
			run(
				{ type: "load_started" },
				event({ kind: "card", card: fresh }),
				event({ kind: "card", card: card(7) }),
				event({ kind: "remove", id: asPrId("PR_2") }),
				loaded([card(1), card(2)]),
			),
		);
		expect(state.cards.get(fresh.id)?.derived.state).toBe("approved_blocked");
		expect([...state.cards.keys()]).toEqual([asPrId("PR_1"), asPrId("PR_7")]);
	});

	test("during a reload events still apply at once", () => {
		const state = run(loaded([card(1)]), { type: "load_started" }, event({ kind: "card", card: card(3) }));
		expect(numbers(state)).toEqual([1, 3]);
	});

	test("events from before the load started are not replayed", () => {
		const state = run(loaded([card(1)]), event({ kind: "card", card: card(5) }), { type: "load_started" }, loaded([card(1)]));
		expect(numbers(state)).toEqual([1]);
	});
});
