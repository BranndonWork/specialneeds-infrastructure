import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext, fetchMock } from 'cloudflare:test';
import { cacheKey, checkCache, fetchAndCache } from '../src/cache';

// Every case needs its own URL. caches.default and CACHE_KV are shared across the pool worker,
// so a reused URL leaks an L1 entry into the next test and hides the L2 path being asserted.
function uniqueUrl(label: string): string {
	return `https://api.test/api/v1/${label}-${crypto.randomUUID()}/`;
}

async function seedKv(url: string, body: string, meta: Record<string, unknown>): Promise<void> {
	await env.CACHE_KV.put(await cacheKey(url), body, { metadata: meta });
}

async function read(url: string): Promise<Response | null> {
	const ctx = createExecutionContext();
	const res = await checkCache(new Request(url), env.CACHE_KV, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}

describe('KV entries honour the max-age Django sent', () => {
	it('serves an entry that is still inside its max-age', async () => {
		const url = uniqueUrl('fresh');
		await seedKv(url, '{"v":"fresh"}', {
			contentType: 'application/json',
			cacheControl: 'public, max-age=3600',
			storedAt: Date.now() - 10_000,
			maxAge: 3600,
		});

		const res = await read(url);

		expect(res).not.toBeNull();
		expect(res!.headers.get('X-Cache')).toBe('KV-HIT');
		expect(await res!.text()).toBe('{"v":"fresh"}');
	});

	it('does not serve an entry that is past its max-age', async () => {
		const url = uniqueUrl('expired');
		await seedKv(url, '{"v":"stale"}', {
			contentType: 'application/json',
			cacheControl: 'public, max-age=300',
			storedAt: Date.now() - 301_000,
			maxAge: 300,
		});

		expect(await read(url)).toBeNull();
	});

	it('keeps the expired body in KV so the origin-down fallback can still use it', async () => {
		const url = uniqueUrl('retained');
		await seedKv(url, '{"v":"stale"}', {
			contentType: 'application/json',
			cacheControl: 'public, max-age=300',
			storedAt: Date.now() - 301_000,
			maxAge: 300,
		});

		await read(url);

		expect(await env.CACHE_KV.get(await cacheKey(url))).toBe('{"v":"stale"}');
	});

	it('treats a short max-age as expired where a long one is still fresh', async () => {
		const storedAt = Date.now() - 120_000;
		const shortUrl = uniqueUrl('short-max-age');
		const longUrl = uniqueUrl('long-max-age');
		const meta = { contentType: 'application/json', cacheControl: 'public', storedAt };

		await seedKv(shortUrl, '{}', { ...meta, maxAge: 60 });
		await seedKv(longUrl, '{}', { ...meta, maxAge: 3600 });

		expect(await read(shortUrl)).toBeNull();
		expect(await read(longUrl)).not.toBeNull();
	});

	// Entries written before this change carry no storedAt and would otherwise be served forever.
	it('does not serve a legacy entry that has no stored timestamp', async () => {
		const url = uniqueUrl('legacy');
		await seedKv(url, '{"v":"immortal"}', {
			contentType: 'application/json',
			cacheControl: 'public, max-age=300',
		});

		expect(await read(url)).toBeNull();
	});
});

describe('writes record what is needed to expire the entry', () => {
	beforeAll(() => {
		fetchMock.activate();
		fetchMock.disableNetConnect();
	});
	afterEach(() => fetchMock.assertNoPendingInterceptors());

	async function writeThroughOrigin(url: string, cacheControl: string): Promise<void> {
		fetchMock
			.get('https://origin.test')
			.intercept({ path: new URL(url).pathname })
			.reply(200, '{"v":"from-origin"}', {
				headers: { 'Content-Type': 'application/json', 'Cache-Control': cacheControl },
			});

		const ctx = createExecutionContext();
		await fetchAndCache(new Request(url), env.ORIGIN_URL, env.CACHE_KV, ctx, 'test-origin-secret', null);
		await waitOnExecutionContext(ctx);
	}

	it('stores the max-age the origin sent, alongside the write time', async () => {
		const url = uniqueUrl('write-meta');
		await writeThroughOrigin(url, 'public, max-age=3600');

		const stored = await env.CACHE_KV.getWithMetadata<{ storedAt?: number; maxAge?: number }>(
			await cacheKey(url),
			'text',
		);

		expect(stored.value).toBe('{"v":"from-origin"}');
		expect(stored.metadata?.maxAge).toBe(3600);
		expect(stored.metadata?.storedAt).toBeTypeOf('number');
	});

	it('gives the KV key an expiry instead of writing it permanently', async () => {
		const url = uniqueUrl('write-ttl');
		await writeThroughOrigin(url, 'public, max-age=300, stale-if-error=86400');

		const key = await cacheKey(url);
		const { keys } = await env.CACHE_KV.list();

		expect(keys.find(k => k.name === key)?.expiration).toBeTypeOf('number');
	});

	it('serves what it just wrote, then stops once the max-age has passed', async () => {
		const url = uniqueUrl('write-then-expire');
		await writeThroughOrigin(url, 'public, max-age=300');

		expect(await read(url)).not.toBeNull();

		const key = await cacheKey(url);
		const stored = await env.CACHE_KV.getWithMetadata<Record<string, unknown>>(key, 'text');
		await env.CACHE_KV.put(key, stored.value!, {
			metadata: { ...stored.metadata, storedAt: Date.now() - 301_000 },
		});
		await caches.default.delete(new Request(`https://cache.internal/${key}`));

		expect(await read(url)).toBeNull();
	});
});

// A DELETE evicts L1 only at the PoP that handles it, and the serving PoP (Vercel, Virginia) is
// never the deleting one (Celery, Frankfurt). Capping L1 keeps every other PoP within a minute of
// an edit while KV still holds the entry for the origin's full max-age (#615).
describe('L1 holds an entry for at most 60 seconds regardless of the origin max-age', () => {
	beforeAll(() => {
		fetchMock.activate();
		fetchMock.disableNetConnect();
	});
	afterEach(() => fetchMock.assertNoPendingInterceptors());

	const THIRTY_DAYS = 'public, max-age=2592000, stale-if-error=86400';

	async function l1Entry(url: string): Promise<Response | undefined> {
		return caches.default.match(new Request(`https://cache.internal/${await cacheKey(url)}`));
	}

	async function writeThroughOrigin(url: string): Promise<Response> {
		fetchMock
			.get('https://origin.test')
			.intercept({ path: new URL(url).pathname })
			.reply(200, '{"v":"from-origin"}', {
				headers: { 'Content-Type': 'application/json', 'Cache-Control': THIRTY_DAYS },
			});

		const ctx = createExecutionContext();
		const res = await fetchAndCache(new Request(url), env.ORIGIN_URL, env.CACHE_KV, ctx, 'test-origin-secret', null);
		await waitOnExecutionContext(ctx);
		return res;
	}

	it('caps the L1 copy written on an origin fetch', async () => {
		const url = uniqueUrl('l1-cap-origin');
		await writeThroughOrigin(url);

		expect((await l1Entry(url))?.headers.get('Cache-Control')).toBe('public, max-age=60');
	});

	it('keeps the full max-age in KV on an origin fetch', async () => {
		const url = uniqueUrl('l1-cap-kv-meta');
		await writeThroughOrigin(url);

		const stored = await env.CACHE_KV.getWithMetadata<{ maxAge?: number; cacheControl?: string }>(
			await cacheKey(url),
			'text',
		);

		expect(stored.metadata?.maxAge).toBe(2592000);
		expect(stored.metadata?.cacheControl).toBe(THIRTY_DAYS);
	});

	it('returns the origin max-age to the caller on an origin fetch', async () => {
		const url = uniqueUrl('l1-cap-origin-response');
		const res = await writeThroughOrigin(url);

		expect(res.headers.get('Cache-Control')).toBe(THIRTY_DAYS);
	});

	it('caps the L1 copy written on a KV hit', async () => {
		const url = uniqueUrl('l1-cap-kv-hit');
		await seedKv(url, '{"v":"kv"}', {
			contentType: 'application/json',
			cacheControl: THIRTY_DAYS,
			storedAt: Date.now(),
			maxAge: 2592000,
		});

		const res = await read(url);

		expect(res?.headers.get('X-Cache')).toBe('KV-HIT');
		expect((await l1Entry(url))?.headers.get('Cache-Control')).toBe('public, max-age=60');
	});

	it('returns the origin max-age to the caller on an L1 hit', async () => {
		const url = uniqueUrl('l1-cap-l1-hit');
		await seedKv(url, '{"v":"kv"}', {
			contentType: 'application/json',
			cacheControl: THIRTY_DAYS,
			storedAt: Date.now(),
			maxAge: 2592000,
		});
		await read(url);

		const res = await read(url);

		expect(res?.headers.get('X-Cache')).toBe('HIT');
		expect(res?.headers.get('Cache-Control')).toBe(THIRTY_DAYS);
		expect(res?.headers.get('X-Origin-Cache-Control')).toBeNull();
	});
});
