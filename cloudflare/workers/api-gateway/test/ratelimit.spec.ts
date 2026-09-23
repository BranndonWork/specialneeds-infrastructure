import { describe, it, expect } from 'vitest';
import { checkRateLimit, getTier } from '../src/ratelimit';
import { RENDER_IDENTITY } from '../src/identity';

const LISTING_ID = '3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b';

const BROWSE_URL = 'https://api.test/api/v1/listings/display/education/schools/a-school/';
const AUTH_URL = 'https://api.test/api/v1/token/';
const GENERAL_URL = 'https://api.test/api/v1/anything-else/';
const LOGIN_URL = 'https://api.test/api/v1/user/login/';
const SIGNUP_URL = 'https://api.test/api/v1/listings/signup/';
const CLAIM_URL = `https://api.test/api/v1/listings/${LISTING_ID}/claim/`;

const POST: RequestInit = { method: 'POST' };

// caches.default backs the counters and is shared across the pool worker, so every case needs
// its own identity string or counters bleed between tests.
function uniqueIdentity(label: string): string {
	return `${label}-${crypto.randomUUID()}`;
}

async function hitTimes(url: string, identity: string, times: number, init?: RequestInit): Promise<boolean[]> {
	const results: boolean[] = [];
	for (let i = 0; i < times; i++) {
		results.push((await checkRateLimit(new Request(url, init), identity)).limited);
	}
	return results;
}

describe('getTier', () => {
	it.each([
		'/api/v1/user/login/',
		'/api/v1/user/login',
		'/api/v1/listings/signup/',
		'/api/v1/listings/signup',
		`/api/v1/listings/${LISTING_ID}/claim/`,
		`/api/v1/listings/${LISTING_ID}/claim`,
	])('puts POST %s on the send tier', (pathname) => {
		expect(getTier('POST', pathname)).toBe('send');
	});

	it('matches the path Django routes, so a percent-encoded letter still lands on the send tier', () => {
		expect(getTier('POST', '/api/v1/user/logi%6e/')).toBe('send');
		expect(getTier('POST', '/api/v1/listings/signu%70/')).toBe('send');
	});

	it.each([
		['POST', '/api/v1/user/login/extra/', 'general'],
		['POST', '/api/v1/user/loginx/', 'general'],
		['POST', '/prefix/api/v1/user/login/', 'general'],
		['GET', '/api/v1/user/login/', 'general'],
		['GET', '/api/v1/listings/signup/', 'browse'],
		['POST', '/api/v1/listings/signup/extra/', 'browse'],
		['GET', `/api/v1/listings/${LISTING_ID}/claim/`, 'browse'],
		['POST', `/api/v1/listings/${LISTING_ID}/claims/`, 'browse'],
		['POST', `/api/v1/listings/${LISTING_ID}/claims/pending/`, 'browse'],
		['POST', `/api/v1/listings/${LISTING_ID}/claim/extra/`, 'browse'],
		['POST', '/api/v1/listings/not-a-uuid/claim/', 'browse'],
		['POST', '/api/v1/listings/claims/self-claim/confirm/', 'browse'],
		['POST', '/api/v1/token/', 'auth'],
		['POST', '/api/v1/token/refresh/', 'auth'],
	])('keeps %s %s on the %s tier', (method, pathname, tier) => {
		expect(getTier(method, pathname)).toBe(tier);
	});

	it.each([
		['POST', '/api/v1/toke%6e/', 'auth'],
		['POST', '/api/v1/token/refres%68/', 'auth'],
		['GET', '/api/v1/listing%73/display/education/schools/a-school/', 'browse'],
		['GET', '/api/v1/listings/display/education/schools/caf%C3%A9/', 'browse'],
	])('matches %s %s on the decoded path Django routes, landing on %s', (method, pathname, tier) => {
		expect(getTier(method, pathname)).toBe(tier);
	});
});

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

	it('limits send POSTs at 30 per window with a 600s block, one counter across login, signup, and claim', async () => {
		const identity = uniqueIdentity('send-tier');
		expect(await hitTimes(LOGIN_URL, identity, 10, POST)).not.toContain(true);
		expect(await hitTimes(SIGNUP_URL, identity, 10, POST)).not.toContain(true);
		expect(await hitTimes(CLAIM_URL, identity, 10, POST)).not.toContain(true);

		const limited = await checkRateLimit(new Request(LOGIN_URL, POST), identity);
		expect(limited.limited).toBe(true);
		expect(limited.retryAfter).toBe(600);
	});

	it('keeps the send tier off the auth counter, so token refresh survives a blocked login', async () => {
		const identity = uniqueIdentity('send-vs-auth');
		expect(await hitTimes(LOGIN_URL, identity, 30, POST)).not.toContain(true);
		expect((await checkRateLimit(new Request(LOGIN_URL, POST), identity)).limited).toBe(true);

		expect((await checkRateLimit(new Request('https://api.test/api/v1/token/refresh/', POST), identity)).limited).toBe(false);
		expect((await checkRateLimit(new Request(CLAIM_URL), identity)).limited).toBe(false);
	});
});
