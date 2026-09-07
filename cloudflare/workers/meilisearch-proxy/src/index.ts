/**
 * Meilisearch proxy worker - forwards search requests to Hetzner backend
 */

import { recordSearch, type SearchParams } from './search-log';

interface Env {
	MEILI_HOST: string;
	MEILI_SEARCH_KEY: string;
	MEILISEARCH_STATUS_BYPASS_KEY: string;
	SEARCH_ANALYTICS?: AnalyticsEngineDataset;
}

const CORS_HEADERS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, X-Status-Bypass',
};

const SEARCH_PATH = /^\/indexes\/([^/]+)\/search$/;
const MULTI_SEARCH_PATH = '/multi-search';
const INDEX_NAME = /^[A-Za-z0-9_-]+$/;

type SearchQuery = { indexUid?: unknown; q?: unknown; filter?: unknown; sort?: unknown };

function isAllowedQuery(query: unknown): query is SearchQuery & { indexUid: string } {
	return typeof query === 'object' && query !== null
		&& typeof (query as SearchQuery).indexUid === 'string'
		&& INDEX_NAME.test((query as SearchQuery).indexUid as string);
}

function snapshotSearchParams(query: SearchQuery): SearchParams {
	return { q: query.q, filter: query.filter, sort: query.sort } as SearchParams;
}

// Public searches only ever see published records. The caller's own filter is kept and
// ANDed after ours, whatever shape it came in.
function injectPublishedFilter(query: SearchQuery): void {
	const existing = query.filter;
	if (existing == null) {
		query.filter = 'status = published';
	} else if (Array.isArray(existing)) {
		query.filter = ['status = published', ...existing];
	} else {
		query.filter = ['status = published', existing];
	}
}

function isValidBypassSecret(request: Request, env: Env): boolean {
	const header = request.headers.get('X-Status-Bypass') ?? '';
	if (!env.MEILISEARCH_STATUS_BYPASS_KEY || !header) return false;

	// Constant-time comparison to prevent timing attacks
	const a = new TextEncoder().encode(header.padEnd(64));
	const b = new TextEncoder().encode(env.MEILISEARCH_STATUS_BYPASS_KEY.padEnd(64));
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
	return diff === 0 && header === env.MEILISEARCH_STATUS_BYPASS_KEY;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		// Handle CORS preflight
		if (request.method === 'OPTIONS') {
			return new Response(null, { headers: CORS_HEADERS });
		}

		const url = new URL(request.url);

		// Health check endpoint
		if (url.pathname === '/health') {
			return new Response('OK', {
				headers: { ...CORS_HEADERS, 'Content-Type': 'text/plain' }
			});
		}

		// Only the search endpoints are proxied; documents, settings, keys, etc. stay unreachable
		const searchMatch = SEARCH_PATH.exec(url.pathname);
		const isMultiSearch = url.pathname === MULTI_SEARCH_PATH;
		if (!searchMatch && !isMultiSearch) {
			return new Response('Not Found', {
				status: 404,
				headers: CORS_HEADERS
			});
		}

		// POST only: GET search reads ?filter= from the querystring, which the
		// body injection below never sees, so it could bypass the status filter
		if (request.method !== 'POST') {
			return new Response('Method Not Allowed', {
				status: 405,
				headers: { ...CORS_HEADERS, 'Allow': 'POST' }
			});
		}

		try {
			// Querystring is dropped: POST search reads parameters from the body only
			const meiliUrl = `${env.MEILI_HOST}${url.pathname}`;

			// Inject status = published filter into public search requests.
			// Requests from the Next.js server-side proxy that include the bypass
			// secret are allowed to search across all statuses.
			const raw = await request.text();
			const statusBypassed = isValidBypassSecret(request, env);
			let searchParams: SearchParams | null = null;
			let body = raw;
			let indexName = searchMatch ? searchMatch[1] : '';
			if (isMultiSearch) {
				// Every query in the batch names its own index, so each one is guarded the
				// way a single search is: a valid index name, and the published filter.
				const parsed = raw ? JSON.parse(raw) : null;
				const queries = parsed?.queries;
				if (!Array.isArray(queries) || queries.length === 0 || !queries.every(isAllowedQuery)) {
					return new Response(JSON.stringify({ error: 'Invalid multi-search body' }), {
						status: 400,
						headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
					});
				}
				// The first query is the caller's own search; the rest are count siblings.
				indexName = queries[0].indexUid;
				if (!statusBypassed) {
					searchParams = snapshotSearchParams(queries[0]);
					queries.forEach(injectPublishedFilter);
					body = JSON.stringify(parsed);
				}
			} else if (raw && !statusBypassed) {
				const parsed = JSON.parse(raw);
				// Snapshot what the caller asked for, before the status filter is
				// injected below. These three keys are all the query log ever reads.
				searchParams = snapshotSearchParams(parsed);
				injectPublishedFilter(parsed);
				body = JSON.stringify(parsed);
			}

			// Forward request to Meilisearch (strip X-Status-Bypass — never forward to origin)
			const meiliRequest = new Request(meiliUrl, {
				method: 'POST',
				headers: {
					'Authorization': `Bearer ${env.MEILI_SEARCH_KEY}`,
					'Content-Type': 'application/json',
				},
				body,
			});

			// Fetch from Meilisearch
			const response = await fetch(meiliRequest);
			const data = await response.text();

			// Deferred so neither the parsing nor the write sits on the search path,
			// and so a failure in here can never reach the visitor.
			ctx.waitUntil(Promise.resolve().then(() => recordSearch(env.SEARCH_ANALYTICS, {
				indexName,
				statusBypassRequested: request.headers.has('X-Status-Bypass'),
				responseOk: response.ok,
				searchParams,
				// A multi-search answer nests one result per query; the log reads the caller's own.
				responseText: isMultiSearch ? JSON.stringify(JSON.parse(data).results?.[0] ?? {}) : data,
				region: request.headers.get('X-Visitor-Region') ?? '',
			})));

			// Create response with caching headers
			return new Response(data, {
				status: response.status,
				headers: {
					...CORS_HEADERS,
					'Content-Type': 'application/json',
					// Cache successful searches for 5 minutes
					'Cache-Control': response.ok ? 'public, max-age=300' : 'no-cache',
				},
			});

		} catch (error) {
			console.error('Meilisearch proxy error:', error);
			return new Response(JSON.stringify({
				error: 'Search service unavailable'
			}), {
				status: 503,
				headers: {
					...CORS_HEADERS,
					'Content-Type': 'application/json',
				},
			});
		}
	},
} satisfies ExportedHandler<Env>;
