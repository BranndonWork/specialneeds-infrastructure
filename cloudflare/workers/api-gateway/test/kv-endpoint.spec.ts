import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext, fetchMock } from 'cloudflare:test';
import { cacheKey, checkCache } from '../src/cache';
import { apiPathToFrontendPaths, frontendPathsFor, handleKvEndpoint } from '../src/kv-endpoint';

// The site builds with trailingSlash: true — every emitted page path must end in "/".
// Verified empirically 2026-07-05 against prod: both slash forms revalidate on the
// current Next version, but the trailing-slash form is the site's canonical key.
describe('apiPathToFrontendPaths', () => {
	it('maps a listing display path to the directory page and homepage', () => {
		expect(apiPathToFrontendPaths('/api/v1/listings/display/education/schools/some-school/')).toEqual([
			'/directory/education/schools/some-school/',
			'/',
		]);
	});

	it('maps an article display path to the article page', () => {
		expect(apiPathToFrontendPaths('/api/v1/articles/display/health/autism/some-article/')).toEqual([
			'/articles/health/autism/some-article/',
		]);
	});

	it('maps an event display path to the event page', () => {
		expect(apiPathToFrontendPaths('/api/v1/events/some-event/')).toEqual(['/events/some-event/']);
	});

	it('maps the prefixed event DB-slug form to the same event page', () => {
		expect(apiPathToFrontendPaths('/api/v1/events/events/some-event/')).toEqual(['/events/some-event/']);
	});

	it('does not map event aggregate endpoints', () => {
		expect(apiPathToFrontendPaths('/api/v1/events/categories/')).toEqual([]);
		expect(apiPathToFrontendPaths('/api/v1/events/popular_tags/')).toEqual([]);
		expect(apiPathToFrontendPaths('/api/v1/events/search/')).toEqual([]);
		expect(apiPathToFrontendPaths('/api/v1/events/')).toEqual([]);
	});

	it('always emits trailing-slash page paths, even for slash-less input', () => {
		for (const path of apiPathToFrontendPaths('/api/v1/articles/display/health/some-article')) {
			expect(path.endsWith('/')).toBe(true);
		}
		expect(apiPathToFrontendPaths('/api/v1/articles/display/health/some-article')).toEqual([
			'/articles/health/some-article/',
		]);
	});

	it('has no mapping for aggregate or unknown API paths', () => {
		expect(apiPathToFrontendPaths('/api/v1/articles/')).toEqual([]);
		expect(apiPathToFrontendPaths('/api/v1/articles/popular/tags/')).toEqual([]);
		expect(apiPathToFrontendPaths('/api/v1/listings/categories/')).toEqual([]);
		expect(apiPathToFrontendPaths('/v1/cache')).toEqual([]);
	});
});

describe('frontendPathsFor', () => {
	it('revalidates a frontend URL as its own page path', () => {
		expect(frontendPathsFor('https://www.specialneeds.com/articles/health/some-article')).toEqual([
			'/articles/health/some-article/',
		]);
		expect(frontendPathsFor('https://www.specialneeds.com/directory/schools/some-school/')).toEqual([
			'/directory/schools/some-school/',
		]);
	});

	it('maps API URLs through apiPathToFrontendPaths', () => {
		expect(frontendPathsFor('https://api.specialneeds.com/api/v1/articles/display/health/some-article/')).toEqual([
			'/articles/health/some-article/',
		]);
	});

	it('returns no paths for unmapped API URLs', () => {
		expect(frontendPathsFor('https://api.specialneeds.com/api/v1/articles/tags/')).toEqual([]);
	});
});

const THIRTY_DAYS = 'public, max-age=2592000, stale-if-error=86400';

function uniqueUrl(label: string): string {
	return `https://api.specialneeds.com/api/v1/listings/display/${label}-${crypto.randomUUID()}/`;
}

async function callKvEndpoint(request: Request, cfApiToken = env.CF_API_TOKEN): Promise<Response | null> {
	const ctx = createExecutionContext();
	const res = await handleKvEndpoint(
		request, env.CACHE_KV, env.CACHE_MGMT_TOKEN, ctx, cfApiToken, env.REVALIDATE_SECRET, env.SN_SERVICE_TOKEN,
	);
	await waitOnExecutionContext(ctx);
	return res;
}

async function warm(targetUrl: string, cacheControl: string, body = '{"v":"warmed"}'): Promise<Response | null> {
	return callKvEndpoint(new Request(
		`https://api.specialneeds.com/v1/cache?url=${encodeURIComponent(targetUrl)}` +
			`&content_type=application/json&cache_control=${encodeURIComponent(cacheControl)}`,
		{ method: 'PUT', body, headers: { 'X-Sn-Service-Token': env.CACHE_MGMT_TOKEN } },
	));
}

function deleteRequest(query: string, token: string | null = env.CACHE_MGMT_TOKEN): Request {
	return new Request(`https://api.specialneeds.com/v1/cache?${query}`, {
		method: 'DELETE',
		headers: token === null ? {} : { 'X-Sn-Service-Token': token },
	});
}

// A DELETE of an API URL purges the Cloudflare CDN copy and revalidates the pages built from it.
async function purge(query: string): Promise<{ revalidated: string[]; purgedFiles: string[] }> {
	const sent = { revalidated: [] as string[], purgedFiles: [] as string[] };
	fetchMock
		.get('https://api.cloudflare.com')
		.intercept({ path: /purge_cache/, method: 'POST', headers: { authorization: `Bearer ${env.CF_API_TOKEN}` } })
		.reply(200, (opts) => {
			sent.purgedFiles = JSON.parse(String(opts.body)).files;
			return '{}';
		});
	fetchMock
		.get('https://www.specialneeds.com')
		.intercept({ path: '/api/admin/revalidate/', method: 'POST' })
		.reply(200, (opts) => {
			sent.revalidated = JSON.parse(String(opts.body)).paths;
			return '{}';
		});

	expect((await callKvEndpoint(deleteRequest(query)))?.status).toBe(200);
	return sent;
}

async function read(url: string): Promise<Response | null> {
	const ctx = createExecutionContext();
	const res = await checkCache(new Request(url), env.CACHE_KV, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}

async function l1Entry(url: string): Promise<Response | undefined> {
	return caches.default.match(new Request(`https://cache.internal/${await cacheKey(url)}`));
}

// The publish flow re-warms an edited item with a PUT. Without the same storedAt/maxAge stamp an
// origin fetch writes, checkCache treats the warmed entry as expired and the next request goes to
// origin anyway, so the max-age the warmer sends would decide nothing (#615).
describe('PUT /v1/cache?url= stores a warmed entry the way an origin fetch does', () => {
	it('stamps the max-age it was given, alongside the write time', async () => {
		const url = uniqueUrl('warm-meta');
		expect((await warm(url, THIRTY_DAYS))?.status).toBe(200);

		const stored = await env.CACHE_KV.getWithMetadata<{ storedAt?: number; maxAge?: number; cacheControl?: string }>(
			await cacheKey(url),
			'text',
		);

		expect(stored.value).toBe('{"v":"warmed"}');
		expect(stored.metadata?.maxAge).toBe(2592000);
		expect(stored.metadata?.cacheControl).toBe(THIRTY_DAYS);
		expect(stored.metadata?.storedAt).toBeTypeOf('number');
	});

	it('gives the KV key an expiry instead of writing it permanently', async () => {
		const url = uniqueUrl('warm-ttl');
		await warm(url, THIRTY_DAYS);

		const key = await cacheKey(url);
		const { keys } = await env.CACHE_KV.list();

		expect(keys.find(k => k.name === key)?.expiration).toBeTypeOf('number');
	});

	it('is served as a KV hit by the next read', async () => {
		const url = uniqueUrl('warm-served');
		await warm(url, THIRTY_DAYS);

		const res = await read(url);

		expect(res?.headers.get('X-Cache')).toBe('KV-HIT');
		expect(res?.headers.get('Cache-Control')).toBe(THIRTY_DAYS);
		expect(await res?.text()).toBe('{"v":"warmed"}');
	});
});

// A bulk resave purges thousands of listing pages. Each API display purge also revalidates the
// homepage, so the caller can ask the Worker to leave it out with skip_home=true (#723).
describe('DELETE /v1/cache?url= revalidates the pages built from the URL', () => {
	beforeAll(() => {
		fetchMock.activate();
		fetchMock.disableNetConnect();
	});
	afterEach(() => fetchMock.assertNoPendingInterceptors());

	const listingUrl = encodeURIComponent('https://api.specialneeds.com/api/v1/listings/display/care/in-home/some-provider/');

	it('revalidates the listing page and the homepage by default', async () => {
		expect((await purge(`url=${listingUrl}`)).revalidated).toEqual(['/directory/care/in-home/some-provider/', '/']);
	});

	it('leaves the homepage out when skip_home=true', async () => {
		expect((await purge(`url=${listingUrl}&skip_home=true`)).revalidated).toEqual(['/directory/care/in-home/some-provider/']);
	});
});

describe('DELETE /v1/cache?url= purges the Cloudflare CDN copy of API URLs only', () => {
	beforeAll(() => {
		fetchMock.activate();
		fetchMock.disableNetConnect();
	});
	afterEach(() => {
		vi.restoreAllMocks();
		fetchMock.assertNoPendingInterceptors();
	});

	function expectRevalidate(): void {
		fetchMock.get('https://www.specialneeds.com').intercept({ path: '/api/admin/revalidate/', method: 'POST' }).reply(200, '{}');
	}

	// A purge call with no interceptor fails inside waitUntil without failing the DELETE, so the
	// cases that must not purge watch fetch itself.
	function cloudflareCalls(): () => string[] {
		const spy = vi.spyOn(globalThis, 'fetch');
		return () => spy.mock.calls
			.map(([input]) => (input instanceof Request ? input.url : String(input)))
			.filter((url) => url.startsWith('https://api.cloudflare.com/'));
	}

	it('purges exactly the deleted API URL with the Cloudflare token', async () => {
		const url = uniqueUrl('cdn');

		expect((await purge(`url=${encodeURIComponent(url)}`)).purgedFiles).toEqual([url]);
	});

	it('does not purge a frontend URL, which Cloudflare does not proxy', async () => {
		expectRevalidate();
		const purgeCalls = cloudflareCalls();

		const res = await callKvEndpoint(deleteRequest(`url=${encodeURIComponent('https://www.specialneeds.com/directory/some-provider/')}`));

		expect(res?.status).toBe(200);
		expect(purgeCalls()).toEqual([]);
	});

	it('does not purge when no Cloudflare token is configured', async () => {
		expectRevalidate();
		const purgeCalls = cloudflareCalls();

		const res = await callKvEndpoint(deleteRequest(`url=${encodeURIComponent(uniqueUrl('no-token'))}`), '');

		expect(res?.status).toBe(200);
		expect(purgeCalls()).toEqual([]);
	});
});

describe('delete then rewarm', () => {
	beforeAll(() => {
		fetchMock.activate();
		fetchMock.disableNetConnect();
	});
	afterEach(() => fetchMock.assertNoPendingInterceptors());

	async function warmAndRead(url: string, body: string): Promise<void> {
		await warm(url, THIRTY_DAYS, body);
		await read(url);
		expect(await env.CACHE_KV.get(await cacheKey(url))).toBe(body);
		expect(await l1Entry(url)).toBeDefined();
	}

	it('removes the KV and L1 copies at the PoP that handles the DELETE', async () => {
		const url = uniqueUrl('purged');
		await warmAndRead(url, '{"v":"before"}');

		await purge(`url=${encodeURIComponent(url)}`);

		expect(await env.CACHE_KV.get(await cacheKey(url))).toBeNull();
		expect(await l1Entry(url)).toBeUndefined();
	});

	it('serves the rewarmed body from KV without an origin call, the PUT itself writing no L1 copy', async () => {
		const url = uniqueUrl('rewarm');
		await warmAndRead(url, '{"v":"before"}');
		await purge(`url=${encodeURIComponent(url)}`);

		await warm(url, THIRTY_DAYS, '{"v":"after"}');
		expect(await l1Entry(url)).toBeUndefined();
		const res = await read(url);

		expect(res?.headers.get('X-Cache')).toBe('KV-HIT');
		expect(await res?.text()).toBe('{"v":"after"}');
	});

	// The DELETE ran at another PoP, so this PoP's L1 copy survives it and passes the KV check again
	// once the PUT lands. The 60-second L1 cap is what bounds that old body.
	it('keeps serving the old L1 copy at a PoP the DELETE did not reach, capped at 60 seconds', async () => {
		const url = uniqueUrl('remote-pop');
		await warmAndRead(url, '{"v":"before"}');
		await env.CACHE_KV.delete(await cacheKey(url));

		await warm(url, THIRTY_DAYS, '{"v":"after"}');
		const res = await read(url);

		expect(res?.headers.get('X-Cache')).toBe('HIT');
		expect(await res?.text()).toBe('{"v":"before"}');
		expect((await l1Entry(url))?.headers.get('Cache-Control')).toBe('public, max-age=60');
	});

	it('is rejected without the service token and leaves the entry in place', async () => {
		const url = uniqueUrl('unauthorized');
		await warm(url, THIRTY_DAYS, '{"v":"kept"}');

		const res = await callKvEndpoint(deleteRequest(`url=${encodeURIComponent(url)}`, null));

		expect(res?.status).toBe(403);
		expect(await env.CACHE_KV.get(await cacheKey(url))).toBe('{"v":"kept"}');
	});
});
