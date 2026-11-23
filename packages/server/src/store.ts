import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { asPrId, asSha, isIsoTime } from "@radar/core";
import type { AuthorSignal, HeuristicStats, IsoTime, PrId, PrState, Sha } from "@radar/core";
import type { Clock, Timer } from "./clock.ts";
import { errorMessage } from "./log.ts";
import type { Logger } from "./log.ts";

/** When the running server saw a pull request enter its state. */
export interface StateEntry {
	state: PrState;
	since: IsoTime;
}

export interface Store {
	signal(id: PrId): AuthorSignal | null;
	setSignal(id: PrId, signal: AuthorSignal | null): void;
	stateEntry(id: PrId): StateEntry | null;
	setStateEntry(id: PrId, entry: StateEntry): void;
	heuristic(): HeuristicStats;
	/** Adds one to the `outcome` counter unless an outcome is already counted for this pull request at `headSha`. */
	count(id: PrId, headSha: Sha, outcome: keyof HeuristicStats): void;
	/** Drops the signal and the counted outcome of a pull request when they belong to a head other than `headSha`. */
	forgetOtherHeads(id: PrId, headSha: Sha): void;
	/** Drops every record of one pull request. */
	forget(id: PrId): void;
	/** Drops every record whose pull request is not in `ids`. */
	retain(ids: ReadonlySet<PrId>): void;
	flush(): void;
}

const PR_STATES = [
	"draft",
	"needs_review",
	"in_review",
	"changes_requested",
	"likely_ready_for_rereview",
	"approved_blocked",
	"ready_to_merge",
	"merged",
	"closed",
] as const satisfies readonly PrState[];

const isoTimeSchema = z.string().refine(isIsoTime, "not a timestamp");
const count = z.number().int().nonnegative();

const fileSchema = z.object({
	version: z.literal(1),
	signals: z.record(z.string(), z.object({ kind: z.enum(["ready", "not_ready"]), headSha: z.string().transform(asSha), at: isoTimeSchema })),
	states: z.record(z.string(), z.object({ state: z.enum(PR_STATES), since: isoTimeSchema })),
	heuristic: z.object({ confirmed: count, rejected: count }),
	/** The head SHA at which each pull request's one heuristic outcome was counted. */
	counted: z.record(z.string(), z.string().transform(asSha)).default({}),
});
type StoredFile = z.infer<typeof fileSchema>;

const EMPTY: StoredFile = { version: 1, signals: {}, states: {}, heuristic: { confirmed: 0, rejected: 0 }, counted: {} };

function load(file: string, log: Logger): StoredFile {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		log.info("store.empty", { reason: error instanceof Error && "code" in error ? String(error.code) : errorMessage(error) });
		return EMPTY;
	}
	try {
		return fileSchema.parse(JSON.parse(text));
	} catch (error) {
		log.warn("store.corrupt", { error: errorMessage(error).slice(0, 200) });
		return EMPTY;
	}
}

/** `file` null keeps everything in memory. Writes are debounced and land through a rename, so a crash leaves the old file or the new one. */
export function createStore({
	file,
	clock,
	log,
	debounceMs = 1000,
}: {
	file: string | null;
	clock: Clock;
	log: Logger;
	debounceMs?: number;
}): Store {
	const initial = file === null ? EMPTY : load(file, log);
	const signals = new Map(Object.entries(initial.signals).map(([id, signal]) => [asPrId(id), signal]));
	const states = new Map(Object.entries(initial.states).map(([id, entry]) => [asPrId(id), entry]));
	const heuristic: HeuristicStats = { ...initial.heuristic };
	const counted = new Map(Object.entries(initial.counted).map(([id, headSha]) => [asPrId(id), headSha]));
	let timer: Timer | null = null;
	let dirty = false;

	function write(): void {
		if (timer !== null) clock.clearTimeout(timer);
		timer = null;
		if (!dirty || file === null) return;
		const contents: StoredFile = {
			version: 1,
			signals: Object.fromEntries(signals),
			states: Object.fromEntries(states),
			heuristic,
			counted: Object.fromEntries(counted),
		};
		const temporary = `${file}.${process.pid}.tmp`;
		try {
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(temporary, `${JSON.stringify(contents)}\n`);
			renameSync(temporary, file);
			dirty = false;
		} catch (error) {
			log.error("store.write_failed", { error: errorMessage(error) });
		}
	}

	function changed(): void {
		dirty = true;
		if (timer === null && file !== null) timer = clock.setTimeout(write, debounceMs);
	}

	function forget(id: PrId): void {
		const hadSignal = signals.delete(id);
		const hadState = states.delete(id);
		const hadCounted = counted.delete(id);
		if (hadSignal || hadState || hadCounted) changed();
	}

	return {
		signal: (id) => signals.get(id) ?? null,
		setSignal(id, signal) {
			const held = signals.get(id);
			if (signal === null) {
				if (held !== undefined && signals.delete(id)) changed();
				return;
			}
			if (held?.kind === signal.kind && held.headSha === signal.headSha && held.at === signal.at) return;
			signals.set(id, signal);
			changed();
		},
		stateEntry: (id) => states.get(id) ?? null,
		setStateEntry(id, entry) {
			const held = states.get(id);
			if (held?.state === entry.state && held.since === entry.since) return;
			states.set(id, entry);
			changed();
		},
		heuristic: () => ({ ...heuristic }),
		count(id, headSha, outcome) {
			if (counted.get(id) === headSha) return;
			counted.set(id, headSha);
			heuristic[outcome] += 1;
			changed();
		},
		forgetOtherHeads(id, headSha) {
			const signal = signals.get(id);
			const hadSignal = signal !== undefined && signal.headSha !== headSha && signals.delete(id);
			const countedAt = counted.get(id);
			const hadCounted = countedAt !== undefined && countedAt !== headSha && counted.delete(id);
			if (hadSignal || hadCounted) changed();
		},
		forget,
		retain(ids) {
			for (const id of new Set([...signals.keys(), ...states.keys(), ...counted.keys()])) {
				if (!ids.has(id)) forget(id);
			}
		},
		flush: write,
	};
}
