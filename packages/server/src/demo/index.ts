import { createHash } from "node:crypto";
import type { PrSnapshot } from "@radar/core";
import { nowIso } from "../board.ts";
import type { Clock } from "../clock.ts";
import { refKey } from "../github/source.ts";
import type { PrRef, PullRequestSource } from "../github/source.ts";
import type { DemoControl, DemoStep } from "../http.ts";
import type { ReviewRequester } from "../writer.ts";
import { CAST, SCRIPT, TEAMS, clockwork, initialPullRequests, refOf } from "./scenario.ts";

export interface Demo {
	source: PullRequestSource;
	requester: ReviewRequester;
	control: DemoControl;
	/** One autoplay beat: the next step, or a reset after the last one. */
	advance(): DemoStep;
}

export function createDemo({ clock, hint }: { clock: Clock; hint: (ref: PrRef) => void }): Demo {
	const ago = clockwork(clock.now());
	const prs = new Map<string, PrSnapshot>();
	let position = 0;

	function load(): PrRef[] {
		const touched = new Map([...prs].map(([key, pr]) => [key, refOf(pr)]));
		prs.clear();
		for (const pr of initialPullRequests(ago)) {
			prs.set(refKey(refOf(pr)), pr);
			touched.set(refKey(refOf(pr)), refOf(pr));
		}
		position = 0;
		return [...touched.values()];
	}

	load();

	const source: PullRequestSource = {
		async listOpen() {
			return [...prs.values()]
				.filter((pr) => pr.lifecycle.kind === "open")
				.map((pr) => ({ ...refOf(pr), fingerprint: createHash("sha256").update(JSON.stringify(pr)).digest("base64url") }));
		},
		async fetch(refs) {
			return new Map(refs.map((ref) => [refKey(ref), structuredClone(prs.get(refKey(ref)) ?? null)]));
		},
		teams: async () => structuredClone([...TEAMS]),
	};

	const requester: ReviewRequester = {
		async requestReviewers({ ref, logins }) {
			const key = refKey(ref);
			const pr = prs.get(key);
			if (pr === undefined) throw new Error(`the demo has no pull request ${key}`);
			const at = nowIso(clock.now());
			const requested = new Set(pr.reviewRequests.flatMap((request) => (request.kind === "user" ? [request.reviewer.login] : [])));
			const added = CAST.filter((person) => logins.includes(person.login) && !requested.has(person.login)).map((reviewer) => ({
				kind: "user" as const,
				reviewer,
				asCodeOwner: false,
				requestedAt: at,
			}));
			prs.set(key, { ...pr, reviewRequests: [...pr.reviewRequests, ...added] });
			hint(ref);
		},
	};

	function step(): DemoStep {
		const next = SCRIPT[position];
		if (next === undefined) return { step: position, description: "The scenario is over. Reset it to play again.", done: true };
		const key = refKey(next.ref);
		prs.set(key, next.change(prs.get(key), nowIso(clock.now())));
		position += 1;
		hint(next.ref);
		return { step: position, description: next.description, done: position === SCRIPT.length };
	}

	function reset(): DemoStep {
		for (const ref of load()) hint(ref);
		return { step: 0, description: "The simulated organization is back to its opening board.", done: false };
	}

	return {
		source,
		requester,
		control: { people: [...CAST], step, reset },
		advance: () => (position >= SCRIPT.length ? reset() : step()),
	};
}
