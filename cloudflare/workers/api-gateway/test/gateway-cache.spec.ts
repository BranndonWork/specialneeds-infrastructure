import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { env, SELF, fetchMock, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { cacheKey, checkCache, fetchAndCache } from '../src/cache';
import { handleKvEndpoint } from '../src/kv-endpoint';

const ORIGIN = 'https://origin.test';
const LONG_CACHE = 'public, max-age=3600';

function uniquePath(label: string): string {
	return `/api/v1/listings/display/${label}-${crypto.randomUUID()}/`;
}

function apiUrl(path: string): string {
	return `https://api.specialneeds.com${path}`;
}

function l1Request(key: string): Request {
	return new Request(`https://cache.internal/${key}`);
}

function expectOrigin(path: string, body: string, status = 200, cacheControl = LONG_CACHE): void {
	fetchMock
		.get(ORIGIN)
		.intercept({ path, method: 'GET' })
		.reply(status, body, { headers: { 'content-type': 'application/json', 'cache-control': cacheControl } });
}

async function readThroughCache(url: string): Promise<Response> {
	const ctx = createExecutionContext();
	const request = new Request(url);
	const res = (await checkCache(request, env.CACHE_KV, ctx))
		?? (await fetchAndCache(request, ORIGIN, env.CACHE_KV, ctx, env.WORKER_ORIGIN_SECRET, null));
	await waitOnExecutionContext(ctx);
	return res;
}

async function seedKv(url: string, body: string, ageSeconds: number): Promise<void> {
	await env.CACHE_KV.put(await cacheKey(url), body, {
		metadata: { contentType: 'application/json', cacheControl: 'public, max-age=300', storedAt: Date.now() - ageSeconds * 1000, maxAge: 300 },
	});
}

describe('cache key construction', () => {
	it('is the same whatever order the query parameters arrive in', async () => {
		expect(await cacheKey(apiUrl('/api/v1/listings/?b=2&a=1'))).toBe(await cacheKey(apiUrl('/api/v1/listings/?a=1&b=2')));
	});

	it('ignores the fragment', async () => {
		expect(await cacheKey(apiUrl('/api/v1/listings/?a=1#top'))).toBe(await cacheKey(apiUrl('/api/v1/listings/?a=1')));
	});

	it('differs when a parameter value differs', async () => {
		expect(await cacheKey(apiUrl('/api/v1/listings/?page=1'))).not.toBe(await cacheKey(apiUrl('/api/v1/listings/?page=2')));
	});

	it('differs by path and by host', async () => {
		const base = await cacheKey(apiUrl('/api/v1/listings/'));
		expect(await cacheKey(apiUrl('/api/v1/articles/'))).not.toBe(base);
		expect(await cacheKey('https://www.specialneeds.com/api/v1/listings/')).not.toBe(base);
	});

	it('is a hex SHA-256 digest', async () => {
		expect(await cacheKey(apiUrl('/api/v1/listings/'))).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe('L1, KV and origin', () => {
	beforeAll(() => {
		fetchMock.activate();
		fetchMock.disableNetConnect();
	});
	afterEach(() => fetchMock.assertNoPendingInterceptors());

	it('fetches a miss from origin, then serves the next read from L1', async () => {
		const path = uniquePath('l1');
		expectOrigin(path, '{"v":"origin"}');

		const first = await readThroughCache(apiUrl(path));
		const second = await readThroughCache(apiUrl(path));

		expect(first.headers.get('X-Cache')).toBe('MISS');
		expect(second.headers.get('X-Cache')).toBe('HIT');
		expect(await second.text()).toBe('{"v":"origin"}');
	});

	it('serves from KV when the L1 copy is gone', async () => {
		const path = uniquePath('kv');
		expectOrigin(path, '{"v":"origin"}');
		await readThroughCache(apiUrl(path));
		await caches.default.delete(l1Request(await cacheKey(apiUrl(path))));

		const res = await readThroughCache(apiUrl(path));

		expect(res.headers.get('X-Cache')).toBe('KV-HIT');
	});

	// L1 is per PoP and cannot be evicted everywhere, so an L1 copy counts only while KV still holds the key.
	it('evicts the L1 copy and goes to origin once the KV key is gone', async () => {
		const path = uniquePath('l1-orphan');
		const key = await cacheKey(apiUrl(path));
		expectOrigin(path, '{"v":"first"}');
		await readThroughCache(apiUrl(path));
		await env.CACHE_KV.delete(key);
		expectOrigin(path, '{"v":"second"}');

		const res = await readThroughCache(apiUrl(path));

		expect(res.headers.get('X-Cache')).toBe('MISS');
		expect(await res.text()).toBe('{"v":"second"}');
	});

	it('does not cache a response the origin marks no-store', async () => {
		const path = uniquePath('no-store');
		expectOrigin(path, '{"v":"private"}', 200, 'no-store');

		await readThroughCache(apiUrl(path));

		expect(await env.CACHE_KV.get(await cacheKey(apiUrl(path)))).toBeNull();
	});
});

describe('origin failures', () => {
	beforeAll(() => {
		fetchMock.activate();
		fetchMock.disableNetConnect();
	});
	afterEach(() => fetchMock.assertNoPendingInterceptors());

	it('serves the expired KV body when the origin is unreachable', async () => {
		const path = uniquePath('stale');
		await seedKv(apiUrl(path), '{"v":"stale"}', 600);
		fetchMock.get(ORIGIN).intercept({ path, method: 'GET' }).replyWithError(new Error('connection refused'));

		const res = await readThroughCache(apiUrl(path));

		expect(res.status).toBe(200);
		expect(res.headers.get('X-Cache')).toBe('STALE-ERROR');
		expect(await res.text()).toBe('{"v":"stale"}');
	});

	it('answers 503 when the origin is unreachable and nothing is stored', async () => {
		const path = uniquePath('no-stale');
		fetchMock.get(ORIGIN).intercept({ path, method: 'GET' }).replyWithError(new Error('connection refused'));

		const res = await readThroughCache(apiUrl(path));

		expect(res.status).toBe(503);
	});

	it('does not write an origin 5xx to the cache', async () => {
		const path = uniquePath('5xx');
		expectOrigin(path, '{"error":"boom"}', 502);

		await readThroughCache(apiUrl(path));

		expect(await env.CACHE_KV.get(await cacheKey(apiUrl(path)))).toBeNull();
	});
});

describe('a request carrying Authorization bypasses the cache', () => {
	beforeAll(() => {
		fetchMock.activate();
		fetchMock.disableNetConnect();
	});
	afterEach(() => fetchMock.assertNoPendingInterceptors());

	it('goes to origin even when KV holds a fresh entry, and writes nothing', async () => {
		const path = uniquePath('authorized');
		await seedKv(apiUrl(path), '{"v":"public"}', 0);
		const storedBefore = await env.CACHE_KV.getWithMetadata(await cacheKey(apiUrl(path)), 'text');
		expectOrigin(path, '{"v":"for-this-user"}');

		const res = await SELF.fetch(apiUrl(path), {
			headers: { authorization: 'Bearer user-token', 'cf-connecting-ip': '198.51.100.40' },
		});

		expect(await res.text()).toBe('{"v":"for-this-user"}');
		expect(res.headers.get('X-Cache')).toBeNull();
		const storedAfter = await env.CACHE_KV.getWithMetadata(await cacheKey(apiUrl(path)), 'text');
		expect(storedAfter).toEqual(storedBefore);
	});

	it('serves the same URL from cache when Authorization is absent', async () => {
		const path = uniquePath('anonymous');
		await seedKv(apiUrl(path), '{"v":"public"}', 0);

		const res = await SELF.fetch(apiUrl(path), { headers: { 'cf-connecting-ip': '198.51.100.41' } });

		expect(res.headers.get('X-Cache')).toBe('KV-HIT');
		expect(await res.text()).toBe('{"v":"public"}');
	});
});

describe('delete then rewarm', () => {
	beforeAll(() => {
		fetchMock.activate();
		fetchMock.disableNetConnect();
	});
	afterEach(() => fetchMock.assertNoPendingInterceptors());

	async function purge(url: string): Promise<void> {
		fetchMock.get('https://api.cloudflare.com').intercept({ path: /purge_cache/, method: 'POST' }).reply(200, '{}');
		fetchMock.get('https://www.specialneeds.com').intercept({ path: '/api/admin/revalidate/', method: 'POST' }).reply(200, '{}');
		const ctx = createExecutionContext();
		const request = new Request(`https://api.specialneeds.com/v1/cache?url=${encodeURIComponent(url)}`, {
			method: 'DELETE',
			headers: { 'X-Sn-Service-Token': env.CACHE_MGMT_TOKEN },
		});
		const res = await handleKvEndpoint(
			request, env.CACHE_KV, env.CACHE_MGMT_TOKEN, ctx, env.CF_API_TOKEN, env.REVALIDATE_SECRET, env.SN_SERVICE_TOKEN,
		);
		await waitOnExecutionContext(ctx);
		expect(res?.status).toBe(200);
	}

	it('removes the KV and L1 copies', async () => {
		const path = uniquePath('purged');
		const key = await cacheKey(apiUrl(path));
		expectOrigin(path, '{"v":"before"}');
		await readThroughCache(apiUrl(path));

		await purge(apiUrl(path));

		expect(await env.CACHE_KV.get(key)).toBeNull();
		expect(await caches.default.match(l1Request(key))).toBeUndefined();
	});

	it('serves the edited body on the next read and caches it again', async () => {
		const path = uniquePath('rewarm');
		expectOrigin(path, '{"v":"before"}');
		await readThroughCache(apiUrl(path));
		await purge(apiUrl(path));
		expectOrigin(path, '{"v":"after"}');

		const rewarmed = await readThroughCache(apiUrl(path));
		const next = await readThroughCache(apiUrl(path));

		expect(rewarmed.headers.get('X-Cache')).toBe('MISS');
		expect(await rewarmed.text()).toBe('{"v":"after"}');
		expect(next.headers.get('X-Cache')).toBe('HIT');
		expect(await next.text()).toBe('{"v":"after"}');
	});

	it('is rejected without the service token and leaves the entry in place', async () => {
		const path = uniquePath('unauthorized');
		const key = await cacheKey(apiUrl(path));
		await seedKv(apiUrl(path), '{"v":"kept"}', 0);

		const ctx = createExecutionContext();
		const res = await handleKvEndpoint(
			new Request(`https://api.specialneeds.com/v1/cache?url=${encodeURIComponent(apiUrl(path))}`, { method: 'DELETE' }),
			env.CACHE_KV, env.CACHE_MGMT_TOKEN, ctx, env.CF_API_TOKEN, env.REVALIDATE_SECRET, env.SN_SERVICE_TOKEN,
		);
		await waitOnExecutionContext(ctx);

		expect(res?.status).toBe(403);
		expect(await env.CACHE_KV.get(key)).toBe('{"v":"kept"}');
	});
});
