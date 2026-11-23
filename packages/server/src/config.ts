import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";

interface BaseConfig {
	port: number;
	org: string;
	/** No trailing slash. */
	baseUrl: string;
	timeZone: string;
	priorityLabels: string[];
	botLogins: string[];
	repoDenylist: string[];
	helpWantedAfterBusinessHours: number;
	reconcileSeconds: number;
	fullSweepEvery: number;
	rerequestEnabled: boolean;
	dataDir: string;
	webDist: string;
	sessionSecret: string;
}

export interface GitHubAppConfig {
	appId: string;
	clientId: string;
	clientSecret: string;
	privateKeyPem: string;
	webhookSecret: string;
	installationId: number | null;
}

export interface GitHubConfig extends BaseConfig {
	mode: "github";
	github: GitHubAppConfig;
}

export interface DemoConfig extends BaseConfig {
	mode: "demo";
	/** Zero turns autoplay off. */
	demoIntervalSeconds: number;
}

export type Config = GitHubConfig | DemoConfig;

export class ConfigError extends Error {
	override readonly name = "ConfigError";
}

const required = (what = "a string") =>
	z.string({ error: (issue) => (issue.input === undefined ? "is required" : `must be ${what}`) });

const integer = (min: number) => z.coerce.number({ error: "must be a number" }).int("must be a whole number").min(min, `must be at least ${min}`);

const list = z.string().transform((value) =>
	value
		.split(",")
		.map((item) => item.trim())
		.filter((item) => item !== ""),
);

const flag = z.enum(["true", "false", "1", "0"], { error: "must be true or false" }).transform((value) => value === "true" || value === "1");

function isTimeZone(value: string): boolean {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: value });
		return true;
	} catch {
		return false;
	}
}

const baseUrl = required("an http or https URL")
	.refine((value) => URL.canParse(value) && /^https?:$/.test(new URL(value).protocol), "must be an http or https URL")
	.transform((value) => value.replace(/\/+$/, ""));

const commonSchema = z.object({
	PORT: integer(1).max(65535, "must be at most 65535").default(8080),
	RADAR_TIME_ZONE: z.string().refine(isTimeZone, "must be an IANA time zone such as America/Los_Angeles").default("UTC"),
	RADAR_PRIORITY_LABELS: list.prefault("priority,urgent,hotfix"),
	RADAR_BOT_LOGINS: list.prefault("renovate,dependabot,github-actions"),
	RADAR_REPO_DENYLIST: list.prefault(""),
	RADAR_HELP_WANTED_AFTER_HOURS: integer(0).default(24),
	RADAR_RECONCILE_SECONDS: integer(10).default(300),
	RADAR_FULL_SWEEP_EVERY: integer(1).default(12),
	RADAR_DATA_DIR: z.string().default("./data"),
	RADAR_WEB_DIST: z.string().default("packages/web/dist"),
});

const sessionSecret = required().min(32, "must be at least 32 characters; generate one with openssl rand -hex 32");

const githubSchema = commonSchema.extend({
	RADAR_ORG: required(),
	RADAR_BASE_URL: baseUrl,
	RADAR_SESSION_SECRET: sessionSecret,
	RADAR_REREQUEST_ENABLED: flag.prefault("false"),
	GITHUB_APP_ID: required(),
	GITHUB_APP_CLIENT_ID: required(),
	GITHUB_APP_CLIENT_SECRET: required(),
	GITHUB_APP_PRIVATE_KEY: z.string().optional(),
	GITHUB_APP_PRIVATE_KEY_FILE: z.string().optional(),
	GITHUB_WEBHOOK_SECRET: required(),
	GITHUB_INSTALLATION_ID: integer(1).optional(),
});

const demoSchema = commonSchema.extend({
	RADAR_ORG: z.string().default("atum"),
	RADAR_BASE_URL: baseUrl.optional(),
	RADAR_SESSION_SECRET: sessionSecret.optional(),
	RADAR_REREQUEST_ENABLED: flag.prefault("true"),
	RADAR_DEMO_INTERVAL_SECONDS: integer(0).default(8),
});

function common(env: z.infer<typeof commonSchema>) {
	return {
		port: env.PORT,
		timeZone: env.RADAR_TIME_ZONE,
		priorityLabels: env.RADAR_PRIORITY_LABELS,
		botLogins: env.RADAR_BOT_LOGINS,
		repoDenylist: env.RADAR_REPO_DENYLIST,
		helpWantedAfterBusinessHours: env.RADAR_HELP_WANTED_AFTER_HOURS,
		reconcileSeconds: env.RADAR_RECONCILE_SECONDS,
		fullSweepEvery: env.RADAR_FULL_SWEEP_EVERY,
		dataDir: env.RADAR_DATA_DIR,
		webDist: env.RADAR_WEB_DIST,
	};
}

function parseOrThrow<T>(schema: z.ZodType<T>, env: Record<string, string>, problems: string[] = []): T {
	const result = schema.safeParse(env);
	const all = [...(result.success ? [] : result.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`)), ...problems];
	if (result.success && all.length === 0) return result.data;
	throw new ConfigError(all.join("\n"));
}

const MISSING_KEY = "GITHUB_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_FILE is required";

/** Kubernetes and `.env` files often carry a PEM with escaped newlines. */
function pemFrom(value: string): string {
	return value.includes("\n") ? value : value.replaceAll("\\n", "\n");
}

function privateKey(env: z.infer<typeof githubSchema>, readFile: (path: string) => string): string {
	if (env.GITHUB_APP_PRIVATE_KEY !== undefined) return pemFrom(env.GITHUB_APP_PRIVATE_KEY);
	if (env.GITHUB_APP_PRIVATE_KEY_FILE === undefined) throw new ConfigError(MISSING_KEY);
	try {
		return readFile(env.GITHUB_APP_PRIVATE_KEY_FILE);
	} catch (error) {
		const code = error instanceof Error && "code" in error ? String(error.code) : "unreadable";
		throw new ConfigError(`GITHUB_APP_PRIVATE_KEY_FILE could not be read (${code})`);
	}
}

/** Throws `ConfigError` naming every variable that is missing or malformed. An empty value counts as unset. */
export function loadConfig(
	rawEnv: Record<string, string | undefined>,
	readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): Config {
	const env = Object.fromEntries(
		Object.entries(rawEnv).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== ""),
	);
	if (env.RADAR_DEMO === "1" || env.RADAR_DEMO === "true") {
		const demo = parseOrThrow(demoSchema, env);
		return {
			mode: "demo",
			...common(demo),
			org: demo.RADAR_ORG,
			baseUrl: demo.RADAR_BASE_URL ?? `http://localhost:${demo.PORT}`,
			sessionSecret: demo.RADAR_SESSION_SECRET ?? randomBytes(32).toString("hex"),
			rerequestEnabled: demo.RADAR_REREQUEST_ENABLED,
			demoIntervalSeconds: demo.RADAR_DEMO_INTERVAL_SECONDS,
		};
	}
	const keyMissing = env.GITHUB_APP_PRIVATE_KEY === undefined && env.GITHUB_APP_PRIVATE_KEY_FILE === undefined;
	const github = parseOrThrow(githubSchema, env, keyMissing ? [MISSING_KEY] : []);
	return {
		mode: "github",
		...common(github),
		org: github.RADAR_ORG,
		baseUrl: github.RADAR_BASE_URL,
		sessionSecret: github.RADAR_SESSION_SECRET,
		rerequestEnabled: github.RADAR_REREQUEST_ENABLED,
		github: {
			appId: github.GITHUB_APP_ID,
			clientId: github.GITHUB_APP_CLIENT_ID,
			clientSecret: github.GITHUB_APP_CLIENT_SECRET,
			privateKeyPem: privateKey(github, readFile),
			webhookSecret: github.GITHUB_WEBHOOK_SECRET,
			installationId: github.GITHUB_INSTALLATION_ID ?? null,
		},
	};
}
