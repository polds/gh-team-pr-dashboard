import type { Login, PrId } from "./model.ts";
import type { Card } from "./protocol.ts";

export interface NotificationPrefs {
	enabled: boolean;
	teamRequests: boolean;
	heuristic: boolean;
	quietHours: { startMinute: number; endMinute: number } | null;
	digestMinutes: number;
}

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
	enabled: false,
	teamRequests: false,
	heuristic: false,
	quietHours: null,
	digestMinutes: 0,
};

export type TurnKind = "review_requested" | "rereview" | "team_review_requested" | "your_pr_needs_you" | "your_pr_ready_to_merge";

export interface Turn {
	id: PrId;
	kind: TurnKind;
	repo: string;
	number: number;
	title: string;
	url: string;
	/** True when only the re-review heuristic says it is the user's turn. */
	heuristic: boolean;
}

type TurnFacts = Pick<Turn, "kind" | "heuristic">;

function reviewerTurn(login: Login, card: Card): TurnFacts | null {
	const status = card.derived.reviewers.find((r) => r.reviewer.login === login);
	if (status === undefined) return null;
	switch (status.kind) {
		case "requested":
			return { kind: status.rerequested ? "rereview" : "review_requested", heuristic: false };
		case "approval_dismissed":
			return { kind: "rereview", heuristic: false };
		case "feedback_addressed":
			return { kind: "rereview", heuristic: card.derived.confidence !== "confirmed" };
		default:
			return null;
	}
}

function turnOf(login: Login, card: Card): TurnFacts | null {
	const { state, actors } = card.derived;
	const me = actors.find((actor) => actor.login === login);
	if (me === undefined || state === "draft") return null;
	switch (me.via.kind) {
		case "author":
			return { kind: state === "ready_to_merge" ? "your_pr_ready_to_merge" : "your_pr_needs_you", heuristic: false };
		case "team":
			return { kind: "team_review_requested", heuristic: false };
		case "direct":
			return reviewerTurn(login, card);
	}
}

export function turnsFor(login: Login, cards: Card[]): Map<PrId, Turn> {
	const turns = new Map<PrId, Turn>();
	for (const card of cards) {
		const turn = turnOf(login, card);
		if (turn !== null) {
			turns.set(card.id, { id: card.id, repo: card.repo, number: card.number, title: card.title, url: card.url, ...turn });
		}
	}
	return turns;
}

export interface NotifierState {
	queue: Turn[];
	/** When the oldest queued turn arrived, in epoch milliseconds. */
	windowStartedAt: number | null;
}

export const INITIAL_NOTIFIER_STATE: NotifierState = { queue: [], windowStartedAt: null };

export type NotifierInput = { kind: "board"; before: Card[]; after: Card[] } | { kind: "tick" };

export interface OutgoingNotification {
	title: string;
	body: string;
	url: string | null;
	tag: string;
}

const isWanted = (turn: Turn, prefs: NotificationPrefs) =>
	(turn.kind !== "team_review_requested" || prefs.teamRequests) && (!turn.heuristic || prefs.heuristic);

const wantedTurns = (login: Login, cards: Card[], prefs: NotificationPrefs) =>
	new Map([...turnsFor(login, cards)].filter(([, turn]) => isWanted(turn, prefs)));

function isQuiet(quietHours: NotificationPrefs["quietHours"], minuteOfDay: number): boolean {
	if (quietHours === null) return false;
	const { startMinute, endMinute } = quietHours;
	return startMinute <= endMinute
		? minuteOfDay >= startMinute && minuteOfDay < endMinute
		: minuteOfDay >= startMinute || minuteOfDay < endMinute;
}

/**
 * Turns compare after the opt-in filter, so a re-request that follows a heuristic turn the user
 * never heard about still counts as new.
 */
function advance(queue: Turn[], input: NotifierInput, login: Login, prefs: NotificationPrefs): { queue: Turn[]; fresh: Turn[] } {
	if (input.kind === "tick") return { queue, fresh: [] };
	const before = wantedTurns(login, input.before, prefs);
	const after = wantedTurns(login, input.after, prefs);
	const kept = queue.flatMap((queued) => {
		const current = after.get(queued.id);
		return current?.kind === queued.kind ? [current] : [];
	});
	const fresh = [...after.values()].filter(
		(turn) => before.get(turn.id)?.kind !== turn.kind && !kept.some((queued) => queued.id === turn.id),
	);
	return { queue: kept, fresh };
}

const TITLES: Record<TurnKind, string> = {
	review_requested: "Review requested",
	rereview: "Ready for another review",
	team_review_requested: "Review requested of your team",
	your_pr_needs_you: "Your pull request needs you",
	your_pr_ready_to_merge: "Your pull request is ready to merge",
};

const lineOf = (turn: Turn) => `${turn.repo}#${turn.number}: ${turn.title}`;

function notificationOf(turn: Turn): OutgoingNotification {
	const title = turn.heuristic ? "Likely ready for another review" : TITLES[turn.kind];
	return { title, body: lineOf(turn), url: turn.url, tag: turn.id };
}

function bundled(turns: readonly Turn[]): OutgoingNotification[] {
	const [only, ...rest] = turns;
	if (only === undefined) return [];
	if (rest.length === 0) return [notificationOf(only)];
	return [{ title: `${turns.length} pull requests need you`, body: turns.map(lineOf).join("\n"), url: null, tag: "summary" }];
}

export function notifierStep(
	state: NotifierState,
	input: NotifierInput,
	context: { login: Login; prefs: NotificationPrefs; nowMs: number; minuteOfDay: number },
): { state: NotifierState; deliver: OutgoingNotification[] } {
	const { login, prefs, nowMs, minuteOfDay } = context;
	if (!prefs.enabled) return { state: INITIAL_NOTIFIER_STATE, deliver: [] };
	const { queue, fresh } = advance(state.queue, input, login, prefs);
	const quiet = isQuiet(prefs.quietHours, minuteOfDay);
	if (!quiet && prefs.digestMinutes === 0) {
		return { state: INITIAL_NOTIFIER_STATE, deliver: queue.length === 0 ? fresh.map(notificationOf) : bundled([...queue, ...fresh]) };
	}
	const held = [...queue, ...fresh];
	const windowStartedAt = queue.length > 0 ? (state.windowStartedAt ?? nowMs) : fresh.length > 0 ? nowMs : null;
	const due = !quiet && windowStartedAt !== null && nowMs - windowStartedAt >= prefs.digestMinutes * 60_000;
	if (due) return { state: INITIAL_NOTIFIER_STATE, deliver: bundled(held) };
	return { state: { queue: held, windowStartedAt }, deliver: [] };
}
