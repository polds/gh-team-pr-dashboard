import type { ServerEvent } from "@radar/core";
import { parseEvent } from "./api.ts";
import type { Connection } from "./state.ts";

const KINDS: readonly ServerEvent["kind"][] = ["card", "remove", "presence", "celebrate", "resync"];

/** A drop shorter than this is not worth a "Reconnecting" label: EventSource usually recovers first. */
const GRACE_MS = 2_500;
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

/**
 * Keeps one EventSource open on `/api/events`. EventSource retries a dropped connection by itself;
 * when it gives up (an HTTP error closes it for good), this opens a new one with backoff.
 * Returns a function that closes the stream.
 */
export function openEventStream(handlers: {
	onEvent(event: ServerEvent): void;
	onConnection(connection: Connection): void;
	/** The server refused the stream with an HTTP error. A 401 here is how an open tab learns that its session ended. */
	onRefused(): void;
}): () => void {
	let source: EventSource | null = null;
	let graceTimer: ReturnType<typeof setTimeout> | undefined;
	let retryTimer: ReturnType<typeof setTimeout> | undefined;
	let failures = 0;
	let closed = false;

	const connect = () => {
		source = new EventSource("/api/events", { withCredentials: true });
		source.onopen = () => {
			failures = 0;
			clearTimeout(graceTimer);
			graceTimer = undefined;
			handlers.onConnection("live");
		};
		source.onerror = () => {
			if (graceTimer === undefined) graceTimer = setTimeout(() => handlers.onConnection("reconnecting"), GRACE_MS);
			if (source?.readyState !== EventSource.CLOSED || closed) return;
			handlers.onRefused();
			const delay = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)];
			failures += 1;
			retryTimer = setTimeout(connect, delay);
		};
		for (const kind of KINDS) {
			source.addEventListener(kind, (message) => {
				const event = parseEvent(kind, message.data);
				if (event !== null) handlers.onEvent(event);
			});
		}
	};

	connect();
	return () => {
		closed = true;
		clearTimeout(graceTimer);
		clearTimeout(retryTimer);
		source?.close();
	};
}
