import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { env, SELF, fetchMock } from 'cloudflare:test';
import { cacheKey } from '../src/cache';

// Requests go through the whole worker, so each case also needs its own client IP to stay clear
// of the rate limit, and its own path to stay clear of the KV and L1 entries other cases write.
function uniquePath(label: string): string {
	return `/api/v1/listings/display/${label}-${crypto.randomUUID()}/`;
}

function apiUrl(path: string): string {
	return `https://api.specialneeds.com${path}`;
}

async function seedKv(path: string, body: string, ageSeconds: number): Promise<void> {
	await env.CACHE_KV.put(await cacheKey(apiUrl(path)), body, {
		metadata: { contentType: 'application/json', cacheControl: 'public, max-age=300', storedAt: Date.now() - ageSeconds * 1000, maxAge: 300 },
	});
}

function expectOrigin(path: string, body: string, status = 200): void {
	fetchMock
		.get(env.ORIGIN_URL)
		.intercept({ path, method: 'GET' })
		.reply(status, body, { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' } });
}

describe('a request carrying Authorization bypasses the cache', () => {
	beforeAll(() => {
		fetchMock.activate();
		fetchMock.disableNetConnect();
	});
	afterEach(() => fetchMock.assertNoPendingInterceptors());

	it('goes to origin even when KV holds a fresh entry, and leaves the entry as it was', async () => {
		const path = uniquePath('authorized');
		await seedKv(path, '{"v":"public"}', 0);
		const storedBefore = await env.CACHE_KV.getWithMetadata(await cacheKey(apiUrl(path)), 'text');
		expectOrigin(path, '{"v":"for-this-user"}');

		const res = await SELF.fetch(apiUrl(path), {
			headers: { authorization: 'Bearer user-token', 'cf-connecting-ip': '198.51.100.40' },
		});

		expect(await res.text()).toBe('{"v":"for-this-user"}');
		expect(res.headers.get('X-Cache')).toBeNull();
		expect(await env.CACHE_KV.getWithMetadata(await cacheKey(apiUrl(path)), 'text')).toEqual(storedBefore);
		expect(await caches.default.match(new Request(`https://cache.internal/${await cacheKey(apiUrl(path))}`))).toBeUndefined();
	});

	it('serves the same URL from cache once Authorization is absent', async () => {
		const path = uniquePath('anonymous');
		await seedKv(path, '{"v":"public"}', 0);
		expectOrigin(path, '{"v":"for-this-user"}');
		await SELF.fetch(apiUrl(path), { headers: { authorization: 'Bearer user-token', 'cf-connecting-ip': '198.51.100.41' } });

		const res = await SELF.fetch(apiUrl(path), { headers: { 'cf-connecting-ip': '198.51.100.41' } });

		expect(res.headers.get('X-Cache')).toBe('KV-HIT');
		expect(await res.text()).toBe('{"v":"public"}');
	});
});

describe('an origin 5xx through the worker', () => {
	beforeAll(() => {
		fetchMock.activate();
		fetchMock.disableNetConnect();
	});
	afterEach(() => fetchMock.assertNoPendingInterceptors());

	it.each([500, 502, 503, 504])('serves the expired copy when the origin answers %i', async (status) => {
		const path = uniquePath(`${status}-with-stale`);
		await seedKv(path, '{"v":"stale"}', 600);
		expectOrigin(path, '{"error":"boom"}', status);

		const res = await SELF.fetch(apiUrl(path), { headers: { 'cf-connecting-ip': `198.51.100.${status - 450}` } });

		expect(res.status).toBe(200);
		expect(res.headers.get('X-Cache')).toBe('STALE-ERROR');
		expect(await res.text()).toBe('{"v":"stale"}');
	});

	it("answers with the origin's 5xx status when no copy is stored", async () => {
		const path = uniquePath('5xx-no-stale');
		expectOrigin(path, '{"error":"boom"}', 502);

		const res = await SELF.fetch(apiUrl(path), { headers: { 'cf-connecting-ip': '198.51.100.42' } });

		expect(res.status).toBe(502);
		expect(res.headers.get('X-Cache')).toBeNull();
		expect(await res.json()).toEqual({ error: 'Service unavailable' });
	});

	it('answers with the 5xx when the stored copy is past its stale-if-error window', async () => {
		const path = uniquePath('5xx-past-window');
		await seedKv(path, '{"v":"too-old"}', 300 + 86400 + 60);
		expectOrigin(path, '{"error":"boom"}', 503);

		const res = await SELF.fetch(apiUrl(path), { headers: { 'cf-connecting-ip': '198.51.100.44' } });

		expect(res.status).toBe(503);
		expect(res.headers.get('X-Cache')).toBeNull();
	});

	it('answers with the 5xx when the stored copy carries no storedAt', async () => {
		const path = uniquePath('5xx-unstamped');
		await env.CACHE_KV.put(await cacheKey(apiUrl(path)), '{"v":"unstamped"}', { metadata: { contentType: 'application/json' } });
		expectOrigin(path, '{"error":"boom"}', 503);

		const res = await SELF.fetch(apiUrl(path), { headers: { 'cf-connecting-ip': '198.51.100.45' } });

		expect(res.status).toBe(503);
		expect(res.headers.get('X-Cache')).toBeNull();
	});

	it('answers with a 501 even when an expired copy is stored', async () => {
		const path = uniquePath('501-with-stale');
		await seedKv(path, '{"v":"stale"}', 600);
		expectOrigin(path, '{"error":"not implemented"}', 501);

		const res = await SELF.fetch(apiUrl(path), { headers: { 'cf-connecting-ip': '198.51.100.43' } });

		expect(res.status).toBe(501);
		expect(res.headers.get('X-Cache')).toBeNull();
	});
});
