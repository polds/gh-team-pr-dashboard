import { createContext, useContext } from "react";
import type { BoardConfig, Person, PrId, Viewer } from "@radar/core";
import type { SignalResult } from "../api.ts";

export type SignalKind = "ready" | "not_ready";

/** The author's last signal from this tab. `result` is null while the request is in flight. */
export interface SignalStatus {
	kind: SignalKind;
	result: SignalResult | null;
}

/** What every card needs from the page, so lanes and lists do not thread it through. */
export interface RadarEnv {
	viewer: Viewer;
	config: BoardConfig;
	/** Now by the server's clock, refreshed every 30 seconds. */
	now: Date;
	/** Other people who have this pull request's details open. Empty while the viewer's presence is off. */
	watchersOf(id: PrId): Person[];
	openDetail(id: PrId): void;
	signalOf(id: PrId): SignalStatus | undefined;
	sendSignal(id: PrId, kind: SignalKind): void;
}

export const RadarContext = createContext<RadarEnv | null>(null);

export function useRadar(): RadarEnv {
	const env = useContext(RadarContext);
	if (env === null) throw new Error("useRadar needs a RadarContext provider");
	return env;
}
