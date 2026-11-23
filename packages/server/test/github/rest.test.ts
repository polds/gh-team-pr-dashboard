import { asLogin } from "@radar/core";
import { describe, expect, it } from "vitest";
import { GitHubApiError } from "../../src/github/http.ts";
import {
	exchangeOAuthCode,
	findOrgInstallation,
	getAuthenticatedUser,
	isOrgMember,
	listInstallationRepos,
	requestReviewers,
} from "../../src/github/rest.ts";
import { fakeFetch, json } from "./fakeGitHub.ts";

describe("REST helpers", () => {
	it("finds the organization's installation id with the app JWT and the API headers", async () => {
		const { fetch, requests } = fakeFetch(() => json({ id: 77, account: { login: "acme" } }));
		await expect(findOrgInstallation({ token: "app.jwt", org: "acme", fetch })).resolves.toBe(77);
		expect(requests[0]?.url).toBe("https://api.github.com/orgs/acme/installation");
		expect(requests[0]?.headers.get("authorization")).toBe("Bearer app.jwt");
		expect(requests[0]?.headers.get("x-github-api-version")).toBe("2022-11-28");
		expect(requests[0]?.headers.get("user-agent")).toBe("pr-review-radar");
	});

	it("follows the Link header through every page of installation repositories", async () => {
		const next = "https://api.github.com/installation/repositories?per_page=100&page=2";
		const repo = (name: string, archived: boolean) => ({ name, owner: { login: "acme" }, archived });
		const { fetch, requests } = fakeFetch((request) =>
			request.url === next
				? json({ total_count: 3, repositories: [repo("web", false)] })
				: json({ total_count: 3, repositories: [repo("api", false), repo("legacy", true)] }, { headers: { link: `<${next}>; rel="next", <${next}>; rel="last"` } }),
		);
		await expect(listInstallationRepos({ token: "ghs", fetch })).resolves.toEqual([
			{ owner: "acme", name: "api", archived: false },
			{ owner: "acme", name: "legacy", archived: true },
			{ owner: "acme", name: "web", archived: false },
		]);
		expect(requests.map((request) => request.url)).toEqual(["https://api.github.com/installation/repositories?per_page=100", next]);
	});

	it.each([
		[204, true],
		[404, false],
		[302, false],
	])("reads membership status %i as %s without following redirects", async (status, member) => {
		const { fetch, requests } = fakeFetch(() => new Response(null, { status }));
		await expect(isOrgMember({ token: "ghs", org: "acme", login: asLogin("alice"), fetch })).resolves.toBe(member);
		expect(requests[0]?.url).toBe("https://api.github.com/orgs/acme/members/alice");
		expect(requests[0]?.redirect).toBe("manual");
	});

	it("throws on an unexpected membership status", async () => {
		const { fetch } = fakeFetch(() => new Response("nope", { status: 403 }));
		await expect(isOrgMember({ token: "ghs", org: "acme", login: asLogin("alice"), fetch })).rejects.toMatchObject({ status: 403 });
	});

	it("posts the reviewers to re-request", async () => {
		const { fetch, requests } = fakeFetch(() => json({ number: 12 }, { status: 201 }));
		await requestReviewers({ token: "ghu_user", ref: { owner: "acme", name: "api", number: 12 }, logins: [asLogin("bob")], fetch });
		expect(requests[0]?.method).toBe("POST");
		expect(requests[0]?.url).toBe("https://api.github.com/repos/acme/api/pulls/12/requested_reviewers");
		expect(requests[0]?.headers.get("authorization")).toBe("Bearer ghu_user");
		expect(JSON.parse(requests[0]?.body ?? "")).toEqual({ reviewers: ["bob"] });
	});

	it("throws when GitHub refuses the re-request", async () => {
		const { fetch } = fakeFetch(() => new Response("{}", { status: 422 }));
		const result = requestReviewers({ token: "ghu_user", ref: { owner: "acme", name: "api", number: 12 }, logins: [asLogin("bob")], fetch });
		await expect(result).rejects.toBeInstanceOf(GitHubApiError);
	});

	it("exchanges an OAuth code for a user token", async () => {
		const { fetch, requests } = fakeFetch(() => json({ access_token: "ghu_new", token_type: "bearer", expires_in: 28800 }));
		await expect(exchangeOAuthCode({ clientId: "Iv1.abc", clientSecret: "shh", code: "c0de", fetch })).resolves.toEqual({
			accessToken: "ghu_new",
			expiresInSeconds: 28800,
		});
		expect(requests[0]?.url).toBe("https://github.com/login/oauth/access_token");
		expect(requests[0]?.headers.get("accept")).toBe("application/json");
		expect(JSON.parse(requests[0]?.body ?? "")).toEqual({ client_id: "Iv1.abc", client_secret: "shh", code: "c0de" });
	});

	it("reports a non-expiring user token with a null lifetime", async () => {
		const { fetch } = fakeFetch(() => json({ access_token: "ghu_forever", token_type: "bearer" }));
		await expect(exchangeOAuthCode({ clientId: "a", clientSecret: "b", code: "c", fetch })).resolves.toEqual({
			accessToken: "ghu_forever",
			expiresInSeconds: null,
		});
	});

	it("throws on the error body GitHub returns with HTTP 200 for a bad code", async () => {
		const { fetch } = fakeFetch(() => json({ error: "bad_verification_code", error_description: "The code passed is incorrect or expired." }));
		await expect(exchangeOAuthCode({ clientId: "a", clientSecret: "b", code: "used", fetch })).rejects.toBeInstanceOf(GitHubApiError);
	});

	it("reads the signed-in user", async () => {
		const { fetch, requests } = fakeFetch(() => json({ login: "alice", avatar_url: "https://avatars.example/alice", name: null, id: 1 }));
		await expect(getAuthenticatedUser({ token: "ghu_user", fetch })).resolves.toEqual({
			login: "alice",
			avatarUrl: "https://avatars.example/alice",
			name: null,
		});
		expect(requests[0]?.url).toBe("https://api.github.com/user");
	});
});
