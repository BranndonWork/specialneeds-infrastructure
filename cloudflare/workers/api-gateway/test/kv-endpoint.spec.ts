import { describe, it, expect, beforeAll, afterEach } from 'vitest';
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

// The publish flow re-warms an edited item with a PUT. Without the same storedAt/maxAge stamp an
// origin fetch writes, checkCache treats the warmed entry as expired and the next request goes to
// origin anyway, so the max-age the warmer sends would decide nothing (#615).
describe('PUT /v1/cache?url= stores a warmed entry the way an origin fetch does', () => {
	const THIRTY_DAYS = 'public, max-age=2592000, stale-if-error=86400';

	async function warm(targetUrl: string, cacheControl: string): Promise<Response | null> {
		const ctx = createExecutionContext();
		const request = new Request(
			`https://api.specialneeds.com/v1/cache?url=${encodeURIComponent(targetUrl)}` +
				`&content_type=application/json&cache_control=${encodeURIComponent(cacheControl)}`,
			{ method: 'PUT', body: '{"v":"warmed"}', headers: { 'X-Sn-Service-Token': env.CACHE_MGMT_TOKEN } },
		);
		const res = await handleKvEndpoint(
			request, env.CACHE_KV, env.CACHE_MGMT_TOKEN, ctx, env.CF_API_TOKEN, env.REVALIDATE_SECRET, env.SN_SERVICE_TOKEN,
		);
		await waitOnExecutionContext(ctx);
		return res;
	}

	function uniqueUrl(label: string): string {
		return `https://api.specialneeds.com/api/v1/listings/display/${label}-${crypto.randomUUID()}/`;
	}

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

		const ctx = createExecutionContext();
		const res = await checkCache(new Request(url), env.CACHE_KV, ctx);
		await waitOnExecutionContext(ctx);

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

	async function purge(query: string): Promise<string[]> {
		let revalidated: string[] = [];
		fetchMock.get('https://api.cloudflare.com').intercept({ path: /purge_cache/, method: 'POST' }).reply(200, '{}');
		fetchMock
			.get('https://www.specialneeds.com')
			.intercept({ path: '/api/admin/revalidate/', method: 'POST' })
			.reply(200, (opts) => {
				revalidated = JSON.parse(String(opts.body)).paths;
				return '{}';
			});

		const ctx = createExecutionContext();
		const request = new Request(`https://api.specialneeds.com/v1/cache?${query}`, {
			method: 'DELETE',
			headers: { 'X-Sn-Service-Token': env.CACHE_MGMT_TOKEN },
		});
		const res = await handleKvEndpoint(
			request, env.CACHE_KV, env.CACHE_MGMT_TOKEN, ctx, env.CF_API_TOKEN, env.REVALIDATE_SECRET, env.SN_SERVICE_TOKEN,
		);
		await waitOnExecutionContext(ctx);
		expect(res?.status).toBe(200);
		return revalidated;
	}

	const listingUrl = encodeURIComponent('https://api.specialneeds.com/api/v1/listings/display/care/in-home/some-provider/');

	it('revalidates the listing page and the homepage by default', async () => {
		expect(await purge(`url=${listingUrl}`)).toEqual(['/directory/care/in-home/some-provider/', '/']);
	});

	it('leaves the homepage out when skip_home=true', async () => {
		expect(await purge(`url=${listingUrl}&skip_home=true`)).toEqual(['/directory/care/in-home/some-provider/']);
	});
});
