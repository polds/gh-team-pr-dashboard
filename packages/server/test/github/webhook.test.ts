import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hintsFromEvent, verifySignature } from "../../src/github/webhook.ts";

describe("verifySignature", () => {
	const secret = "webhook-secret";
	const body = JSON.stringify({ action: "opened", number: 12 });
	const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

	it("accepts the signature GitHub computes over the raw body", () => {
		expect(verifySignature(secret, body, signature)).toBe(true);
		expect(verifySignature(secret, new TextEncoder().encode(body), signature)).toBe(true);
	});

	it("rejects a signature made with another secret", () => {
		expect(verifySignature("other-secret", body, signature)).toBe(false);
	});

	it("rejects a tampered body", () => {
		expect(verifySignature(secret, body.replace("12", "13"), signature)).toBe(false);
	});

	it("rejects a missing header", () => {
		expect(verifySignature(secret, body, undefined)).toBe(false);
	});

	it("rejects a header without the sha256= prefix", () => {
		expect(verifySignature(secret, body, signature.slice("sha256=".length))).toBe(false);
	});

	it("rejects a truncated digest", () => {
		expect(verifySignature(secret, body, signature.slice(0, -2))).toBe(false);
	});
});

describe("hintsFromEvent", () => {
	const repository = { name: "api", owner: { login: "acme" } };
	const prHint = (number: number) => ({ kind: "pr", owner: "acme", name: "api", number });
	const shaHint = (sha: string) => ({ kind: "sha", owner: "acme", name: "api", sha });

	it.each(["pull_request", "pull_request_review", "pull_request_review_comment", "pull_request_review_thread"])(
		"maps %s to its pull request",
		(event) => {
			expect(hintsFromEvent(event, { action: "submitted", repository, pull_request: { number: 12 } })).toEqual([prHint(12)]);
		},
	);

	it("maps check_run to each listed pull request", () => {
		const payload = { repository, check_run: { head_sha: "abc", pull_requests: [{ number: 12 }, { number: 14 }] } };
		expect(hintsFromEvent("check_run", payload)).toEqual([prHint(12), prHint(14)]);
	});

	it("maps check_suite to each listed pull request", () => {
		const payload = { repository, check_suite: { head_sha: "abc", pull_requests: [{ number: 9 }] } };
		expect(hintsFromEvent("check_suite", payload)).toEqual([prHint(9)]);
	});

	it.each(["check_run", "check_suite"])("falls back to the head SHA when %s lists no pull requests", (event) => {
		const payload = { repository, [event]: { head_sha: "abc", pull_requests: [] } };
		expect(hintsFromEvent(event, payload)).toEqual([shaHint("abc")]);
	});

	it("maps status to its commit SHA", () => {
		expect(hintsFromEvent("status", { repository, sha: "def", state: "success" })).toEqual([shaHint("def")]);
	});

	it.each(["push", "issues", "constructor", "__proto__"])("ignores the %s event", (event) => {
		expect(hintsFromEvent(event, { repository, pull_request: { number: 12 } })).toEqual([]);
	});

	it.each([null, "garbage", { repository }, { repository, pull_request: { number: "12" } }])(
		"ignores a pull_request payload that does not parse: %j",
		(payload) => {
			expect(hintsFromEvent("pull_request", payload)).toEqual([]);
		},
	);
});
