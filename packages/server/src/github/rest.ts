import { z } from "zod";
import { asLogin } from "@radar/core";
import type { Login } from "@radar/core";
import { API_ROOT, GitHubApiError, USER_AGENT, apiError, githubHeaders, readJson } from "./http.ts";
import type { Fetch } from "./http.ts";
import type { PrRef } from "./source.ts";

interface Authorized {
	token: string;
	fetch?: Fetch;
}

export async function findOrgInstallation({ token, org, fetch = globalThis.fetch }: Authorized & { org: string }): Promise<number> {
	const response = await fetch(`${API_ROOT}/orgs/${encodeURIComponent(org)}/installation`, { headers: githubHeaders(token) });
	return (await readJson(response, z.object({ id: z.number().int() }))).id;
}

export interface InstallationRepo {
	owner: string;
	name: string;
	archived: boolean;
}

const repositoriesPageSchema = z.object({
	repositories: z.array(z.object({ name: z.string(), owner: z.object({ login: z.string() }), archived: z.boolean() })),
});

function nextPage(link: string | null): string | null {
	return link?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
}

export async function listInstallationRepos({ token, fetch = globalThis.fetch }: Authorized): Promise<InstallationRepo[]> {
	const repos: InstallationRepo[] = [];
	let url: string | null = `${API_ROOT}/installation/repositories?per_page=100`;
	while (url !== null) {
		const response: Response = await fetch(url, { headers: githubHeaders(token) });
		const { repositories } = await readJson(response, repositoriesPageSchema);
		repos.push(...repositories.map(({ owner, name, archived }) => ({ owner: owner.login, name, archived })));
		url = nextPage(response.headers.get("link"));
	}
	return repos;
}

export async function isOrgMember({
	token,
	org,
	login,
	fetch = globalThis.fetch,
}: Authorized & { org: string; login: Login }): Promise<boolean> {
	const response = await fetch(`${API_ROOT}/orgs/${encodeURIComponent(org)}/members/${encodeURIComponent(login)}`, {
		headers: githubHeaders(token),
		redirect: "manual",
	});
	switch (response.status) {
		case 204:
			return true;
		case 302:
		case 404:
			return false;
		default:
			throw await apiError(response);
	}
}

/** Needs a user token, so GitHub records the re-request as the signed-in author's. */
export async function requestReviewers({
	token,
	ref,
	logins,
	fetch = globalThis.fetch,
}: Authorized & { ref: PrRef; logins: readonly Login[] }): Promise<void> {
	const response = await fetch(
		`${API_ROOT}/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.name)}/pulls/${ref.number}/requested_reviewers`,
		{
			method: "POST",
			headers: { ...githubHeaders(token), "Content-Type": "application/json" },
			body: JSON.stringify({ reviewers: logins }),
		},
	);
	if (!response.ok) throw await apiError(response);
}

const oauthTokenSchema = z.union([
	z.object({ access_token: z.string(), expires_in: z.number().int().optional() }),
	z.object({ error: z.string(), error_description: z.string().optional() }),
]);

/** GitHub answers a bad code with HTTP 200 and an `error` field, so that case throws too. */
export async function exchangeOAuthCode({
	clientId,
	clientSecret,
	code,
	fetch = globalThis.fetch,
}: {
	clientId: string;
	clientSecret: string;
	code: string;
	fetch?: Fetch;
}): Promise<{ accessToken: string; expiresInSeconds: number | null }> {
	const response = await fetch("https://github.com/login/oauth/access_token", {
		method: "POST",
		headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": USER_AGENT },
		body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
	});
	const body = await readJson(response, oauthTokenSchema);
	if ("error" in body) {
		throw new GitHubApiError(`OAuth code exchange failed: ${body.error_description ?? body.error}`, {
			status: response.status,
			rateLimitResetAt: null,
		});
	}
	return { accessToken: body.access_token, expiresInSeconds: body.expires_in ?? null };
}

export interface AuthenticatedUser {
	login: Login;
	avatarUrl: string;
	name: string | null;
}

const userSchema = z.object({ login: z.string(), avatar_url: z.string(), name: z.string().nullable() });

export async function getAuthenticatedUser({ token, fetch = globalThis.fetch }: Authorized): Promise<AuthenticatedUser> {
	const response = await fetch(`${API_ROOT}/user`, { headers: githubHeaders(token) });
	const { login, avatar_url, name } = await readJson(response, userSchema);
	return { login: asLogin(login), avatarUrl: avatar_url, name };
}
