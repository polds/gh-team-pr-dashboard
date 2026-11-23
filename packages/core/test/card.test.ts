import { describe, expect, it } from "vitest";
import { areasOf, asTeamSlug, buildCard, derive, isBotAuthor } from "../src/index.ts";
import type { CardConfig, PrSnapshot } from "../src/index.ts";
import { ana, bot, check, context, hour, human, pr, requestOf, teamRequestOf } from "./builders.ts";

const rex = human("rex");

const config: CardConfig = {
	priorityLabels: ["priority", "urgent", "hotfix"],
	helpWantedAfterBusinessHours: 24,
	timeZone: "America/Los_Angeles",
	botLogins: ["renovate"],
};

function cardFor(facts: Partial<PrSnapshot>, at: { since: number; now: number }) {
	const snapshot = pr(facts);
	return buildCard({
		snapshot,
		derived: derive(snapshot, context()),
		since: hour(at.since),
		now: new Date(hour(at.now)),
		config,
		suggested: [human("sam")],
	});
}

describe("areasOf", () => {
	it("keeps the first two directories of each path, most touched first", () => {
		const paths = [
			"docs/readme.md",
			"services/billing/src/export.ts",
			"services/billing/test/export.test.ts",
			"README.md",
			"services/auth/session.ts",
		];
		expect(areasOf(paths)).toEqual(["services/billing", "docs", "(root)", "services/auth"]);
	});

	it("caps the list at six areas", () => {
		const paths = ["a/x.ts", "b/x.ts", "c/x.ts", "d/x.ts", "e/x.ts", "f/x.ts", "g/x.ts", "g/y.ts"];
		expect(areasOf(paths)).toEqual(["g", "a", "b", "c", "d", "e"]);
	});
});

describe("isBotAuthor", () => {
	it("recognizes bot accounts, [bot] logins, and configured logins in any case", () => {
		expect(isBotAuthor(bot("dependabot"), [])).toBe(true);
		expect(isBotAuthor(human("github-actions[bot]"), [])).toBe(true);
		expect(isBotAuthor(human("Renovate"), ["renovate"])).toBe(true);
		expect(isBotAuthor(rex, ["renovate"])).toBe(false);
	});
});

describe("buildCard", () => {
	it("summarizes the pull request for the board", () => {
		const card = cardFor(
			{
				labels: ["Urgent", "billing"],
				paths: ["services/billing/src/export.ts"],
				reviewRequests: [teamRequestOf("web")],
				checks: [check("build", "passing"), check("lint", "failing", false), check("e2e", "pending")],
			},
			{ since: 0, now: 1 },
		);
		expect(card).toMatchObject({
			id: "PR_1",
			repo: "acme/web",
			number: 1,
			author: ana,
			isBotPr: false,
			areas: ["services/billing"],
			requestedTeams: [{ slug: asTeamSlug("web"), name: "Team web" }],
			checks: { verdict: "failing", failing: ["lint"], pending: ["e2e"], total: 3 },
			since: hour(0),
			priority: true,
			helpWanted: null,
		});
		expect(cardFor({ checks: [] }, { since: 0, now: 1 }).checks).toEqual({ verdict: "none", failing: [], pending: [], total: 0 });
		expect(cardFor({ checks: [check("build", "passing"), check("e2e", "pending")] }, { since: 0, now: 1 }).checks.verdict).toBe("pending");
	});

	it("asks for help once reviewers have held the pull request past the business-hour threshold", () => {
		const waiting = { reviewRequests: [requestOf(rex)] };
		expect(cardFor(waiting, { since: 0, now: 25 }).helpWanted).toEqual({ suggested: [human("sam")] });
		expect(cardFor(waiting, { since: 0, now: 23 }).helpWanted).toBeNull();
	});

	it("does not count the weekend toward the threshold", () => {
		const fridayMorning = 96;
		const mondayMorning = fridayMorning + 71;
		expect(cardFor({ reviewRequests: [requestOf(rex)] }, { since: fridayMorning, now: mondayMorning }).helpWanted).toBeNull();
	});

	it("never asks for help on a draft, a bot pull request, or a pull request waiting on its author", () => {
		const longWait = { since: 0, now: 100 };
		expect(cardFor({ isDraft: true, reviewRequests: [requestOf(rex)] }, longWait).helpWanted).toBeNull();
		expect(cardFor({ author: bot("dependabot[bot]"), reviewRequests: [requestOf(rex)] }, longWait)).toMatchObject({
			isBotPr: true,
			helpWanted: null,
		});
		const changesRequested: Partial<PrSnapshot> = { reviewDecision: "CHANGES_REQUESTED" };
		expect(cardFor(changesRequested, longWait).helpWanted).toBeNull();
	});
});
