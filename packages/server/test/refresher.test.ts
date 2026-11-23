import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrSnapshot } from "@radar/core";
import { systemClock } from "../src/clock.ts";
import { refKey } from "../src/github/source.ts";
import type { PrRef } from "../src/github/source.ts";
import { createRefresher } from "../src/refresher.ts";
import { memorySource, refOf, snapshot } from "./builders.ts";
import { recordingLogger } from "./helpers.ts";

describe("createRefresher", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	function setup(prs: PrSnapshot[] = [snapshot({ number: 1 }), snapshot({ number: 2 })]) {
		const github = memorySource(prs);
		const applied: { key: string; at: number; snapshot: PrSnapshot | null }[] = [];
		const refresher = createRefresher({
			source: github.source,
			apply: (ref, pr) => applied.push({ key: refKey(ref), at: Date.now(), snapshot: pr }),
			clock: systemClock,
			log: recordingLogger().log,
		});
		return { github, applied, refresher, refs: prs.map(refOf) };
	}

	it("turns 30 marks for one pull request within a second into one fetch", async () => {
		const { github, applied, refresher, refs } = setup();
		const [first] = refs;
		if (first === undefined) throw new Error("no ref");
		for (let i = 0; i < 30; i += 1) {
			refresher.mark(first);
			await vi.advanceTimersByTimeAsync(33);
		}
		await vi.advanceTimersByTimeAsync(10_000);
		expect(github.fetches).toEqual([["acme/web#1"]]);
		expect(applied.map((entry) => entry.key)).toEqual(["acme/web#1"]);
	});

	it("fetches within 5 seconds of the first mark while marks keep coming", async () => {
		const { github, applied, refresher, refs } = setup();
		const [first] = refs;
		if (first === undefined) throw new Error("no ref");
		const start = Date.now();
		for (let i = 0; i < 20; i += 1) {
			refresher.mark(first);
			await vi.advanceTimersByTimeAsync(500);
		}
		expect(github.fetches.length).toBeGreaterThanOrEqual(1);
		expect(applied[0]?.at).toBe(start + 5000);
	});

	it("fetches refs that come due together in one call", async () => {
		const { github, refresher, refs } = setup();
		for (const ref of refs) refresher.mark(ref);
		await vi.advanceTimersByTimeAsync(1500);
		expect(github.fetches).toEqual([["acme/web#1", "acme/web#2"]]);
	});

	it("retries a ref that failed to load once, after 30 seconds, then leaves it", async () => {
		const { github, applied, refresher, refs } = setup();
		const [first] = refs;
		if (first === undefined) throw new Error("no ref");
		github.failing.add(refKey(first));
		refresher.mark(first);
		await vi.advanceTimersByTimeAsync(1500);
		expect(github.fetches).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(29_999);
		expect(github.fetches).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(github.fetches).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(600_000);
		expect(github.fetches).toHaveLength(2);
		expect(applied).toEqual([]);
	});

	it("applies a pull request that no longer exists as null", async () => {
		const { github, applied, refresher, refs } = setup();
		const [first] = refs;
		if (first === undefined) throw new Error("no ref");
		github.delete(first);
		refresher.mark(first);
		await vi.advanceTimersByTimeAsync(1500);
		expect(applied).toEqual([expect.objectContaining({ key: "acme/web#1", snapshot: null })]);
	});

	it("does not let an older fetch overwrite a newer one that finished first", async () => {
		const older = snapshot({ number: 1, title: "older" });
		const newer = snapshot({ number: 1, title: "newer" });
		const releases: (() => void)[] = [];
		const answers = [older, newer];
		const applied: string[] = [];
		const refresher = createRefresher({
			source: {
				fetch: (refs: PrRef[]) => {
					const answer = answers.shift();
					return new Promise((resolve) => releases.push(() => resolve(new Map(refs.map((ref) => [refKey(ref), answer ?? null])))));
				},
			},
			apply: (_ref, pr) => applied.push(pr?.title ?? "gone"),
			clock: systemClock,
			log: recordingLogger().log,
		});
		const slow = refresher.fetchNow([refOf(older)]);
		const fast = refresher.fetchNow([refOf(newer)]);
		releases[1]?.();
		await fast;
		releases[0]?.();
		await slow;
		expect(applied).toEqual(["newer"]);
	});

	it("reports refs that failed in fetchNow without retrying them", async () => {
		const { github, refresher, refs } = setup();
		const [first, second] = refs;
		if (first === undefined || second === undefined) throw new Error("no ref");
		github.failing.add(refKey(second));
		await expect(refresher.fetchNow([first, second])).resolves.toEqual([second]);
		await vi.advanceTimersByTimeAsync(600_000);
		expect(github.fetches).toHaveLength(1);
	});
});
