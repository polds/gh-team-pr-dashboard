import { describe, expect, it } from "vitest";
import { asLogin } from "@radar/core";
import { createSessionCodec, sessionExpiry } from "../src/session.ts";
import type { Session } from "../src/session.ts";

const NOW = new Date("2026-11-04T10:00:00Z");
const session: Session = {
	login: asLogin("ada"),
	avatarUrl: "https://avatars.example/ada",
	name: "Ada",
	userToken: "ghu_secret",
	expiresAt: NOW.getTime() + 60_000,
};

describe("session cookie", () => {
	const codec = createSessionCodec("s".repeat(64));

	it("opens what it sealed, and the sealed value does not show the token", () => {
		const sealed = codec.seal(session);
		expect(sealed).not.toContain("ghu_secret");
		expect(Buffer.from(sealed, "base64url").toString("latin1")).not.toContain("ghu_secret");
		expect(codec.open(sealed, NOW)).toEqual(session);
	});

	it("rejects a tampered cookie", () => {
		const sealed = Buffer.from(codec.seal(session), "base64url");
		sealed[20] = (sealed[20] ?? 0) ^ 1;
		expect(codec.open(sealed.toString("base64url"), NOW)).toBeNull();
		expect(codec.open("garbage", NOW)).toBeNull();
		expect(codec.open("", NOW)).toBeNull();
	});

	it("rejects a cookie sealed with another secret", () => {
		expect(createSessionCodec("t".repeat(64)).open(codec.seal(session), NOW)).toBeNull();
	});

	it("rejects an expired cookie", () => {
		expect(codec.open(codec.seal(session), new Date(session.expiresAt))).toBeNull();
	});

	it("lasts eight hours, or less when the token expires sooner", () => {
		expect(sessionExpiry(NOW, null)).toBe(NOW.getTime() + 8 * 3_600_000);
		expect(sessionExpiry(NOW, 3600)).toBe(NOW.getTime() + 3_600_000);
		expect(sessionExpiry(NOW, 86_400)).toBe(NOW.getTime() + 8 * 3_600_000);
	});
});
