import { describe, expect, it } from "vitest";
import { z } from "zod";
import { graphqlRequest, isNotFound } from "../../src/github/graphql.ts";
import { GitHubApiError } from "../../src/github/http.ts";
import { fakeFetch, graphqlBody, json } from "./fakeGitHub.ts";

const schema = z.object({ viewer: z.object({ login: z.string() }) });

function request(response: Response, allowErrors?: (error: { type?: string; message: string }) => boolean) {
	const github = fakeFetch(() => response);
	const result = graphqlRequest({ token: "ghs_token", query: "query { viewer { login } }", variables: { a: 1 }, schema, allowErrors, fetch: github.fetch });
	return { result, requests: github.requests };
}

describe("graphqlRequest", () => {
	it("posts the query with the token and parses data with the schema", async () => {
		const { result, requests } = request(json({ data: { viewer: { login: "radar[bot]" } } }));
		await expect(result).resolves.toEqual({ viewer: { login: "radar[bot]" } });
		expect(requests[0]?.url).toBe("https://api.github.com/graphql");
		expect(requests[0]?.headers.get("authorization")).toBe("Bearer ghs_token");
		expect(requests[0] && graphqlBody(requests[0])).toEqual({ query: "query { viewer { login } }", variables: { a: 1 } });
	});

	it("throws GitHubApiError with the status on an HTTP error", async () => {
		const { result } = request(new Response("bad gateway", { status: 502 }));
		await expect(result).rejects.toMatchObject({ name: "GitHubApiError", status: 502, rateLimitResetAt: null });
	});

	it("throws GitHubApiError when errors come without data", async () => {
		const { result } = request(json({ data: null, errors: [{ message: "Something went wrong" }] }));
		await expect(result).rejects.toBeInstanceOf(GitHubApiError);
	});

	it("carries the rate-limit reset when GitHub reports the limit exhausted", async () => {
		const response = json(
			{ errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] },
			{ status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1795000000" } },
		);
		await expect(request(response).result).rejects.toMatchObject({ status: 403, rateLimitResetAt: new Date(1795000000 * 1000) });
	});

	it("rejects partial data unless every error is allowed", async () => {
		const body = { data: { viewer: { login: "radar[bot]" } }, errors: [{ type: "NOT_FOUND", message: "Could not resolve" }] };
		await expect(request(json(body)).result).rejects.toBeInstanceOf(GitHubApiError);
		await expect(request(json(body), isNotFound).result).resolves.toEqual({ viewer: { login: "radar[bot]" } });
	});

	it("rejects data that does not match the schema", async () => {
		await expect(request(json({ data: { viewer: { name: "Radar" } } })).result).rejects.toThrow();
	});
});
