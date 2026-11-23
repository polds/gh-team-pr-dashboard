import type { IsoTime, ServerEvent } from "@radar/core";
import { nowIso } from "./board.ts";
import type { Board } from "./board.ts";
import type { Clock } from "./clock.ts";
import { refKey } from "./github/source.ts";
import type { PrRef, PullRequestSource } from "./github/source.ts";
import { errorMessage } from "./log.ts";
import type { Logger } from "./log.ts";
import type { Refresher } from "./refresher.ts";

export interface Reconciler {
	/** Joins the sweep in flight, if any. Never rejects: a failed sweep logs and leaves the board as it was. */
	sweep(): Promise<void>;
	lastSweepAt(): IsoTime | null;
}

/**
 * Brings the board to what GitHub lists now. It fetches pull requests that are
 * new or whose listing fingerprint moved, every one on each `fullSweepEvery`-th
 * sweep, and each held open pull request the listing no longer has.
 */
export function createReconciler({
	source,
	board,
	refresher,
	publish,
	clock,
	log,
	fullSweepEvery,
}: {
	source: Pick<PullRequestSource, "listOpen" | "teams">;
	board: Board;
	refresher: Pick<Refresher, "fetchNow">;
	publish: (events: ServerEvent[]) => void;
	clock: Clock;
	log: Logger;
	fullSweepEvery: number;
}): Reconciler {
	const fingerprints = new Map<string, string>();
	let sweeps = 0;
	let running: Promise<void> | null = null;
	let last: IsoTime | null = null;

	async function run(): Promise<void> {
		const started = clock.now().getTime();
		sweeps += 1;
		const full = sweeps % fullSweepEvery === 0;
		publish(board.setTeams(await source.teams(), clock.now()));
		const open = await source.listOpen();
		const listed = new Set(open.map(refKey));
		const heldOpen = board.openRefs();
		const held = new Set(heldOpen.map(refKey));
		const changed = open.filter((pr) => full || !held.has(refKey(pr)) || fingerprints.get(refKey(pr)) !== pr.fingerprint);
		const missing = heldOpen.filter((ref) => !listed.has(refKey(ref)));
		const toFetch: PrRef[] = [...changed.map(({ owner, name, number }) => ({ owner, name, number })), ...missing];
		const failed = new Set((await refresher.fetchNow(toFetch)).map(refKey));
		for (const key of fingerprints.keys()) if (!listed.has(key)) fingerprints.delete(key);
		for (const pr of changed) if (!failed.has(refKey(pr))) fingerprints.set(refKey(pr), pr.fingerprint);
		if (failed.size === 0) board.pruneStore();
		last = nowIso(clock.now());
		log.info("reconcile.done", {
			open: open.length,
			fetched: toFetch.length,
			missing: missing.length,
			failed: failed.size,
			full,
			ms: clock.now().getTime() - started,
		});
	}

	return {
		sweep() {
			running ??= run()
				.catch((error: unknown) => log.error("reconcile.failed", { error: errorMessage(error) }))
				.finally(() => {
					running = null;
				});
			return running;
		},
		lastSweepAt: () => last,
	};
}
