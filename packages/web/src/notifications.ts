import { useCallback, useEffect, useRef } from "react";
import { INITIAL_NOTIFIER_STATE, notifierStep } from "@radar/core";
import type { Card, Login, NotifierInput, OutgoingNotification } from "@radar/core";
import { minuteOfDay } from "./format.ts";
import { notificationPrefsSetting } from "./prefs.ts";

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

/** Reads the stored prefs on every step, so a change from any tab applies before the next notification. */
export function useDesktopNotifications({ cards, login }: { cards: Card[]; login: Login }): void {
	const notifier = useRef(INITIAL_NOTIFIER_STATE);
	const previous = useRef<Card[] | null>(null);

	const step = useCallback(
		(input: NotifierInput) => {
			const stored = notificationPrefsSetting.read();
			const prefs = notificationPermission() === "granted" ? stored : { ...stored, enabled: false };
			const now = new Date();
			const result = notifierStep(notifier.current, input, { login, prefs, nowMs: now.getTime(), minuteOfDay: minuteOfDay(now) });
			notifier.current = result.state;
			for (const notification of result.deliver) raise(notification);
		},
		[login],
	);

	useEffect(
		() =>
			notificationPrefsSetting.subscribe(() => {
				if (!notificationPrefsSetting.read().enabled) notifier.current = INITIAL_NOTIFIER_STATE;
			}),
		[],
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
