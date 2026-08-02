import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { env, SELF, fetchMock } from 'cloudflare:test';
import { resolveIdentity, RENDER_IDENTITY } from '../src/identity';
import type { Env } from '../src/index';

const testEnv = env as unknown as Env;

// Must match the miniflare bindings in vitest.config.mts.
const PRIMARY = 'test-identity-signing-secret';
const PREVIOUS = 'test-identity-signing-secret-previous';

const DEFAULT_URL = 'https://api.test/api/v1/listings/display/education/schools/a-school/';

async function hmacHex(secret: string, message: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
	return Array.from(new Uint8Array(mac))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

function nowSeconds(): number {
	return Math.floor(Date.now() / 1000);
}

interface SignedRequestOptions {
	identity: string;
	url?: string;
	ts?: number;
	secret?: string;
	signature?: string;
	signedPathname?: string;
	clientIp?: string;
}

async function signedRequest(opts: SignedRequestOptions): Promise<Request> {
	const url = opts.url ?? DEFAULT_URL;
	const ts = String(opts.ts ?? nowSeconds());
	const pathname = opts.signedPathname ?? new URL(url).pathname;
	const message = `${opts.identity}\n${pathname}\n${ts}`;
	const headers = new Headers({
		'x-sn-identity': opts.identity,
		'x-sn-identity-ts': ts,
		'x-sn-identity-sig': opts.signature ?? (await hmacHex(opts.secret ?? PRIMARY, message)),
	});
	if (opts.clientIp) headers.set('cf-connecting-ip', opts.clientIp);
	return new Request(url, { headers });
}

describe('resolveIdentity', () => {
	it('trusts a valid signature and returns the asserted identity', async () => {
		const request = await signedRequest({ identity: '203.0.113.10', clientIp: '198.51.100.1' });
		expect(await resolveIdentity(request, testEnv)).toEqual({ value: '203.0.113.10', verified: true });
	});

	it('trusts a valid signature asserting the render identity', async () => {
		const request = await signedRequest({ identity: RENDER_IDENTITY, clientIp: '198.51.100.1' });
		expect(await resolveIdentity(request, testEnv)).toEqual({ value: RENDER_IDENTITY, verified: true });
	});

	it('rejects a forged signature and falls back to CF-Connecting-IP', async () => {
		const request = await signedRequest({
			identity: '203.0.113.10',
			secret: 'not-the-signing-secret',
			clientIp: '198.51.100.1',
		});
		expect(await resolveIdentity(request, testEnv)).toEqual({ value: '198.51.100.1', verified: false });
	});

	it('rejects a signature made over a different pathname', async () => {
		const request = await signedRequest({
			identity: '203.0.113.10',
			signedPathname: '/api/v1/listings/display/some/other/path/',
			clientIp: '198.51.100.1',
		});
		expect(await resolveIdentity(request, testEnv)).toEqual({ value: '198.51.100.1', verified: false });
	});

	it('rejects a timestamp older than the 60s window', async () => {
		const request = await signedRequest({
			identity: '203.0.113.10',
			ts: nowSeconds() - 61,
			clientIp: '198.51.100.1',
		});
		expect(await resolveIdentity(request, testEnv)).toEqual({ value: '198.51.100.1', verified: false });
	});

	it('accepts a timestamp just inside the 60s window', async () => {
		const request = await signedRequest({ identity: '203.0.113.10', ts: nowSeconds() - 59 });
		expect(await resolveIdentity(request, testEnv)).toEqual({ value: '203.0.113.10', verified: true });
	});

	it('accepts 5s of forward clock skew but not 60s', async () => {
		const withinSkew = await signedRequest({ identity: '203.0.113.10', ts: nowSeconds() + 5 });
		expect(await resolveIdentity(withinSkew, testEnv)).toEqual({ value: '203.0.113.10', verified: true });

		const beyondSkew = await signedRequest({
			identity: '203.0.113.10',
			ts: nowSeconds() + 60,
			clientIp: '198.51.100.1',
		});
		expect(await resolveIdentity(beyondSkew, testEnv)).toEqual({ value: '198.51.100.1', verified: false });
	});

	it('accepts a signature made with the previous secret', async () => {
		const request = await signedRequest({ identity: '203.0.113.10', secret: PREVIOUS });
		expect(await resolveIdentity(request, testEnv)).toEqual({ value: '203.0.113.10', verified: true });
	});

	it('falls back when the identity headers are absent', async () => {
		const request = new Request(DEFAULT_URL, { headers: { 'cf-connecting-ip': '198.51.100.1' } });
		expect(await resolveIdentity(request, testEnv)).toEqual({ value: '198.51.100.1', verified: false });
	});

	it('falls back to "unknown" when there is no CF-Connecting-IP either', async () => {
		const request = new Request(DEFAULT_URL);
		expect(await resolveIdentity(request, testEnv)).toEqual({ value: 'unknown', verified: false });
	});

	it('falls back when only some of the identity headers are present', async () => {
		const signed = await signedRequest({ identity: '203.0.113.10', clientIp: '198.51.100.1' });
		for (const missing of ['x-sn-identity', 'x-sn-identity-ts', 'x-sn-identity-sig']) {
			const headers = new Headers(signed.headers);
			headers.delete(missing);
			const request = new Request(DEFAULT_URL, { headers });
			expect(await resolveIdentity(request, testEnv)).toEqual({ value: '198.51.100.1', verified: false });
		}
	});

	it('treats a malformed hex signature as a verification failure, not a throw', async () => {
		for (const signature of ['zzzz', 'abc', '', '0x1234']) {
			const request = await signedRequest({ identity: '203.0.113.10', signature, clientIp: '198.51.100.1' });
			expect(await resolveIdentity(request, testEnv)).toEqual({ value: '198.51.100.1', verified: false });
		}
	});

	it('treats a non-numeric timestamp as a verification failure', async () => {
		const request = await signedRequest({ identity: '203.0.113.10', clientIp: '198.51.100.1' });
		const headers = new Headers(request.headers);
		headers.set('x-sn-identity-ts', 'not-a-timestamp');
		const malformed = new Request(DEFAULT_URL, { headers });
		expect(await resolveIdentity(malformed, testEnv)).toEqual({ value: '198.51.100.1', verified: false });
	});

	it('falls back when no signing secret is configured', async () => {
		const noSecret = { IDENTITY_SIGNING_SECRET: '' } as unknown as Env;
		const request = await signedRequest({ identity: '203.0.113.10', clientIp: '198.51.100.1' });
		expect(await resolveIdentity(request, noSecret)).toEqual({ value: '198.51.100.1', verified: false });
	});
});

describe('identity propagation to origin', () => {
	beforeAll(() => {
		fetchMock.activate();
		fetchMock.disableNetConnect();
	});

	afterEach(() => fetchMock.assertNoPendingInterceptors());

	async function captureOriginHeaders(request: Request, originPath: string): Promise<Record<string, string>> {
		let captured: Record<string, string> = {};
		fetchMock
			.get('https://origin.test')
			.intercept({ path: originPath, method: 'GET' })
			.reply((opts) => {
				const headers = opts.headers as Record<string, string | string[]>;
				captured = Object.fromEntries(
					Object.entries(headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v[0] : v]),
				);
				return {
					statusCode: 200,
					data: JSON.stringify({ ok: true }),
					responseOptions: { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } },
				};
			});

		const response = await SELF.fetch(request);
		expect(response.status).toBe(200);
		return captured;
	}

	it('presents a verified visitor IP to origin as CF-Connecting-IP', async () => {
		const path = '/api/v1/listings/display/origin-visitor-ip/';
		const request = await signedRequest({
			identity: '203.0.113.77',
			url: `https://api.test${path}`,
			clientIp: '198.51.100.1',
		});
		const headers = await captureOriginHeaders(request, path);

		expect(headers['cf-connecting-ip']).toBe('203.0.113.77');
		expect(headers['x-sn-identity']).toBeUndefined();
		expect(headers['x-sn-identity-ts']).toBeUndefined();
		expect(headers['x-sn-identity-sig']).toBeUndefined();
	});

	it('leaves CF-Connecting-IP alone when the signature does not verify', async () => {
		const path = '/api/v1/listings/display/origin-forged-ip/';
		const request = await signedRequest({
			identity: '203.0.113.78',
			url: `https://api.test${path}`,
			secret: 'not-the-signing-secret',
			clientIp: '198.51.100.1',
		});
		const headers = await captureOriginHeaders(request, path);

		expect(headers['cf-connecting-ip']).toBe('198.51.100.1');
		expect(headers['x-sn-identity']).toBeUndefined();
	});

	it('leaves CF-Connecting-IP alone for the render identity', async () => {
		const path = '/api/v1/listings/display/origin-render-ip/';
		const request = await signedRequest({
			identity: RENDER_IDENTITY,
			url: `https://api.test${path}`,
			clientIp: '198.51.100.1',
		});
		const headers = await captureOriginHeaders(request, path);

		expect(headers['cf-connecting-ip']).toBe('198.51.100.1');
		expect(headers['x-sn-identity']).toBeUndefined();
	});
});
