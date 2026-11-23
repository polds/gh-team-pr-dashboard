import type { Court, PrState } from "./model.ts";
import type { Card } from "./protocol.ts";

export type LaneId = Exclude<PrState, "draft" | "merged" | "closed">;

export interface Lane {
	id: LaneId;
	title: string;
	court: Court;
}

/** `approved_blocked` has no single court. Its lane shows the author, who holds most blockers. */
export const LANES: readonly Lane[] = [
	{ id: "needs_review", title: "Needs review", court: "reviewers" },
	{ id: "in_review", title: "In review", court: "reviewers" },
	{ id: "changes_requested", title: "Author addressing", court: "author" },
	{ id: "likely_ready_for_rereview", title: "Likely ready for re-review", court: "reviewers" },
	{ id: "approved_blocked", title: "Approved, blocked", court: "author" },
	{ id: "ready_to_merge", title: "Ready to merge", court: "author" },
];

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function compareCards(a: Card, b: Card): number {
	return (
		Number(b.priority) - Number(a.priority) ||
		Date.parse(a.since) - Date.parse(b.since) ||
		byText(a.repo, b.repo) ||
		a.number - b.number
	);
}

export interface BoardLayout {
	helpWanted: Card[];
	lanes: Record<LaneId, Card[]>;
	drafts: Card[];
	bots: Card[];
	done: Card[];
}

type Place = LaneId | "drafts" | "bots" | "done";

function placeOf(card: Card): Place {
	if (card.isBotPr) return "bots";
	const { state } = card.derived;
	switch (state) {
		case "draft":
			return "drafts";
		case "merged":
		case "closed":
			return "done";
		default:
			return state;
	}
}

export function layoutBoard(cards: Card[]): BoardLayout {
	const layout: BoardLayout = {
		helpWanted: [],
		lanes: {
			needs_review: [],
			in_review: [],
			changes_requested: [],
			likely_ready_for_rereview: [],
			approved_blocked: [],
			ready_to_merge: [],
		},
		drafts: [],
		bots: [],
		done: [],
	};
	for (const card of [...cards].sort(compareCards)) {
		const place = placeOf(card);
		if (place === "drafts" || place === "bots" || place === "done") {
			layout[place].push(card);
			continue;
		}
		layout.lanes[place].push(card);
		if (card.helpWanted !== null) layout.helpWanted.push(card);
	}
	return layout;
}
