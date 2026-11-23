import { useCallback, useState } from "react";
import { DEFAULT_NOTIFICATION_PREFS } from "@radar/core";
import type { NotificationPrefs } from "@radar/core";

/** The part of `Storage` that prefs need, so tests can pass a fake that throws. */
export interface PrefsStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

const NOTIFICATIONS_KEY = "radar.notifications";
const PRESENCE_KEY = "radar.presence";
export const DIGEST_CHOICES = [0, 15, 30, 60] as const;
const MINUTES_PER_DAY = 24 * 60;

/** `localStorage`, or null where reading it throws (blocked cookies, some private modes). */
export function browserStorage(): PrefsStorage | null {
	try {
		return window.localStorage;
	} catch {
		return null;
	}
}

export function readNotificationPrefs(storage: PrefsStorage | null): NotificationPrefs {
	return parseNotificationPrefs(readJson(storage, NOTIFICATIONS_KEY));
}

export function writeNotificationPrefs(storage: PrefsStorage | null, prefs: NotificationPrefs): void {
	write(storage, NOTIFICATIONS_KEY, JSON.stringify(prefs));
}

export function readPresenceOn(storage: PrefsStorage | null): boolean {
	return readJson(storage, PRESENCE_KEY) === true;
}

export function writePresenceOn(storage: PrefsStorage | null, on: boolean): void {
	write(storage, PRESENCE_KEY, JSON.stringify(on));
}

/** Each field falls back to its off default on its own, so one bad field does not reset the rest. */
export function parseNotificationPrefs(value: unknown): NotificationPrefs {
	if (typeof value !== "object" || value === null) return DEFAULT_NOTIFICATION_PREFS;
	const fallback = DEFAULT_NOTIFICATION_PREFS;
	const flag = (key: "enabled" | "teamRequests" | "heuristic") => {
		const field: unknown = Reflect.get(value, key);
		return typeof field === "boolean" ? field : fallback[key];
	};
	const digest: unknown = Reflect.get(value, "digestMinutes");
	return {
		enabled: flag("enabled"),
		teamRequests: flag("teamRequests"),
		heuristic: flag("heuristic"),
		quietHours: parseQuietHours(Reflect.get(value, "quietHours")),
		digestMinutes: DIGEST_CHOICES.find((choice) => choice === digest) ?? fallback.digestMinutes,
	};
}

function parseQuietHours(value: unknown): NotificationPrefs["quietHours"] {
	if (typeof value !== "object" || value === null) return null;
	const startMinute: unknown = Reflect.get(value, "startMinute");
	const endMinute: unknown = Reflect.get(value, "endMinute");
	return isMinuteOfDay(startMinute) && isMinuteOfDay(endMinute) ? { startMinute, endMinute } : null;
}

function isMinuteOfDay(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < MINUTES_PER_DAY;
}

function readJson(storage: PrefsStorage | null, key: string): unknown {
	try {
		const raw = storage?.getItem(key) ?? null;
		return raw === null ? null : JSON.parse(raw);
	} catch {
		return null;
	}
}

function write(storage: PrefsStorage | null, key: string, value: string): void {
	try {
		storage?.setItem(key, value);
	} catch {
		// Storage full or blocked: the setting still holds for this tab.
	}
}

export function useNotificationPrefs(): [NotificationPrefs, (prefs: NotificationPrefs) => void] {
	const [prefs, setPrefs] = useState(() => readNotificationPrefs(browserStorage()));
	const update = useCallback((next: NotificationPrefs) => {
		setPrefs(next);
		writeNotificationPrefs(browserStorage(), next);
	}, []);
	return [prefs, update];
}

export function usePresenceSwitch(): [boolean, (on: boolean) => void] {
	const [on, setOn] = useState(() => readPresenceOn(browserStorage()));
	const update = useCallback((next: boolean) => {
		setOn(next);
		writePresenceOn(browserStorage(), next);
	}, []);
	return [on, update];
}
