import { join } from "node:path";
import type { ServerEvent } from "@radar/core";
import { createBoard } from "./board.ts";
import type { Board } from "./board.ts";
import type { Clock, Timer } from "./clock.ts";
import type { Config } from "./config.ts";
import { createDemo } from "./demo/index.ts";
import type { Demo } from "./demo/index.ts";
import { createAppAuth } from "./github/appAuth.ts";
import type { Fetch } from "./github/http.ts";
import { createGitHubSource, refKey } from "./github/source.ts";
import type { PrRef } from "./github/source.ts";
import { createApp } from "./http.ts";
import { createHub } from "./hub.ts";
import type { Hub } from "./hub.ts";
import { errorMessage } from "./log.ts";
import type { Logger } from "./log.ts";
import { createPresence } from "./presence.ts";
import { createReconciler } from "./reconcile.ts";
import type { Reconciler } from "./reconcile.ts";
import { createRefresher } from "./refresher.ts";
import { createSessionCodec } from "./session.ts";
import { createStore } from "./store.ts";
import { createGitHubRequester } from "./writer.ts";

export const TICK_MS = 60_000;

export interface Radar {
	app: ReturnType<typeof createApp>;
	board: Board;
	hub: Hub;
	reconciler: Reconciler;
	/** Null in GitHub mode. */
	demo: Demo | null;
	/** Starts the sweep, tick, and demo autoplay timers. */
	start(): void;
	/** Stops every timer, flushes the store, and ends every stream. */
	stop(): void;
}

function modeOf(config: Config, deps: { clock: Clock; log: Logger; fetch: Fetch; mark: (ref: PrRef) => void }) {
	switch (config.mode) {
		case "github": {
			const { appId, privateKeyPem, installationId } = config.github;
			const source = createGitHubSource({
				org: config.org,
				appAuth: createAppAuth({ appId, privateKeyPem, fetch: deps.fetch }),
				installationId: installationId ?? undefined,
				repoDenylist: config.repoDenylist,
				fetch: deps.fetch,
				onFetchError: (error, ref) => deps.log.warn("github.fetch_failed", { pr: refKey(ref), error: errorMessage(error) }),
			});
			const github = { fetch: deps.fetch, installationToken: source.installationToken };
			return { source, requester: createGitHubRequester({ fetch: deps.fetch }), demo: null, deps: { config, github } };
		}
		case "demo": {
			const demo = createDemo({ clock: deps.clock, hint: deps.mark });
			return { source: demo.source, requester: demo.requester, demo, deps: { config, demo: demo.control } };
		}
		default: {
			const unhandled: never = config;
			return unhandled;
		}
	}
}

export function createRadar({ config, clock, log, fetch = globalThis.fetch }: { config: Config; clock: Clock; log: Logger; fetch?: Fetch }): Radar {
	const store = createStore({ file: config.mode === "demo" ? null : join(config.dataDir, "state.json"), clock, log });
	const board = createBoard({
		store,
		cardConfig: {
			priorityLabels: config.priorityLabels,
			helpWantedAfterBusinessHours: config.helpWantedAfterBusinessHours,
			timeZone: config.timeZone,
			botLogins: config.botLogins,
		},
	});
	const hub = createHub({ clock });
	const publish = (events: ServerEvent[]) => {
		for (const event of events) hub.broadcast(event);
	};
	const presence = createPresence({ clock, onChange: (list) => hub.broadcast({ kind: "presence", presence: list }) });
	const mode = modeOf(config, { clock, log, fetch, mark: (ref) => refresher.mark(ref) });
	const refresher = createRefresher({ source: mode.source, apply: (ref, snapshot) => publish(board.apply(ref, snapshot, clock.now())), clock, log });
	const reconciler = createReconciler({ source: mode.source, board, refresher, publish, clock, log, fullSweepEvery: config.fullSweepEvery });
	const app = createApp({
		...mode.deps,
		board,
		hub,
		presence,
		refresher,
		requester: mode.requester,
		sessions: createSessionCodec(config.sessionSecret),
		clock,
		lastSweepAt: reconciler.lastSweepAt,
		log,
	});
	const timers: Timer[] = [];

	return {
		app,
		board,
		hub,
		reconciler,
		demo: mode.demo,
		start() {
			timers.push(
				clock.setInterval(() => void reconciler.sweep(), config.reconcileSeconds * 1000),
				clock.setInterval(() => publish(board.tick(clock.now())), TICK_MS),
			);
			const { demo } = mode;
			if (demo !== null && config.mode === "demo" && config.demoIntervalSeconds > 0) {
				timers.push(
					clock.setInterval(() => {
						const { step, description } = demo.advance();
						log.info("demo.step", { step, description });
					}, config.demoIntervalSeconds * 1000),
				);
			}
		},
		stop() {
			for (const timer of timers.splice(0)) clock.clearInterval(timer);
			refresher.stop();
			presence.stop();
			store.flush();
			hub.close();
		},
	};
}
