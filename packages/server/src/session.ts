import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { z } from "zod";
import { asLogin } from "@radar/core";
import type { Login } from "@radar/core";

export interface Session {
	login: Login;
	avatarUrl: string;
	name: string | null;
	/** Null unless the one-click re-request is on, which is the only use of the token. */
	userToken: string | null;
	/** Epoch milliseconds. */
	expiresAt: number;
}

export interface SessionCodec {
	seal(session: Session): string;
	/** Null for a cookie that does not decrypt, does not parse, or has expired. */
	open(value: string, now: Date): Session | null;
}

export const SESSION_HOURS = 8;

const IV_BYTES = 12;
const TAG_BYTES = 16;

const sessionSchema = z.object({
	login: z.string().min(1).transform(asLogin),
	avatarUrl: z.string(),
	name: z.string().nullable(),
	userToken: z.string().nullable(),
	expiresAt: z.number(),
});

export function createSessionCodec(secret: string): SessionCodec {
	const key = Buffer.from(hkdfSync("sha256", secret, "pr-review-radar", "session cookie v1", 32));

	return {
		seal(session) {
			const iv = randomBytes(IV_BYTES);
			const cipher = createCipheriv("aes-256-gcm", key, iv);
			const body = Buffer.concat([cipher.update(JSON.stringify(session), "utf8"), cipher.final()]);
			return Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64url");
		},

		open(value, now) {
			const sealed = Buffer.from(value, "base64url");
			if (sealed.length <= IV_BYTES + TAG_BYTES) return null;
			try {
				const decipher = createDecipheriv("aes-256-gcm", key, sealed.subarray(0, IV_BYTES));
				decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
				const text = Buffer.concat([decipher.update(sealed.subarray(IV_BYTES, sealed.length - TAG_BYTES)), decipher.final()]).toString("utf8");
				const session = sessionSchema.safeParse(JSON.parse(text));
				return session.success && session.data.expiresAt > now.getTime() ? session.data : null;
			} catch {
				return null;
			}
		},
	};
}

export function sessionExpiry(now: Date, tokenLifetimeSeconds: number | null): number {
	const limit = now.getTime() + SESSION_HOURS * 3_600_000;
	return tokenLifetimeSeconds === null ? limit : Math.min(limit, now.getTime() + tokenLifetimeSeconds * 1000);
}
