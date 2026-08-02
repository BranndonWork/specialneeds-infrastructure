import { describe, it, expect } from 'vitest';
import { checkRateLimit } from '../src/ratelimit';
import { RENDER_IDENTITY } from '../src/identity';

const BROWSE_URL = 'https://api.test/api/v1/listings/display/education/schools/a-school/';
const AUTH_URL = 'https://api.test/api/v1/token/';
const GENERAL_URL = 'https://api.test/api/v1/anything-else/';

// caches.default backs the counters and is shared across the pool worker, so every case needs
// its own identity string or counters bleed between tests.
function uniqueIdentity(label: string): string {
	return `${label}-${crypto.randomUUID()}`;
}

async function hitTimes(url: string, identity: string, times: number): Promise<boolean[]> {
	const results: boolean[] = [];
	for (let i = 0; i < times; i++) {
		results.push((await checkRateLimit(new Request(url), identity)).limited);
	}
	return results;
}

describe('checkRateLimit identity keying', () => {
	it('gives two different verified visitor IPs separate counters', async () => {
		const noisy = uniqueIdentity('203.0.113.10');
		const quiet = uniqueIdentity('203.0.113.11');

		expect(await hitTimes(BROWSE_URL, noisy, 60)).not.toContain(true);
		expect((await checkRateLimit(new Request(BROWSE_URL), noisy)).limited).toBe(true);

		expect((await checkRateLimit(new Request(BROWSE_URL), quiet)).limited).toBe(false);
	});

	it('does not read CF-Connecting-IP — the identity parameter alone keys the counter', async () => {
		const identity = uniqueIdentity('shared-identity');
		const first = new Request(BROWSE_URL, { headers: { 'CF-Connecting-IP': '198.51.100.1' } });
		const second = new Request(BROWSE_URL, { headers: { 'CF-Connecting-IP': '198.51.100.2' } });

		await checkRateLimit(first, identity);
		for (let i = 0; i < 59; i++) await checkRateLimit(second, identity);

		expect((await checkRateLimit(second, identity)).limited).toBe(true);
	});
});

describe('checkRateLimit tiers', () => {
	it('puts the render identity on the render tier at 300/min regardless of path', async () => {
		const identity = RENDER_IDENTITY;
		// Well past the browse limit of 60 — proves the path tier is not what applies here.
		expect(await hitTimes(BROWSE_URL, identity, 300)).not.toContain(true);

		const limited = await checkRateLimit(new Request(BROWSE_URL), identity);
		expect(limited.limited).toBe(true);
		expect(limited.retryAfter).toBe(60);
	});

	it('limits browse paths at 60/min for a visitor identity', async () => {
		const identity = uniqueIdentity('browse-tier');
		expect(await hitTimes(BROWSE_URL, identity, 60)).not.toContain(true);

		const limited = await checkRateLimit(new Request(BROWSE_URL), identity);
		expect(limited.limited).toBe(true);
		expect(limited.retryAfter).toBe(60);
	});

	it('limits general paths at 120/min for a visitor identity', async () => {
		const identity = uniqueIdentity('general-tier');
		expect(await hitTimes(GENERAL_URL, identity, 120)).not.toContain(true);

		expect((await checkRateLimit(new Request(GENERAL_URL), identity)).limited).toBe(true);
	});

	it('limits auth paths at 5/min with a 600s block', async () => {
		const identity = uniqueIdentity('auth-tier');
		expect(await hitTimes(AUTH_URL, identity, 5)).not.toContain(true);

		const limited = await checkRateLimit(new Request(AUTH_URL), identity);
		expect(limited.limited).toBe(true);
		expect(limited.retryAfter).toBe(600);
	});

	it('keeps tiers on separate counters for the same identity', async () => {
		const identity = uniqueIdentity('multi-tier');
		expect(await hitTimes(AUTH_URL, identity, 5)).not.toContain(true);
		expect((await checkRateLimit(new Request(AUTH_URL), identity)).limited).toBe(true);

		expect((await checkRateLimit(new Request(BROWSE_URL), identity)).limited).toBe(false);
	});
});
