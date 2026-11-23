import type {
	Derived,
	IsoTime,
	Login,
	Person,
	PrId,
	Sha,
	TeamSlug,
} from "./model.ts";

/** What the board shows for one pull request. The server builds it, and the browser renders it. */
export interface Card {
	id: PrId;
	repo: string;
	number: number;
	url: string;
	title: string;
	author: Person;
	isBotPr: boolean;
	labels: string[];
	/** Path areas the pull request touches, for example `services/billing`. */
	areas: string[];
	/** Teams with a pending review request on this pull request. */
	requestedTeams: { slug: TeamSlug; name: string }[];
	additions: number;
	deletions: number;
	headSha: Sha;
	checks: {
		verdict: "passing" | "failing" | "pending" | "none";
		failing: string[];
		pending: string[];
		total: number;
	};
	derived: Derived;
	/** When the pull request entered its state. Observed by the server when possible, estimated otherwise. */
	since: IsoTime;
	/** True when the pull request carries a priority label. */
	priority: boolean;
	/** Set when the pull request has waited on reviewers past the help-wanted threshold. */
	helpWanted: { suggested: Person[] } | null;
}

export interface Viewer {
	login: Login;
	avatarUrl: string;
	name: string | null;
	teams: { slug: TeamSlug; name: string }[];
}

export interface BoardConfig {
	org: string;
	priorityLabels: string[];
	helpWantedAfterBusinessHours: number;
	/** True when the server can re-request review on GitHub for the author. */
	rerequestEnabled: boolean;
	demo: boolean;
}

export interface PresenceEntry {
	person: Person;
	/** The pull request whose details this person has open, if any. */
	viewing: PrId | null;
}

/** Aggregate outcomes of `likely_ready_for_rereview` cards. It holds no names. */
export interface HeuristicStats {
	confirmed: number;
	rejected: number;
}

export interface BoardResponse {
	viewer: Viewer;
	config: BoardConfig;
	cards: Card[];
	presence: PresenceEntry[];
	heuristic: HeuristicStats;
	serverTime: IsoTime;
}

/** Events on `GET /api/events`. The SSE `event:` field carries `kind`, and `data:` carries the JSON body. */
export type ServerEvent =
	| { kind: "card"; card: Card }
	| { kind: "remove"; id: PrId }
	| { kind: "presence"; presence: PresenceEntry[] }
	| { kind: "celebrate"; id: PrId; repo: string; number: number; title: string; by: Person | null }
	| { kind: "resync" };

export interface PresenceRequest {
	/** Null leaves the board. */
	viewing: PrId | null;
	active: boolean;
}

export interface AuthorSignalRequest {
	kind: "ready" | "not_ready" | "clear";
}

export type AuthorSignalResponse =
	| { ok: true; wroteToGitHub: boolean }
	| { ok: false; error: "not_author" | "not_found" | "github_refused" | "nothing_to_rerequest" };

