import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { asSha } from "@radar/core";
import type { Sha } from "@radar/core";

export function verifySignature(secret: string, rawBody: string | Uint8Array, signatureHeader: string | undefined): boolean {
	const hex = signatureHeader?.match(/^sha256=([0-9a-f]{64})$/)?.[1];
	if (hex === undefined) return false;
	const expected = createHmac("sha256", secret).update(rawBody).digest();
	return timingSafeEqual(expected, Buffer.from(hex, "hex"));
}

export type WebhookHint =
	| { kind: "pr"; owner: string; name: string; number: number }
	| { kind: "sha"; owner: string; name: string; sha: Sha };

const repositorySchema = z.object({ name: z.string(), owner: z.object({ login: z.string() }) });
type Repository = z.infer<typeof repositorySchema>;

const prNumberSchema = z.number().int().positive();

const checkTargetSchema = z.object({
	head_sha: z.string(),
	pull_requests: z.array(z.object({ number: prNumberSchema })),
});
type CheckTarget = z.infer<typeof checkTargetSchema>;

function prHint({ owner, name }: Repository, number: number): WebhookHint {
	return { kind: "pr", owner: owner.login, name, number };
}

function shaHint({ owner, name }: Repository, sha: string): WebhookHint {
	return { kind: "sha", owner: owner.login, name, sha: asSha(sha) };
}

/** A fork's check payload lists no pull requests, so the head SHA stands in. */
function checkHints(repository: Repository, target: CheckTarget): WebhookHint[] {
	if (target.pull_requests.length === 0) return [shaHint(repository, target.head_sha)];
	return target.pull_requests.map(({ number }) => prHint(repository, number));
}

const pullRequestEventSchema = z
	.object({ repository: repositorySchema, pull_request: z.object({ number: prNumberSchema }) })
	.transform(({ repository, pull_request }) => [prHint(repository, pull_request.number)]);

const HINT_SCHEMAS = new Map<string, z.ZodType<WebhookHint[]>>([
	["pull_request", pullRequestEventSchema],
	["pull_request_review", pullRequestEventSchema],
	["pull_request_review_comment", pullRequestEventSchema],
	["pull_request_review_thread", pullRequestEventSchema],
	[
		"check_run",
		z
			.object({ repository: repositorySchema, check_run: checkTargetSchema })
			.transform(({ repository, check_run }) => checkHints(repository, check_run)),
	],
	[
		"check_suite",
		z
			.object({ repository: repositorySchema, check_suite: checkTargetSchema })
			.transform(({ repository, check_suite }) => checkHints(repository, check_suite)),
	],
	[
		"status",
		z
			.object({ repository: repositorySchema, sha: z.string() })
			.transform(({ repository, sha }) => [shaHint(repository, sha)]),
	],
]);

export function hintsFromEvent(eventName: string, payload: unknown): WebhookHint[] {
	const result = HINT_SCHEMAS.get(eventName)?.safeParse(payload);
	return result?.success ? result.data : [];
}
