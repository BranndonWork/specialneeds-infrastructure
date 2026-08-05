import { describe, it, expect, vi } from 'vitest';
import { buildSearchEvent, recordSearch, type SearchLogInput } from '../src/search-log';

function input(overrides: Partial<SearchLogInput> = {}): SearchLogInput {
	return {
		indexName: 'listings',
		statusBypassRequested: false,
		responseOk: true,
		searchParams: { q: 'autism' },
		responseText: JSON.stringify({ hits: [], estimatedTotalHits: 7 }),
		region: 'FL',
		...overrides,
	};
}

describe('buildSearchEvent', () => {
	describe('what gets logged at all', () => {
		it('logs a listings search that carries a term', () => {
			expect(buildSearchEvent(input())).not.toBeNull();
		});

		it('logs a termless listings browse that carries a geo radius', () => {
			const event = buildSearchEvent(input({
				searchParams: { q: '', filter: "status = 'published' AND _geoRadius(27.95, -82.45, 40234)" },
			}));
			expect(event).not.toBeNull();
			expect(event?.radiusMiles).toBe(25);
		});

		it('skips a termless browse with no location — those are the homepage and popular modules', () => {
			const event = buildSearchEvent(input({
				searchParams: { q: '', filter: "status = 'published' AND parent_category_slug = 'education'", sort: ['published_at_timestamp:desc'] },
			}));
			expect(event).toBeNull();
		});

		it('skips the articles index', () => {
			expect(buildSearchEvent(input({ indexName: 'articles' }))).toBeNull();
		});

		it('skips provider and staff searches that carry the status bypass', () => {
			expect(buildSearchEvent(input({ statusBypassRequested: true }))).toBeNull();
		});

		it('skips a failed search', () => {
			expect(buildSearchEvent(input({ responseOk: false }))).toBeNull();
		});

		it('skips a request whose parameters never reached us', () => {
			expect(buildSearchEvent(input({ searchParams: null }))).toBeNull();
		});
	});

	describe('term normalization', () => {
		it('lowercases, trims and collapses whitespace', () => {
			expect(buildSearchEvent(input({ searchParams: { q: '  Autism   THERAPY \n' } }))?.term).toBe('autism therapy');
		});

		it('truncates a pasted wall of text', () => {
			const event = buildSearchEvent(input({ searchParams: { q: 'a'.repeat(500) } }));
			expect(event?.term).toHaveLength(128);
		});

		it('tolerates a missing q', () => {
			expect(buildSearchEvent(input({ searchParams: { filter: '_geoRadius(27.9, -82.4, 16093)' } }))?.term).toBe('');
		});
	});

	describe('category filters', () => {
		it('reads a parent-only filter', () => {
			const event = buildSearchEvent(input({
				searchParams: { q: 'camp', filter: "status = 'published' AND parent_category_slug = 'education'" },
			}));
			expect(event?.parentCategory).toBe('education');
			expect(event?.childCategory).toBe('');
		});

		it('splits a parent/child composite slug', () => {
			const event = buildSearchEvent(input({
				searchParams: { q: 'camp', filter: "status = 'published' AND category_slug = 'education/schools'" },
			}));
			expect(event?.parentCategory).toBe('education');
			expect(event?.childCategory).toBe('schools');
		});

		it('does not mistake parent_category_slug for category_slug', () => {
			const event = buildSearchEvent(input({
				searchParams: { q: 'camp', filter: "parent_category_slug = 'recreational-activities'" },
			}));
			expect(event?.childCategory).toBe('');
			expect(event?.parentCategory).toBe('recreational-activities');
		});

		it('reads a filter supplied as an array', () => {
			const event = buildSearchEvent(input({
				searchParams: { q: 'camp', filter: ["status = 'published'", "category_slug = 'education/schools'"] },
			}));
			expect(event?.parentCategory).toBe('education');
			expect(event?.childCategory).toBe('schools');
		});

		it('leaves both empty when no category was filtered', () => {
			const event = buildSearchEvent(input());
			expect(event?.parentCategory).toBe('');
			expect(event?.childCategory).toBe('');
		});
	});

	describe('search location', () => {
		it('converts the geo radius from meters back to miles', () => {
			const event = buildSearchEvent(input({
				searchParams: { q: 'speech', filter: '_geoRadius(27.9506, -82.4572, 160934)' },
			}));
			expect(event?.radiusMiles).toBe(100);
		});

		it('rounds coordinates to a tenth of a degree so a precise browser fix is not stored', () => {
			const event = buildSearchEvent(input({
				searchParams: { q: 'speech', filter: '_geoRadius(27.9506312, -82.4572391, 40234)' },
			}));
			expect(event?.latitude).toBe(28);
			expect(event?.longitude).toBe(-82.5);
		});

		it('falls back to the proximity sort when the search was nationwide', () => {
			const event = buildSearchEvent(input({
				searchParams: { q: 'speech', sort: ['_geoPoint(27.9506, -82.4572):asc'] },
			}));
			expect(event?.latitude).toBe(28);
			expect(event?.longitude).toBe(-82.5);
			expect(event?.radiusMiles).toBe(0);
		});

		it('reports zeroes when the search carried no location', () => {
			const event = buildSearchEvent(input());
			expect(event?.latitude).toBe(0);
			expect(event?.longitude).toBe(0);
			expect(event?.radiusMiles).toBe(0);
		});
	});

	describe('result count', () => {
		it('reads estimatedTotalHits', () => {
			expect(buildSearchEvent(input())?.resultCount).toBe(7);
		});

		it('reads totalHits when Meilisearch paginated exhaustively', () => {
			const event = buildSearchEvent(input({
				responseText: JSON.stringify({ hits: [], totalHits: 42 }),
			}));
			expect(event?.resultCount).toBe(42);
		});

		it('reports zero rather than throwing on an unreadable response', () => {
			expect(buildSearchEvent(input({ responseText: 'not json at all' }))?.resultCount).toBe(0);
		});

		it('is not confused by a listing whose text contains the key name', () => {
			const event = buildSearchEvent(input({
				responseText: JSON.stringify({ hits: [{ content: '"estimatedTotalHits": 999' }], estimatedTotalHits: 3 }),
			}));
			expect(event?.resultCount).toBe(3);
		});
	});

	describe('visitor region', () => {
		it('keeps the state code it was handed', () => {
			expect(buildSearchEvent(input({ region: 'ca' }))?.region).toBe('CA');
		});

		it('is empty when nothing forwarded one', () => {
			expect(buildSearchEvent(input({ region: '' }))?.region).toBe('');
		});

		it('drops anything that is not a plain region code', () => {
			expect(buildSearchEvent(input({ region: '198.51.100.7' }))?.region).toBe('');
		});
	});
});

describe('recordSearch', () => {
	function fakeDataset() {
		return { writeDataPoint: vi.fn() };
	}

	it('writes exactly the four blobs and four doubles the ticket lists, and nothing else', () => {
		const dataset = fakeDataset();
		recordSearch(dataset, input({
			searchParams: { q: 'Autism Therapy', filter: "category_slug = 'therapies/speech-therapy' AND _geoRadius(27.9506, -82.4572, 40234)" },
			region: 'FL',
		}));

		expect(dataset.writeDataPoint).toHaveBeenCalledTimes(1);
		expect(dataset.writeDataPoint).toHaveBeenCalledWith({
			indexes: ['therapies'],
			blobs: ['autism therapy', 'therapies', 'speech-therapy', 'FL'],
			doubles: [28, -82.5, 25, 7],
		});
	});

	it('writes nothing when the search is not one we log', () => {
		const dataset = fakeDataset();
		recordSearch(dataset, input({ statusBypassRequested: true }));
		expect(dataset.writeDataPoint).not.toHaveBeenCalled();
	});

	it('does not throw when the dataset binding is missing', () => {
		expect(() => recordSearch(undefined, input())).not.toThrow();
	});

	it('swallows a dataset that throws, because logging must never fail a search', () => {
		const dataset = {
			writeDataPoint: vi.fn(() => {
				throw new Error('analytics engine is down');
			}),
		};
		expect(() => recordSearch(dataset, input())).not.toThrow();
	});

	it('writes nothing when the search parameters never reached us', () => {
		const dataset = fakeDataset();
		expect(() => recordSearch(dataset, input({ searchParams: null }))).not.toThrow();
		expect(dataset.writeDataPoint).not.toHaveBeenCalled();
	});
});
