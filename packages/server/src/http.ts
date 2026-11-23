import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { asPrId } from "@radar/core";
import type { AuthorSignalResponse, BoardResponse, IsoTime, Person, PresenceRequest, ServerEvent } from "@radar/core";
import { nowIso } from "./board.ts";
import type { Board } from "./board.ts";
import type { Clock } from "./clock.ts";
import type { DemoConfig, GitHubConfig } from "./config.ts";
import type { Fetch } from "./github/http.ts";
import { exchangeOAuthCode, getAuthenticatedUser, isOrgMember } from "./github/rest.ts";
import { refKey } from "./github/source.ts";
import type { PrRef } from "./github/source.ts";
import { hintsFromEvent, verifySignature } from "./github/webhook.ts";
import type { Hub } from "./hub.ts";
import { errorMessage } from "./log.ts";
import type { Logger } from "./log.ts";
import type { Presence } from "./presence.ts";
import type { Refresher } from "./refresher.ts";
import { SESSION_HOURS, sessionExpiry } from "./session.ts";
import type { Session, SessionCodec } from "./session.ts";
import type { ReviewRequester } from "./writer.ts";

export const SESSION_COOKIE = "radar_session";
export const STATE_COOKIE = "radar_oauth_state";

export interface DemoStep {
	step: number;
	description: string;
	done: boolean;
}

export interface DemoControl {
	people: Person[];
	step(): DemoStep;
	reset(): DemoStep;
}

interface CommonDeps {
	board: Board;
	hub: Hub;
	presence: Presence;
	refresher: Pick<Refresher, "mark">;
	requester: ReviewRequester;
	sessions: SessionCodec;
	clock: Clock;
	lastSweepAt: () => IsoTime | null;
	log: Logger;
}

export type AppDeps = CommonDeps &
	(
		| { config: GitHubConfig; github: { fetch: Fetch; installationToken: () => Promise<string> } }
		| { config: DemoConfig; demo: DemoControl }
	);

type App = Hono<{ Variables: { session: Session } }>;

const RESERVED_PREFIXES = ["/api", "/auth", "/webhooks", "/demo", "/healthz"];

const isReserved = (path: string) => RESERVED_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));

const presenceRequestSchema = z.object({
	viewing: z.string().min(1).transform(asPrId).nullable(),
	active: z.boolean(),
}) satisfies z.ZodType<PresenceRequest>;

const signalRequestSchema = z.object({ kind: z.enum(["ready", "not_ready", "clear"]) });

function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function page(c: Context, status: 200 | 400 | 403 | 404 | 502, title: string, body: string): Response {
	return c.html(
		`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title></head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`,
		status,
	);
}

async function parseBody<T>(c: Context, schema: z.ZodType<T>): Promise<T | null> {
	const body: unknown = await c.req.json().catch(() => undefined);
	const result = schema.safeParse(body);
	return result.success ? result.data : null;
}

export function createApp(deps: AppDeps): App {
	const { config, board, hub, presence, refresher, requester, sessions, clock, log } = deps;
	const secure = config.baseUrl.startsWith("https://");
	const app: App = new Hono();
	const publish = (events: ServerEvent[]) => {
		for (const event of events) hub.broadcast(event);
	};

	function setSession(c: Context, session: Session): void {
		setCookie(c, SESSION_COOKIE, sessions.seal(session), {
			httpOnly: true,
			sameSite: "Lax",
			path: "/",
			secure,
			maxAge: Math.max(0, Math.floor((session.expiresAt - clock.now().getTime()) / 1000)),
		});
	}

	app.get("/healthz", (c) => c.json({ ok: true, lastSweepAt: deps.lastSweepAt() }));

	app.use("/api/*", async (c, next) => {
		if (c.req.method === "POST" && c.req.header("x-radar") !== "1") return c.json({ error: "missing_x_radar_header" }, 403);
		const cookie = getCookie(c, SESSION_COOKIE);
		const session = cookie === undefined ? null : sessions.open(cookie, clock.now());
		if (session === null) return c.json({ error: "unauthenticated", loginUrl: "/auth/login" }, 401);
		c.set("session", session);
		await next();
	});

	app.get("/api/board", (c) => {
		const { login, avatarUrl, name } = c.get("session");
		const response: BoardResponse = {
			viewer: { login, avatarUrl, name, teams: board.teamsOf(login) },
			config: {
				org: config.org,
				priorityLabels: config.priorityLabels,
				helpWantedAfterBusinessHours: config.helpWantedAfterBusinessHours,
				rerequestEnabled: config.rerequestEnabled,
				demo: config.mode === "demo",
			},
			cards: board.cards(),
			presence: presence.list(),
			heuristic: board.heuristic(),
			serverTime: nowIso(clock.now()),
		};
		return c.json(response);
	});

	app.get(
		"/api/events",
		() =>
			new Response(hub.open(), {
				headers: {
					"Content-Type": "text/event-stream; charset=utf-8",
					"Cache-Control": "no-cache, no-transform",
					"X-Accel-Buffering": "no",
				},
			}),
	);

	app.post("/api/presence", async (c) => {
		const request = await parseBody(c, presenceRequestSchema);
		if (request === null) return c.json({ error: "bad_request" }, 400);
		const { login, avatarUrl } = c.get("session");
		presence.heartbeat({ login, avatarUrl, isBot: false }, request);
		return c.body(null, 204);
	});

	app.post("/api/prs/:id/signal", async (c) => {
		const request = await parseBody(c, signalRequestSchema);
		if (request === null) return c.json({ error: "bad_request" }, 400);
		const answer = (response: AuthorSignalResponse) => c.json(response);
		const session = c.get("session");
		const id = asPrId(c.req.param("id"));
		const held = board.get(id);
		if (held === undefined) return answer({ ok: false, error: "not_found" });
		if (held.snapshot.author.login !== session.login) return answer({ ok: false, error: "not_author" });
		const now = clock.now();
		switch (request.kind) {
			case "ready": {
				if (!config.rerequestEnabled) {
					publish(board.setSignal(id, "ready", now));
					return answer({ ok: true, wroteToGitHub: false });
				}
				const logins = held.derived.reviewers
					.filter((reviewer) => reviewer.kind === "feedback_addressed" || reviewer.kind === "feedback_outstanding")
					.map((reviewer) => reviewer.reviewer.login);
				if (logins.length === 0) return answer({ ok: false, error: "nothing_to_rerequest" });
				try {
					await requester.requestReviewers({ ref: held.ref, logins, userToken: session.userToken });
				} catch (error) {
					log.warn("signal.rerequest_refused", { pr: refKey(held.ref), error: errorMessage(error) });
					return answer({ ok: false, error: "github_refused" });
				}
				board.noteRerequest(id);
				refresher.mark(held.ref);
				return answer({ ok: true, wroteToGitHub: true });
			}
			case "not_ready":
				publish(board.setSignal(id, "not_ready", now));
				return answer({ ok: true, wroteToGitHub: false });
			case "clear":
				publish(board.setSignal(id, null, now));
				return answer({ ok: true, wroteToGitHub: false });
			default: {
				const unhandled: never = request.kind;
				return unhandled;
			}
		}
	});

	app.post("/auth/logout", (c) => {
		deleteCookie(c, SESSION_COOKIE, { path: "/", secure });
		return c.redirect("/", 303);
	});

	if ("github" in deps) {
		const { github } = deps;
		const { clientId, clientSecret, webhookSecret } = deps.config.github;
		const denied = new Set(config.repoDenylist.map((name) => name.toLowerCase()));

		app.get("/auth/login", (c) => {
			const state = randomBytes(16).toString("base64url");
			setCookie(c, STATE_COOKIE, state, { httpOnly: true, sameSite: "Lax", path: "/auth", secure, maxAge: 600 });
			const authorize = new URL("https://github.com/login/oauth/authorize");
			authorize.searchParams.set("client_id", clientId);
			authorize.searchParams.set("redirect_uri", `${config.baseUrl}/auth/callback`);
			authorize.searchParams.set("state", state);
			return c.redirect(authorize.toString(), 302);
		});

		app.get("/auth/callback", async (c) => {
			const expected = getCookie(c, STATE_COOKIE);
			deleteCookie(c, STATE_COOKIE, { path: "/auth", secure });
			const code = c.req.query("code");
			if (expected === undefined || c.req.query("state") !== expected || code === undefined) {
				return page(c, 400, "Sign-in expired", '<p>The sign-in link is stale. <a href="/auth/login">Sign in again</a>.</p>');
			}
			try {
				const token = await exchangeOAuthCode({ clientId, clientSecret, code, fetch: github.fetch });
				const user = await getAuthenticatedUser({ token: token.accessToken, fetch: github.fetch });
				const member = await isOrgMember({ token: await github.installationToken(), org: config.org, login: user.login, fetch: github.fetch });
				if (!member) {
					return page(c, 403, "Not a member", `<p>PR Review Radar is open to members of the ${escapeHtml(config.org)} organization on GitHub.</p>`);
				}
				setSession(c, { ...user, userToken: token.accessToken, expiresAt: sessionExpiry(clock.now(), token.expiresInSeconds) });
				return c.redirect("/", 302);
			} catch (error) {
				log.warn("auth.callback_failed", { error: errorMessage(error) });
				return page(c, 502, "Sign-in failed", '<p>GitHub did not complete the sign-in. <a href="/auth/login">Try again</a>.</p>');
			}
		});

		app.post("/webhooks/github", async (c) => {
			const raw = new Uint8Array(await c.req.arrayBuffer());
			if (!verifySignature(webhookSecret, raw, c.req.header("x-hub-signature-256"))) return c.json({ error: "bad_signature" }, 401);
			let payload: unknown;
			try {
				payload = JSON.parse(new TextDecoder().decode(raw));
			} catch {
				return c.json({ error: "bad_json" }, 400);
			}
			const refs = hintsFromEvent(c.req.header("x-github-event") ?? "", payload)
				.filter((hint) => !denied.has(hint.name.toLowerCase()))
				.flatMap((hint): PrRef[] =>
					hint.kind === "pr" ? [{ owner: hint.owner, name: hint.name, number: hint.number }] : board.refsForSha(hint, hint.sha),
				);
			for (const ref of refs) refresher.mark(ref);
			return c.json({ marked: refs.length }, 202);
		});
	} else {
		const { demo } = deps;
		const people = new Map(demo.people.map((person) => [person.login, person]));

		app.get("/auth/login", (c) => {
			const links = demo.people
				.filter((person) => !person.isBot)
				.map((person) => `<li><a href="/auth/demo?login=${encodeURIComponent(person.login)}">${escapeHtml(person.login)}</a></li>`)
				.join("");
			return page(c, 200, "PR Review Radar demo", `<p>Pick a person to sign in as. The organization and its pull requests are simulated.</p><ul>${links}</ul>`);
		});

		app.get("/auth/demo", (c) => {
			const person = [...people.values()].find((candidate) => candidate.login === c.req.query("login") && !candidate.isBot);
			if (person === undefined) return page(c, 404, "No such demo person", '<p><a href="/auth/login">Pick someone else</a>.</p>');
			const now = clock.now();
			setSession(c, { login: person.login, avatarUrl: person.avatarUrl, name: null, userToken: "", expiresAt: now.getTime() + SESSION_HOURS * 3_600_000 });
			return c.redirect("/", 302);
		});

		app.post("/demo/step", (c) => c.json(demo.step()));
		app.post("/demo/reset", (c) => c.json(demo.reset()));
	}

	let assets: MiddlewareHandler | null = null;
	let index: MiddlewareHandler | null = null;
	app.get(
		"*",
		(c, next) => {
			if (isReserved(c.req.path)) return c.notFound();
			if (!existsSync(join(config.webDist, "index.html"))) {
				return c.text(`The web build is missing from ${config.webDist}. Run npm run build.\n`, 503);
			}
			return next();
		},
		(c, next) => {
			assets ??= serveStatic({ root: config.webDist });
			return assets(c, next);
		},
		(c, next) => {
			index ??= serveStatic({ path: join(config.webDist, "index.html") });
			return index(c, next);
		},
	);

	return app;
}
