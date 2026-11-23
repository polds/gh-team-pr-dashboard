import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { asPrId } from "@radar/core";
import { systemClock } from "../src/clock.ts";
import { createHub } from "../src/hub.ts";
import { createPresence } from "../src/presence.ts";
import type { PresenceEntry } from "@radar/core";
import { person } from "./builders.ts";

async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
	const { value } = await reader.read();
	return new TextDecoder().decode(value);
}

describe("createHub", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("starts each stream with resync, then sends broadcasts and a keep-alive comment", async () => {
		const hub = createHub({ clock: systemClock });
		const reader = hub.open().getReader();
		expect(await readChunk(reader)).toBe('event: resync\ndata: {"kind":"resync"}\n\n');
		hub.broadcast({ kind: "remove", id: asPrId("PR_1") });
		expect(await readChunk(reader)).toBe('event: remove\ndata: {"kind":"remove","id":"PR_1"}\n\n');
		await vi.advanceTimersByTimeAsync(25_000);
		expect(await readChunk(reader)).toBe(": keep-alive\n\n");
		hub.close();
		await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
	});

	it("forgets a stream the client cancelled", async () => {
		const hub = createHub({ clock: systemClock });
		const stream = hub.open();
		expect(hub.subscribers()).toBe(1);
		await stream.cancel();
		expect(hub.subscribers()).toBe(0);
		hub.close();
	});
});

describe("createPresence", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("announces joins, moves, and leaves, but not a heartbeat that changes nothing", () => {
		const changes: PresenceEntry[][] = [];
		const presence = createPresence({ clock: systemClock, onChange: (list) => changes.push(list) });
		const ada = person("ada");
		presence.heartbeat(ada, { viewing: null, active: true });
		presence.heartbeat(ada, { viewing: null, active: true });
		presence.heartbeat(ada, { viewing: asPrId("PR_1"), active: true });
		presence.heartbeat(ada, { viewing: null, active: false });
		expect(changes).toEqual([[{ person: ada, viewing: null }], [{ person: ada, viewing: "PR_1" }], []]);
		presence.stop();
	});

	it("drops an entry 45 seconds after its last heartbeat, swept every 10 seconds", async () => {
		const changes: PresenceEntry[][] = [];
		const presence = createPresence({ clock: systemClock, onChange: (list) => changes.push(list) });
		presence.heartbeat(person("ada"), { viewing: null, active: true });
		await vi.advanceTimersByTimeAsync(40_000);
		expect(presence.list()).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(presence.list()).toEqual([]);
		expect(changes.at(-1)).toEqual([]);
		presence.stop();
	});
});
