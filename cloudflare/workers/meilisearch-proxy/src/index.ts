/**
 * Meilisearch proxy worker - forwards search requests to Hetzner backend
 */

interface Env {
	MEILI_HOST: string;
	MEILI_SEARCH_KEY: string;
}

const CORS_HEADERS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type',
};

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

		// Only allow search endpoints
		if (!url.pathname.startsWith('/indexes/')) {
			return new Response('Not Found', {
				status: 404,
				headers: CORS_HEADERS
			});
		}

		try {
			// Build Meilisearch URL
			const meiliUrl = `${env.MEILI_HOST}${url.pathname}${url.search}`;

			// Forward request to Meilisearch
			const meiliRequest = new Request(meiliUrl, {
				method: request.method,
				headers: {
					'Authorization': `Bearer ${env.MEILI_SEARCH_KEY}`,
					'Content-Type': 'application/json',
				},
				body: request.method === 'POST' ? await request.text() : null,
			});

			// Fetch from Meilisearch
			const response = await fetch(meiliRequest);
			const data = await response.text();

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
