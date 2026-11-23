import { useSyncExternalStore } from "react";
import { DEFAULT_NOTIFICATION_PREFS } from "@radar/core";
import type { NotificationPrefs } from "@radar/core";

export interface PrefsStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

const NOTIFICATIONS_KEY = "radar.notifications";
const PRESENCE_KEY = "radar.presence";
export const DIGEST_CHOICES = [0, 15, 30, 60] as const;
const MINUTES_PER_DAY = 24 * 60;

/** `localStorage`, or null where reading it throws (blocked cookies, some private modes). */
function browserStorage(): PrefsStorage | null {
	try {
		return window.localStorage;
	} catch {
		return null;
	}
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

export interface StoredSetting<T> {
	/** The stored value, read fresh on every call. */
	read(): T;
	write(value: T): void;
	/** Calls `listener` when this tab writes the setting or another tab changes it. */
	subscribe(listener: () => void): () => void;
}

export interface SettingEnv {
	storage(): PrefsStorage | null;
	/** Calls `listener` with the key of each `storage` event, which fires when another tab changes storage. */
	onOtherTab(listener: (key: string | null) => void): () => void;
}

const browserEnv: SettingEnv = {
	storage: browserStorage,
	onOtherTab(listener) {
		const handle = (event: StorageEvent) => listener(event.key);
		window.addEventListener("storage", handle);
		return () => window.removeEventListener("storage", handle);
	},
};

/**
 * One setting kept in storage, which every tab reads as the truth.
 * A write that storage refuses still holds for this tab, until another tab changes the setting.
 */
export function storedSetting<T>(key: string, parse: (value: unknown) => T, env: SettingEnv): StoredSetting<T> {
	const listeners = new Set<() => void>();
	let unstored: string | null = null;
	let cachedRaw: string | null | undefined;
	let cached: T;

	const read = () => {
		const raw = unstored ?? getRaw(env.storage(), key);
		if (raw !== cachedRaw) {
			cachedRaw = raw;
			cached = parse(parseJson(raw));
		}
		return cached;
	};

	const write = (value: T) => {
		const raw = JSON.stringify(value);
		unstored = setRaw(env.storage(), key, raw) ? null : raw;
		for (const listener of [...listeners]) listener();
	};

	const subscribe = (listener: () => void) => {
		listeners.add(listener);
		const stop = env.onOtherTab((changed) => {
			if (changed !== key && changed !== null) return;
			unstored = null;
			listener();
		});
		return () => {
			listeners.delete(listener);
			stop();
		};
	};

	return { read, write, subscribe };
}

export const notificationPrefsSetting = storedSetting(NOTIFICATIONS_KEY, parseNotificationPrefs, browserEnv);
export const presenceSetting = storedSetting(PRESENCE_KEY, (value) => value === true, browserEnv);

export function useStoredSetting<T>(setting: StoredSetting<T>): [T, (value: T) => void] {
	return [useSyncExternalStore(setting.subscribe, setting.read), setting.write];
}

function getRaw(storage: PrefsStorage | null, key: string): string | null {
	try {
		return storage?.getItem(key) ?? null;
	} catch {
		return null;
	}
}

function parseJson(raw: string | null): unknown {
	try {
		return raw === null ? null : JSON.parse(raw);
	} catch {
		return null;
	}
}

function setRaw(storage: PrefsStorage | null, key: string, raw: string): boolean {
	if (storage === null) return false;
	try {
		storage.setItem(key, raw);
		return true;
	} catch {
		return false;
	}
}
