import { Kind, parse } from "graphql";
import type { FieldNode } from "graphql";
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
