import { describe, expect, it } from "vitest";
import type { CardConfig, PrSnapshot, ServerEvent } from "@radar/core";
import { createBoard } from "../src/board.ts";
import { systemClock } from "../src/clock.ts";
import { silentLogger } from "../src/log.ts";
import { createReconciler } from "../src/reconcile.ts";
import { createRefresher } from "../src/refresher.ts";
import { createStore } from "../src/store.ts";
import { hour, memorySource, snapshot } from "./builders.ts";
import { recordingLogger } from "./helpers.ts";

const CARD_CONFIG: CardConfig = { priorityLabels: [], helpWantedAfterBusinessHours: 24, timeZone: "UTC", botLogins: [] };

function setup(prs: PrSnapshot[], fullSweepEvery = 12) {
	const github = memorySource(prs);
	const board = createBoard({ org: "acme", store: createStore({ file: null, clock: systemClock, log: silentLogger }), cardConfig: CARD_CONFIG });
	const events: ServerEvent[] = [];
	const publish = (batch: ServerEvent[]) => events.push(...batch);
	const refresher = createRefresher({
		source: github.source,
		apply: (ref, pr) => publish(board.apply(ref, pr, systemClock.now())),
		clock: systemClock,
		log: silentLogger,
	});
	const logger = recordingLogger();
	const reconciler = createReconciler({ source: github.source, board, refresher, publish, clock: systemClock, log: logger.log, fullSweepEvery });
	return { github, board, events, reconciler, logger };
}

const one = snapshot({ number: 1 });
const two = snapshot({ number: 2 });

describe("reconciler", () => {
	it("builds the board from the open list and records the sweep time", async () => {
		const { board, events, reconciler } = setup([one, two]);
		expect(reconciler.lastSweepAt()).toBeNull();
		await reconciler.sweep();
		expect(board.cards().map((card) => card.number)).toEqual([1, 2]);
		expect(events.map((event) => event.kind)).toEqual(["card", "card"]);
		expect(reconciler.lastSweepAt()).not.toBeNull();
	});

	it("fetches a held pull request that left the open list, and the board shows it merged", async () => {
		const { github, board, reconciler } = setup([one, two]);
		await reconciler.sweep();
		github.set({ ...two, lifecycle: { kind: "merged", at: hour(3) } });
		github.fetches.length = 0;
		await reconciler.sweep();
		expect(github.fetches).toEqual([["acme/web#2"]]);
		expect(board.get(two.id)?.derived.state).toBe("merged");
		github.fetches.length = 0;
		await reconciler.sweep();
		expect(github.fetches).toEqual([]);
	});

	it("emits nothing and fetches nothing on a second sweep when nothing changed", async () => {
		const { github, events, reconciler } = setup([one, two]);
		await reconciler.sweep();
		events.length = 0;
		github.fetches.length = 0;
		await reconciler.sweep();
		expect(events).toEqual([]);
		expect(github.fetches).toEqual([]);
	});

	it("fetches only the pull request whose fingerprint moved", async () => {
		const { github, events, reconciler } = setup([one, two]);
		await reconciler.sweep();
		events.length = 0;
		github.fetches.length = 0;
		github.set({ ...one, title: "Retitled" });
		await reconciler.sweep();
		expect(github.fetches).toEqual([["acme/web#1"]]);
		expect(events.map((event) => event.kind)).toEqual(["card"]);
	});

	it("fetches everything on every full sweep, and still emits nothing when nothing changed", async () => {
		const { github, events, reconciler } = setup([one, two], 3);
		await reconciler.sweep();
		await reconciler.sweep();
		events.length = 0;
		github.fetches.length = 0;
		await reconciler.sweep();
		expect(github.fetches).toEqual([["acme/web#1", "acme/web#2"]]);
		expect(events).toEqual([]);
	});

	it("runs one sweep at a time and lets a caller join the one in flight", async () => {
		const { github, reconciler } = setup([one]);
		const release = github.hold();
		const first = reconciler.sweep();
		const second = reconciler.sweep();
		expect(second).toBe(first);
		await Promise.resolve();
		release();
		await Promise.all([first, second]);
		expect(github.lists()).toBe(1);
		await reconciler.sweep();
		expect(github.lists()).toBe(2);
	});

	it("logs a failed sweep and lets the next one run", async () => {
		const { github, reconciler, logger, board } = setup([one]);
		const listOpen = github.source.listOpen;
		github.source.listOpen = () => Promise.reject(new Error("GitHub is down"));
		await reconciler.sweep();
		expect(logger.lines.find((line) => line.event === "reconcile.failed")?.fields).toEqual({ error: "GitHub is down" });
		expect(reconciler.lastSweepAt()).toBeNull();
		github.source.listOpen = listOpen;
		await reconciler.sweep();
		expect(board.get(one.id)).toBeDefined();
	});
});
