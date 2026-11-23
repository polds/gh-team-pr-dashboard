import { describe, expect, it } from "vitest";
import { DEFAULT_NOTIFICATION_PREFS, INITIAL_NOTIFIER_STATE, notifierStep, turnsFor } from "../src/index.ts";
import type { Card, Confidence, NotificationPrefs, NotifierInput, NotifierState, ReviewerStatusKind } from "../src/index.ts";
import { asAuthor, card, direct, hour, human, viaTeam } from "./builders.ts";

const rex = human("rex");

const statusOf = (kind: ReviewerStatusKind, rerequested = false) => ({ reviewer: rex, kind, rerequested, since: hour(0) });
const requested = (number: number, rerequested = false) =>
	card({ number, derived: { actors: [direct(rex)], reviewers: [statusOf("requested", rerequested)] } });
const teamRequested = (number: number) => card({ number, derived: { actors: [viaTeam(rex, "web")] } });
const likelyReady = (number: number, confidence: Confidence = "high") =>
	card({
		number,
		derived: { state: "likely_ready_for_rereview", confidence, actors: [direct(rex)], reviewers: [statusOf("feedback_addressed")] },
	});
const ownPr = (number: number, state: "changes_requested" | "ready_to_merge" | "draft") =>
	card({ number, author: rex, derived: { state, court: "author", actors: [asAuthor(rex)] } });

const on: NotificationPrefs = { ...DEFAULT_NOTIFICATION_PREFS, enabled: true };
const board = (before: Card[], after: Card[]): NotifierInput => ({ kind: "board", before, after });
const tick: NotifierInput = { kind: "tick" };
const at = (hours: number, minutes = 0) => ({ minuteOfDay: hours * 60 + minutes, nowMs: (hours * 60 + minutes) * 60_000 });

function step(state: NotifierState, input: NotifierInput, prefs: NotificationPrefs, when = at(12)) {
	return notifierStep(state, input, { login: rex.login, prefs, ...when });
}

const single = (number: number, title: string) => ({
	title,
	body: `acme/web#${number}: Change ${number}`,
	url: `https://github.com/acme/web/pull/${number}`,
	tag: `PR_${number}`,
});

describe("turnsFor", () => {
	it("names the kind of turn each pull request gives the user", () => {
		const turns = turnsFor(rex.login, [
			requested(1),
			requested(2, true),
			teamRequested(3),
			likelyReady(4),
			likelyReady(5, "confirmed"),
			ownPr(6, "changes_requested"),
			ownPr(7, "ready_to_merge"),
			ownPr(8, "draft"),
			card({ number: 9, derived: { state: "in_review", actors: [direct(rex)], reviewers: [statusOf("commented")] } }),
			card({ number: 10, derived: { actors: [direct(human("cora"))] } }),
		]);
		expect([...turns.values()].map((t) => [t.number, t.kind, t.heuristic])).toEqual([
			[1, "review_requested", false],
			[2, "rereview", false],
			[3, "team_review_requested", false],
			[4, "rereview", true],
			[5, "rereview", false],
			[6, "your_pr_needs_you", false],
			[7, "your_pr_ready_to_merge", false],
		]);
	});
});

describe("notifierStep", () => {
	it("delivers nothing and empties the queue while disabled, and the same change delivers once enabled", () => {
		const change = board([], [requested(1)]);
		expect(step(INITIAL_NOTIFIER_STATE, change, DEFAULT_NOTIFICATION_PREFS)).toEqual({ state: INITIAL_NOTIFIER_STATE, deliver: [] });
		expect(step(INITIAL_NOTIFIER_STATE, change, on).deliver).toEqual([single(1, "Review requested")]);

		const queued = step(INITIAL_NOTIFIER_STATE, change, { ...on, digestMinutes: 30 }).state;
		expect(queued.queue).toHaveLength(1);
		expect(step(queued, tick, DEFAULT_NOTIFICATION_PREFS)).toEqual({ state: INITIAL_NOTIFIER_STATE, deliver: [] });
	});

	it("delivers each new turn on its own when nothing holds notifications", () => {
		const { deliver } = step(INITIAL_NOTIFIER_STATE, board([], [requested(1), ownPr(2, "ready_to_merge")]), on);
		expect(deliver).toEqual([single(1, "Review requested"), single(2, "Your pull request is ready to merge")]);
	});

	it("does not notify again for a turn that was already there, and does for a new kind of turn", () => {
		expect(step(INITIAL_NOTIFIER_STATE, board([requested(1)], [requested(1)]), on).deliver).toEqual([]);
		const changed = step(INITIAL_NOTIFIER_STATE, board([ownPr(2, "changes_requested")], [ownPr(2, "ready_to_merge")]), on);
		expect(changed.deliver).toEqual([single(2, "Your pull request is ready to merge")]);
	});

	it("notifies team requests only with the opt-in", () => {
		const change = board([], [teamRequested(3)]);
		expect(step(INITIAL_NOTIFIER_STATE, change, on).deliver).toEqual([]);
		expect(step(INITIAL_NOTIFIER_STATE, change, { ...on, teamRequests: true }).deliver).toEqual([
			single(3, "Review requested of your team"),
		]);
	});

	it("notifies heuristic turns only with the opt-in", () => {
		const change = board([], [likelyReady(4)]);
		expect(step(INITIAL_NOTIFIER_STATE, change, on).deliver).toEqual([]);
		expect(step(INITIAL_NOTIFIER_STATE, change, { ...on, heuristic: true }).deliver).toEqual([
			single(4, "Likely ready for another review"),
		]);
	});

	it("announces a re-request that follows a heuristic turn the user opted out of, once", () => {
		const rerequest = board([likelyReady(4)], [requested(4, true)]);
		expect(step(INITIAL_NOTIFIER_STATE, rerequest, on).deliver).toEqual([single(4, "Ready for another review")]);
		expect(step(INITIAL_NOTIFIER_STATE, rerequest, { ...on, heuristic: true }).deliver).toEqual([]);
	});

	it("holds turns during quiet hours and delivers the single one when they end", () => {
		const prefs = { ...on, quietHours: { startMinute: 12 * 60, endMinute: 13 * 60 } };
		const held = step(INITIAL_NOTIFIER_STATE, board([], [requested(1)]), prefs, at(12, 10));
		expect(held.deliver).toEqual([]);
		expect(step(held.state, tick, prefs, at(12, 59)).deliver).toEqual([]);
		expect(step(held.state, tick, prefs, at(13))).toEqual({ state: INITIAL_NOTIFIER_STATE, deliver: [single(1, "Review requested")] });
	});

	it("holds turns through quiet hours that wrap midnight and delivers one summary when they end", () => {
		const prefs = { ...on, quietHours: { startMinute: 22 * 60, endMinute: 7 * 60 } };
		const first = step(INITIAL_NOTIFIER_STATE, board([], [requested(1)]), prefs, at(23));
		const second = step(first.state, board([requested(1)], [requested(1), requested(2)]), prefs, at(2));
		expect([first.deliver, second.deliver]).toEqual([[], []]);
		expect(step(second.state, tick, prefs, at(6, 59)).deliver).toEqual([]);
		expect(step(second.state, tick, prefs, at(7)).deliver).toEqual([
			{ title: "2 pull requests need you", body: "acme/web#1: Change 1\nacme/web#2: Change 2", url: null, tag: "summary" },
		]);
	});

	it("batches turns into one summary once the digest interval has passed since the first", () => {
		const prefs = { ...on, digestMinutes: 30 };
		const first = step(INITIAL_NOTIFIER_STATE, board([], [requested(1)]), prefs, at(12));
		const second = step(first.state, board([requested(1)], [requested(1), requested(2)]), prefs, at(12, 10));
		expect([first.deliver, second.deliver]).toEqual([[], []]);
		expect(step(second.state, tick, prefs, at(12, 29)).deliver).toEqual([]);
		const flushed = step(second.state, tick, prefs, at(12, 30));
		expect(flushed.state).toEqual(INITIAL_NOTIFIER_STATE);
		expect(flushed.deliver.map((n) => n.title)).toEqual(["2 pull requests need you"]);
	});

	it("drops a queued turn that stopped being the user's turn before delivery", () => {
		const prefs = { ...on, quietHours: { startMinute: 22 * 60, endMinute: 7 * 60 } };
		const held = step(INITIAL_NOTIFIER_STATE, board([], [requested(1)]), prefs, at(23));
		const resolved = step(held.state, board([requested(1)], [card({ number: 1 })]), prefs, at(23, 30));
		expect(resolved).toEqual({ state: INITIAL_NOTIFIER_STATE, deliver: [] });
		expect(step(resolved.state, tick, prefs, at(7)).deliver).toEqual([]);
	});
});
