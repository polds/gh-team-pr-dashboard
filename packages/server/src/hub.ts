import type { ServerEvent } from "@radar/core";
import type { Clock } from "./clock.ts";

export interface Hub {
	/** A new Server-Sent Events stream. It starts with a `resync` event. */
	open(): ReadableStream<Uint8Array>;
	broadcast(event: ServerEvent): void;
	subscribers(): number;
	/** Ends every stream and stops the keep-alive. */
	close(): void;
}

const MAX_QUEUED_CHUNKS = 500;

const encoder = new TextEncoder();

export function eventFrame(event: ServerEvent): string {
	return `event: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function createHub({ clock, keepAliveMs = 25_000 }: { clock: Clock; keepAliveMs?: number }): Hub {
	const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();

	function send(text: string): void {
		const chunk = encoder.encode(text);
		for (const stream of streams) {
			if ((stream.desiredSize ?? 0) < -MAX_QUEUED_CHUNKS) {
				streams.delete(stream);
				stream.error(new Error("subscriber stopped reading"));
				continue;
			}
			stream.enqueue(chunk);
		}
	}

	const keepAlive = clock.setInterval(() => send(": keep-alive\n\n"), keepAliveMs);

	return {
		open() {
			let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
			return new ReadableStream<Uint8Array>({
				start(stream) {
					controller = stream;
					stream.enqueue(encoder.encode(eventFrame({ kind: "resync" })));
					streams.add(stream);
				},
				cancel() {
					if (controller !== null) streams.delete(controller);
				},
			});
		},
		broadcast: (event) => send(eventFrame(event)),
		subscribers: () => streams.size,
		close() {
			clock.clearInterval(keepAlive);
			for (const stream of streams) stream.close();
			streams.clear();
		},
	};
}
