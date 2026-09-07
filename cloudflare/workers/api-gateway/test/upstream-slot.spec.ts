import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import {
	clampInterval,
	planClaim,
	DEFAULT_INTERVAL_MS,
	MAX_INTERVAL_MS,
	MAX_QUEUE_DEPTH,
	MAX_WAIT_MS,
	type SlotClock,
} from '../src/upstream-slot';
import { handleRateLimitSlot } from '../src/ratelimit-slot-endpoint';

const TOKEN = 'test-cache-mgmt-token';

// Each case gets its own upstream name so one object's clock never bleeds into another test.
const uniqueUpstream = (label: string) => `${label}-${crypto.randomUUID()}`;

function claim(upstream: string, intervalMs: number, token: string | null = TOKEN): Promise<Response | null> {
	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	if (token !== null) headers['X-Sn-Service-Token'] = token;
	const request = new Request(`https://api.test/v1/ratelimit/${upstream}`, {
		method: 'POST',
		headers,
		body: JSON.stringify({ interval_ms: intervalMs }),
	});
	return handleRateLimitSlot(request, env.UPSTREAM_SLOT, TOKEN);
}

describe('clampInterval', () => {
	it('defaults when absent or unparseable', () => {
		expect(clampInterval(undefined)).toBe(DEFAULT_INTERVAL_MS);
		expect(clampInterval('soon')).toBe(DEFAULT_INTERVAL_MS);
	});

	it('clamps to the allowed range', () => {
		expect(clampInterval(0)).toBe(1);
		expect(clampInterval(10_000_000)).toBe(MAX_INTERVAL_MS);
		expect(clampInterval('250')).toBe(250);
	});
});

// The scheduling rule is pure, so arrival order and overflow are pinned here without timers.
// The Durable Object around it is Cloudflare's runtime and is not exercised by this suite.
describe('planClaim', () => {
	it('gives the first claim the slot now', () => {
		const clock: SlotClock = { nextFreeAt: 0, waiting: 0 };
		expect(planClaim(clock, 1000, 5000)).toEqual({ accepted: true, wait: 0 });
		expect(clock.nextFreeAt).toBe(6000);
	});

	it('spaces simultaneous claims one interval apart in arrival order', () => {
		const clock: SlotClock = { nextFreeAt: 0, waiting: 0 };
		const waits = [0, 1, 2].map(() => planClaim(clock, 1000, 5000));
		expect(waits).toEqual([
			{ accepted: true, wait: 0 },
			{ accepted: true, wait: 1000 },
			{ accepted: true, wait: 2000 },
		]);
	});

	it('does not carry an old clock forward once the interval has passed', () => {
		const clock: SlotClock = { nextFreeAt: 5000, waiting: 0 };
		expect(planClaim(clock, 1000, 9000)).toEqual({ accepted: true, wait: 0 });
		expect(clock.nextFreeAt).toBe(10_000);
	});

	it('refuses a claim that would wait past the limit and leaves the clock alone', () => {
		const clock: SlotClock = { nextFreeAt: 5000 + MAX_WAIT_MS + 1, waiting: 0 };
		expect(planClaim(clock, 1000, 5000)).toEqual({ accepted: false });
		expect(clock.nextFreeAt).toBe(5000 + MAX_WAIT_MS + 1);
	});

	it('refuses a claim when the line is full', () => {
		const clock: SlotClock = { nextFreeAt: 0, waiting: MAX_QUEUE_DEPTH };
		expect(planClaim(clock, 1000, 5000)).toEqual({ accepted: false });
		expect(clock.nextFreeAt).toBe(0);
	});
});

describe('handleRateLimitSlot routing', () => {
	it('ignores paths outside /v1/ratelimit/', async () => {
		const request = new Request('https://api.test/v1/cache/anything', { method: 'POST' });
		expect(await handleRateLimitSlot(request, env.UPSTREAM_SLOT, TOKEN)).toBeNull();
	});

	it('refuses a missing token', async () => {
		expect((await claim(uniqueUpstream('auth'), 100, null))?.status).toBe(403);
	});

	it('refuses a wrong token', async () => {
		expect((await claim(uniqueUpstream('auth'), 100, 'nope'))?.status).toBe(403);
	});

	it('refuses a missing upstream name', async () => {
		const request = new Request('https://api.test/v1/ratelimit/', { method: 'POST', headers: { 'X-Sn-Service-Token': TOKEN } });
		expect((await handleRateLimitSlot(request, env.UPSTREAM_SLOT, TOKEN))?.status).toBe(400);
	});

	it('only answers POST', async () => {
		const request = new Request('https://api.test/v1/ratelimit/x', { method: 'GET', headers: { 'X-Sn-Service-Token': TOKEN } });
		expect((await handleRateLimitSlot(request, env.UPSTREAM_SLOT, TOKEN))?.status).toBe(405);
	});
});
