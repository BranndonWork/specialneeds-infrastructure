import { env, createExecutionContext, waitOnExecutionContext, fetchMock } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import worker from '../src';

const BASE = 'http://example.com';

function makeSearchRequest(body: object, headers: Record<string, string> = {}): Request {
	return new Request(`${BASE}/indexes/listings/search`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...headers },
		body: JSON.stringify(body),
	});
}

async function dispatch(request: Request): Promise<Response> {
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

beforeAll(() => {
	fetchMock.activate();
	fetchMock.disableNetConnect();
});

afterEach(() => fetchMock.assertNoPendingInterceptors());

describe('meilisearch-proxy', () => {
	describe('health check', () => {
		it('GET /health returns OK', async () => {
			const response = await dispatch(new Request(`${BASE}/health`));
			expect(response.status).toBe(200);
			expect(await response.text()).toBe('OK');
		});
	});

	describe('route guard', () => {
		it('rejects paths outside /indexes/', async () => {
			const response = await dispatch(new Request(`${BASE}/keys`));
			expect(response.status).toBe(404);
		});

		it('rejects root path', async () => {
			const response = await dispatch(new Request(`${BASE}/`));
			expect(response.status).toBe(404);
		});

		it('rejects document endpoints under /indexes/', async () => {
			const response = await dispatch(new Request(`${BASE}/indexes/listings/documents`, { method: 'POST' }));
			expect(response.status).toBe(404);
		});

		it('rejects settings endpoints under /indexes/', async () => {
			const response = await dispatch(new Request(`${BASE}/indexes/listings/settings`));
			expect(response.status).toBe(404);
		});

		it('rejects /multi-search', async () => {
			const response = await dispatch(new Request(`${BASE}/multi-search`, { method: 'POST' }));
			expect(response.status).toBe(404);
		});
	});

	describe('method guard', () => {
		it('rejects GET search with 405', async () => {
			const response = await dispatch(new Request(`${BASE}/indexes/listings/search?q=autism`));
			expect(response.status).toBe(405);
			expect(response.headers.get('Allow')).toBe('POST');
		});

		it('does not forward a GET search with a crafted status filter', async () => {
			const crafted = `${BASE}/indexes/listings/search?q=&filter=${encodeURIComponent("status = 'draft'")}`;
			const response = await dispatch(new Request(crafted));
			expect(response.status).toBe(405);
		});

		it('rejects GET search even with a valid bypass secret', async () => {
			const response = await dispatch(new Request(`${BASE}/indexes/listings/search?q=draft`, {
				headers: { 'X-Status-Bypass': 'test-bypass-secret' },
			}));
			expect(response.status).toBe(405);
		});

		it('rejects DELETE search with 405', async () => {
			const response = await dispatch(new Request(`${BASE}/indexes/listings/search`, { method: 'DELETE' }));
			expect(response.status).toBe(405);
		});
	});

	describe('status filter injection', () => {
		it('injects status = published when no filter is present', async () => {
			fetchMock
				.get(env.MEILI_HOST)
				.intercept({ method: 'POST', path: '/indexes/listings/search' })
				.reply(200, (req) => {
					const body = JSON.parse(req.body as string);
					expect(body.filter).toBe('status = published');
					return JSON.stringify({ hits: [] });
				});

			const response = await dispatch(makeSearchRequest({ q: 'autism' }));
			expect(response.status).toBe(200);
		});

		it('ANDs with an existing string filter', async () => {
			fetchMock
				.get(env.MEILI_HOST)
				.intercept({ method: 'POST', path: '/indexes/listings/search' })
				.reply(200, (req) => {
					const body = JSON.parse(req.body as string);
					expect(body.filter).toEqual(['status = published', 'category_slug = education']);
					return JSON.stringify({ hits: [] });
				});

			const response = await dispatch(makeSearchRequest({ q: 'school', filter: 'category_slug = education' }));
			expect(response.status).toBe(200);
		});

		it('ANDs with an existing array filter', async () => {
			fetchMock
				.get(env.MEILI_HOST)
				.intercept({ method: 'POST', path: '/indexes/listings/search' })
				.reply(200, (req) => {
					const body = JSON.parse(req.body as string);
					expect(body.filter).toEqual(['status = published', 'category_slug = education', ['tag = foo', 'tag = bar']]);
					return JSON.stringify({ hits: [] });
				});

			const response = await dispatch(makeSearchRequest({
				q: 'school',
				filter: ['category_slug = education', ['tag = foo', 'tag = bar']],
			}));
			expect(response.status).toBe(200);
		});
	});

	describe('X-Status-Bypass header', () => {
		it('skips filter injection when bypass secret is correct', async () => {
			fetchMock
				.get(env.MEILI_HOST)
				.intercept({ method: 'POST', path: '/indexes/listings/search' })
				.reply(200, (req) => {
					const body = JSON.parse(req.body as string);
					expect(body.filter).toBeUndefined();
					return JSON.stringify({ hits: [] });
				});

			const response = await dispatch(makeSearchRequest(
				{ q: 'draft listing' },
				{ 'X-Status-Bypass': 'test-bypass-secret' },
			));
			expect(response.status).toBe(200);
		});

		it('still injects filter when bypass secret is wrong', async () => {
			fetchMock
				.get(env.MEILI_HOST)
				.intercept({ method: 'POST', path: '/indexes/listings/search' })
				.reply(200, (req) => {
					const body = JSON.parse(req.body as string);
					expect(body.filter).toBe('status = published');
					return JSON.stringify({ hits: [] });
				});

			const response = await dispatch(makeSearchRequest(
				{ q: 'draft listing' },
				{ 'X-Status-Bypass': 'wrong-secret' },
			));
			expect(response.status).toBe(200);
		});

		it('does not forward X-Status-Bypass header to Meilisearch', async () => {
			fetchMock
				.get(env.MEILI_HOST)
				.intercept({ method: 'POST', path: '/indexes/listings/search' })
				.reply(200, (req) => {
					expect(req.headers['x-status-bypass']).toBeUndefined();
					return JSON.stringify({ hits: [] });
				});

			await dispatch(makeSearchRequest(
				{ q: 'test' },
				{ 'X-Status-Bypass': 'test-bypass-secret' },
			));
		});
	});
});
