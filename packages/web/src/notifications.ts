import { useCallback, useEffect, useMemo, useRef } from "react";
import { INITIAL_NOTIFIER_STATE, notifierStep } from "@radar/core";
import type { Card, Login, NotificationPrefs, NotifierInput, OutgoingNotification } from "@radar/core";
import { minuteOfDay } from "./format.ts";

const TICK_MS = 30_000;

export type Permission = NotificationPermission | "unsupported";

export function notificationPermission(): Permission {
	return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

/** Asks the browser for permission. Call it only from the user turning notifications on. */
export async function askPermission(): Promise<Permission> {
	if (typeof Notification === "undefined") return "unsupported";
	try {
		return await Notification.requestPermission();
	} catch {
		return Notification.permission;
	}
}

export function useDesktopNotifications({ cards, login, prefs }: { cards: Card[]; login: Login; prefs: NotificationPrefs }): void {
	const notifier = useRef(INITIAL_NOTIFIER_STATE);
	const previous = useRef<Card[] | null>(null);
	const granted = notificationPermission() === "granted";
	const effective = useMemo(() => (granted ? prefs : { ...prefs, enabled: false }), [prefs, granted]);

	const step = useCallback(
		(input: NotifierInput) => {
			const now = new Date();
			const result = notifierStep(notifier.current, input, { login, prefs: effective, nowMs: now.getTime(), minuteOfDay: minuteOfDay(now) });
			notifier.current = result.state;
			for (const notification of result.deliver) raise(notification);
		},
		[login, effective],
	);

	useEffect(() => {
		const before = previous.current;
		previous.current = cards;
		if (before !== null && before !== cards) step({ kind: "board", before, after: cards });
	}, [cards, step]);

	useEffect(() => {
		const timer = setInterval(() => step({ kind: "tick" }), TICK_MS);
		return () => clearInterval(timer);
	}, [step]);
}

function raise({ title, body, tag, url }: OutgoingNotification): void {
	try {
		const notification = new Notification(title, { body, tag });
		notification.onclick = () => {
			window.focus();
			if (url !== null) window.open(url, "_blank", "noopener");
			notification.close();
		};
	} catch {
		// Some browsers only raise notifications from a service worker. Radar has none, so it stays quiet there.
	}
}
