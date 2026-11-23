import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openEventStream } from "../src/stream.ts";

class FakeEventSource {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSED = 2;
	static opened: FakeEventSource[] = [];
	readyState = FakeEventSource.CONNECTING;
	onopen: (() => void) | null = null;
	onerror: (() => void) | null = null;

	constructor() {
		FakeEventSource.opened.push(this);
	}

	addEventListener(): void {}

	close(): void {
		this.readyState = FakeEventSource.CLOSED;
	}

	/** The server answered with an HTTP error, so the browser gave up on this connection. */
	refuse(): void {
		this.readyState = FakeEventSource.CLOSED;
		this.onerror?.();
	}

	/** The connection dropped and the browser is retrying by itself. */
	drop(): void {
		this.readyState = FakeEventSource.CONNECTING;
		this.onerror?.();
	}
}

describe("openEventStream", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		FakeEventSource.opened = [];
		vi.stubGlobal("EventSource", FakeEventSource);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it("reports a refused stream, so the app can find out that its session ended", () => {
		const onRefused = vi.fn();
		const close = openEventStream({ onEvent: () => {}, onConnection: () => {}, onRefused });
		FakeEventSource.opened[0]?.refuse();
		expect(onRefused).toHaveBeenCalledTimes(1);
		close();
	});

	it("does not report a drop that the browser retries by itself", () => {
		const onRefused = vi.fn();
		const close = openEventStream({ onEvent: () => {}, onConnection: () => {}, onRefused });
		FakeEventSource.opened[0]?.drop();
		expect(onRefused).not.toHaveBeenCalled();
		close();
	});

	it("opens a new stream after a refusal, and stops once closed", () => {
		const close = openEventStream({ onEvent: () => {}, onConnection: () => {}, onRefused: () => {} });
		FakeEventSource.opened[0]?.refuse();
		vi.advanceTimersByTime(1_000);
		expect(FakeEventSource.opened).toHaveLength(2);
		close();
		FakeEventSource.opened[1]?.refuse();
		vi.advanceTimersByTime(60_000);
		expect(FakeEventSource.opened).toHaveLength(2);
	});
});
