import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const shots = process.argv[2] ? resolve(process.argv[2]) : null;
if (shots) mkdirSync(shots, { recursive: true });
const port = 8900 + Math.floor(Math.random() * 90);
const base = `http://localhost:${port}`;
const dataDir = mkdtempSync(join(tmpdir(), "radar-verify-"));

const results = [];
function check(name, pass, detail = "") {
	results.push({ name, pass });
	console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

let serverLog = "";
function startServer() {
	const child = spawn("node", ["packages/server/src/main.ts"], {
		cwd: root,
		env: { ...process.env, RADAR_DEMO: "1", RADAR_DEMO_INTERVAL_SECONDS: "0", PORT: String(port), RADAR_DATA_DIR: dataDir },
		stdio: ["ignore", "pipe", "pipe"],
	});
	child.stdout.on("data", (chunk) => (serverLog += chunk));
	child.stderr.on("data", (chunk) => (serverLog += chunk));
	return child;
}
let server = startServer();

async function waitForServer() {
	for (let i = 0; i < 50; i++) {
		try {
			const response = await fetch(`${base}/healthz`);
			if (response.ok) return;
		} catch {}
		await new Promise((r) => setTimeout(r, 200));
	}
	throw new Error(`server did not start:\n${serverLog}`);
}

async function step() {
	const response = await fetch(`${base}/demo/step`, { method: "POST" });
	return response.json();
}

const NOTIFICATION_STUB = `
	window.__notifications = [];
	window.Notification = class {
		static permission = "granted";
		static requestPermission = async () => "granted";
		constructor(title, options) { window.__notifications.push({ title, body: options && options.body }); }
		close() {}
	};
`;

async function openAs(browser, login, { stubNotifications = false } = {}) {
	const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
	if (stubNotifications) await context.addInitScript(NOTIFICATION_STUB);
	return openTab(context, `/auth/demo?login=${login}`);
}

/** Another tab in the same browser, sharing its session and `localStorage`. */
async function openTab(context, path = "/") {
	const page = await context.newPage();
	const presenceCalls = [];
	page.on("request", (request) => {
		if (request.url().endsWith("/api/presence")) presenceCalls.push(request.postData());
	});
	await page.goto(`${base}${path}`);
	await page.waitForSelector('[data-testid="mine"]');
	return { page, context, presenceCalls };
}

const card = (section, pr) => `[data-testid="${section}"] [data-pr="${pr}"]`;

async function appears(page, selector, timeout = 5000) {
	const started = Date.now();
	try {
		await page.waitForSelector(selector, { timeout });
		return Date.now() - started;
	} catch {
		return null;
	}
}

const HEARTBEAT_MS = 20_000;

/** Opens the collapsed groups, sweeps the window width, and lists each card whose content crosses its border. */
async function cardSpills(page) {
	const original = page.viewportSize();
	const setGroups = (open) => page.evaluate((value) => document.querySelectorAll("details").forEach((d) => (d.open = value)), open);
	await setGroups(true);
	const spills = new Set();
	for (let width = 360; width <= 1920; width += 20) {
		await page.setViewportSize({ width, height: 900 });
		const found = await page.evaluate(() => {
			const out = [];
			for (const card of document.querySelectorAll('article[data-testid="card"]')) {
				const box = card.getBoundingClientRect();
				for (const el of card.querySelectorAll("*")) {
					const r = el.getBoundingClientRect();
					if (r.width === 0 || el.classList.contains("sr-only")) continue;
					if (r.right > box.right + 0.5 || r.left < box.left - 0.5) {
						const section = card.closest('[data-testid]:not([data-testid="card"])');
						out.push(`${card.dataset.pr} in ${section ? section.dataset.testid : "?"} (.${el.className}, card ${Math.round(box.width)} px wide)`);
						break;
					}
				}
			}
			return out;
		});
		for (const spill of found) spills.add(`${spill} at ${width} px`);
	}
	await setGroups(false);
	if (original) await page.setViewportSize(original);
	return [...spills];
}

async function enableNotifications(page) {
	await page.click('[data-testid="notifications-button"]');
	await page.click('[data-testid="notifications-toggle"]');
	await page.keyboard.press("Escape");
}

let browser;
try {
	await waitForServer();
	browser = await chromium.launch();

	const unauthenticated = await fetch(`${base}/api/board`);
	check("the board API refuses a request with no session", unauthenticated.status === 401);

	const ken = await openAs(browser, "ken");
	const linus = await openAs(browser, "linus");

	const lanes = await ken.page.$$eval('[data-testid^="lane-"]', (nodes) => nodes.map((n) => n.getAttribute("data-testid")));
	check("the board shows the six lanes in order", lanes.join() === "lane-needs_review,lane-in_review,lane-changes_requested,lane-likely_ready_for_rereview,lane-approved_blocked,lane-ready_to_merge", lanes.join());

	const likely = "atum/monorepo#4098";
	const likelyText = await ken.page.textContent(card("mine-needs-review", likely)).catch(() => null);
	check("Mine shows the reviewer a pull request that nobody re-requested", likelyText !== null);
	check("the likely-ready card says it is a heuristic and explains why", /heuristic/i.test(likelyText ?? "") && /requested changes/i.test(likelyText ?? "") && /commit/i.test(likelyText ?? "") && /thread/i.test(likelyText ?? ""), (likelyText ?? "").replace(/\s+/g, " ").slice(0, 160));
	check("Mine lists a team request separately", (await ken.page.$(card("mine-team", "atum/monorepo#4102"))) !== null);
	check("the tab title carries the count of pull requests that need the viewer", /^\(\d+\) /.test(await ken.page.title()), await ken.page.title());
	check("the author sees both signal buttons on their own likely-ready card", (await linus.page.$(`${card("mine-waiting", likely)} [data-testid="signal-ready"]`)) !== null && (await linus.page.$(`${card("mine-waiting", likely)} [data-testid="signal-not-ready"]`)) !== null);
	check("the reviewer gets no signal button on someone else's card", (await ken.page.$(`[data-pr="${likely}"] [data-testid="signal-ready"]`)) === null);
	check("drafts and bot pull requests sit in collapsed groups", (await ken.page.$('[data-testid="group-drafts"]:not([open])')) !== null && (await ken.page.$('[data-testid="group-bots"]:not([open])')) !== null);
	check("a long-waiting pull request is in the help-wanted lane", (await ken.page.$(card("help-wanted", "atum/monorepo#4102"))) !== null);

	if (shots) await ken.page.screenshot({ path: join(shots, "board-ken.png"), fullPage: true });

	check("presence sends nothing while it is off", ken.presenceCalls.length === 0 && linus.presenceCalls.length === 0);

	const spills = await cardSpills(ken.page);
	check("no card content sticks out of its card at any window width from 360 to 1920 px", spills.length === 0, spills.slice(0, 3).join("; "));

	const first = await step();
	const kenSaw = await appears(ken.page, card("lane-likely_ready_for_rereview", "atum/mobile#77"));
	const linusSaw = await appears(linus.page, card("lane-likely_ready_for_rereview", "atum/mobile#77"));
	check("a GitHub change moves the card for every viewer within 5 seconds", kenSaw !== null && linusSaw !== null, `${first.description} ken ${kenSaw} ms, linus ${linusSaw} ms`);

	await step();
	const merged = await appears(ken.page, card("lane-ready_to_merge", "atum/mobile#77"));
	const toast = await appears(linus.page, '[data-testid="toast"]');
	check("an approval moves the card to ready to merge and every board celebrates", merged !== null && toast !== null);

	await step();
	check("a finished CI run moves an approved pull request to ready to merge", (await appears(ken.page, card("lane-ready_to_merge", "atum/monorepo#4104"))) !== null);

	const barbaraOff = await openAs(browser, "barbara", { stubNotifications: true });
	const barbaraOn = await openAs(browser, "barbara", { stubNotifications: true });
	await enableNotifications(barbaraOn.page);
	const barbaraTabA = await openAs(browser, "barbara", { stubNotifications: true });
	await enableNotifications(barbaraTabA.page);
	const barbaraTabB = await openTab(barbaraTabA.context);
	await enableNotifications(barbaraTabA.page);
	await step();
	const turned = await appears(barbaraOn.page, card("mine-my-turn", "atum/monorepo#4110"));
	await appears(barbaraOff.page, card("mine-my-turn", "atum/monorepo#4110"));
	await barbaraOn.page.waitForFunction(() => window.__notifications.length > 0, null, { timeout: 5000 }).catch(() => {});
	const delivered = await barbaraOn.page.evaluate(() => window.__notifications);
	const silent = await barbaraOff.page.evaluate(() => window.__notifications);
	check("a change request puts the pull request in the author's Mine", turned !== null);
	check("an opted-in browser raises a desktop notification when it becomes the user's turn", delivered.length === 1, JSON.stringify(delivered));
	check("a browser that did not opt in raises none for the same event", silent.length === 0);
	await appears(barbaraTabB.page, card("mine-my-turn", "atum/monorepo#4110"));
	await barbaraTabB.page.waitForFunction(() => window.__notifications.length > 0, null, { timeout: 1000 }).catch(() => {});
	const otherTab = await barbaraTabB.page.evaluate(() => window.__notifications);
	const otherTabLabel = await barbaraTabB.page.textContent('[data-testid="notifications-button"]');
	check("turning notifications off in one tab silences the other tab", otherTab.length === 0 && /off/.test(otherTabLabel ?? ""), `${JSON.stringify(otherTab)} button: ${otherTabLabel}`);

	await ken.page.click('[data-testid="presence-toggle"]');
	await linus.page.click('[data-testid="presence-toggle"]');
	await ken.page.click(`${card("lane-likely_ready_for_rereview", likely)}`, { position: { x: 12, y: 60 } });
	const detailOpen = await appears(ken.page, '[data-testid="detail"]');
	const watcher = await appears(linus.page, `[data-pr="${likely}"] .watchers`);
	const headerPresence = await linus.page.textContent('[data-testid="presence"]');
	check("with presence on, the detail panel opens and other viewers see who is looking at the card", detailOpen !== null && watcher !== null, `header: ${(headerPresence ?? "").replace(/\s+/g, " ").slice(0, 80)}`);
	if (shots) await ken.page.screenshot({ path: join(shots, "detail-ken.png") });
	await ken.page.keyboard.press("Escape");
	await ken.page.click('[data-testid="presence-toggle"]');
	const gone = await linus.page.waitForFunction((pr) => document.querySelector(`[data-pr="${pr}"] .watchers`) === null, likely, { timeout: 5000 }).then(() => true, () => false);
	check("turning presence off removes the viewer from everyone's board", gone);

	await linus.page.click(`${card("mine-waiting", likely)} [data-testid="signal-not-ready"]`);
	const backToAuthor = await appears(ken.page, card("lane-changes_requested", likely));
	const leftMine = await ken.page.waitForFunction((selector) => document.querySelector(selector) === null, card("mine-needs-review", likely), { timeout: 5000 }).then(() => true, () => false);
	check("the author's \"not ready yet\" moves the card back to the author for every viewer", backToAuthor !== null && leftMine);

	await step();
	await step();
	const last = await step();
	const explicit = await appears(ken.page, card("lane-in_review", likely));
	const backInMine = await appears(ken.page, card("mine-needs-review", likely));
	check("a real re-request puts the card in review and back in the reviewer's Mine", explicit !== null && backInMine !== null, last.description);
	const explicitText = (await ken.page.textContent(card("mine-needs-review", likely))) ?? "";
	check("a re-requested card no longer carries the heuristic label", !/heuristic/i.test(explicitText));

	const board = await (await ken.context.request.get(`${base}/api/board`)).json();
	const perPerson = JSON.stringify(board.heuristic);
	check("the board API exposes heuristic outcomes only as two totals", Object.keys(board.heuristic).sort().join() === "confirmed,rejected", perPerson);

	const margaretTabA = await openAs(browser, "margaret");
	await margaretTabA.page.click('[data-testid="presence-toggle"]');
	const margaretTabB = await openTab(margaretTabA.context);
	await margaretTabA.page.click('[data-testid="presence-toggle"]');
	const sentBefore = margaretTabB.presenceCalls.length;
	await new Promise((r) => setTimeout(r, HEARTBEAT_MS + 1500));
	const heartbeats = margaretTabB.presenceCalls.slice(sentBefore).filter((body) => JSON.parse(body ?? "{}").active === true);
	const otherSwitch = await margaretTabB.page.getAttribute('[data-testid="presence-toggle"]', "aria-checked");
	const present = (await (await linus.context.request.get(`${base}/api/board`)).json()).presence.map((entry) => entry.person.login);
	check("turning presence off in one tab stops the other tab's heartbeats", heartbeats.length === 0 && otherSwitch === "false" && !present.includes("margaret"), `heartbeats ${JSON.stringify(heartbeats)}, switch ${otherSwitch}, present ${JSON.stringify(present)}`);

	if (shots) {
		await ken.page.screenshot({ path: join(shots, "board-ken-after.png"), fullPage: true });
		const dark = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
		const darkPage = await dark.newPage();
		await darkPage.goto(`${base}/auth/demo?login=margaret`);
		await darkPage.waitForSelector('[data-testid="mine"]');
		await darkPage.screenshot({ path: join(shots, "board-margaret-dark.png"), fullPage: true });
		const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
		const phonePage = await phone.newPage();
		await phonePage.goto(`${base}/auth/demo?login=ken`);
		await phonePage.waitForSelector('[data-testid="mine"]');
		await phonePage.screenshot({ path: join(shots, "board-ken-390.png"), fullPage: true });
	}

	// A restarted demo server has a new session secret, so every open tab now holds a dead session.
	const stopped = new Promise((r) => server.once("exit", r));
	server.kill("SIGTERM");
	await stopped;
	server = startServer();
	await waitForServer();
	const signIn = await appears(ken.page, 'a[href="/auth/login"]', 45000);
	check("a tab whose session ended lands on the sign-in screen when its stream reconnects", signIn !== null, `${signIn} ms`);
} catch (error) {
	check("the run finished without an exception", false, String(error && error.stack ? error.stack : error));
	console.log(serverLog.split("\n").slice(-15).join("\n"));
} finally {
	if (browser) await browser.close();
	server.kill("SIGTERM");
	rmSync(dataDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed} of ${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
