import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { asPrId, asSha } from "@radar/core";
import { systemClock } from "../src/clock.ts";
import { createStore } from "../src/store.ts";
import { iso, recordingLogger } from "./helpers.ts";

const PR = asPrId("PR_1");
const OTHER = asPrId("PR_2");
const SINCE = iso("2026-11-04T10:00:00.000Z");

describe("createStore", () => {
	let dir: string;
	let file: string;

	beforeEach(() => {
		vi.useFakeTimers();
		dir = mkdtempSync(join(tmpdir(), "radar-store-"));
		file = join(dir, "nested", "state.json");
	});

	afterEach(() => {
		vi.useRealTimers();
		rmSync(dir, { recursive: true, force: true });
	});

	const open = (logger = recordingLogger()) => createStore({ file, clock: systemClock, log: logger.log });

	it("starts empty and logs once when the file is missing", () => {
		const logger = recordingLogger();
		const store = open(logger);
		expect(store.signal(PR)).toBeNull();
		expect(store.stateEntry(PR)).toBeNull();
		expect(store.heuristic()).toEqual({ confirmed: 0, rejected: 0 });
		expect(logger.events()).toEqual(["store.empty"]);
	});

	it("keeps signals, state entries, and counters across a restart", () => {
		const store = open();
		store.setSignal(PR, { kind: "not_ready", headSha: asSha("abc"), at: SINCE });
		store.setStateEntry(PR, { state: "changes_requested", since: SINCE });
		store.count("confirmed");
		store.count("rejected");
		store.count("confirmed");
		store.flush();
		const reopened = open();
		expect(reopened.signal(PR)).toEqual({ kind: "not_ready", headSha: "abc", at: SINCE });
		expect(reopened.stateEntry(PR)).toEqual({ state: "changes_requested", since: SINCE });
		expect(reopened.heuristic()).toEqual({ confirmed: 2, rejected: 1 });
	});

	it("debounces writes and leaves no temporary file behind", () => {
		const store = open();
		store.setStateEntry(PR, { state: "in_review", since: SINCE });
		store.setStateEntry(OTHER, { state: "draft", since: SINCE });
		expect(() => readFileSync(file)).toThrow();
		vi.advanceTimersByTime(1000);
		expect(JSON.parse(readFileSync(file, "utf8")).states).toEqual({
			PR_1: { state: "in_review", since: SINCE },
			PR_2: { state: "draft", since: SINCE },
		});
		expect(readdirSync(join(dir, "nested"))).toEqual(["state.json"]);
	});

	it("starts empty and logs once when the file is corrupt", () => {
		mkdirSync(join(dir, "nested"));
		writeFileSync(file, "{ not json");
		const logger = recordingLogger();
		expect(open(logger).heuristic()).toEqual({ confirmed: 0, rejected: 0 });
		writeFileSync(file, JSON.stringify({ version: 1, signals: {}, states: { PR_1: { state: "bogus", since: SINCE } }, heuristic: { confirmed: 0, rejected: 0 } }));
		expect(open(logger).stateEntry(PR)).toBeNull();
		expect(logger.events()).toEqual(["store.corrupt", "store.corrupt"]);
	});

	it("forgets one pull request and retains only the given ones", () => {
		const store = open();
		store.setSignal(PR, { kind: "ready", headSha: asSha("abc"), at: SINCE });
		store.setStateEntry(PR, { state: "likely_ready_for_rereview", since: SINCE });
		store.setStateEntry(OTHER, { state: "draft", since: SINCE });
		store.forget(PR);
		expect(store.signal(PR)).toBeNull();
		expect(store.stateEntry(PR)).toBeNull();
		store.retain(new Set());
		expect(store.stateEntry(OTHER)).toBeNull();
	});

	it("keeps everything in memory when it has no file", () => {
		const store = createStore({ file: null, clock: systemClock, log: recordingLogger().log });
		store.count("confirmed");
		store.flush();
		expect(store.heuristic()).toEqual({ confirmed: 1, rejected: 0 });
		expect(vi.getTimerCount()).toBe(0);
	});
});
