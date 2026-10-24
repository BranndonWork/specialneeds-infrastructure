import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { SELF, env, fetchMock } from 'cloudflare:test';
import { cacheKey, putCacheEntry } from '../src/cache';
import { checkRateLimit } from '../src/ratelimit';
import { RENDER_IDENTITY } from '../src/identity';
import { hmacHex } from './hmac';

// Must match the miniflare bindings in vitest.config.mts.
const SIGNING_SECRET = 'test-identity-signing-secret';

// caches.default and CACHE_KV are shared across the pool worker, so every case needs its own URL.
function uniqueUrl(label: string): string {
	return `https://api.test/api/v1/listings/display/${label}-${crypto.randomUUID()}/`;
}

async function signedRenderGet(url: string): Promise<Request> {
	const ts = String(Math.floor(Date.now() / 1000));
	const pathname = new URL(url).pathname;
	return new Request(url, {
		headers: {
			'cf-connecting-ip': '198.51.100.80',
			'x-sn-identity': RENDER_IDENTITY,
			'x-sn-identity-ts': ts,
			'x-sn-identity-sig': await hmacHex(SIGNING_SECRET, `${RENDER_IDENTITY}\n${pathname}\n${ts}`),
		},
	});
}

async function seedCache(url: string, body: string): Promise<void> {
	await putCacheEntry(env.CACHE_KV, await cacheKey(url), body, 'application/json', 'public, max-age=300');
}

// Spends a bucket past its limit, which sets the block every later request in it meets.
async function exhaustBucket(url: string, identity: string, limit: number): Promise<void> {
	for (let i = 0; i <= limit; i++) await checkRateLimit(new Request(url), identity);
	expect((await checkRateLimit(new Request(url), identity)).limited).toBe(true);
}

describe('render requests check the gateway cache before the render bucket', () => {
	beforeAll(() => {
		fetchMock.activate();
		fetchMock.disableNetConnect();
	});

	afterEach(() => fetchMock.assertNoPendingInterceptors());

	it('answers a cached render request with 200 while the render bucket is blocked', async () => {
		const url = uniqueUrl('cached');
		await seedCache(url, '{"v":"cached"}');
		await exhaustBucket(url, RENDER_IDENTITY, 300);

		const response = await SELF.fetch(await signedRenderGet(url));

		expect(response.status).toBe(200);
		expect(response.headers.get('X-Cache')).toBe('KV-HIT');
		expect(await response.text()).toBe('{"v":"cached"}');
	});

	// With net connect disabled, a request that reached origin would come back as a 503.
	it('still refuses an uncached render request with 429 while the render bucket is blocked', async () => {
		const url = uniqueUrl('uncached');
		await exhaustBucket(url, RENDER_IDENTITY, 300);

		const response = await SELF.fetch(await signedRenderGet(url));

		expect(response.status).toBe(429);
	});

	it('keeps the rate limit ahead of the cache for a visitor, so a blocked visitor gets 429 on a cached path', async () => {
		const url = uniqueUrl('visitor');
		const visitorIp = '198.51.100.81';
		await seedCache(url, '{"v":"cached"}');
		await exhaustBucket(url, visitorIp, 60);

		const response = await SELF.fetch(new Request(url, { headers: { 'cf-connecting-ip': visitorIp } }));

		expect(response.status).toBe(429);
	});
});
