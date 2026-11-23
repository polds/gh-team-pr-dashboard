import type { BoardResponse, Card, PresenceEntry, PrId, ServerEvent } from "@radar/core";

export type Connection = "live" | "reconnecting";

export type Celebration = Extract<ServerEvent, { kind: "celebrate" }>;

/** The board response minus the parts that live events change. */
export type BoardMeta = Omit<BoardResponse, "cards" | "presence">;

export type Phase =
	| { status: "loading" }
	| { status: "signed_out"; loginUrl: string }
	| { status: "error"; message: string }
	| {
			status: "ready";
			board: BoardMeta;
			cards: ReadonlyMap<PrId, Card>;
			presence: PresenceEntry[];
			/** Server clock minus browser clock, so time in state does not drift with a wrong local clock. */
			clockOffsetMs: number;
	  };

export type ClientState = Phase & {
	connection: Connection;
	/** At most one toast per pull request, oldest first. */
	toasts: Celebration[];
	/**
	 * Events that arrived while a board load was in flight. The load's snapshot may predate them,
	 * so they are replayed onto it. Null when no load is in flight.
	 */
	inFlight: ServerEvent[] | null;
};

export type Action =
	| { type: "load_started" }
	| { type: "loaded"; board: BoardResponse; receivedAtMs: number }
	| { type: "load_failed"; message: string }
	| { type: "signed_out"; loginUrl: string }
	| { type: "event"; event: ServerEvent }
	| { type: "connection"; connection: Connection }
	| { type: "toast_expired"; id: PrId };

export const MAX_TOASTS = 3;

export const INITIAL_STATE: ClientState = {
	status: "loading",
	connection: "live",
	toasts: [],
	inFlight: null,
};

export function reduce(state: ClientState, action: Action): ClientState {
	switch (action.type) {
		case "load_started":
			return state.status === "ready" ? { ...state, inFlight: [] } : { ...shared(state), status: "loading", inFlight: [] };
		case "loaded": {
			const { cards, presence, ...board } = action.board;
			const loaded: ClientState = {
				...shared(state),
				status: "ready",
				board,
				cards: new Map(cards.map((card) => [card.id, card])),
				presence,
				clockOffsetMs: clockOffset(board.serverTime, action.receivedAtMs),
				inFlight: null,
			};
			return (state.inFlight ?? []).reduce(applyEvent, loaded);
		}
		case "load_failed":
			return state.status === "ready"
				? { ...state, inFlight: null }
				: { ...shared(state), status: "error", message: action.message, inFlight: null };
		case "signed_out":
			return { ...shared(state), status: "signed_out", loginUrl: action.loginUrl, inFlight: null };
		case "event": {
			const next = applyEvent(state, action.event);
			const buffered = next.inFlight !== null && isReplayable(action.event);
			return buffered ? { ...next, inFlight: [...(next.inFlight ?? []), action.event] } : next;
		}
		case "connection":
			return state.connection === action.connection ? state : { ...state, connection: action.connection };
		case "toast_expired":
			return { ...state, toasts: state.toasts.filter((toast) => toast.id !== action.id) };
		default: {
			const _exhaustive: never = action;
			return _exhaustive;
		}
	}
}

function applyEvent(state: ClientState, event: ServerEvent): ClientState {
	switch (event.kind) {
		case "card": {
			if (state.status !== "ready") return state;
			const cards = new Map(state.cards);
			cards.set(event.card.id, event.card);
			return { ...state, cards };
		}
		case "remove": {
			if (state.status !== "ready" || !state.cards.has(event.id)) return state;
			const cards = new Map(state.cards);
			cards.delete(event.id);
			return { ...state, cards };
		}
		case "presence":
			return state.status === "ready" ? { ...state, presence: event.presence } : state;
		case "celebrate": {
			const others = state.toasts.filter((toast) => toast.id !== event.id);
			return { ...state, toasts: [...others, event].slice(-MAX_TOASTS) };
		}
		case "resync":
			return state;
		default: {
			const _exhaustive: never = event;
			return _exhaustive;
		}
	}
}

/** Events whose effect a newer snapshot could overwrite. A toast is not one of them. */
function isReplayable(event: ServerEvent): boolean {
	return event.kind === "card" || event.kind === "remove" || event.kind === "presence";
}

function clockOffset(serverTime: string, receivedAtMs: number): number {
	const offset = Date.parse(serverTime) - receivedAtMs;
	return Number.isFinite(offset) ? offset : 0;
}

function shared(state: ClientState): Pick<ClientState, "connection" | "toasts" | "inFlight"> {
	return { connection: state.connection, toasts: state.toasts, inFlight: state.inFlight };
}

export function cardList(state: ClientState): Card[] {
	return state.status === "ready" ? [...state.cards.values()] : [];
}
