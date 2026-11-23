import type { z } from "zod";

export type Fetch = typeof globalThis.fetch;

export const API_ROOT = "https://api.github.com";
export const USER_AGENT = "pr-review-radar";

export class GitHubApiError extends Error {
	override readonly name = "GitHubApiError";
	readonly status: number;
	/** When GitHub said to retry, from `retry-after` or an exhausted `x-ratelimit-reset`. Null when GitHub reported no rate limit. */
	readonly rateLimitResetAt: Date | null;

	constructor(message: string, options: { status: number; rateLimitResetAt: Date | null }) {
		super(message);
		this.status = options.status;
		this.rateLimitResetAt = options.rateLimitResetAt;
	}
}

export function githubHeaders(token: string): Record<string, string> {
	return {
		Accept: "application/vnd.github+json",
		Authorization: `Bearer ${token}`,
		"User-Agent": USER_AGENT,
		"X-GitHub-Api-Version": "2022-11-28",
	};
}

const SECONDS = /^\d+$/;

export function rateLimitResetAt(headers: Headers): Date | null {
	const retryAfter = headers.get("retry-after");
	if (retryAfter !== null && SECONDS.test(retryAfter)) {
		return new Date(Date.now() + Number(retryAfter) * 1000);
	}
	const reset = headers.get("x-ratelimit-reset");
	if (headers.get("x-ratelimit-remaining") === "0" && reset !== null && SECONDS.test(reset)) {
		return new Date(Number(reset) * 1000);
	}
	return null;
}

export async function apiError(response: Response): Promise<GitHubApiError> {
	const detail = (await response.text()).slice(0, 300);
	return new GitHubApiError(`GitHub responded ${response.status}: ${detail}`, {
		status: response.status,
		rateLimitResetAt: rateLimitResetAt(response.headers),
	});
}

export async function readJson<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
	if (!response.ok) throw await apiError(response);
	return schema.parse(await response.json());
}
