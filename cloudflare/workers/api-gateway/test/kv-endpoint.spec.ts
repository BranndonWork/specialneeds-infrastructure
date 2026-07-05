import { describe, it, expect } from 'vitest';
import { apiPathToFrontendPaths, frontendPathsFor } from '../src/kv-endpoint';

// The site builds with trailingSlash: true — every emitted page path must end in "/".
// Verified empirically 2026-07-05 against prod: both slash forms revalidate on the
// current Next version, but the trailing-slash form is the site's canonical key.
describe('apiPathToFrontendPaths', () => {
	it('maps a listing display path to the directory page and homepage', () => {
		expect(apiPathToFrontendPaths('/api/v1/listings/display/education/schools/some-school/')).toEqual([
			'/directory/education/schools/some-school/',
			'/',
		]);
	});

	it('maps an article display path to the article page', () => {
		expect(apiPathToFrontendPaths('/api/v1/articles/display/health/autism/some-article/')).toEqual([
			'/articles/health/autism/some-article/',
		]);
	});

	it('maps an event display path to the event page', () => {
		expect(apiPathToFrontendPaths('/api/v1/events/some-event/')).toEqual(['/events/some-event/']);
	});

	it('maps the prefixed event DB-slug form to the same event page', () => {
		expect(apiPathToFrontendPaths('/api/v1/events/events/some-event/')).toEqual(['/events/some-event/']);
	});

	it('does not map event aggregate endpoints', () => {
		expect(apiPathToFrontendPaths('/api/v1/events/categories/')).toEqual([]);
		expect(apiPathToFrontendPaths('/api/v1/events/popular_tags/')).toEqual([]);
		expect(apiPathToFrontendPaths('/api/v1/events/search/')).toEqual([]);
		expect(apiPathToFrontendPaths('/api/v1/events/')).toEqual([]);
	});

	it('always emits trailing-slash page paths, even for slash-less input', () => {
		for (const path of apiPathToFrontendPaths('/api/v1/articles/display/health/some-article')) {
			expect(path.endsWith('/')).toBe(true);
		}
		expect(apiPathToFrontendPaths('/api/v1/articles/display/health/some-article')).toEqual([
			'/articles/health/some-article/',
		]);
	});

	it('has no mapping for aggregate or unknown API paths', () => {
		expect(apiPathToFrontendPaths('/api/v1/articles/')).toEqual([]);
		expect(apiPathToFrontendPaths('/api/v1/articles/popular/tags/')).toEqual([]);
		expect(apiPathToFrontendPaths('/api/v1/listings/categories/')).toEqual([]);
		expect(apiPathToFrontendPaths('/v1/cache')).toEqual([]);
	});
});

describe('frontendPathsFor', () => {
	it('revalidates a frontend URL as its own page path', () => {
		expect(frontendPathsFor('https://www.specialneeds.com/articles/health/some-article')).toEqual([
			'/articles/health/some-article/',
		]);
		expect(frontendPathsFor('https://www.specialneeds.com/directory/schools/some-school/')).toEqual([
			'/directory/schools/some-school/',
		]);
	});

	it('maps API URLs through apiPathToFrontendPaths', () => {
		expect(frontendPathsFor('https://api.specialneeds.com/api/v1/articles/display/health/some-article/')).toEqual([
			'/articles/health/some-article/',
		]);
	});

	it('returns no paths for unmapped API URLs', () => {
		expect(frontendPathsFor('https://api.specialneeds.com/api/v1/articles/tags/')).toEqual([]);
	});
});
