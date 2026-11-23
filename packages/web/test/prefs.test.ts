import { describe, expect, test } from "vitest";
import { DEFAULT_NOTIFICATION_PREFS } from "@radar/core";
import type { NotificationPrefs } from "@radar/core";
import { readNotificationPrefs, readPresenceOn, writeNotificationPrefs, writePresenceOn } from "../src/prefs.ts";
import type { PrefsStorage } from "../src/prefs.ts";

function memoryStorage(initial: Record<string, string> = {}): PrefsStorage & { data: Map<string, string> } {
	const data = new Map(Object.entries(initial));
	return {
		data,
		getItem: (key) => data.get(key) ?? null,
		setItem: (key, value) => {
			data.set(key, value);
		},
	};
}

const throwingStorage: PrefsStorage = {
	getItem() {
		throw new DOMException("blocked", "SecurityError");
	},
	setItem() {
		throw new DOMException("full", "QuotaExceededError");
	},
};

const custom: NotificationPrefs = {
	enabled: true,
	teamRequests: true,
	heuristic: false,
	quietHours: { startMinute: 18 * 60, endMinute: 9 * 60 },
	digestMinutes: 30,
};

describe("notification prefs storage", () => {
	test("empty storage, no storage, and throwing storage all read as off", () => {
		expect(readNotificationPrefs(memoryStorage())).toEqual(DEFAULT_NOTIFICATION_PREFS);
		expect(readNotificationPrefs(null)).toEqual(DEFAULT_NOTIFICATION_PREFS);
		expect(readNotificationPrefs(throwingStorage)).toEqual(DEFAULT_NOTIFICATION_PREFS);
		expect(DEFAULT_NOTIFICATION_PREFS.enabled).toBe(false);
	});

	test("a write reads back the same prefs", () => {
		const storage = memoryStorage();
		writeNotificationPrefs(storage, custom);
		expect(readNotificationPrefs(storage)).toEqual(custom);
	});

	test("writing to a throwing storage does not throw", () => {
		expect(() => writeNotificationPrefs(throwingStorage, custom)).not.toThrow();
		expect(() => writePresenceOn(throwingStorage, true)).not.toThrow();
	});

	test("garbage reads as the defaults", () => {
		expect(readNotificationPrefs(memoryStorage({ "radar.notifications": "{not json" }))).toEqual(DEFAULT_NOTIFICATION_PREFS);
		expect(readNotificationPrefs(memoryStorage({ "radar.notifications": "42" }))).toEqual(DEFAULT_NOTIFICATION_PREFS);
	});

	test("each bad field falls back on its own", () => {
		const stored = JSON.stringify({ enabled: true, teamRequests: "yes", quietHours: { startMinute: 2000, endMinute: 60 }, digestMinutes: 7 });
		expect(readNotificationPrefs(memoryStorage({ "radar.notifications": stored }))).toEqual({ ...DEFAULT_NOTIFICATION_PREFS, enabled: true });
	});
});

describe("presence switch storage", () => {
	test("is off unless stored as on", () => {
		expect(readPresenceOn(memoryStorage())).toBe(false);
		expect(readPresenceOn(null)).toBe(false);
		expect(readPresenceOn(throwingStorage)).toBe(false);
		expect(readPresenceOn(memoryStorage({ "radar.presence": "\"true\"" }))).toBe(false);
	});

	test("a write reads back", () => {
		const storage = memoryStorage();
		writePresenceOn(storage, true);
		expect(readPresenceOn(storage)).toBe(true);
		writePresenceOn(storage, false);
		expect(readPresenceOn(storage)).toBe(false);
	});
});
