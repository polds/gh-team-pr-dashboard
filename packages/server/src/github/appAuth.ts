import { createPrivateKey, sign } from "node:crypto";
import { z } from "zod";
import { API_ROOT, githubHeaders, readJson } from "./http.ts";
import type { Fetch } from "./http.ts";

export interface AppAuth {
	appJwt(): string;
	installationToken(installationId: number): Promise<string>;
}

const accessTokenSchema = z.object({ token: z.string(), expires_at: z.iso.datetime({ offset: true }) });

const REFRESH_BEFORE_EXPIRY_MS = 60_000;

function base64url(value: object): string {
	return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function createAppAuth({
	appId,
	privateKeyPem,
	fetch = globalThis.fetch,
	now = Date.now,
}: {
	appId: string;
	privateKeyPem: string;
	fetch?: Fetch;
	now?: () => number;
}): AppAuth {
	const privateKey = createPrivateKey(privateKeyPem);
	const cached = new Map<number, { token: string; refreshAt: number }>();
	const inFlight = new Map<number, Promise<string>>();

	function appJwt(): string {
		const seconds = Math.floor(now() / 1000);
		const unsigned = `${base64url({ alg: "RS256", typ: "JWT" })}.${base64url({ iat: seconds - 60, exp: seconds + 9 * 60, iss: appId })}`;
		return `${unsigned}.${sign("sha256", Buffer.from(unsigned), privateKey).toString("base64url")}`;
	}

	async function requestToken(installationId: number): Promise<string> {
		const response = await fetch(`${API_ROOT}/app/installations/${installationId}/access_tokens`, {
			method: "POST",
			headers: githubHeaders(appJwt()),
		});
		const { token, expires_at } = await readJson(response, accessTokenSchema);
		cached.set(installationId, { token, refreshAt: Date.parse(expires_at) - REFRESH_BEFORE_EXPIRY_MS });
		return token;
	}

	function installationToken(installationId: number): Promise<string> {
		const entry = cached.get(installationId);
		if (entry !== undefined && now() < entry.refreshAt) return Promise.resolve(entry.token);
		const pending = inFlight.get(installationId);
		if (pending !== undefined) return pending;
		const request = requestToken(installationId).finally(() => inFlight.delete(installationId));
		inFlight.set(installationId, request);
		return request;
	}

	return { appJwt, installationToken };
}
