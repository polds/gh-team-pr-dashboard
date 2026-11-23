import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthorSignalResponse, BoardResponse, Card, PrState, ServerEvent } from "@radar/core";
import { systemClock } from "../src/clock.ts";
import { loadConfig } from "../src/config.ts";
import type { DemoStep } from "../src/http.ts";
import { silentLogger } from "../src/log.ts";
import { createRadar } from "../src/radar.ts";
import type { Radar } from "../src/radar.ts";
import { jsonOf } from "./helpers.ts";

const OPEN_STATES: PrState[] = [
	"draft",
	"needs_review",
	"in_review",
	"changes_requested",
	"likely_ready_for_rereview",
	"approved_blocked",
	"ready_to_merge",
];

/** The script's moves, in order: which pull request each step moves, and where to. */
const STORY: { pr: string; state: PrState; celebrateBy?: string }[] = [
	{ pr: "atum/mobile#77", state: "likely_ready_for_rereview" },
	{ pr: "atum/mobile#77", state: "ready_to_merge", celebrateBy: "barbara" },
	{ pr: "atum/monorepo#4104", state: "ready_to_merge" },
	{ pr: "atum/monorepo#4110", state: "changes_requested", celebrateBy: "margaret" },
	{ pr: "atum/mobile#74", state: "merged" },
	{ pr: "atum/monorepo#4121", state: "needs_review" },
	{ pr: "atum/monorepo#4098", state: "in_review" },
];

const keyOf = (card: Card) => `${card.repo}#${card.number}`;
const statesOf = (board: BoardResponse) => new Map(board.cards.map((card) => [keyOf(card), card.derived.state]));

function parseFrames(text: string): ServerEvent[] {
	return text
		.split("\n\n")
		.filter((frame) => frame.startsWith("event: "))
		.map((frame) => JSON.parse(frame.slice(frame.indexOf("data: ") + "data: ".length)));
}

describe("demo end to end", () => {
	let radar: Radar;

	beforeEach(() => {
		vi.useFakeTimers({ now: new Date("2026-11-18T17:00:00Z") });
	});

	afterEach(() => {
		radar.stop();
		vi.useRealTimers();
	});

	async function boot(env: Record<string, string> = {}) {
		radar = createRadar({ config: loadConfig({ RADAR_DEMO: "1", RADAR_DEMO_INTERVAL_SECONDS: "0", ...env }), clock: systemClock, log: silentLogger });
		await radar.reconciler.sweep();
		const signIn = async (login: string) => {
			const response = await radar.app.request(`/auth/demo?login=${encodeURIComponent(login)}`);
			expect(response.status).toBe(302);
			return response.headers.getSetCookie()[0]?.split(";")[0] ?? "";
		};
		const cookie = await signIn("ken");
		const board = async () => jsonOf<BoardResponse>(await radar.app.request("/api/board", { headers: { Cookie: cookie } }));
		const settle = () => vi.advanceTimersByTimeAsync(1500);
		const step = async () => {
			const result = await jsonOf<DemoStep>(await radar.app.request("/demo/step", { method: "POST" }));
			await settle();
			return result;
		};
		const reset = async () => {
			const result = await jsonOf<DemoStep>(await radar.app.request("/demo/reset", { method: "POST" }));
			await settle();
			return result;
		};
		const events = await radar.app.request("/api/events", { headers: { Cookie: cookie } });
		const reader = events.body?.getReader();
		let streamed = "";
		void (async () => {
			for (;;) {
				const chunk = await reader?.read();
				if (chunk === undefined || chunk.done) return;
				streamed += new TextDecoder().decode(chunk.value);
			}
		})();
		const stream = () => parseFrames(streamed);
		return { board, step, reset, settle, signIn, stream };
	}

	it("opens with a card in every state and group, signed in as ken", async () => {
		const { board } = await boot();
		const opening = await board();
		expect(opening.viewer).toMatchObject({ login: "ken", teams: [{ slug: "platform", name: "Platform" }] });
		expect(opening.config.demo).toBe(true);
		const states = new Set(opening.cards.map((card) => card.derived.state));
		for (const state of OPEN_STATES) expect(states, state).toContain(state);

		const find = (predicate: (card: Card) => boolean, label: string) => {
			const card = opening.cards.find(predicate);
			if (card === undefined) throw new Error(`no ${label} card`);
			return card;
		};
		const helpWanted = find((card) => card.helpWanted !== null, "help wanted");
		expect(helpWanted.derived.state).toBe("needs_review");
		expect(helpWanted.requestedTeams).toEqual([{ slug: "platform", name: "Platform" }]);
		expect(helpWanted.derived.actors.some((actor) => actor.via.kind === "direct")).toBe(true);
		expect(helpWanted.helpWanted?.suggested.length).toBeGreaterThan(0);
		expect(find((card) => card.priority, "priority").labels).toContain("hotfix");
		expect(find((card) => card.isBotPr, "bot").author.login).toBe("renovate[bot]");

		const changesRequested = opening.cards.filter((card) => card.derived.state === "changes_requested");
		expect(changesRequested.some((card) => card.derived.reasons.some((reason) => reason.kind === "changes_requested_by"))).toBe(true);
		expect(changesRequested.some((card) => card.derived.reasons.every((reason) => reason.kind !== "changes_requested_by"))).toBe(true);
		for (const card of changesRequested) {
			expect(card.derived.reasons.some((reason) => reason.kind === "open_threads" && reason.awaitingAuthor > 0)).toBe(true);
		}

		const likelyReady = find((card) => card.derived.state === "likely_ready_for_rereview", "likely ready");
		expect(likelyReady.derived.actors.map((actor) => actor.login)).toContain("ken");
		expect(likelyReady.derived.confidence).toBe("high");

		const blockers = opening.cards.filter((card) => card.derived.state === "approved_blocked").map((card) => card.derived.blockers);
		expect(blockers).toEqual(expect.arrayContaining([["ci_failing"], ["ci_pending"], ["review_missing"]]));
	});

	it("makes the described move on every step, celebrates the unblocking reviews, and resets to the opening board", async () => {
		const { board, step, reset, stream } = await boot();
		const opening = statesOf(await board());
		const run = async () => {
			const moves: (PrState | undefined)[] = [];
			let before = statesOf(await board());
			for (const [index, move] of STORY.entries()) {
				const result = await step();
				expect(result).toMatchObject({ step: index + 1, done: index === STORY.length - 1 });
				const after = statesOf(await board());
				expect(after.get(move.pr), result.description).toBe(move.state);
				for (const [pr, state] of before) if (pr !== move.pr) expect(after.get(pr), `${pr} after step ${index + 1}`).toBe(state);
				moves.push(after.get(move.pr));
				before = after;
			}
			return moves;
		};

		const first = await run();
		const celebrations = stream().flatMap((event) => (event.kind === "celebrate" ? [`${event.repo}#${event.number} by ${event.by?.login}`] : []));
		expect(celebrations).toEqual(STORY.flatMap((move) => (move.celebrateBy === undefined ? [] : [`${move.pr} by ${move.celebrateBy}`])));
		expect(await step()).toMatchObject({ step: STORY.length, done: true });

		expect(await reset()).toMatchObject({ step: 0, done: false });
		expect(statesOf(await board())).toEqual(opening);
		expect(await run()).toEqual(first);
	});

	it("re-requests review through the simulated GitHub when the author says ready", async () => {
		const { signIn, settle } = await boot();
		const cookie = await signIn("linus");
		const before = await jsonOf<BoardResponse>(await radar.app.request("/api/board", { headers: { Cookie: cookie } }));
		const payouts = before.cards.find((card) => card.number === 4098);
		const response = await radar.app.request(`/api/prs/${payouts?.id}/signal`, {
			method: "POST",
			headers: { Cookie: cookie, "X-Radar": "1", "Content-Type": "application/json" },
			body: JSON.stringify({ kind: "ready" }),
		});
		expect(await jsonOf<AuthorSignalResponse>(response)).toEqual({ ok: true, wroteToGitHub: true });
		await settle();
		const after = await jsonOf<BoardResponse>(await radar.app.request("/api/board", { headers: { Cookie: cookie } }));
		const card = after.cards.find((candidate) => candidate.number === 4098);
		expect(card?.derived.state).toBe("in_review");
		expect(card?.derived.reviewers).toContainEqual(expect.objectContaining({ kind: "requested", rerequested: true }));
		expect(after.heuristic).toEqual({ confirmed: 1, rejected: 0 });
	});

	it("plays the script on its own and loops back to the opening board", async () => {
		const { board } = await boot({ RADAR_DEMO_INTERVAL_SECONDS: "8" });
		const opening = statesOf(await board());
		radar.start();
		await vi.advanceTimersByTimeAsync(8000 + 1500);
		expect(statesOf(await board()).get("atum/mobile#77")).toBe("likely_ready_for_rereview");
		await vi.advanceTimersByTimeAsync(8000 * STORY.length);
		expect(statesOf(await board())).toEqual(opening);
	});

	it("lists the demo people on the login page and has no webhook route", async () => {
		await boot();
		const login = await (await radar.app.request("/auth/login")).text();
		for (const person of ["ada", "grace", "linus", "margaret", "ken", "barbara"]) expect(login).toContain(`/auth/demo?login=${person}`);
		expect(login).not.toContain("renovate");
		expect((await radar.app.request("/auth/demo?login=renovate%5Bbot%5D")).status).toBe(404);
		expect((await radar.app.request("/webhooks/github", { method: "POST", body: "{}" })).status).toBe(404);
	});
});
