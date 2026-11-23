import { useEffect, useRef } from "react";
import type { PrId } from "@radar/core";
import { sendPresence } from "./api.ts";

const HEARTBEAT_MS = 20_000;

export function usePresence(enabled: boolean, viewing: PrId | null): void {
	const viewingRef = useRef(viewing);

	useEffect(() => {
		viewingRef.current = viewing;
		if (enabled) sendPresence({ active: true, viewing });
	}, [enabled, viewing]);

	useEffect(() => {
		if (!enabled) return;
		const beat = () => sendPresence({ active: true, viewing: viewingRef.current });
		const leave = () => sendPresence({ active: false, viewing: null }, { keepalive: true });
		const back = (event: PageTransitionEvent) => {
			if (event.persisted) beat();
		};
		const timer = setInterval(beat, HEARTBEAT_MS);
		window.addEventListener("pagehide", leave);
		window.addEventListener("pageshow", back);
		return () => {
			clearInterval(timer);
			window.removeEventListener("pagehide", leave);
			window.removeEventListener("pageshow", back);
			sendPresence({ active: false, viewing: null });
		};
	}, [enabled]);
}
