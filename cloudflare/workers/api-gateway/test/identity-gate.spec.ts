import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { SELF, fetchMock } from 'cloudflare:test';
import { hmacHex } from './hmac';

// Must match the miniflare bindings in vitest.config.mts.
const SIGNING_SECRET = 'test-identity-signing-secret';

const LISTING_ID = '3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b';
const SIGNUP_PATH = '/api/v1/listings/signup/';
const CLAIM_PATH = `/api/v1/listings/${LISTING_ID}/claim/`;
const LOGIN_PATH = '/api/v1/user/login/';

interface GatewayRequestOptions {
	clientIp: string;
	method?: string;
	signedAs?: string;
	signingSecret?: string;
}

async function gatewayRequest(path: string, opts: GatewayRequestOptions): Promise<Request> {
	const method = opts.method ?? 'POST';
	const headers = new Headers({ 'content-type': 'application/json', 'cf-connecting-ip': opts.clientIp });
	if (opts.signedAs) {
		const ts = String(Math.floor(Date.now() / 1000));
		const pathname = new URL(`https://api.test${path}`).pathname;
		headers.set('x-sn-identity', opts.signedAs);
		headers.set('x-sn-identity-ts', ts);
		headers.set('x-sn-identity-sig', await hmacHex(opts.signingSecret ?? SIGNING_SECRET, `${opts.signedAs}\n${pathname}\n${ts}`));
	}
	return new Request(`https://api.test${path}`, {
		method,
		headers,
		body: method === 'POST' ? '{}' : undefined,
	});
}

function expectOriginCall(path: string, method: string): void {
	fetchMock
		.get('https://origin.test')
		.intercept({ path, method })
		.reply(400, JSON.stringify({ reached: 'origin' }), {
			headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
		});
}

describe('identity gate on signup and claim', () => {
	beforeAll(() => {
		fetchMock.activate();
		fetchMock.disableNetConnect();
	});

	afterEach(() => fetchMock.assertNoPendingInterceptors());

	// With net connect disabled, a request that reached origin would surface as the 503 the
	// proxy returns on a failed fetch, so a 403 here also proves origin was never called.
	it.each([SIGNUP_PATH, CLAIM_PATH, '/api/v1/listings/signup', `/api/v1/listings/${LISTING_ID}/claim`])(
		'rejects an unsigned POST to %s with a 403 JSON body',
		async (path) => {
			const response = await SELF.fetch(await gatewayRequest(path, { clientIp: '198.51.100.20' }));

			expect(response.status).toBe(403);
			expect(response.headers.get('content-type')).toContain('application/json');
			expect(await response.json()).toEqual({ error: 'Forbidden' });
		},
	);

	it('rejects a POST whose signature does not verify', async () => {
		const request = await gatewayRequest(CLAIM_PATH, {
			clientIp: '198.51.100.21',
			signedAs: '203.0.113.21',
			signingSecret: 'not-the-signing-secret',
		});
		expect((await SELF.fetch(request)).status).toBe(403);
	});

	it('rejects before the rate limit, so unsigned posts never spend the send counter', async () => {
		const statuses: number[] = [];
		for (let i = 0; i < 31; i++) {
			statuses.push((await SELF.fetch(await gatewayRequest(SIGNUP_PATH, { clientIp: '198.51.100.26' }))).status);
		}
		expect(new Set(statuses)).toEqual(new Set([403]));
	});

	it('rejects a percent-encoded signup path that Django would still route to signup', async () => {
		const response = await SELF.fetch(await gatewayRequest('/api/v1/listings/signu%70/', { clientIp: '198.51.100.22' }));
		expect(response.status).toBe(403);
	});

	it.each([SIGNUP_PATH, CLAIM_PATH])('passes a verified POST to %s through to origin', async (path) => {
		expectOriginCall(path, 'POST');
		const request = await gatewayRequest(path, { clientIp: '198.51.100.23', signedAs: '203.0.113.23' });

		const response = await SELF.fetch(request);
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ reached: 'origin' });
	});

	it('does not gate login, which is reached directly by the internal scripts', async () => {
		expectOriginCall(LOGIN_PATH, 'POST');
		const response = await SELF.fetch(await gatewayRequest(LOGIN_PATH, { clientIp: '198.51.100.24' }));
		expect(response.status).toBe(400);
	});

	it('does not gate a GET on the claim path', async () => {
		expectOriginCall(CLAIM_PATH, 'GET');
		const response = await SELF.fetch(await gatewayRequest(CLAIM_PATH, { clientIp: '198.51.100.25', method: 'GET' }));
		expect(response.status).toBe(400);
	});
});
