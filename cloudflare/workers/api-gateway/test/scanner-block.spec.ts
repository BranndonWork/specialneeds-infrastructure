import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { SELF, fetchMock } from 'cloudflare:test';
import { hmacHex } from './hmac';

const SIGNING_SECRET = 'test-identity-signing-secret';

// caches.default is shared across the pool worker, so every case needs its own address.
let nextOctet = 1;
function uniqueIp(): string {
	return `198.51.100.${nextOctet++}`;
}

async function probe(path: string, clientIp: string, signedAs?: string, signingSecret = SIGNING_SECRET): Promise<Response> {
	const headers = new Headers({ 'cf-connecting-ip': clientIp });
	if (signedAs) {
		const ts = String(Math.floor(Date.now() / 1000));
		headers.set('x-sn-identity', signedAs);
		headers.set('x-sn-identity-ts', ts);
		headers.set('x-sn-identity-sig', await hmacHex(signingSecret, `${signedAs}\n${path}\n${ts}`));
	}
	return SELF.fetch(new Request(`https://api.test${path}`, { headers }));
}

function originReplies(status: number, times: number): void {
	fetchMock
		.get('https://origin.test')
		.intercept({ path: /.*/ })
		.reply(status, 'Not Found', { headers: { 'cache-control': 'no-store' } })
		.times(times);
}

async function probeTimes(times: number, clientIp: string, signedAs?: string, signingSecret?: string): Promise<number[]> {
	const statuses: number[] = [];
	for (let i = 0; i < times; i++) {
		const response = await probe(`/.env-${i}/`, clientIp, signedAs, signingSecret);
		statuses.push(response.status);
		await response.arrayBuffer();
	}
	return statuses;
}

describe('scanner block', () => {
	beforeAll(() => {
		fetchMock.activate();
		fetchMock.disableNetConnect();
	});

	afterEach(() => fetchMock.assertNoPendingInterceptors());

	it('blocks an IP at the edge after its tenth 404, so origin never sees the eleventh', async () => {
		originReplies(404, 10);
		const statuses = await probeTimes(12, uniqueIp());

		expect(statuses.slice(0, 10)).toEqual(Array(10).fill(404));
		expect(statuses.slice(10)).toEqual([403, 403]);
	});

	it('does not block an IP with nine 404s', async () => {
		const ip = uniqueIp();
		originReplies(404, 9);
		await probeTimes(9, ip);
		originReplies(200, 1);

		expect((await probe('/api/v1/listings/', ip)).status).toBe(200);
	});

	it('blocks a verified visitor identity, not the egress it arrived on', async () => {
		const egress = uniqueIp();
		const visitor = uniqueIp();
		originReplies(404, 10);
		await probeTimes(10, egress, visitor);

		expect((await probe('/.env/', egress, visitor)).status).toBe(403);
		originReplies(200, 1);
		expect((await probe('/api/v1/listings/', egress)).status).toBe(200);
	});

	it('never blocks the egress when a signed request fails verification', async () => {
		const egress = uniqueIp();
		originReplies(404, 12);
		const statuses = await probeTimes(12, egress, uniqueIp(), 'not-the-signing-secret');

		expect(statuses).toEqual(Array(12).fill(404));
	});

	it('never blocks render fetches', async () => {
		originReplies(404, 12);
		const statuses = await probeTimes(12, uniqueIp(), 'render');

		expect(statuses).toEqual(Array(12).fill(404));
	});
});
