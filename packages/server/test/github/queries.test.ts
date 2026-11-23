import { parse } from "graphql";
import { describe, expect, it } from "vitest";
import { CONNECTION_PAGE_QUERIES, OPEN_PULL_REQUESTS_QUERY, ORG_TEAMS_QUERY, TEAM_MEMBERS_QUERY, buildPullRequestsQuery } from "../../src/github/queries.ts";
import { pullRequestAliases } from "./fakeGitHub.ts";

describe("buildPullRequestsQuery", () => {
	const refs = [
		{ owner: "acme", name: "api", number: 12 },
		{ owner: "acme", name: "web.app", number: 7 },
	];

	it("emits one aliased repository block per ref, in order", () => {
		expect(pullRequestAliases(buildPullRequestsQuery(refs))).toEqual([
			{ alias: "p0", owner: "acme", name: "api", number: 12 },
			{ alias: "p1", owner: "acme", name: "web.app", number: 7 },
		]);
	});

	it("inlines each pull request number into its isRequired arguments", () => {
		const query = buildPullRequestsQuery(refs);
		expect(query.split("isRequired(pullRequestNumber: 12)")).toHaveLength(3);
		expect(query.split("isRequired(pullRequestNumber: 7)")).toHaveLength(3);
	});

	it.each([
		["an owner with a quote", { owner: 'acme"', name: "api", number: 1 }],
		["an owner with a brace", { owner: "acme}", name: "api", number: 1 }],
		["a name with a space", { owner: "acme", name: "my api", number: 1 }],
		["a zero number", { owner: "acme", name: "api", number: 0 }],
		["a fractional number", { owner: "acme", name: "api", number: 1.5 }],
	])("rejects %s", (_label, ref) => {
		expect(() => buildPullRequestsQuery([ref])).toThrow();
	});

	it("rejects an empty list", () => {
		expect(() => buildPullRequestsQuery([])).toThrow();
	});
});

describe("static queries", () => {
	it.each([OPEN_PULL_REQUESTS_QUERY, ORG_TEAMS_QUERY, TEAM_MEMBERS_QUERY, ...Object.values(CONNECTION_PAGE_QUERIES)])("parse as GraphQL", (query) => {
		expect(() => parse(query)).not.toThrow();
	});
});
