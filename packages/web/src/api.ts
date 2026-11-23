import { asLogin, asPrId, isIsoTime } from "@radar/core";
import type {
	AuthorSignalRequest,
	AuthorSignalResponse,
	BoardResponse,
	Card,
	Court,
	Person,
	PresenceEntry,
	PresenceRequest,
	PrId,
	PrState,
	ServerEvent,
} from "@radar/core";

const PR_STATES: Record<PrState, true> = {
	draft: true,
	needs_review: true,
	in_review: true,
	changes_requested: true,
	likely_ready_for_rereview: true,
	approved_blocked: true,
	ready_to_merge: true,
	merged: true,
	closed: true,
};
const COURTS: Record<Court, true> = { author: true, reviewers: true, ci: true, nobody: true };
const SIGNAL_ERRORS: Record<Extract<AuthorSignalResponse, { ok: false }>["error"], true> = {
	not_author: true,
	not_found: true,
	github_refused: true,
	nothing_to_rerequest: true,
};

export type BoardResult =
	| { kind: "ok"; board: BoardResponse }
	| { kind: "signed_out"; loginUrl: string }
	| { kind: "failed"; message: string };

export async function fetchBoard(signal: AbortSignal): Promise<BoardResult> {
	let response: Response;
	try {
		response = await fetch("/api/board", { signal, headers: { Accept: "application/json" }, credentials: "same-origin" });
	} catch (error) {
		if (signal.aborted) throw error;
		return { kind: "failed", message: "Radar's server did not answer. Check your connection." };
	}
	const body = await readJson(response);
	if (response.status === 401) {
		const loginUrl = isObject(body) && typeof body.loginUrl === "string" ? body.loginUrl : "/auth/login";
		return { kind: "signed_out", loginUrl };
	}
	if (!response.ok) return { kind: "failed", message: `The server answered ${response.status}.` };
	const board = parseBoard(body);
	return board === null ? { kind: "failed", message: "The server sent a board this page cannot read." } : { kind: "ok", board };
}

export type SignalResult = AuthorSignalResponse | { ok: false; error: "unreachable" | "signed_out" };

export async function sendSignal(id: PrId, kind: AuthorSignalRequest["kind"]): Promise<SignalResult> {
	let response: Response;
	try {
		response = await postJson(`/api/prs/${encodeURIComponent(id)}/signal`, { kind } satisfies AuthorSignalRequest);
	} catch {
		return { ok: false, error: "unreachable" };
	}
	if (response.status === 401) return { ok: false, error: "signed_out" };
	return parseSignalResponse(await readJson(response)) ?? { ok: false, error: "unreachable" };
}

export function sendPresence(request: PresenceRequest, options: { keepalive?: boolean } = {}): void {
	postJson("/api/presence", request, options).catch(() => {});
}

export async function signOut(): Promise<void> {
	await postJson("/auth/logout", {}).catch(() => undefined);
}

function postJson(path: string, body: unknown, options: { keepalive?: boolean } = {}): Promise<Response> {
	return fetch(path, {
		method: "POST",
		credentials: "same-origin",
		keepalive: options.keepalive ?? false,
		headers: { "Content-Type": "application/json", "X-Radar": "1" },
		body: JSON.stringify(body),
	});
}

async function readJson(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		return null;
	}
}

/** Turns one SSE message into an event. The `event:` name is authoritative for the kind. */
export function parseEvent(kind: string, data: string): ServerEvent | null {
	let body: unknown = {};
	if (data.trim() !== "") {
		try {
			body = JSON.parse(data);
		} catch {
			return null;
		}
	}
	if (!isObject(body)) return null;
	switch (kind) {
		case "card":
			return isCard(body.card) ? { kind, card: body.card } : null;
		case "remove":
			return typeof body.id === "string" ? { kind, id: asPrId(body.id) } : null;
		case "presence":
			return Array.isArray(body.presence) ? { kind, presence: body.presence.filter(isPresenceEntry) } : null;
		case "celebrate":
			return typeof body.id === "string" &&
				typeof body.repo === "string" &&
				typeof body.number === "number" &&
				typeof body.title === "string" &&
				(body.by === null || isPerson(body.by))
				? { kind, id: asPrId(body.id), repo: body.repo, number: body.number, title: body.title, by: body.by }
				: null;
		case "resync":
			return { kind };
		default:
			return null;
	}
}

/** A board with every card this page can render. A card it cannot read is left out, not the whole board. */
export function parseBoard(value: unknown): BoardResponse | null {
	if (!isObject(value)) return null;
	const { viewer, config, cards, presence, heuristic, serverTime } = value;
	if (!isObject(viewer) || typeof viewer.login !== "string" || typeof viewer.avatarUrl !== "string") return null;
	if (!isObject(config) || typeof config.org !== "string") return null;
	if (!Array.isArray(cards) || typeof serverTime !== "string" || !isIsoTime(serverTime)) return null;
	const teams = Array.isArray(viewer.teams) ? viewer.teams.filter(isTeam) : [];
	return {
		viewer: {
			login: asLogin(viewer.login),
			avatarUrl: viewer.avatarUrl,
			name: typeof viewer.name === "string" ? viewer.name : null,
			teams,
		},
		config: {
			org: config.org,
			priorityLabels: Array.isArray(config.priorityLabels) ? config.priorityLabels.filter(isString) : [],
			helpWantedAfterBusinessHours: typeof config.helpWantedAfterBusinessHours === "number" ? config.helpWantedAfterBusinessHours : 0,
			rerequestEnabled: config.rerequestEnabled === true,
			demo: config.demo === true,
		},
		cards: cards.filter(isCard),
		presence: Array.isArray(presence) ? presence.filter(isPresenceEntry) : [],
		heuristic: {
			confirmed: isObject(heuristic) && typeof heuristic.confirmed === "number" ? heuristic.confirmed : 0,
			rejected: isObject(heuristic) && typeof heuristic.rejected === "number" ? heuristic.rejected : 0,
		},
		serverTime,
	};
}

export function parseSignalResponse(value: unknown): AuthorSignalResponse | null {
	if (!isObject(value)) return null;
	if (value.ok === true) return { ok: true, wroteToGitHub: value.wroteToGitHub === true };
	if (value.ok === false && typeof value.error === "string" && isSignalError(value.error)) return { ok: false, error: value.error };
	return null;
}

/**
 * True when every field the board reads to place and draw a card has its declared shape.
 * Sentence-level variants such as reason kinds are not checked here: their renderers fall back
 * to a generic sentence, so a newer server cannot break an open tab.
 */
export function isCard(value: unknown): value is Card {
	if (!isObject(value)) return false;
	const { derived, checks, helpWanted } = value;
	return (
		typeof value.id === "string" &&
		typeof value.repo === "string" &&
		typeof value.number === "number" &&
		typeof value.url === "string" &&
		typeof value.title === "string" &&
		isPerson(value.author) &&
		typeof value.isBotPr === "boolean" &&
		isStringArray(value.labels) &&
		isStringArray(value.areas) &&
		Array.isArray(value.requestedTeams) &&
		value.requestedTeams.every(isTeam) &&
		typeof value.additions === "number" &&
		typeof value.deletions === "number" &&
		typeof value.since === "string" &&
		typeof value.priority === "boolean" &&
		isObject(checks) &&
		typeof checks.verdict === "string" &&
		isStringArray(checks.failing) &&
		isStringArray(checks.pending) &&
		typeof checks.total === "number" &&
		(helpWanted === null || (isObject(helpWanted) && Array.isArray(helpWanted.suggested) && helpWanted.suggested.every(isPerson))) &&
		isObject(derived) &&
		typeof derived.state === "string" &&
		derived.state in PR_STATES &&
		typeof derived.court === "string" &&
		derived.court in COURTS &&
		Array.isArray(derived.reasons) &&
		derived.reasons.every((reason) => isObject(reason) && typeof reason.kind === "string") &&
		Array.isArray(derived.reviewers) &&
		derived.reviewers.every((status) => isObject(status) && isPerson(status.reviewer) && typeof status.kind === "string") &&
		Array.isArray(derived.actors) &&
		derived.actors.every((actor) => isObject(actor) && typeof actor.login === "string" && isObject(actor.via)) &&
		isStringArray(derived.blockers)
	);
}

function isPresenceEntry(value: unknown): value is PresenceEntry {
	return isObject(value) && isPerson(value.person) && (value.viewing === null || typeof value.viewing === "string");
}

function isPerson(value: unknown): value is Person {
	return isObject(value) && typeof value.login === "string" && typeof value.avatarUrl === "string" && typeof value.isBot === "boolean";
}

function isTeam(value: unknown): value is BoardResponse["viewer"]["teams"][number] {
	return isObject(value) && typeof value.slug === "string" && typeof value.name === "string";
}

function isSignalError(value: string): value is keyof typeof SIGNAL_ERRORS {
	return value in SIGNAL_ERRORS;
}

function isString(value: unknown): value is string {
	return typeof value === "string";
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(isString);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
