import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext, fetchMock } from 'cloudflare:test';
import { toOriginUrl } from '../src/origin';
import { fetchAndCache } from '../src/cache';

const ORIGIN = 'https://origin.test';

function pathSentToOrigin(requestPath: string): string {
	return toOriginUrl(`https://api.test${requestPath}`, ORIGIN).pathname;
}

describe('the origin URL keeps the request on the origin host', () => {
	it('rewrites the scheme, host and port to the origin', () => {
		const target = toOriginUrl('https://api.test/api/v1/listings/', 'http://origin.test:8000');

		expect(target.protocol).toBe('http:');
		expect(target.hostname).toBe('origin.test');
		expect(target.port).toBe('8000');
	});

	it('carries the query string through untouched', () => {
		const target = toOriginUrl('https://api.test/api/v1/listings?page=2&q=camp', ORIGIN);

		expect(target.search).toBe('?page=2&q=camp');
	});
});

describe('app paths still get the slash Django APPEND_SLASH would redirect for', () => {
	it('appends a slash to a slash-less app path', () => {
		expect(pathSentToOrigin('/api/v1/listings')).toBe('/api/v1/listings/');
	});

	it('leaves an app path that already ends in a slash alone', () => {
		expect(pathSentToOrigin('/api/v1/listings/')).toBe('/api/v1/listings/');
	});

	it('appends a slash to the health endpoint', () => {
		expect(pathSentToOrigin('/health')).toBe('/health/');
	});

	// Only the /static/ prefix is exempt. A path that merely contains the word is an app path.
	it('appends a slash to an app path whose segment merely contains "static"', () => {
		expect(pathSentToOrigin('/api/v1/listings/static-electricity-camp')).toBe(
			'/api/v1/listings/static-electricity-camp/',
		);
	});

	it('appends a slash to a slash-less path under a different prefix that ends in static', () => {
		expect(pathSentToOrigin('/assets/static')).toBe('/assets/static/');
	});
});

describe('static files reach whitenoise as literal filenames', () => {
	// A slash here 404s the file, and three such 404s under /static/admin/ trip CrowdSec's
	// admin-probing scenario and ban the visitor from the whole API.
	it('does not append a slash to an admin stylesheet', () => {
		expect(pathSentToOrigin('/static/admin/css/base.01580fff1759.css')).toBe(
			'/static/admin/css/base.01580fff1759.css',
		);
	});

	it('does not append a slash to a static file at the top of the prefix', () => {
		expect(pathSentToOrigin('/static/favicon.ico')).toBe('/static/favicon.ico');
	});

	it('does not append a slash to a static path that has no extension', () => {
		expect(pathSentToOrigin('/static/admin/img/icon')).toBe('/static/admin/img/icon');
	});

	it('leaves a static directory path that already ends in a slash alone', () => {
		expect(pathSentToOrigin('/static/admin/css/')).toBe('/static/admin/css/');
	});
});

describe('the origin fetch uses that path', () => {
	beforeAll(() => {
		fetchMock.activate();
		fetchMock.disableNetConnect();
	});
	afterEach(() => fetchMock.assertNoPendingInterceptors());

	it('fetches an admin stylesheet from the origin with no trailing slash', async () => {
		const path = `/static/admin/css/base.${crypto.randomUUID()}.css`;
		fetchMock
			.get(ORIGIN)
			.intercept({ path })
			.reply(200, 'body{}', {
				headers: { 'Content-Type': 'text/css', 'Cache-Control': 'public, max-age=31536000' },
			});

		const ctx = createExecutionContext();
		const res = await fetchAndCache(
			new Request(`https://api.test${path}`),
			env.ORIGIN_URL,
			env.CACHE_KV,
			ctx,
			'test-origin-secret',
			null,
		);
		await waitOnExecutionContext(ctx);

		expect(res.status).toBe(200);
		expect(await res.text()).toBe('body{}');
	});
});
