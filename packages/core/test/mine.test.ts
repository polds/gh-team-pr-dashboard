import { describe, expect, it } from "vitest";
import { mineFor } from "../src/index.ts";
import type { Card } from "../src/index.ts";
import { asAuthor, card, direct, hour, human, viaTeam } from "./builders.ts";

const rex = human("rex");
const cora = human("cora");
const numbers = (cards: Card[]) => cards.map((c) => c.number);

describe("mineFor", () => {
	it("sorts one person's board into review requests, team requests, their turn, and waiting on others", () => {
		const mine = mineFor(rex.login, [
			card({ number: 1, since: hour(5), derived: { actors: [direct(rex)] } }),
			card({ number: 2, derived: { actors: [viaTeam(rex, "web"), direct(cora)] } }),
			card({ number: 3, author: rex, derived: { state: "changes_requested", court: "author", actors: [asAuthor(rex)] } }),
			card({ number: 4, author: rex, derived: { state: "in_review", actors: [direct(cora)] } }),
			card({ number: 5, author: rex, derived: { state: "merged", court: "nobody" } }),
			card({ number: 6, derived: { actors: [direct(cora)] } }),
			card({ number: 7, since: hour(1), derived: { actors: [direct(rex)] } }),
			card({ number: 8, derived: { state: "closed", court: "nobody", actors: [direct(rex)] } }),
		]);
		expect(numbers(mine.needsMyReview)).toEqual([7, 1]);
		expect(numbers(mine.teamRequests)).toEqual([2]);
		expect(numbers(mine.myTurn)).toEqual([3]);
		expect(numbers(mine.waitingOnOthers)).toEqual([4]);
	});
});
