import type { Login } from "@radar/core";
import type { Fetch } from "./github/http.ts";
import { requestReviewers } from "./github/rest.ts";
import type { PrRef } from "./github/source.ts";

/** Radar's one write to GitHub: the author re-requests review, with the author's own token. */
export interface ReviewRequester {
	requestReviewers(input: { ref: PrRef; logins: Login[]; userToken: string }): Promise<void>;
}

export function createGitHubRequester({ fetch = globalThis.fetch }: { fetch?: Fetch } = {}): ReviewRequester {
	return {
		requestReviewers: ({ ref, logins, userToken }) => requestReviewers({ token: userToken, ref, logins, fetch }),
	};
}
