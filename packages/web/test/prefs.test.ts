import { describe, expect, test, vi } from "vitest";
import { DEFAULT_NOTIFICATION_PREFS } from "@radar/core";
import type { NotificationPrefs } from "@radar/core";
import { parseNotificationPrefs, storedSetting } from "../src/prefs.ts";
import type { PrefsStorage, SettingEnv } from "../src/prefs.ts";

const NOTIFICATIONS = "radar.notifications";
const PRESENCE = "radar.presence";

/** One browser's storage, shared by its tabs. A write in one tab reaches the others as a storage event, as in a real browser. */
function browser(initial: Record<string, string> = {}) {
	const data = new Map(Object.entries(initial));
	const tabs = new Set<(key: string | null) => void>();
	const tab = (): SettingEnv & { otherTabWrites: (key: string, value: string) => void } => {
		const own = new Set<(key: string | null) => void>();
		const others = (key: string | null) => {
			for (const listener of tabs) if (!own.has(listener)) listener(key);
		};
		return {
			storage: () => ({
				getItem: (key) => data.get(key) ?? null,
				setItem: (key, value) => {
					data.set(key, value);
					others(key);
				},
			}),
			onOtherTab(listener) {
				own.add(listener);
				tabs.add(listener);
				return () => {
					own.delete(listener);
					tabs.delete(listener);
				};
			},
			otherTabWrites(key, value) {
				data.set(key, value);
				for (const listener of own) listener(key);
			},
		};
	};
	const clear = () => {
		data.clear();
		for (const listener of tabs) listener(null);
	};
	return { data, tab, clear };
}

const throwingStorage: PrefsStorage = {
	getItem() {
		throw new DOMException("blocked", "SecurityError");
	},
	setItem() {
		throw new DOMException("full", "QuotaExceededError");
	},
};

const fixed = (storage: PrefsStorage | null): SettingEnv => ({ storage: () => storage, onOtherTab: () => () => {} });

const presenceIn = (env: SettingEnv) => storedSetting(PRESENCE, (value) => value === true, env);
const prefsIn = (env: SettingEnv) => storedSetting(NOTIFICATIONS, parseNotificationPrefs, env);

const custom: NotificationPrefs = {
	enabled: true,
	teamRequests: true,
	heuristic: false,
	quietHours: { startMinute: 18 * 60, endMinute: 9 * 60 },
	digestMinutes: 30,
};

describe("notification prefs storage", () => {
	test("empty storage, no storage, and throwing storage all read as off", () => {
		expect(prefsIn(browser().tab()).read()).toEqual(DEFAULT_NOTIFICATION_PREFS);
		expect(prefsIn(fixed(null)).read()).toEqual(DEFAULT_NOTIFICATION_PREFS);
		expect(prefsIn(fixed(throwingStorage)).read()).toEqual(DEFAULT_NOTIFICATION_PREFS);
		expect(DEFAULT_NOTIFICATION_PREFS.enabled).toBe(false);
	});

	test("a write reads back the same prefs, in this tab and a fresh one", () => {
		const shared = browser();
		prefsIn(shared.tab()).write(custom);
		expect(prefsIn(shared.tab()).read()).toEqual(custom);
	});

	test("garbage reads as the defaults", () => {
		expect(prefsIn(browser({ [NOTIFICATIONS]: "{not json" }).tab()).read()).toEqual(DEFAULT_NOTIFICATION_PREFS);
		expect(prefsIn(browser({ [NOTIFICATIONS]: "42" }).tab()).read()).toEqual(DEFAULT_NOTIFICATION_PREFS);
	});

	test("each bad field falls back on its own", () => {
		const stored = JSON.stringify({ enabled: true, teamRequests: "yes", quietHours: { startMinute: 2000, endMinute: 60 }, digestMinutes: 7 });
		expect(prefsIn(browser({ [NOTIFICATIONS]: stored }).tab()).read()).toEqual({ ...DEFAULT_NOTIFICATION_PREFS, enabled: true });
	});

	test("reads return the same object until the stored value changes", () => {
		const setting = prefsIn(browser({ [NOTIFICATIONS]: JSON.stringify(custom) }).tab());
		const first = setting.read();
		expect(setting.read()).toBe(first);
		setting.write({ ...custom, enabled: false });
		expect(setting.read()).not.toBe(first);
		expect(setting.read().enabled).toBe(false);
	});
});

describe("presence switch storage", () => {
	test("is off unless stored as on", () => {
		expect(presenceIn(browser().tab()).read()).toBe(false);
		expect(presenceIn(fixed(null)).read()).toBe(false);
		expect(presenceIn(fixed(throwingStorage)).read()).toBe(false);
		expect(presenceIn(browser({ [PRESENCE]: "\"true\"" }).tab()).read()).toBe(false);
	});

	test("a write reads back", () => {
		const setting = presenceIn(browser().tab());
		setting.write(true);
		expect(setting.read()).toBe(true);
		setting.write(false);
		expect(setting.read()).toBe(false);
	});
});

describe("a setting shared by two tabs", () => {
	test("turning presence off in one tab turns it off in the other and tells its subscribers", () => {
		const shared = browser();
		const tabA = presenceIn(shared.tab());
		tabA.write(true);
		const tabB = presenceIn(shared.tab());
		const heard = vi.fn();
		tabB.subscribe(heard);
		expect(tabB.read()).toBe(true);
		tabA.write(false);
		expect(heard).toHaveBeenCalledTimes(1);
		expect(tabB.read()).toBe(false);
	});

	test("turning notifications on in one tab turns them on in the other", () => {
		const shared = browser();
		const tabA = prefsIn(shared.tab());
		const tabB = prefsIn(shared.tab());
		const heard = vi.fn();
		tabB.subscribe(heard);
		tabA.write(custom);
		expect(heard).toHaveBeenCalledTimes(1);
		expect(tabB.read()).toEqual(custom);
	});

	test("a tab reads the stored value even with no subscriber, as a heartbeat does", () => {
		const shared = browser({ [PRESENCE]: "true" });
		const tabB = presenceIn(shared.tab());
		expect(tabB.read()).toBe(true);
		presenceIn(shared.tab()).write(false);
		expect(tabB.read()).toBe(false);
	});

	test("a change to another key does not notify", () => {
		const shared = browser();
		const env = shared.tab();
		const heard = vi.fn();
		presenceIn(env).subscribe(heard);
		env.otherTabWrites(NOTIFICATIONS, JSON.stringify(custom));
		expect(heard).not.toHaveBeenCalled();
	});

	test("clearing storage in another tab turns the setting off", () => {
		const shared = browser({ [PRESENCE]: "true" });
		const tabB = presenceIn(shared.tab());
		const heard = vi.fn();
		tabB.subscribe(heard);
		shared.clear();
		expect(heard).toHaveBeenCalledTimes(1);
		expect(tabB.read()).toBe(false);
	});

	test("an unsubscribed listener hears nothing", () => {
		const shared = browser();
		const tabB = presenceIn(shared.tab());
		const heard = vi.fn();
		tabB.subscribe(heard)();
		presenceIn(shared.tab()).write(true);
		expect(heard).not.toHaveBeenCalled();
	});
});

describe("a write that storage refuses", () => {
	test("does not throw and still holds for this tab", () => {
		const setting = presenceIn(fixed(throwingStorage));
		expect(() => setting.write(true)).not.toThrow();
		expect(setting.read()).toBe(true);
		const prefs = prefsIn(fixed(null));
		prefs.write(custom);
		expect(prefs.read()).toEqual(custom);
	});

	test("gives way to a later change from another tab", () => {
		const shared = browser({ [PRESENCE]: "true" });
		const env = shared.tab();
		const full: PrefsStorage = { getItem: (key) => shared.data.get(key) ?? null, setItem: throwingStorage.setItem };
		const setting = presenceIn({ storage: () => full, onOtherTab: env.onOtherTab });
		setting.subscribe(() => {});
		setting.write(false);
		expect(setting.read()).toBe(false);
		env.otherTabWrites(PRESENCE, "true");
		expect(setting.read()).toBe(true);
	});
});
