import type { Login } from "@radar/core";
import type { Fetch } from "./github/http.ts";
import { requestReviewers } from "./github/rest.ts";
import type { PrRef } from "./github/source.ts";

export interface ReviewRequester {
	requestReviewers(input: { ref: PrRef; logins: Login[]; userToken: string | null }): Promise<void>;
}

export function createGitHubRequester({ fetch = globalThis.fetch }: { fetch?: Fetch } = {}): ReviewRequester {
	return {
		async requestReviewers({ ref, logins, userToken }) {
			if (userToken === null) throw new Error("the session holds no user token");
			await requestReviewers({ token: userToken, ref, logins, fetch });
		},
	};
}
