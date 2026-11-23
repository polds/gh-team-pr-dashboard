import type { Login, Person, PresenceEntry, PresenceRequest, PrId } from "@radar/core";
import type { Clock } from "./clock.ts";

export interface Presence {
	heartbeat(person: Person, request: PresenceRequest): void;
	list(): PresenceEntry[];
	stop(): void;
}

/** Held in memory only. Nothing here is written to disk or logged. */
export function createPresence({
	clock,
	onChange,
	ttlMs = 45_000,
	sweepMs = 10_000,
}: {
	clock: Clock;
	onChange: (presence: PresenceEntry[]) => void;
	ttlMs?: number;
	sweepMs?: number;
}): Presence {
	const entries = new Map<Login, { person: Person; viewing: PrId | null; expiresAt: number }>();

	function list(): PresenceEntry[] {
		return [...entries.values()]
			.sort((a, b) => a.person.login.localeCompare(b.person.login))
			.map(({ person, viewing }) => ({ person, viewing }));
	}

	function sweep(): void {
		const now = clock.now().getTime();
		let changed = false;
		for (const [login, entry] of entries) {
			if (entry.expiresAt <= now) changed = entries.delete(login) || changed;
		}
		if (changed) onChange(list());
	}

	const timer = clock.setInterval(sweep, sweepMs);

	return {
		heartbeat(person, { viewing, active }) {
			const held = entries.get(person.login);
			if (!active) {
				if (entries.delete(person.login)) onChange(list());
				return;
			}
			entries.set(person.login, { person, viewing, expiresAt: clock.now().getTime() + ttlMs });
			if (held === undefined || held.viewing !== viewing || held.person.avatarUrl !== person.avatarUrl) onChange(list());
		},
		list,
		stop: () => clock.clearInterval(timer),
	};
}
