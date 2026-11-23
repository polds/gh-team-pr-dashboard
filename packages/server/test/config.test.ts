import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.ts";

const GITHUB_ENV = {
	RADAR_ORG: "atum",
	RADAR_BASE_URL: "https://radar.example.com/",
	RADAR_SESSION_SECRET: "a".repeat(64),
	GITHUB_APP_ID: "123",
	GITHUB_APP_CLIENT_ID: "Iv1.abc",
	GITHUB_APP_CLIENT_SECRET: "client-secret",
	GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----",
	GITHUB_WEBHOOK_SECRET: "hook-secret",
};

const noFile = (path: string): string => {
	throw Object.assign(new Error(`no ${path}`), { code: "ENOENT" });
};

describe("loadConfig", () => {
	it("starts demo mode with no GitHub variable and the runbook defaults", () => {
		const config = loadConfig({ RADAR_DEMO: "1" }, noFile);
		expect(config).toMatchObject({
			mode: "demo",
			org: "atum",
			port: 8080,
			baseUrl: "http://localhost:8080",
			timeZone: "UTC",
			priorityLabels: ["priority", "urgent", "hotfix"],
			botLogins: ["renovate", "dependabot", "github-actions"],
			repoDenylist: [],
			helpWantedAfterBusinessHours: 24,
			reconcileSeconds: 300,
			fullSweepEvery: 12,
			dataDir: "./data",
			webDist: "packages/web/dist",
			demoIntervalSeconds: 8,
		});
		expect(config.sessionSecret).toHaveLength(64);
	});

	it("runs the demo against its simulated organization whatever RADAR_ORG says, since the board holds only that organization's pull requests", () => {
		expect(loadConfig({ RADAR_DEMO: "1", RADAR_ORG: "acme" }, noFile).org).toBe("atum");
	});

	it("makes a new session secret at each demo start, ignoring RADAR_SESSION_SECRET", () => {
		const shared = "a".repeat(64);
		const first = loadConfig({ RADAR_DEMO: "1", RADAR_SESSION_SECRET: shared }, noFile).sessionSecret;
		const second = loadConfig({ RADAR_DEMO: "1", RADAR_SESSION_SECRET: shared }, noFile).sessionSecret;
		expect(first).not.toBe(shared);
		expect(second).not.toBe(first);
		expect(loadConfig({ RADAR_DEMO: "1", RADAR_SESSION_SECRET: "short" }, noFile).mode).toBe("demo");
	});

	it("reads GitHub mode and strips the trailing slash from the base URL", () => {
		const config = loadConfig({ ...GITHUB_ENV, RADAR_REPO_DENYLIST: "sandbox, scratch", GITHUB_INSTALLATION_ID: "42" }, noFile);
		expect(config.mode).toBe("github");
		if (config.mode !== "github") return;
		expect(config.baseUrl).toBe("https://radar.example.com");
		expect(config.rerequestEnabled).toBe(false);
		expect(config.repoDenylist).toEqual(["sandbox", "scratch"]);
		expect(config.github.installationId).toBe(42);
		expect(config.github.privateKeyPem).toBe("-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----");
	});

	it("reads the private key from GITHUB_APP_PRIVATE_KEY_FILE", () => {
		const { GITHUB_APP_PRIVATE_KEY: _key, ...env } = GITHUB_ENV;
		const config = loadConfig({ ...env, GITHUB_APP_PRIVATE_KEY_FILE: "/secrets/key.pem" }, (path) => `pem from ${path}`);
		expect(config.mode === "github" && config.github.privateKeyPem).toBe("pem from /secrets/key.pem");
	});

	it("names each missing variable, treating an empty value as missing", () => {
		const { GITHUB_APP_ID: _id, ...env } = GITHUB_ENV;
		const load = () => loadConfig({ ...env, GITHUB_WEBHOOK_SECRET: "" }, noFile);
		expect(load).toThrow(ConfigError);
		expect(load).toThrow(/GITHUB_APP_ID is required/);
		expect(load).toThrow(/GITHUB_WEBHOOK_SECRET is required/);
	});

	it("names a missing private key and an unreadable key file", () => {
		const { GITHUB_APP_PRIVATE_KEY: _key, ...env } = GITHUB_ENV;
		expect(() => loadConfig(env, noFile)).toThrow("GITHUB_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_FILE is required");
		expect(() => loadConfig({ ...env, GITHUB_APP_PRIVATE_KEY_FILE: "/nope" }, noFile)).toThrow("GITHUB_APP_PRIVATE_KEY_FILE could not be read (ENOENT)");
	});

	it("rejects malformed values by name without echoing them", () => {
		const load = () => loadConfig({ ...GITHUB_ENV, PORT: "eighty", RADAR_TIME_ZONE: "Mars/Olympus", RADAR_SESSION_SECRET: "short" }, noFile);
		expect(load).toThrow(/PORT must be a number/);
		expect(load).toThrow(/RADAR_TIME_ZONE must be an IANA time zone/);
		expect(load).toThrow(/RADAR_SESSION_SECRET must be at least 32 characters/);
		expect(load).not.toThrow(/short/);
	});

	it("turns demo autoplay off with an interval of zero", () => {
		expect(loadConfig({ RADAR_DEMO: "1", RADAR_DEMO_INTERVAL_SECONDS: "0", PORT: "8791" }, noFile)).toMatchObject({
			demoIntervalSeconds: 0,
			baseUrl: "http://localhost:8791",
		});
	});
});
