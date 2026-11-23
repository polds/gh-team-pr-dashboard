import type { PrSnapshot } from "@radar/core";
import type { Clock, Timer } from "./clock.ts";
import { refKey } from "./github/source.ts";
import type { PrRef, PullRequestSource } from "./github/source.ts";
import { errorMessage } from "./log.ts";
import type { Logger } from "./log.ts";

export interface Refresher {
	/** A hint that this pull request changed. It is fetched once the hints for it go quiet. */
	mark(ref: PrRef): void;
	/** Fetches and applies now, with no debounce and no retry. Resolves with the refs that failed to load. */
	fetchNow(refs: readonly PrRef[]): Promise<PrRef[]>;
	stop(): void;
}

interface Pending {
	ref: PrRef;
	firstAt: number;
	dueAt: number;
	retry: boolean;
}

export function createRefresher({
	source,
	apply,
	clock,
	log,
	debounceMs = 1500,
	maxWaitMs = 5000,
	retryMs = 30_000,
}: {
	source: Pick<PullRequestSource, "fetch">;
	apply: (ref: PrRef, snapshot: PrSnapshot | null) => void;
	clock: Clock;
	log: Logger;
	debounceMs?: number;
	maxWaitMs?: number;
	retryMs?: number;
}): Refresher {
	const pending = new Map<string, Pending>();
	const appliedTicket = new Map<string, number>();
	let tickets = 0;
	let timer: Timer | null = null;
	let timerDueAt = Number.POSITIVE_INFINITY;
	let stopped = false;

	const now = () => clock.now().getTime();

	async function fetchAndApply(refs: readonly PrRef[]): Promise<PrRef[]> {
		if (refs.length === 0) return [];
		const ticket = ++tickets;
		let snapshots: Map<string, PrSnapshot | null>;
		try {
			snapshots = await source.fetch([...refs]);
		} catch (error) {
			log.warn("refresh.fetch_failed", { refs: refs.length, error: errorMessage(error) });
			return [...refs];
		}
		const failed: PrRef[] = [];
		for (const ref of refs) {
			const key = refKey(ref);
			const snapshot = snapshots.get(key);
			if (snapshot === undefined) {
				failed.push(ref);
				continue;
			}
			if ((appliedTicket.get(key) ?? 0) > ticket) continue;
			appliedTicket.set(key, ticket);
			try {
				apply(ref, snapshot);
			} catch (error) {
				log.error("refresh.apply_failed", { pr: key, error: errorMessage(error) });
			}
		}
		return failed;
	}

	function schedule(): void {
		if (stopped) return;
		let next = Number.POSITIVE_INFINITY;
		for (const entry of pending.values()) next = Math.min(next, entry.dueAt);
		if (next === timerDueAt) return;
		if (timer !== null) clock.clearTimeout(timer);
		timer = null;
		timerDueAt = next;
		if (next !== Number.POSITIVE_INFINITY) timer = clock.setTimeout(fire, Math.max(0, next - now()));
	}

	function fire(): void {
		timer = null;
		timerDueAt = Number.POSITIVE_INFINITY;
		const at = now();
		const due = [...pending.values()].filter((entry) => entry.dueAt <= at);
		for (const entry of due) pending.delete(refKey(entry.ref));
		schedule();
		if (due.length > 0) void refresh(due);
	}

	async function refresh(due: Pending[]): Promise<void> {
		const failed = new Set((await fetchAndApply(due.map((entry) => entry.ref))).map(refKey));
		const at = now();
		for (const entry of due) {
			const key = refKey(entry.ref);
			if (!failed.has(key) || pending.has(key)) continue;
			if (entry.retry) {
				log.warn("refresh.gave_up", { pr: key });
				continue;
			}
			pending.set(key, { ref: entry.ref, firstAt: at, dueAt: at + retryMs, retry: true });
		}
		schedule();
	}

	return {
		mark(ref) {
			if (stopped) return;
			const key = refKey(ref);
			const at = now();
			const held = pending.get(key);
			if (held !== undefined && !held.retry) {
				held.dueAt = Math.min(at + debounceMs, held.firstAt + maxWaitMs);
			} else {
				pending.set(key, { ref, firstAt: at, dueAt: at + debounceMs, retry: false });
			}
			schedule();
		},
		fetchNow: fetchAndApply,
		stop() {
			stopped = true;
			if (timer !== null) clock.clearTimeout(timer);
			timer = null;
			pending.clear();
		},
	};
}
