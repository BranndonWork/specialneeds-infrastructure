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

async function l1Entry(url: string): Promise<Response | undefined> {
	return caches.default.match(new Request(`https://cache.internal/${await cacheKey(url)}`));
}

function expectOrigin(url: string, body: string, status = 200, cacheControl = 'public, max-age=3600'): void {
	fetchMock
		.get(env.ORIGIN_URL)
		.intercept({ path: new URL(url).pathname })
		.reply(status, body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': cacheControl } });
}

// The worker's GET path: a cache read, then the origin on a miss.
async function readThroughCache(url: string): Promise<Response> {
	const ctx = createExecutionContext();
	const request = new Request(url);
	const res = (await checkCache(request, env.CACHE_KV, ctx))
		?? (await fetchAndCache(request, env.ORIGIN_URL, env.CACHE_KV, ctx, env.WORKER_ORIGIN_SECRET, null));
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

	it('keeps the expired body in KV so the stale-if-error fallback can still use it', async () => {
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

describe('cacheKey', () => {
	it('is the same whatever order the query parameters arrive in', async () => {
		expect(await cacheKey('https://api.test/api/v1/listings/?b=2&a=1')).toBe(await cacheKey('https://api.test/api/v1/listings/?a=1&b=2'));
	});

	it('ignores the fragment', async () => {
		expect(await cacheKey('https://api.test/api/v1/listings/?a=1#top')).toBe(await cacheKey('https://api.test/api/v1/listings/?a=1'));
	});

	it('differs when a parameter value differs', async () => {
		expect(await cacheKey('https://api.test/api/v1/listings/?page=1')).not.toBe(await cacheKey('https://api.test/api/v1/listings/?page=2'));
	});

	it('differs by path and by host', async () => {
		const base = await cacheKey('https://api.test/api/v1/listings/');
		expect(await cacheKey('https://api.test/api/v1/articles/')).not.toBe(base);
		expect(await cacheKey('https://www.specialneeds.com/api/v1/listings/')).not.toBe(base);
	});

	it('is 64 lowercase hex characters', async () => {
		expect(await cacheKey('https://api.test/api/v1/listings/')).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe('L1, KV and origin', () => {
	beforeAll(() => {
		fetchMock.activate();
		fetchMock.disableNetConnect();
	});
	afterEach(() => fetchMock.assertNoPendingInterceptors());

	it('fetches a miss from origin, then serves the next read from L1', async () => {
		const url = uniqueUrl('l1');
		expectOrigin(url, '{"v":"origin"}');

		const first = await readThroughCache(url);
		const second = await readThroughCache(url);

		expect(first.headers.get('X-Cache')).toBe('MISS');
		expect(second.headers.get('X-Cache')).toBe('HIT');
		expect(await second.text()).toBe('{"v":"origin"}');
	});

	it('serves from KV when the L1 copy is gone', async () => {
		const url = uniqueUrl('kv');
		expectOrigin(url, '{"v":"origin"}');
		await readThroughCache(url);
		await caches.default.delete(new Request(`https://cache.internal/${await cacheKey(url)}`));

		const res = await readThroughCache(url);

		expect(res.headers.get('X-Cache')).toBe('KV-HIT');
	});

	// L1 is per PoP and a DELETE cannot reach every PoP, so an L1 copy counts only while KV holds the key.
	it('evicts an L1 copy whose KV key is gone, and answers a miss', async () => {
		const url = uniqueUrl('l1-orphan');
		expectOrigin(url, '{"v":"first"}');
		await readThroughCache(url);
		expect(await l1Entry(url)).toBeDefined();
		await env.CACHE_KV.delete(await cacheKey(url));

		expect(await read(url)).toBeNull();
		expect(await l1Entry(url)).toBeUndefined();
	});

	it('goes to origin once the KV key is gone, even with an L1 copy present', async () => {
		const url = uniqueUrl('l1-orphan-refill');
		expectOrigin(url, '{"v":"first"}');
		await readThroughCache(url);
		await env.CACHE_KV.delete(await cacheKey(url));
		expectOrigin(url, '{"v":"second"}');

		const res = await readThroughCache(url);

		expect(res.headers.get('X-Cache')).toBe('MISS');
		expect(await res.text()).toBe('{"v":"second"}');
	});

	it('writes a response the origin marks no-store to neither tier', async () => {
		const url = uniqueUrl('no-store');
		expectOrigin(url, '{"v":"private"}', 200, 'no-store');

		await readThroughCache(url);

		expect(await env.CACHE_KV.get(await cacheKey(url))).toBeNull();
		expect(await l1Entry(url)).toBeUndefined();
	});
});

describe('origin failures', () => {
	beforeAll(() => {
		fetchMock.activate();
		fetchMock.disableNetConnect();
	});
	afterEach(() => fetchMock.assertNoPendingInterceptors());

	const EXPIRED = {
		contentType: 'application/json',
		cacheControl: 'public, max-age=300',
		storedAt: Date.now() - 600_000,
		maxAge: 300,
	};

	it('serves the expired KV body when the origin is unreachable', async () => {
		const url = uniqueUrl('stale');
		await seedKv(url, '{"v":"stale"}', EXPIRED);
		fetchMock.get(env.ORIGIN_URL).intercept({ path: new URL(url).pathname }).replyWithError(new Error('connection refused'));

		const res = await readThroughCache(url);

		expect(res.status).toBe(200);
		expect(res.headers.get('X-Cache')).toBe('STALE-ERROR');
		expect(await res.text()).toBe('{"v":"stale"}');
	});

	it('answers 503 when the origin is unreachable and the stored copy carries no storedAt', async () => {
		const url = uniqueUrl('unstamped');
		await seedKv(url, '{"v":"unstamped"}', { contentType: 'application/json', cacheControl: 'public, max-age=300' });
		fetchMock.get(env.ORIGIN_URL).intercept({ path: new URL(url).pathname }).replyWithError(new Error('connection refused'));

		const res = await readThroughCache(url);

		expect(res.status).toBe(503);
	});

	it('answers 503 when the origin is unreachable and nothing is stored', async () => {
		const url = uniqueUrl('no-stale');
		fetchMock.get(env.ORIGIN_URL).intercept({ path: new URL(url).pathname }).replyWithError(new Error('connection refused'));

		const res = await readThroughCache(url);

		expect(res.status).toBe(503);
	});

	it('writes an origin 5xx to neither tier', async () => {
		const url = uniqueUrl('5xx');
		expectOrigin(url, '{"error":"boom"}', 502);

		await readThroughCache(url);

		expect(await env.CACHE_KV.get(await cacheKey(url))).toBeNull();
		expect(await l1Entry(url)).toBeUndefined();
	});
});
