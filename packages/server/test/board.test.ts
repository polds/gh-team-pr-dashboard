import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { asPrId, asSha, asTeamSlug } from "@radar/core";
import type { CardConfig, PrSnapshot, ServerEvent } from "@radar/core";
import { createBoard } from "../src/board.ts";
import { systemClock } from "../src/clock.ts";
import { silentLogger } from "../src/log.ts";
import { createStore } from "../src/store.ts";
import type { Store } from "../src/store.ts";
import { approvedPr, bob, changesRequestedPr, hour, likelyReadyPr, person, refOf, requestedPr, review, snapshot } from "./builders.ts";

const CARD_CONFIG: CardConfig = {
	priorityLabels: ["hotfix"],
	helpWantedAfterBusinessHours: 24,
	timeZone: "America/Los_Angeles",
	botLogins: ["renovate"],
};

const at = (n: number) => new Date(hour(n));

const memoryStore = () => createStore({ file: null, clock: systemClock, log: silentLogger });
const newBoard = (store: Store = memoryStore()) => createBoard({ org: "acme", store, cardConfig: CARD_CONFIG });

const kinds = (events: ServerEvent[]) => events.map((event) => event.kind);
const cardOf = (events: ServerEvent[]) => {
	const event = events.find((candidate) => candidate.kind === "card");
	if (event?.kind !== "card") throw new Error(`no card event in ${JSON.stringify(kinds(events))}`);
	return event.card;
};

const requested = requestedPr;
const changesRequested = changesRequestedPr;
const likelyReady = likelyReadyPr;
const approved = approvedPr;

describe("board", () => {
	it("emits a card on the first apply and nothing for an identical one", () => {
		const board = newBoard();
		const first = board.apply(refOf(requested), requested, at(1));
		expect(kinds(first)).toEqual(["card"]);
		expect(cardOf(first).derived.state).toBe("needs_review");
		expect(board.apply(refOf(requested), requested, at(1))).toEqual([]);
		expect(board.apply(refOf(requested), structuredClone(requested), at(1))).toEqual([]);
	});

	it("uses the estimate for a new pull request and the observed time when its state changes", () => {
		const board = newBoard();
		expect(cardOf(board.apply(refOf(changesRequested), changesRequested, at(2.5))).since).toBe(hour(2));
		const moved = cardOf(board.apply(refOf(likelyReady), likelyReady, at(7)));
		expect(moved.derived.state).toBe("likely_ready_for_rereview");
		expect(moved.since).toBe(at(7).toISOString());
		const touched = { ...likelyReady, title: "Renamed" };
		expect(cardOf(board.apply(refOf(touched), touched, at(9))).since).toBe(at(7).toISOString());
	});

	it("keeps the observed time across a restart while the state matches, and falls back to the estimate when it does not", () => {
		const store = memoryStore();
		const before = newBoard(store);
		before.apply(refOf(changesRequested), changesRequested, at(2.5));
		before.apply(refOf(likelyReady), likelyReady, at(7));
		expect(cardOf(newBoard(store).apply(refOf(likelyReady), likelyReady, at(8))).since).toBe(at(7).toISOString());
		const afterApproval = cardOf(newBoard(store).apply(refOf(approved), approved, at(8)));
		expect(afterApproval.derived.state).toBe("ready_to_merge");
		expect(afterApproval.since).toBe(afterApproval.derived.sinceEstimate);
	});

	it("keeps a merged pull request for 15 minutes, then removes it and its records", () => {
		const store = memoryStore();
		const board = newBoard(store);
		board.apply(refOf(approved), approved, at(5));
		const merged: PrSnapshot = { ...approved, lifecycle: { kind: "merged", at: hour(6) } };
		const mergedAt = at(6);
		expect(cardOf(board.apply(refOf(merged), merged, mergedAt)).derived.state).toBe("merged");
		expect(board.tick(new Date(mergedAt.getTime() + 14 * 60_000))).toEqual([]);
		expect(board.tick(new Date(mergedAt.getTime() + 15 * 60_000))).toEqual([{ kind: "remove", id: approved.id }]);
		expect(board.get(approved.id)).toBeUndefined();
		expect(store.stateEntry(approved.id)).toBeNull();
	});

	it("removes a pull request that no longer exists at once", () => {
		const store = memoryStore();
		const board = newBoard(store);
		board.apply(refOf(requested), requested, at(1));
		expect(board.apply(refOf(requested), null, at(1))).toEqual([{ kind: "remove", id: requested.id }]);
		expect(board.cards()).toEqual([]);
		expect(store.stateEntry(requested.id)).toBeNull();
		expect(board.apply(refOf(requested), null, at(1))).toEqual([]);
	});

	it("ignores a merged pull request it never held", () => {
		const board = newBoard();
		expect(board.apply(refOf(approved), { ...approved, lifecycle: { kind: "merged", at: hour(1) } }, at(1))).toEqual([]);
	});

	it("never holds a pull request from a repository outside the organization, and reads the owner without case", () => {
		const board = newBoard();
		const foreign = snapshot({ id: asPrId("PR_foreign"), repo: { owner: "someone-else", name: "anything" }, number: 7 });
		expect(board.apply(refOf(foreign), foreign, at(1))).toEqual([]);
		const shouted = snapshot({ repo: { owner: "ACME", name: "web" } });
		expect(kinds(board.apply(refOf(shouted), shouted, at(1)))).toEqual(["card"]);
		expect(board.cards().map((card) => card.id)).toEqual([shouted.id]);
		expect(board.openRefs()).toEqual([refOf(shouted)]);
	});

	it("celebrates a review that moves a pull request out of the reviewers' court", () => {
		const board = newBoard();
		board.apply(refOf(likelyReady), likelyReady, at(3));
		const events = board.apply(refOf(approved), approved, at(4));
		expect(kinds(events)).toEqual(["card", "celebrate"]);
		expect(events[1]).toEqual({ kind: "celebrate", id: approved.id, repo: "acme/web", number: 1, title: approved.title, by: bob });
	});

	it("does not celebrate an author push", () => {
		const board = newBoard();
		board.apply(refOf(changesRequested), changesRequested, at(2.5));
		expect(kinds(board.apply(refOf(likelyReady), likelyReady, at(3)))).toEqual(["card"]);
		const pushed: PrSnapshot = { ...requested, headSha: asSha("c9"), headCommittedAt: hour(5) };
		board.apply(refOf(requested), requested, at(1));
		expect(kinds(board.apply(refOf(pushed), pushed, at(5)))).toEqual(["card"]);
	});

	it("flips help wanted on a tick once the wait passes the threshold", () => {
		const board = newBoard();
		const team = { slug: asTeamSlug("platform"), name: "Platform", members: [bob, person("cy")] };
		board.setTeams([team], at(0));
		const card = cardOf(board.apply(refOf(requested), requested, at(1)));
		expect(card.helpWanted).toBeNull();
		expect(board.tick(at(20))).toEqual([]);
		const flipped = cardOf(board.tick(at(25)));
		expect(flipped.helpWanted).not.toBeNull();
		expect(board.get(requested.id)?.card.helpWanted).not.toBeNull();
	});

	it("resolves a head SHA in a repository to its pull requests", () => {
		const board = newBoard();
		board.apply(refOf(likelyReady), likelyReady, at(3));
		expect(board.refsForSha({ owner: "acme", name: "web" }, asSha("c2"))).toEqual([{ owner: "acme", name: "web", number: 1 }]);
		expect(board.refsForSha({ owner: "acme", name: "api" }, asSha("c2"))).toEqual([]);
		expect(board.refsForSha({ owner: "acme", name: "web" }, asSha("c1"))).toEqual([]);
	});

	it("re-derives every card when team membership changes, and not when it stays", () => {
		const board = newBoard();
		const teamRequest = snapshot({ reviewRequests: [{ kind: "team", slug: asTeamSlug("platform"), name: "Platform", asCodeOwner: false, requestedAt: hour(0) }] });
		board.apply(refOf(teamRequest), teamRequest, at(1));
		const team = (members: string[]) => [{ slug: asTeamSlug("platform"), name: "Platform", members: members.map((login) => person(login)) }];
		const events = board.setTeams(team(["bob", "cy"]), at(1));
		expect(cardOf(events).derived.actors.map((actor) => actor.login)).toEqual(["bob", "cy"]);
		expect(board.setTeams(team(["bob", "cy"]), at(1))).toEqual([]);
		expect(board.teamsOf(bob.login)).toEqual([{ slug: "platform", name: "Platform" }]);
	});

	describe("author signal and heuristic counters", () => {
		it("moves a likely-ready card to changes requested on not ready, counts a rejection once, and clears on the next push", () => {
			const store = memoryStore();
			const board = newBoard(store);
			board.apply(refOf(likelyReady), likelyReady, at(3));
			expect(cardOf(board.setSignal(likelyReady.id, "not_ready", at(4))).derived.state).toBe("changes_requested");
			expect(board.setSignal(likelyReady.id, "not_ready", at(4))).toEqual([]);
			expect(store.heuristic()).toEqual({ confirmed: 0, rejected: 1 });
			const pushed: PrSnapshot = { ...likelyReady, headSha: asSha("c3"), headCommittedAt: hour(5) };
			expect(cardOf(board.apply(refOf(pushed), pushed, at(5))).derived.state).toBe("likely_ready_for_rereview");
			expect(store.signal(likelyReady.id)).toBeNull();
		});

		it("lets a reviewer's new change request override a stored ready signal, and lets the author signal ready again", () => {
			const board = newBoard();
			board.apply(refOf(changesRequested), changesRequested, at(2.5));
			expect(cardOf(board.setSignal(changesRequested.id, "ready", at(3))).derived.state).toBe("likely_ready_for_rereview");
			const askedAgain: PrSnapshot = {
				...changesRequested,
				decisiveReviews: [review(bob, "CHANGES_REQUESTED", hour(4))],
				latestReviews: [review(bob, "CHANGES_REQUESTED", hour(4))],
			};
			expect(cardOf(board.apply(refOf(askedAgain), askedAgain, at(4))).derived).toMatchObject({ state: "changes_requested", court: "author" });
			expect(cardOf(board.setSignal(changesRequested.id, "ready", at(5))).derived.state).toBe("likely_ready_for_rereview");
		});

		it("counts a re-review by a likely-ready actor as confirmed, once per spell", () => {
			const store = memoryStore();
			const board = newBoard(store);
			board.apply(refOf(likelyReady), likelyReady, at(3));
			board.noteRerequest(likelyReady.id);
			board.apply(refOf(approved), approved, at(4));
			expect(store.heuristic()).toEqual({ confirmed: 1, rejected: 0 });
		});

		it("counts at most one outcome per pull request and head, across toggles, clears, a ready signal, and a re-review", () => {
			const store = memoryStore();
			const board = newBoard(store);
			board.apply(refOf(likelyReady), likelyReady, at(3));
			for (let round = 0; round < 5; round += 1) {
				board.setSignal(likelyReady.id, "not_ready", at(3.5));
				expect(cardOf(board.setSignal(likelyReady.id, null, at(3.5))).derived.state).toBe("likely_ready_for_rereview");
			}
			board.setSignal(likelyReady.id, "ready", at(3.6));
			board.setSignal(likelyReady.id, null, at(3.6));
			board.noteRerequest(likelyReady.id);
			board.apply(refOf(approved), approved, at(4));
			expect(store.heuristic()).toEqual({ confirmed: 0, rejected: 1 });
		});

		it("keeps the one outcome across a restart, and counts again once the head moves", () => {
			const dir = mkdtempSync(join(tmpdir(), "radar-board-"));
			const fileStore = () => createStore({ file: join(dir, "state.json"), clock: systemClock, log: silentLogger });
			try {
				const before = fileStore();
				const board = newBoard(before);
				board.apply(refOf(likelyReady), likelyReady, at(3));
				board.setSignal(likelyReady.id, "not_ready", at(3.5));
				board.setSignal(likelyReady.id, null, at(3.5));
				before.flush();

				const after = fileStore();
				const restarted = newBoard(after);
				restarted.apply(refOf(likelyReady), likelyReady, at(4));
				restarted.setSignal(likelyReady.id, "not_ready", at(4));
				expect(after.heuristic()).toEqual({ confirmed: 0, rejected: 1 });

				const pushed: PrSnapshot = { ...likelyReady, headSha: asSha("c3"), headCommittedAt: hour(5) };
				expect(cardOf(restarted.apply(refOf(pushed), pushed, at(5))).derived.state).toBe("likely_ready_for_rereview");
				restarted.setSignal(pushed.id, "not_ready", at(5.5));
				expect(after.heuristic()).toEqual({ confirmed: 0, rejected: 2 });
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("counts a re-review that lands with a new push once, at the head the card was judged on", () => {
			const store = memoryStore();
			const board = newBoard(store);
			board.apply(refOf(likelyReady), likelyReady, at(3));
			board.noteRerequest(likelyReady.id);
			const reviewedAfterPush: PrSnapshot = { ...approved, headSha: asSha("c3"), headCommittedAt: hour(3.5) };
			board.apply(refOf(reviewedAfterPush), reviewedAfterPush, at(4));
			expect(store.heuristic()).toEqual({ confirmed: 1, rejected: 0 });
		});

		it("does not count outcomes on a card that is not a heuristic likely-ready card", () => {
			const store = memoryStore();
			const board = newBoard(store);
			board.apply(refOf(changesRequested), changesRequested, at(2.5));
			board.setSignal(changesRequested.id, "not_ready", at(3));
			expect(store.heuristic()).toEqual({ confirmed: 0, rejected: 0 });
		});
	});
});
