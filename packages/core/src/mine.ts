import type { Login } from "./model.ts";
import { compareCards } from "./order.ts";
import type { Card } from "./protocol.ts";

export interface Mine {
	needsMyReview: Card[];
	teamRequests: Card[];
	myTurn: Card[];
	waitingOnOthers: Card[];
}

function listFor(login: Login, card: Card): keyof Mine | null {
	const { state, actors } = card.derived;
	if (state === "merged" || state === "closed" || state === "draft") return null;
	const me = actors.find((actor) => actor.login === login);
	if (card.author.login === login) return me === undefined ? "waitingOnOthers" : "myTurn";
	switch (me?.via.kind) {
		case "direct":
			return "needsMyReview";
		case "team":
			return "teamRequests";
		default:
			return null;
	}
}

export function mineFor(login: Login, cards: Card[]): Mine {
	const mine: Mine = { needsMyReview: [], teamRequests: [], myTurn: [], waitingOnOthers: [] };
	for (const card of [...cards].sort(compareCards)) {
		const list = listFor(login, card);
		if (list !== null) mine[list].push(card);
	}
	return mine;
}
