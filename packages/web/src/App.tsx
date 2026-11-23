import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { Dispatch } from "react";
import { layoutBoard, mineFor } from "@radar/core";
import type { Person, PrId } from "@radar/core";
import { fetchBoard, sendPresence, sendSignal, signOut } from "./api.ts";
import { NO_FILTERS, applyFilters, filterOptions, isFiltering } from "./filters.ts";
import { useDesktopNotifications } from "./notifications.ts";
import { usePresence } from "./presence.ts";
import { notificationPrefsSetting, presenceSetting, useStoredSetting } from "./prefs.ts";
import { INITIAL_STATE, reduce } from "./state.ts";
import type { Action, ClientState } from "./state.ts";
import { openEventStream } from "./stream.ts";
import { Board } from "./ui/Board.tsx";
import { RadarContext } from "./ui/context.ts";
import type { RadarEnv, SignalKind, SignalStatus } from "./ui/context.ts";
import { Detail } from "./ui/Detail.tsx";
import { FilterBar } from "./ui/FilterBar.tsx";
import { Header } from "./ui/Header.tsx";
import { Mine } from "./ui/Mine.tsx";
import { NotificationsMenu } from "./ui/NotificationsMenu.tsx";
import { ErrorScreen, LoadingScreen, SignedOutScreen } from "./ui/Screens.tsx";
import { Toasts } from "./ui/Toasts.tsx";

const PRODUCT = "PR Review Radar";
const RETRY_MS = 15_000;
const TICK_MS = 30_000;
const SIGNAL_MESSAGE_MS = 12_000;

export function App() {
	const [state, dispatch] = useReducer(reduce, INITIAL_STATE);
	const load = useBoardLoader(dispatch);
	const signedOut = state.status === "signed_out";

	useEffect(() => {
		if (signedOut) return;
		load();
		return openEventStream({
			onEvent: (event) => (event.kind === "resync" ? load() : dispatch({ type: "event", event })),
			onConnection: (connection) => dispatch({ type: "connection", connection }),
			onRefused: load,
		});
	}, [signedOut, load]);

	switch (state.status) {
		case "loading":
			return <LoadingScreen />;
		case "signed_out":
			return <SignedOutScreen loginUrl={state.loginUrl} />;
		case "error":
			return <ErrorScreen message={state.message} onRetry={load} />;
		case "ready":
			return <ReadyBoard state={state} dispatch={dispatch} />;
		default: {
			const _exhaustive: never = state;
			return null;
		}
	}
}

function useBoardLoader(dispatch: Dispatch<Action>): () => void {
	const inFlight = useRef<AbortController | null>(null);
	const retry = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const load = useCallback(() => {
		inFlight.current?.abort();
		clearTimeout(retry.current);
		const controller = new AbortController();
		inFlight.current = controller;
		dispatch({ type: "load_started" });
		fetchBoard(controller.signal).then(
			(result) => {
				if (controller.signal.aborted) return;
				switch (result.kind) {
					case "ok":
						dispatch({ type: "loaded", board: result.board, receivedAtMs: Date.now() });
						return;
					case "signed_out":
						dispatch({ type: "signed_out", loginUrl: result.loginUrl });
						return;
					case "failed":
						dispatch({ type: "load_failed", message: result.message });
						retry.current = setTimeout(load, RETRY_MS);
						return;
				}
			},
			() => {},
		);
	}, [dispatch]);
	useEffect(
		() => () => {
			inFlight.current?.abort();
			clearTimeout(retry.current);
		},
		[],
	);
	return load;
}

type ReadyState = Extract<ClientState, { status: "ready" }>;

function ReadyBoard({ state, dispatch }: { state: ReadyState; dispatch: Dispatch<Action> }) {
	const { board, cards, presence } = state;
	const { viewer, config } = board;
	const [prefs, setPrefs] = useStoredSetting(notificationPrefsSetting);
	const [presenceOn, setPresenceOn] = useStoredSetting(presenceSetting);
	const [filters, setFilters] = useState(NO_FILTERS);
	const [detailId, setDetailId] = useState<PrId | null>(null);
	const signals = useSignals(dispatch);
	const now = useNow(state.clockOffsetMs);

	const all = useMemo(() => [...cards.values()], [cards]);
	const mine = useMemo(() => mineFor(viewer.login, all), [viewer.login, all]);
	const shown = useMemo(() => applyFilters(all, filters), [all, filters]);
	const layout = useMemo(() => layoutBoard(shown), [shown]);
	const options = useMemo(() => filterOptions(all), [all]);
	const needsYou = mine.needsMyReview.length + mine.myTurn.length;

	usePresence(presenceOn, detailId);
	useDesktopNotifications({ cards: all, login: viewer.login });

	useEffect(() => {
		document.title = needsYou === 0 ? PRODUCT : `(${needsYou}) ${PRODUCT}`;
		return () => {
			document.title = PRODUCT;
		};
	}, [needsYou]);

	const others = useMemo(() => (presenceOn ? presence.filter((entry) => entry.person.login !== viewer.login) : []), [presence, presenceOn, viewer.login]);
	const watchers = useMemo(() => {
		const byPr = new Map<PrId, Person[]>();
		for (const entry of others) {
			if (entry.viewing === null) continue;
			byPr.set(entry.viewing, [...(byPr.get(entry.viewing) ?? []), entry.person]);
		}
		return byPr;
	}, [others]);

	const env = useMemo<RadarEnv>(
		() => ({
			viewer,
			config,
			now,
			watchersOf: (id) => watchers.get(id) ?? [],
			openDetail: setDetailId,
			signalOf: (id) => signals.statuses.get(id),
			sendSignal: signals.send,
		}),
		[viewer, config, now, watchers, signals],
	);

	const expireToast = useCallback((id: PrId) => dispatch({ type: "toast_expired", id }), [dispatch]);

	const leave = async () => {
		if (presenceOn) sendPresence({ active: false, viewing: null });
		await signOut();
		dispatch({ type: "signed_out", loginUrl: "/auth/login" });
	};

	return (
		<RadarContext.Provider value={env}>
			<div className="app">
				<a className="skip-link" href="#board">
					Skip to the board
				</a>
				<Header
					org={config.org}
					demo={config.demo}
					viewer={viewer}
					connection={state.connection}
					presenceOn={presenceOn}
					onPresence={setPresenceOn}
					people={others.map((entry) => entry.person)}
					notifications={<NotificationsMenu prefs={prefs} onChange={setPrefs} />}
					onSignOut={leave}
				/>
				<main className="page">
					<Mine mine={mine} />
					<section id="board" className="board" aria-labelledby="board-title" tabIndex={-1}>
						<div className="board-head">
							<h2 id="board-title">Everyone's pull requests</h2>
							{all.length > 0 && (
								<FilterBar filters={filters} options={options} org={config.org} viewer={viewer} shown={shown.length} total={all.length} onChange={setFilters} />
							)}
						</div>
						{all.length === 0 ? (
							<p className="board-empty">
								No open pull requests in {config.org}. When someone opens one, it shows up here within seconds.
							</p>
						) : shown.length === 0 && isFiltering(filters) ? (
							<p className="board-empty">
								No pull requests match these filters.{" "}
								<button type="button" className="link-button" onClick={() => setFilters(NO_FILTERS)}>
									Clear filters
								</button>
							</p>
						) : (
							<Board layout={layout} />
						)}
					</section>
				</main>
				<footer className="footer">
					<p>{heuristicSentence(board.heuristic)}</p>
				</footer>
				<Toasts toasts={state.toasts} org={config.org} onExpire={expireToast} />
				{detailId !== null && <Detail key={detailId} card={cards.get(detailId)} onClose={() => setDetailId(null)} />}
			</div>
		</RadarContext.Provider>
	);
}

function heuristicSentence({ confirmed, rejected }: { confirmed: number; rejected: number }): string {
	if (confirmed === 0 && rejected === 0) return "Re-review guesses so far: none confirmed or marked not ready yet.";
	return `Re-review guesses so far: ${confirmed} confirmed, ${rejected} marked not ready.`;
}

function useNow(offsetMs: number): Date {
	const [now, setNow] = useState(() => new Date(Date.now() + offsetMs));
	useEffect(() => {
		const tick = () => setNow(new Date(Date.now() + offsetMs));
		tick();
		const timer = setInterval(tick, TICK_MS);
		const onVisible = () => {
			if (document.visibilityState === "visible") tick();
		};
		document.addEventListener("visibilitychange", onVisible);
		return () => {
			clearInterval(timer);
			document.removeEventListener("visibilitychange", onVisible);
		};
	}, [offsetMs]);
	return now;
}

function useSignals(dispatch: Dispatch<Action>): { statuses: ReadonlyMap<PrId, SignalStatus>; send(id: PrId, kind: SignalKind): void } {
	const [statuses, setStatuses] = useState<ReadonlyMap<PrId, SignalStatus>>(new Map());
	const update = useCallback((id: PrId, status: SignalStatus | null, onlyIf?: SignalStatus) => {
		setStatuses((current) => {
			if (onlyIf !== undefined && current.get(id) !== onlyIf) return current;
			const next = new Map(current);
			if (status === null) next.delete(id);
			else next.set(id, status);
			return next;
		});
	}, []);
	const send = useCallback(
		(id: PrId, kind: SignalKind) => {
			update(id, { kind, result: null });
			sendSignal(id, kind).then((result) => {
				if (!result.ok && result.error === "signed_out") {
					dispatch({ type: "signed_out", loginUrl: "/auth/login" });
					return;
				}
				const done: SignalStatus = { kind, result };
				update(id, done);
				setTimeout(() => update(id, null, done), SIGNAL_MESSAGE_MS);
			});
		},
		[dispatch, update],
	);
	return useMemo(() => ({ statuses, send }), [statuses, send]);
}
