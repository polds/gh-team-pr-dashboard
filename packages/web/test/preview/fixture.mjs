// A board as the server would send it: 23 cards across every lane, drafts, bots, help wanted, and
// done, seen by "mira". Times are relative to now so time in state reads naturally.

const NOW = Date.now();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const ago = (ms) => new Date(NOW - ms).toISOString();

const people = new Map();
const person = (login) => {
	if (!people.has(login)) people.set(login, { login, avatarUrl: `/avatars/${encodeURIComponent(login)}.svg`, isBot: login.endsWith("[bot]") });
	return people.get(login);
};

const VIEWER = "mira";
const WEB_PLATFORM = { slug: "web-platform", name: "Web platform" };
const direct = { kind: "direct", asCodeOwner: false };
const owner = { kind: "direct", asCodeOwner: true };
const viaAuthor = { kind: "author" };
const viaTeam = { kind: "team", ...WEB_PLATFORM, asCodeOwner: false };

const reviewer = (login, kind, sinceMs, rerequested = false) => ({ reviewer: person(login), kind, rerequested, since: ago(sinceMs) });
const actor = (login, via, sinceMs) => ({ login, via, since: ago(sinceMs) });
const checks = {
	passing: (total = 6) => ({ verdict: "passing", failing: [], pending: [], total }),
	failing: (...names) => ({ verdict: "failing", failing: names, pending: [], total: 6 }),
	pending: (...names) => ({ verdict: "pending", failing: [], pending: names, total: 6 }),
	none: () => ({ verdict: "none", failing: [], pending: [], total: 0 }),
};

function card(id, repo, title, author, facts) {
	const { number, state, court, sinceMs, reasons = [], reviewers = [], actors = [], blockers = [], confidence = null, ...rest } = facts;
	return {
		id: `PR_${id}`,
		repo: `acme/${repo}`,
		number,
		url: `https://github.com/acme/${repo}/pull/${number}`,
		title,
		author: person(author),
		isBotPr: author.endsWith("[bot]"),
		labels: [],
		areas: [],
		requestedTeams: [],
		additions: 120,
		deletions: 34,
		headSha: `sha${id}`,
		checks: checks.passing(),
		since: ago(sinceMs),
		priority: false,
		helpWanted: null,
		derived: { state, court, sinceEstimate: ago(sinceMs), actors, reviewers, reasons, blockers, confidence },
		...rest,
	};
}

function baseCards() {
	return [
		card(1, "monorepo", "Add a retry budget to the payments client", "ken", {
			number: 2141,
			state: "needs_review",
			court: "reviewers",
			sinceMs: 3 * HOUR,
			areas: ["services/payments"],
			labels: ["payments"],
			reviewers: [reviewer(VIEWER, "requested", 3 * HOUR)],
			actors: [actor(VIEWER, owner, 3 * HOUR)],
			reasons: [{ kind: "review_requested", from: [VIEWER], teams: [] }],
		}),
		card(2, "web", "Lazy-load the settings page", "li", {
			number: 981,
			state: "needs_review",
			court: "reviewers",
			sinceMs: 26 * HOUR,
			areas: ["apps/web"],
			requestedTeams: [WEB_PLATFORM],
			actors: [actor(VIEWER, viaTeam, 26 * HOUR), actor("joe", viaTeam, 26 * HOUR)],
			reasons: [{ kind: "review_requested", from: [], teams: ["Web platform"] }],
		}),
		card(3, "api", "Rate limit the export endpoint", "sam", {
			number: 455,
			state: "needs_review",
			court: "reviewers",
			sinceMs: 53 * HOUR,
			priority: true,
			labels: ["priority", "security"],
			areas: ["services/export"],
			reasons: [{ kind: "no_reviewer_requested" }],
			helpWanted: { suggested: [person("ken"), person("ana"), person("joe")] },
		}),
		card(4, "monorepo", "Move feature flags to the config service", "ana", {
			number: 2120,
			state: "in_review",
			court: "reviewers",
			sinceMs: 5 * HOUR,
			areas: ["services/config", "apps/web"],
			checks: checks.pending("e2e"),
			reviewers: [reviewer("ken", "commented", 5 * HOUR), reviewer("joe", "requested", 7 * HOUR)],
			actors: [actor("ken", direct, 5 * HOUR), actor("joe", direct, 7 * HOUR)],
			reasons: [
				{ kind: "commented_by", reviewer: "ken", at: ago(5 * HOUR) },
				{ kind: "review_requested", from: ["joe"], teams: [] },
			],
		}),
		card(5, "infra", "Split the staging VPC into two subnets", "joe", {
			number: 77,
			state: "in_review",
			court: "reviewers",
			sinceMs: 20 * HOUR,
			areas: ["terraform/staging"],
			labels: ["infra"],
			reviewers: [reviewer("ken", "commented", 20 * HOUR)],
			actors: [actor("ken", direct, 20 * HOUR)],
			reasons: [{ kind: "commented_by", reviewer: "ken", at: ago(20 * HOUR) }],
		}),
		card(6, "web", "Rewrite the onboarding checklist", VIEWER, {
			number: 975,
			state: "changes_requested",
			court: "author",
			sinceMs: 25 * HOUR,
			areas: ["apps/web"],
			reviewers: [reviewer("ken", "feedback_outstanding", 25 * HOUR)],
			actors: [actor(VIEWER, viaAuthor, 25 * HOUR)],
			reasons: [
				{ kind: "changes_requested_by", reviewer: "ken", at: ago(25 * HOUR) },
				{ kind: "open_threads", reviewer: "ken", awaitingAuthor: 2, total: 3 },
			],
		}),
		card(7, "monorepo", "Batch webhook deliveries per installation", "sam", {
			number: 2099,
			state: "changes_requested",
			court: "author",
			sinceMs: 73 * HOUR,
			areas: ["services/webhooks"],
			checks: checks.failing("build", "lint"),
			reviewers: [reviewer("ana", "feedback_outstanding", 73 * HOUR)],
			actors: [actor("sam", viaAuthor, 73 * HOUR)],
			reasons: [
				{ kind: "changes_requested_by", reviewer: "ana", at: ago(73 * HOUR) },
				{ kind: "open_threads", reviewer: "ana", awaitingAuthor: 1, total: 4 },
			],
		}),
		card(8, "monorepo", "Cache team membership for five minutes", "ken", {
			number: 2088,
			state: "likely_ready_for_rereview",
			court: "reviewers",
			sinceMs: 6 * HOUR,
			confidence: "high",
			areas: ["services/auth"],
			reviewers: [reviewer(VIEWER, "feedback_addressed", 6 * HOUR)],
			actors: [actor(VIEWER, direct, 6 * HOUR)],
			reasons: [
				{ kind: "changes_requested_by", reviewer: VIEWER, at: ago(50 * HOUR) },
				{ kind: "new_commits_since_review", reviewer: VIEWER, reviewedSha: "abc123" },
				{ kind: "threads_addressed", reviewer: VIEWER, resolved: 1, answered: 1, outdatedOnly: 0, total: 2 },
			],
		}),
		card(9, "web", "Fix the focus ring on the date picker", VIEWER, {
			number: 968,
			state: "likely_ready_for_rereview",
			court: "reviewers",
			sinceMs: 4 * HOUR,
			confidence: "medium",
			areas: ["apps/web"],
			labels: ["a11y"],
			reviewers: [reviewer("ken", "feedback_addressed", 4 * HOUR)],
			actors: [actor("ken", direct, 4 * HOUR)],
			reasons: [
				{ kind: "changes_requested_by", reviewer: "ken", at: ago(30 * HOUR) },
				{ kind: "new_commits_since_review", reviewer: "ken", reviewedSha: "def456" },
				{ kind: "no_threads_on_change_request", reviewer: "ken" },
			],
		}),
		card(10, "api", "Stream large CSV exports instead of buffering", "li", {
			number: 449,
			state: "likely_ready_for_rereview",
			court: "reviewers",
			sinceMs: 27 * HOUR,
			confidence: "high",
			areas: ["services/export"],
			reviewers: [reviewer("joe", "feedback_addressed", 27 * HOUR), reviewer("ana", "approved", 40 * HOUR)],
			actors: [actor("joe", direct, 27 * HOUR)],
			reasons: [
				{ kind: "changes_requested_by", reviewer: "joe", at: ago(60 * HOUR) },
				{ kind: "new_commits_since_review", reviewer: "joe", reviewedSha: "aaa111" },
				{ kind: "threads_addressed", reviewer: "joe", resolved: 2, answered: 0, outdatedOnly: 1, total: 3 },
			],
			helpWanted: { suggested: [person("ana"), person("ken")] },
		}),
		card(11, "monorepo", "Upgrade the build image to Node 22", "ana", {
			number: 2075,
			state: "approved_blocked",
			court: "ci",
			sinceMs: 40 * MINUTE,
			areas: ["tools/ci"],
			checks: checks.pending("integration"),
			blockers: ["ci_pending"],
			reviewers: [reviewer("ken", "approved", 2 * HOUR)],
			reasons: [
				{ kind: "approved_by", reviewers: ["ken"] },
				{ kind: "blocked", blocker: "ci_pending", checks: ["integration"] },
			],
		}),
		card(12, "web", "Drop the legacy billing banner", "joe", {
			number: 960,
			state: "approved_blocked",
			court: "author",
			sinceMs: 30 * HOUR,
			areas: ["apps/web"],
			blockers: ["conflicts"],
			reviewers: [reviewer(VIEWER, "approved", 30 * HOUR)],
			actors: [actor("joe", viaAuthor, 30 * HOUR)],
			reasons: [
				{ kind: "approved_by", reviewers: [VIEWER] },
				{ kind: "blocked", blocker: "conflicts", checks: [] },
			],
		}),
		card(13, "api", "Add an audit log for role changes", VIEWER, {
			number: 440,
			state: "approved_blocked",
			court: "author",
			sinceMs: 2 * HOUR,
			areas: ["services/auth"],
			checks: checks.failing("unit-tests"),
			blockers: ["ci_failing"],
			reviewers: [reviewer("ken", "approved", 3 * HOUR), reviewer("ana", "approved", 2 * HOUR)],
			actors: [actor(VIEWER, viaAuthor, 2 * HOUR)],
			reasons: [
				{ kind: "approved_by", reviewers: ["ken", "ana"] },
				{ kind: "blocked", blocker: "ci_failing", checks: ["unit-tests"] },
			],
		}),
		card(14, "monorepo", "Remove the dead new_nav feature flag", "ken", {
			number: 2060,
			state: "ready_to_merge",
			court: "author",
			sinceMs: 3 * HOUR,
			areas: ["apps/web"],
			reviewers: [reviewer("ana", "approved", 3 * HOUR)],
			actors: [actor("ken", viaAuthor, 3 * HOUR)],
			reasons: [{ kind: "approved_by", reviewers: ["ana"] }],
		}),
		card(15, "mobile", "Bump the iOS deployment target to 17", "li", {
			number: 312,
			state: "ready_to_merge",
			court: "ci",
			sinceMs: 12 * MINUTE,
			labels: ["ios"],
			reviewers: [reviewer("sam", "approved", HOUR)],
			reasons: [{ kind: "approved_by", reviewers: ["sam"] }, { kind: "in_merge_queue" }],
		}),
		card(16, "monorepo", "Spike: search indexing with tantivy", "joe", {
			number: 2150,
			state: "draft",
			court: "author",
			sinceMs: 2 * 24 * HOUR,
			actors: [actor("joe", viaAuthor, 48 * HOUR)],
			reasons: [{ kind: "draft" }],
			checks: checks.none(),
		}),
		card(17, "web", "Prototype the new header", VIEWER, {
			number: 990,
			state: "draft",
			court: "author",
			sinceMs: 5 * HOUR,
			actors: [actor(VIEWER, viaAuthor, 5 * HOUR)],
			reasons: [{ kind: "draft" }],
		}),
		card(18, "monorepo", "Bump eslint from 9.3.0 to 9.4.0", "dependabot[bot]", {
			number: 2148,
			state: "needs_review",
			court: "reviewers",
			sinceMs: 9 * HOUR,
			labels: ["dependencies"],
			reasons: [{ kind: "no_reviewer_requested" }],
		}),
		card(19, "web", "Update dependency vite to v8.3.9", "renovate[bot]", {
			number: 987,
			state: "ready_to_merge",
			court: "author",
			sinceMs: HOUR,
			labels: ["dependencies"],
			reasons: [{ kind: "approved_by", reviewers: ["li"] }, { kind: "auto_merge_enabled" }],
		}),
		card(20, "api", "Fix the time zone in digest emails", "ana", {
			number: 438,
			state: "merged",
			court: "nobody",
			sinceMs: HOUR,
			reasons: [],
		}),
		card(21, "web", "Try a CSS-only tooltip", "li", {
			number: 955,
			state: "closed",
			court: "nobody",
			sinceMs: 3 * HOUR,
			reasons: [],
		}),
		card(22, "monorepo", "Docs: explain the area filter", "ana", {
			number: 2144,
			state: "needs_review",
			court: "reviewers",
			sinceMs: 30 * MINUTE,
			areas: ["docs"],
			checks: checks.none(),
			reviewers: [reviewer("li", "requested", 30 * MINUTE)],
			actors: [actor("li", direct, 30 * MINUTE)],
			reasons: [{ kind: "review_requested", from: ["li"], teams: [] }],
		}),
		card(23, "mobile", "Offline queue for comments", "sam", {
			number: 309,
			state: "in_review",
			court: "reviewers",
			sinceMs: 2 * HOUR,
			areas: ["apps/ios"],
			reviewers: [reviewer("ken", "requested", 2 * HOUR, true), reviewer("ana", "approval_dismissed", 2 * HOUR)],
			actors: [actor("ken", direct, 2 * HOUR), actor("ana", direct, 2 * HOUR)],
			reasons: [{ kind: "rerequested", from: ["ken"] }, { kind: "blocked", blocker: "approval_dismissed", checks: [] }],
		}),
	];
}

/** The base board plus generated cards spread over the lanes, `count` cards in all. */
export function manyCards(count) {
	const base = baseCards();
	const lanes = [
		["needs_review", "reviewers"],
		["in_review", "reviewers"],
		["changes_requested", "author"],
		["approved_blocked", "author"],
		["ready_to_merge", "author"],
	];
	const authors = ["ana", "ken", "li", "sam", "joe", "noor", "ravi"];
	const titles = [
		"Tighten the retry policy for the queue worker",
		"Add pagination to the audit log endpoint",
		"Extract the date helpers into a shared package",
		"Make the invoice PDF render server-side",
		"Remove the unused analytics script",
		"Speed up the search index rebuild",
	];
	const extra = [];
	for (let i = 0; base.length + extra.length < count; i++) {
		const [state, court] = lanes[i % lanes.length];
		const author = authors[i % authors.length];
		extra.push(
			card(100 + i, ["monorepo", "web", "api"][i % 3], titles[i % titles.length], author, {
				number: 3000 + i,
				state,
				court,
				sinceMs: (i + 1) * 97 * MINUTE,
				reviewers: [reviewer(authors[(i + 2) % authors.length], court === "author" ? "approved" : "requested", HOUR)],
				actors: [actor(court === "author" ? author : authors[(i + 2) % authors.length], court === "author" ? viaAuthor : direct, HOUR)],
				reasons: [{ kind: "review_requested", from: [authors[(i + 2) % authors.length]], teams: [] }],
				labels: i % 4 === 0 ? ["backend"] : [],
				checks: i % 5 === 0 ? checks.failing("unit") : checks.passing(),
			}),
		);
	}
	return [...base, ...extra];
}

export function board(cards = baseCards()) {
	return {
		viewer: { login: VIEWER, avatarUrl: `/avatars/${VIEWER}.svg`, name: "Mira Okafor", teams: [WEB_PLATFORM] },
		config: { org: "acme", priorityLabels: ["priority", "urgent", "hotfix"], helpWantedAfterBusinessHours: 8, rerequestEnabled: false, demo: false },
		cards,
		presence: [
			{ person: person(VIEWER), viewing: null },
			{ person: person("ken"), viewing: "PR_8" },
			{ person: person("li"), viewing: "PR_6" },
			{ person: person("ana"), viewing: null },
		],
		heuristic: { confirmed: 12, rejected: 1 },
		serverTime: new Date().toISOString(),
	};
}

/** A review moves the team request on web#981 into review, and the board celebrates it. */
export function liveUpdate() {
	const moved = baseCards().find((c) => c.id === "PR_2");
	moved.derived = {
		...moved.derived,
		state: "in_review",
		reviewers: [reviewer("joe", "commented", 0)],
		actors: [actor("joe", direct, 0)],
		reasons: [{ kind: "commented_by", reviewer: "joe", at: ago(0) }],
	};
	moved.requestedTeams = [];
	moved.since = ago(0);
	return {
		card: { kind: "card", card: moved },
		celebrate: { kind: "celebrate", id: "PR_2", repo: "acme/web", number: 981, title: moved.title, by: person("joe") },
	};
}
