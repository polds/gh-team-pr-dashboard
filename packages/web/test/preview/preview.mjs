// Renders the built board against a fixture and writes screenshots.
// Usage: node packages/web/test/preview/preview.mjs <out-dir>
// Build first with `npm run build -w @radar/web`. The script serves packages/web/dist, answers
// /api/board with page.route, and keeps /api/events open from its own server so it can push events.
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { board, liveUpdate, manyCards } from "./fixture.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const outDir = process.argv[2];
if (outDir === undefined) {
	console.error("usage: node preview.mjs <out-dir>");
	process.exit(2);
}
mkdirSync(outDir, { recursive: true });

const dist = resolve(dirname(fileURLToPath(import.meta.url)), "../../dist");
if (!existsSync(join(dist, "index.html"))) {
	console.error(`no build at ${dist}; run npm run build -w @radar/web first`);
	process.exit(2);
}

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
const streams = new Set();

function avatar(login) {
	let hash = 0;
	for (const char of login) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
	const hue = hash % 360;
	const initials = login.replace(/\[bot\]$/, "").slice(0, 2).toUpperCase();
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" fill="hsl(${hue} 45% 52%)"/><text x="20" y="25.5" font-family="system-ui,sans-serif" font-size="15" font-weight="600" fill="#fff" text-anchor="middle">${initials}</text></svg>`;
}

const server = createServer((req, res) => {
	const url = new URL(req.url ?? "/", "http://localhost");
	if (url.pathname === "/api/events") {
		res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
		res.write("event: resync\ndata: {\"kind\":\"resync\"}\n\n");
		streams.add(res);
		req.on("close", () => streams.delete(res));
		return;
	}
	const avatarMatch = /^\/avatars\/(.+)\.svg$/.exec(url.pathname);
	if (avatarMatch !== null) {
		res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "max-age=3600" });
		res.end(avatar(decodeURIComponent(avatarMatch[1])));
		return;
	}
	const file = join(dist, url.pathname === "/" ? "index.html" : url.pathname);
	if (!file.startsWith(dist) || !existsSync(file)) {
		res.writeHead(404).end();
		return;
	}
	res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" });
	res.end(readFileSync(file));
});

function broadcast(event) {
	for (const res of streams) res.write(`event: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`);
}

await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
// The new headless mode, because the old headless shell reports notification permission as denied even when granted.
const browser = await chromium.launch({ channel: "chromium" });
const failures = [];
const shots = [];

function check(name, ok, detail = "") {
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail === "" ? "" : `: ${detail}`}`);
	if (!ok) failures.push(name);
}

async function openBoard({ name, colorScheme = "light", width = 1440, height = 900, cards, presence = true, notifications = null, boardStatus = 200 }) {
	const context = await browser.newContext({ colorScheme, viewport: { width, height }, reducedMotion: "reduce" });
	if (notifications !== null) await context.grantPermissions(["notifications"], { origin });
	await context.addInitScript(
		([presenceOn, prefs]) => {
			localStorage.setItem("radar.presence", JSON.stringify(presenceOn));
			if (prefs !== null) localStorage.setItem("radar.notifications", JSON.stringify(prefs));
		},
		[presence, notifications],
	);
	const page = await context.newPage();
	const errors = [];
	page.on("pageerror", (error) => errors.push(String(error)));
	page.on("console", (message) => {
		if (message.type() === "error" && !/status of 40[13]|status of 500/.test(message.text())) errors.push(message.text());
	});
	const posts = [];
	await page.route("**/api/board", (route) =>
		boardStatus === 200
			? route.fulfill({ json: board(cards) })
			: route.fulfill({ status: boardStatus, json: boardStatus === 401 ? { error: "unauthenticated", loginUrl: "/auth/login" } : { error: "boom" } }),
	);
	await page.route("**/api/presence", (route) => {
		posts.push({ path: "/api/presence", headers: route.request().headers(), body: route.request().postDataJSON() });
		return route.fulfill({ status: 204 });
	});
	await page.route("**/api/prs/*/signal", (route) => {
		posts.push({ path: new URL(route.request().url()).pathname, headers: route.request().headers(), body: route.request().postDataJSON() });
		return route.fulfill({ json: { ok: true, wroteToGitHub: false } });
	});
	await page.goto(origin);
	return { context, page, errors, posts, name };
}

async function settle(page) {
	await page.evaluate(() =>
		Promise.all([...document.images].map((img) => (img.complete ? null : new Promise((done) => img.addEventListener("load", done) || img.addEventListener("error", done))))),
	);
	await page.waitForTimeout(150);
}

async function shoot(page, file, options = {}) {
	const path = join(outDir, file);
	await page.screenshot({ path, ...options });
	shots.push(path);
}

async function noHorizontalOverflow(page, label) {
	const { scroll, inner } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
	check(`${label}: no horizontal page scroll`, scroll <= inner, `${scroll} <= ${inner}`);
}

async function finish({ context, errors, name }) {
	check(`${name}: no console errors`, errors.length === 0, errors.join(" | "));
	await context.close();
}

try {
	{
		const session = await openBoard({ name: "light 1440" });
		const { page, posts } = session;
		await page.waitForSelector('[data-testid="mine"]');
		await settle(page);
		check("title counts what needs the viewer", (await page.title()) === "(5) PR Review Radar", await page.title());
		check("six lanes", (await page.locator('[data-testid^="lane-"]').count()) === 6);
		check("help wanted lane shows", await page.locator('[data-testid="help-wanted"]').isVisible());
		check("likely-ready card waiting on the viewer is in Mine", (await page.locator('[data-testid="mine-needs-review"] [data-pr="acme/monorepo#2088"]').count()) === 1);
		check("team request is in its own list", (await page.locator('[data-testid="mine-team"] [data-pr="acme/web#981"]').count()) === 1);
		check("own likely-ready card has both buttons", (await page.locator('[data-testid="mine-waiting"] [data-pr="acme/web#968"] [data-testid="signal-not-ready"]').count()) === 1);
		check("presence sent with the X-Radar header", posts.some((p) => p.path === "/api/presence" && p.headers["x-radar"] === "1" && p.body.active === true));
		check("connection shows live", (await page.locator(".connection-live").count()) === 1);
		await noHorizontalOverflow(page, "light 1440");
		await shoot(page, "board-light-1440.png", { fullPage: true });

		await page.locator('[data-testid="group-drafts"] summary').click();
		await page.locator('[data-testid="group-bots"] summary').click();
		await shoot(page, "groups-open-1440.png", { fullPage: true, clip: undefined });

		await page.locator('[data-testid="mine-waiting"] [data-pr="acme/web#968"] [data-testid="signal-ready"]').click();
		await page.waitForSelector('[data-testid="mine-waiting"] [data-pr="acme/web#968"] .signal-result.tone-ok');
		check("signal posts the author's kind", posts.some((p) => p.path === "/api/prs/PR_9/signal" && p.body.kind === "ready" && p.headers["x-radar"] === "1"));
		await page.locator('[data-testid="mine-waiting"] [data-pr="acme/web#968"]').screenshot({ path: join(outDir, "signal-result.png") });
		shots.push(join(outDir, "signal-result.png"));

		const update = liveUpdate();
		broadcast(update.card);
		broadcast(update.celebrate);
		await page.waitForSelector('[data-testid="lane-in_review"] [data-pr="acme/web#981"]');
		check("a card event moves the card to its new lane", true);
		check("celebrate shows a toast", await page.locator('[data-testid="toast"]').isVisible());
		await page.evaluate(() => window.scrollTo(0, 0));
		await shoot(page, "live-update-1440.png");
		await finish(session);
	}

	{
		const session = await openBoard({ name: "dark 1440", colorScheme: "dark" });
		await session.page.waitForSelector('[data-testid="mine"]');
		await settle(session.page);
		await shoot(session.page, "board-dark-1440.png", { fullPage: true });
		await finish(session);
	}

	{
		const session = await openBoard({ name: "light 390", width: 390, height: 844 });
		await session.page.waitForSelector('[data-testid="mine"]');
		await settle(session.page);
		await noHorizontalOverflow(session.page, "light 390");
		await shoot(session.page, "board-390.png", { fullPage: true });
		await finish(session);
	}

	{
		const session = await openBoard({ name: "dark 390", colorScheme: "dark", width: 390, height: 844 });
		await session.page.waitForSelector('[data-testid="mine"]');
		await settle(session.page);
		await noHorizontalOverflow(session.page, "dark 390");
		await shoot(session.page, "board-dark-390.png");
		await finish(session);
	}

	{
		const session = await openBoard({ name: "1280 with 40 cards", width: 1280, height: 900, cards: manyCards(40) });
		await session.page.waitForSelector('[data-testid="mine"]');
		await settle(session.page);
		await noHorizontalOverflow(session.page, "1280 with 40 cards");
		const lanes = await session.page.evaluate(() => {
			const element = document.querySelector(".lanes");
			return { scroll: element.scrollWidth, client: element.clientWidth };
		});
		check("1280: all six lanes fit without sideways scroll", lanes.scroll <= lanes.client, `${lanes.scroll} <= ${lanes.client}`);
		await shoot(session.page, "board-1280-40-cards.png", { fullPage: true });
		await finish(session);
	}

	{
		const session = await openBoard({ name: "detail" });
		const { page, posts } = session;
		await page.waitForSelector('[data-testid="mine"]');
		await settle(page);
		const opener = page.locator('[data-testid="mine-needs-review"] [data-pr="acme/monorepo#2088"] .card-open');
		await opener.focus();
		await opener.press("Enter");
		await page.waitForSelector('[data-testid="detail"][open]');
		await page.waitForTimeout(100);
		check("detail reports viewing to presence", posts.some((p) => p.path === "/api/presence" && p.body.viewing === "PR_8"));
		check("detail shows who else is looking", (await page.locator('[data-testid="detail"] .people').filter({ hasText: "ken" }).count()) > 0);
		await shoot(page, "detail-1440.png");
		await page.keyboard.press("Tab");
		const focusInside = await page.evaluate(() => document.querySelector('[data-testid="detail"]').contains(document.activeElement));
		check("focus stays in the detail panel", focusInside);
		await page.keyboard.press("Escape");
		await page.waitForSelector('[data-testid="detail"]', { state: "detached" });
		const restored = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
		check("Escape closes the panel and focus returns to the card", restored === "Details for monorepo#2088", String(restored));
		check("closing reports viewing nothing", posts.at(-1)?.body.viewing === null);
		await finish(session);
	}

	{
		const session = await openBoard({ name: "detail 390", width: 390, height: 844 });
		await session.page.waitForSelector('[data-testid="mine"]');
		await settle(session.page);
		await session.page.locator('[data-testid="mine-waiting"] [data-pr="acme/web#968"] .card-ref').click();
		await session.page.waitForSelector('[data-testid="detail"][open]');
		await session.page.waitForTimeout(100);
		await shoot(session.page, "detail-390.png");
		await session.page.keyboard.press("Escape");
		await session.page.waitForSelector('[data-testid="detail"]', { state: "detached" });
		const restored = await session.page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
		check("a card body click opens the panel, and closing focuses the card", restored === "Details for web#968", String(restored));
		await finish(session);
	}

	{
		const prefs = { enabled: true, teamRequests: true, heuristic: false, quietHours: { startMinute: 1080, endMinute: 540 }, digestMinutes: 30 };
		const session = await openBoard({ name: "notifications", notifications: prefs });
		const { page } = session;
		await page.waitForSelector('[data-testid="mine"]');
		await settle(page);
		await page.locator('[data-testid="notifications-button"]').click();
		await page.waitForSelector('[data-testid="notifications-toggle"]');
		check("notifications switch reads on", (await page.locator('[data-testid="notifications-toggle"]').getAttribute("aria-checked")) === "true");
		await shoot(page, "notifications-1440.png");
		await finish(session);
	}

	{
		const session = await openBoard({ name: "presence off", presence: false });
		const { page, posts } = session;
		await page.waitForSelector('[data-testid="mine"]');
		await settle(page);
		await page.waitForTimeout(300);
		check("presence off sends nothing", !posts.some((p) => p.path === "/api/presence"));
		check("presence off shows no avatars", (await page.locator(".presence-people").count()) === 0);
		await page.locator('[data-testid="notifications-button"]').click();
		check("notifications are off by default", (await page.locator('[data-testid="notifications-toggle"]').getAttribute("aria-checked")) === "false");
		await finish(session);
	}

	{
		const session = await openBoard({ name: "signed out", boardStatus: 401 });
		await session.page.waitForSelector("text=Sign in with GitHub");
		check("sign-in button goes to the login URL", (await session.page.locator("a", { hasText: "Sign in with GitHub" }).getAttribute("href")) === "/auth/login");
		await shoot(session.page, "signed-out.png");
		await finish(session);
	}

	{
		const session = await openBoard({ name: "load error", boardStatus: 500 });
		await session.page.waitForSelector("text=Try again");
		await shoot(session.page, "load-error.png");
		await finish(session);
	}

	{
		const session = await openBoard({ name: "empty board", cards: [] });
		await session.page.waitForSelector('[data-testid="mine"]');
		await shoot(session.page, "empty-board.png");
		await finish(session);
	}
} finally {
	await browser.close();
	for (const res of streams) res.end();
	server.close();
}

console.log(`\nscreenshots:\n${shots.map((s) => `  ${s}`).join("\n")}`);
if (failures.length > 0) {
	console.error(`\n${failures.length} check(s) failed: ${failures.join(", ")}`);
	process.exit(1);
}
console.log("\nall checks passed");
