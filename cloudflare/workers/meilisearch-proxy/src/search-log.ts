/**
 * Search query logging into Cloudflare Analytics Engine.
 *
 * Feeds the demand-gap report: which terms families search in an area, and
 * whether any listing covers them. Tracker issue #396.
 *
 * Nothing here identifies a person. No IP address, no session, no user id, and
 * no coordinate finer than a tenth of a degree.
 *
 * Analytics Engine requires a stable field order, so the blob and double
 * positions below are part of the stored schema. Append, never reorder.
 *
 *   blobs   [term, parent category, child category, visitor region]
 *   doubles [latitude, longitude, radius in miles, result count]
 *   index    parent category, the sampling key
 *
 * The event timestamp is Analytics Engine's own column and is not written here.
 */

const LOGGED_INDEX = 'listings';
const MAX_TERM_LENGTH = 128;
const METERS_PER_MILE = 1609.34;

const PARENT_CATEGORY = /parent_category_slug\s*=\s*'([^']*)'/;
const CHILD_CATEGORY = /(?<!parent_)category_slug\s*=\s*'([^']*)'/;
const GEO_RADIUS = /_geoRadius\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)/;
const GEO_POINT = /_geoPoint\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)/;
/** The subset of the Meilisearch search parameters the query log reads. */
export interface SearchParams {
	q?: unknown;
	filter?: unknown;
	sort?: unknown;
}

export interface SearchLogInput {
	indexName: string;
	/**
	 * Whether the caller asked to search across statuses, which only the
	 * my-account proxy does. Set from the presence of the header rather than
	 * from the secret validating, so a rotated or missing secret cannot spill
	 * provider searches into the demand log.
	 */
	statusBypassRequested: boolean;
	responseOk: boolean;
	searchParams: SearchParams | null;
	responseText: string;
	region: string;
}

export interface SearchEvent {
	term: string;
	parentCategory: string;
	childCategory: string;
	region: string;
	latitude: number;
	longitude: number;
	radiusMiles: number;
	resultCount: number;
}

export function recordSearch(dataset: AnalyticsEngineDataset | undefined, input: SearchLogInput): void {
	if (!dataset) return;

	try {
		const event = buildSearchEvent(input);
		if (!event) return;

		dataset.writeDataPoint({
			indexes: [event.parentCategory],
			blobs: [event.term, event.parentCategory, event.childCategory, event.region],
			doubles: [event.latitude, event.longitude, event.radiusMiles, event.resultCount],
		});
	} catch (error) {
		console.error('Search logging failed:', error);
	}
}

export function buildSearchEvent(input: SearchLogInput): SearchEvent | null {
	if (input.indexName !== LOGGED_INDEX) return null;
	if (input.statusBypassRequested) return null;
	if (!input.responseOk) return null;
	if (!input.searchParams) return null;

	const filter = flattenExpression(input.searchParams.filter);
	const sort = flattenExpression(input.searchParams.sort);

	const term = normalizeTerm(input.searchParams.q);
	const location = readLocation(filter, sort);

	// A search with neither a term nor a location is a homepage or sidebar
	// module fetching its own content, not a family looking for something.
	if (!term && !location.radiusMiles && !location.latitude && !location.longitude) return null;

	const [parentCategory, childCategory] = readCategories(filter);

	return {
		term,
		parentCategory,
		childCategory,
		region: normalizeRegion(input.region),
		...location,
		resultCount: readResultCount(input.responseText),
	};
}

function normalizeTerm(q: unknown): string {
	if (typeof q !== 'string') return '';
	return q.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, MAX_TERM_LENGTH);
}

function normalizeRegion(region: string): string {
	const stripped = region.toUpperCase().replace(/[^A-Z]/g, '');
	return stripped.length <= 3 ? stripped : '';
}

/** Meilisearch takes `filter` and `sort` as a string or an arbitrarily nested array of them. */
function flattenExpression(expression: unknown): string {
	if (typeof expression === 'string') return expression;
	if (Array.isArray(expression)) return expression.map(flattenExpression).join(' ');
	return '';
}

function readCategories(filter: string): [string, string] {
	const child = CHILD_CATEGORY.exec(filter);
	if (child) {
		const [parentSlug, childSlug = ''] = child[1].split('/');
		return [parentSlug, childSlug];
	}

	const parent = PARENT_CATEGORY.exec(filter);
	return [parent ? parent[1] : '', ''];
}

function readLocation(filter: string, sort: string): Pick<SearchEvent, 'latitude' | 'longitude' | 'radiusMiles'> {
	const radius = GEO_RADIUS.exec(filter);
	if (radius) {
		return {
			latitude: coarsen(radius[1]),
			longitude: coarsen(radius[2]),
			radiusMiles: Math.round(Number(radius[3]) / METERS_PER_MILE),
		};
	}

	// A nationwide search sorts by proximity without filtering to a radius.
	const point = GEO_POINT.exec(sort);
	if (point) {
		return { latitude: coarsen(point[1]), longitude: coarsen(point[2]), radiusMiles: 0 };
	}

	return { latitude: 0, longitude: 0, radiusMiles: 0 };
}

/** A tenth of a degree is about seven miles — enough to map demand, too coarse to place a household. */
function coarsen(degrees: string): number {
	return Math.round(Number(degrees) * 10) / 10;
}

/**
 * Scans backwards rather than parsing, because the response carries up to a
 * thousand listings and this runs on every search. Meilisearch emits the total
 * after `hits`, so the last occurrence is the real one and any earlier match
 * inside listing text is skipped. A shape we do not recognise reports zero.
 */
function readResultCount(responseText: string): number {
	for (const key of ['"estimatedTotalHits"', '"totalHits"']) {
		const at = responseText.lastIndexOf(key);
		if (at === -1) continue;

		const found = /^\s*:\s*(\d+)/.exec(responseText.slice(at + key.length, at + key.length + 32));
		if (found) return Number(found[1]);
	}

	return 0;
}
