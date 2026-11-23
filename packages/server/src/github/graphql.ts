import { z } from "zod";
import { API_ROOT, GitHubApiError, githubHeaders, rateLimitResetAt, readJson } from "./http.ts";
import type { Fetch } from "./http.ts";

const graphqlErrorSchema = z.object({ message: z.string(), type: z.string().optional() });
export type GraphQLErrorInfo = z.infer<typeof graphqlErrorSchema>;

const envelopeSchema = z.object({ data: z.unknown(), errors: z.array(graphqlErrorSchema).optional() });

export const isNotFound = (error: GraphQLErrorInfo): boolean => error.type === "NOT_FOUND";

/**
 * Throws `GitHubApiError` on an HTTP error, on a response without data, and on
 * any error in the `errors` array that `allowErrors` does not accept. A partial
 * error nulls fields, so data that comes with an unaccepted error is not trusted.
 */
export async function graphqlRequest<T>({
	token,
	query,
	variables = {},
	schema,
	allowErrors = () => false,
	fetch = globalThis.fetch,
}: {
	token: string;
	query: string;
	variables?: Record<string, unknown>;
	schema: z.ZodType<T>;
	allowErrors?: (error: GraphQLErrorInfo) => boolean;
	fetch?: Fetch;
}): Promise<T> {
	const response = await fetch(`${API_ROOT}/graphql`, {
		method: "POST",
		headers: { ...githubHeaders(token), "Content-Type": "application/json" },
		body: JSON.stringify({ query, variables }),
	});
	const { data, errors = [] } = await readJson(response, envelopeSchema);
	const blocking = errors.filter((error) => !allowErrors(error));
	if (data === null || data === undefined || blocking.length > 0) {
		const messages = (blocking.length > 0 ? blocking : errors).map((error) => error.message);
		throw new GitHubApiError(`GitHub GraphQL: ${messages.join("; ") || "no data"}`, {
			status: response.status,
			rateLimitResetAt: rateLimitResetAt(response.headers),
		});
	}
	return schema.parse(data);
}

function present<T>(values: readonly (T | null)[] | null): T[] {
	return (values ?? []).filter((value): value is T => value !== null);
}

/** A GitHub connection's `nodes`, where the connection, the list, and each node may be null. */
export function connection<T extends z.ZodType>(node: T) {
	return z
		.object({ nodes: z.array(node.nullable()).nullable() })
		.nullable()
		.transform((value) => present(value?.nodes ?? null));
}

export function page<T extends z.ZodType>(node: T) {
	return z
		.object({
			pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
			nodes: z.array(node.nullable()).nullable(),
		})
		.transform(({ pageInfo, nodes }) => ({
			nodes: present(nodes),
			after: pageInfo.hasNextPage ? pageInfo.endCursor : null,
		}));
}

/** Fetches from the page after `start`, or from the first page when `start` is null, through the last. */
export async function collectPages<T>(
	fetchPage: (after: string | null) => Promise<{ nodes: T[]; after: string | null }>,
	start: string | null = null,
): Promise<T[]> {
	const items: T[] = [];
	let after = start;
	do {
		const result = await fetchPage(after);
		items.push(...result.nodes);
		after = result.after;
	} while (after !== null);
	return items;
}
