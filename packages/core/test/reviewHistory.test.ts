import { describe, expect, it } from "vitest";
import { asTeamSlug, emptyHistory, recordReviews, suggestReviewers } from "../src/index.ts";
import type { Login, Person, PrSnapshot, Review } from "../src/index.ts";
import { ana, bot, hour, human, pr, requestOf, review, reviews, teamRequestOf } from "./builders.ts";

const bea = human("bea");
const cora = human("cora");
const rex = human("rex");
const sam = human("sam");
const tom = human("tom");
const uma = human("uma");
const zed = human("zed");
const deployBot = bot("deploy-bot");
const people = new Map<Login, Person>([ana, bea, cora, rex, sam, tom, uma, zed, deployBot].map((p) => [p.login, p]));
const teams = new Map([[asTeamSlug("web"), [ana.login, rex.login, deployBot.login, sam.login, tom.login]]]);

const past = (repo: string, paths: string[], ...history: Review[]): PrSnapshot =>
	pr({ repo: { owner: "acme", name: repo }, author: cora, paths, ...reviews(...history) });

function historyOfPastWork() {
	const history = emptyHistory();
	const billing = ["services/billing/src/export.ts"];
	recordReviews(history, past("web", billing, review(bea, "APPROVED", hour(1)), review(tom, "COMMENTED", hour(5))));
	recordReviews(history, past("web", billing, review(bea, "CHANGES_REQUESTED", hour(8))));
	recordReviews(history, past("api", billing, review(zed, "APPROVED", hour(9))));
	recordReviews(history, past("web", ["docs/guide.md"], review(uma, "APPROVED", hour(10))));
	recordReviews(history, past("web", billing, review(rex, "APPROVED", hour(11)), review(ana, "COMMENTED", hour(12))));
	recordReviews(history, past("web", billing, review(bot("lint[bot]"), "COMMENTED", hour(13))));
	return history;
}

const current = pr({
	paths: ["services/billing/src/invoice.ts"],
	reviewRequests: [requestOf(rex), teamRequestOf("web")],
});

describe("suggestReviewers", () => {
	it("prefers the latest reviewers of the same areas in the same repository, then members of requested teams", () => {
		const suggested = suggestReviewers({ snapshot: current, history: historyOfPastWork(), teams, people, limit: 3 });
		expect(suggested).toEqual([bea, tom, sam]);
	});

	it("stops at the limit", () => {
		expect(suggestReviewers({ snapshot: current, history: historyOfPastWork(), teams, people, limit: 2 })).toEqual([bea, tom]);
	});

	it("never suggests the author, a bot, or someone already reviewing", () => {
		const suggested = suggestReviewers({ snapshot: current, history: historyOfPastWork(), teams, people, limit: 10 });
		expect(suggested).toEqual([bea, tom, sam]);
	});

	it("suggests only team members when the history is empty", () => {
		expect(suggestReviewers({ snapshot: current, history: emptyHistory(), teams, people, limit: 3 })).toEqual([sam, tom]);
	});
});
