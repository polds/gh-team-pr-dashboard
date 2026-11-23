import type { ServerEvent } from "@radar/core";
import type { Clock, Timer } from "./clock.ts";

export interface Hub {
	/** A new Server-Sent Events stream. It starts with a `resync` event and ends at `expiresAt`, in epoch milliseconds. */
	open(expiresAt: number): ReadableStream<Uint8Array>;
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
	const streams = new Map<ReadableStreamDefaultController<Uint8Array>, Timer>();

	function forget(stream: ReadableStreamDefaultController<Uint8Array>): boolean {
		const expiry = streams.get(stream);
		if (expiry === undefined) return false;
		clock.clearTimeout(expiry);
		streams.delete(stream);
		return true;
	}

	function send(text: string): void {
		const chunk = encoder.encode(text);
		for (const stream of streams.keys()) {
			if ((stream.desiredSize ?? 0) < -MAX_QUEUED_CHUNKS) {
				forget(stream);
				stream.error(new Error("subscriber stopped reading"));
				continue;
			}
			stream.enqueue(chunk);
		}
	}

	const keepAlive = clock.setInterval(() => send(": keep-alive\n\n"), keepAliveMs);

	return {
		open(expiresAt) {
			let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
			return new ReadableStream<Uint8Array>({
				start(stream) {
					controller = stream;
					stream.enqueue(encoder.encode(eventFrame({ kind: "resync" })));
					const expiry = clock.setTimeout(() => {
						if (forget(stream)) stream.close();
					}, expiresAt - clock.now().getTime());
					streams.set(stream, expiry);
				},
				cancel() {
					if (controller !== null) forget(controller);
				},
			});
		},
		broadcast: (event) => send(eventFrame(event)),
		subscribers: () => streams.size,
		close() {
			clock.clearInterval(keepAlive);
			for (const [stream, expiry] of streams) {
				clock.clearTimeout(expiry);
				stream.close();
			}
			streams.clear();
		},
	};
}
