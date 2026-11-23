import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { buildSchema, parse, validate } from "graphql";
import type { GraphQLSchema } from "graphql";
import { OPEN_PULL_REQUESTS_QUERY, ORG_TEAMS_QUERY, buildPullRequestsQuery } from "../src/github/queries.ts";

const SCHEMA_URL = "https://docs.github.com/public/fpt/schema.docs.graphql";
const CACHE_DIR = new URL("../.cache/", import.meta.url);
const CACHE_FILE = new URL("schema.docs.graphql", CACHE_DIR);
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

async function schemaText(): Promise<string> {
	const cached = await stat(CACHE_FILE).catch(() => null);
	if (cached !== null && Date.now() - cached.mtimeMs < MAX_AGE_MS) return readFile(CACHE_FILE, "utf8");
	const response = await fetch(SCHEMA_URL);
	if (!response.ok) throw new Error(`Downloading ${SCHEMA_URL} failed with HTTP ${response.status}`);
	const text = await response.text();
	await mkdir(CACHE_DIR, { recursive: true });
	await writeFile(new URL(".gitignore", CACHE_DIR), "*\n");
	await writeFile(CACHE_FILE, text);
	return text;
}

function problems(schema: GraphQLSchema, query: string): string[] {
	try {
		return validate(schema, parse(query)).map((error) => error.message);
	} catch (error) {
		return [String(error)];
	}
}

const schema = buildSchema(await schemaText(), { assumeValid: true });
const queries: [string, string][] = [
	[
		"pull requests",
		buildPullRequestsQuery([
			{ owner: "octo-org", name: "octo-repo", number: 1 },
			{ owner: "octo-org", name: "docs.site", number: 4821 },
		]),
	],
	["open pull requests", OPEN_PULL_REQUESTS_QUERY],
	["organization teams", ORG_TEAMS_QUERY],
];

let failed = false;
for (const [label, query] of queries) {
	for (const message of problems(schema, query)) {
		console.error(`${label}: ${message}`);
		failed = true;
	}
}
if (failed) process.exit(1);
console.log(`schema check passed: ${queries.length} queries`);
