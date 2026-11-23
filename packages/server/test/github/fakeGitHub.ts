import { Kind, parse } from "graphql";
import type { FieldNode, SelectionSetNode, ValueNode } from "graphql";
import { z } from "zod";

export interface SentRequest {
	method: string;
	url: string;
	headers: Headers;
	redirect: Request["redirect"];
	body: string;
}

/** A `fetch` that records each request and answers with `respond`. */
export function fakeFetch(respond: (request: SentRequest) => Response | Promise<Response>) {
	const requests: SentRequest[] = [];
	const fetch: typeof globalThis.fetch = async (input, init) => {
		const request = new Request(input, init);
		const sent = {
			method: request.method,
			url: request.url,
			headers: request.headers,
			redirect: request.redirect,
			body: await request.text(),
		};
		requests.push(sent);
		return respond(sent);
	};
	return { fetch, requests };
}

export function json(body: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(body), { status: 200, ...init });
}

const graphqlBodySchema = z.object({ query: z.string(), variables: z.record(z.string(), z.unknown()) });

export function graphqlBody(request: SentRequest): z.infer<typeof graphqlBodySchema> {
	return graphqlBodySchema.parse(JSON.parse(request.body));
}

function argument(field: FieldNode, name: string): string {
	const value = field.arguments?.find((arg) => arg.name.value === name)?.value;
	if (value?.kind === Kind.STRING || value?.kind === Kind.INT) return value.value;
	throw new Error(`Field ${field.name.value} has no ${name} argument`);
}

/** The aliased repository blocks of a `buildPullRequestsQuery` document, read from its AST. */
export function pullRequestAliases(query: string): { alias: string; owner: string; name: string; number: number }[] {
	const [operation] = parse(query).definitions;
	if (operation?.kind !== Kind.OPERATION_DEFINITION) throw new Error("Expected one operation");
	return operation.selectionSet.selections.map((selection) => {
		if (selection.kind !== Kind.FIELD || selection.alias === undefined) throw new Error("Expected an aliased field");
		const pullRequest = selection.selectionSet?.selections[0];
		if (pullRequest?.kind !== Kind.FIELD) throw new Error("Expected a pullRequest field");
		return {
			alias: selection.alias.value,
			owner: argument(selection, "owner"),
			name: argument(selection, "name"),
			number: Number(argument(pullRequest, "number")),
		};
	});
}

/**
 * GitHub's data as plain objects: a connection is the full array of its nodes, and a field that takes
 * arguments, such as `repository` or `pullRequest`, is a function of them.
 */
export type World = { [field: string]: unknown };

function argumentValue(node: ValueNode, variables: Record<string, unknown>): unknown {
	switch (node.kind) {
		case Kind.VARIABLE:
			return variables[node.name.value] ?? null;
		case Kind.INT:
			return Number(node.value);
		case Kind.STRING:
		case Kind.ENUM:
		case Kind.BOOLEAN:
			return node.value;
		case Kind.NULL:
			return null;
		case Kind.LIST:
			return node.values.map((value) => argumentValue(value, variables));
		default:
			throw new Error(`The fake GitHub does not read ${node.kind} arguments`);
	}
}

/** One page of `items`, as GitHub answers `first`, `last`, and `after`. A cursor is the index after the page. */
function connectionPage(items: unknown[], args: Record<string, unknown>) {
	const start = typeof args.after === "string" ? Number(args.after) : 0;
	const end = typeof args.first === "number" ? Math.min(items.length, start + args.first) : items.length;
	const from = typeof args.last === "number" ? Math.max(start, end - args.last) : start;
	return {
		totalCount: items.length,
		pageInfo: { hasNextPage: end < items.length, endCursor: end > from ? String(end) : null },
		nodes: items.slice(from, end),
	};
}

function select(value: unknown, set: SelectionSetNode | undefined, variables: Record<string, unknown>): unknown {
	if (value === undefined || value === null) return null;
	if (set === undefined) return value;
	if (Array.isArray(value)) return value.map((item) => select(item, set, variables));
	const source = value as World;
	const out: World = {};
	for (const selection of set.selections) {
		if (selection.kind === Kind.INLINE_FRAGMENT) {
			if (selection.typeCondition === undefined || source.__typename === selection.typeCondition.name.value) {
				Object.assign(out, select(source, selection.selectionSet, variables));
			}
			continue;
		}
		if (selection.kind !== Kind.FIELD) throw new Error("The fake GitHub does not read fragment spreads");
		const args = Object.fromEntries((selection.arguments ?? []).map((arg) => [arg.name.value, argumentValue(arg.value, variables)]));
		let field = source[selection.name.value];
		if (typeof field === "function") field = field(args);
		else if (Array.isArray(field) && ("first" in args || "last" in args)) field = connectionPage(field, args);
		out[selection.alias?.value ?? selection.name.value] = select(field, selection.selectionSet, variables);
	}
	return out;
}

/** Answers a query from `root` the way GitHub would, honoring aliases, inline fragments, variables, and connection paging. */
export function answerQuery(query: string, variables: Record<string, unknown>, root: World): { data: unknown } {
	const [operation] = parse(query).definitions;
	if (operation?.kind !== Kind.OPERATION_DEFINITION) throw new Error("Expected one operation");
	return { data: select(root, operation.selectionSet, variables) };
}

function isConnection(value: object): value is { nodes: unknown[] } {
	return "nodes" in value && Object.keys(value).every((key) => key === "nodes" || key === "pageInfo");
}

/** A node in the shape a query selects, turned back into GitHub's data: each connection its array, each thread its comments. */
export function worldOf(node: unknown): unknown {
	if (Array.isArray(node)) return node.map(worldOf);
	if (node === null || typeof node !== "object") return node;
	if (isConnection(node)) return worldOf(node.nodes);
	const fields = Object.fromEntries(Object.entries(node).map(([key, value]) => [key, worldOf(value)]));
	if ("first" in fields && "last" in fields && Array.isArray(fields.first) && Array.isArray(fields.last)) {
		const { first, last, ...thread } = fields;
		const comments = JSON.stringify(first) === JSON.stringify(last) ? first : [...first, ...last];
		return { ...thread, comments };
	}
	return fields;
}

/** A repository whose pull requests are `pullRequests`, each a `worldOf` pull request, open ones listed. */
export function repositoryWorld(pullRequests: World[]): World {
	const commits = pullRequests.flatMap((pr) => (pr.commits as { commit: World }[]).map(({ commit }) => commit));
	return {
		pullRequest: ({ number }: { number: number }) => pullRequests.find((pr) => pr.number === number) ?? null,
		pullRequests: pullRequests.filter((pr) => pr.state === "OPEN"),
		object: ({ oid }: { oid: string }) => {
			const commit = commits.find((candidate) => candidate.oid === oid);
			return commit === undefined ? null : { __typename: "Commit", ...commit };
		},
	};
}
