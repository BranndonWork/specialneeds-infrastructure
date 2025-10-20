import { backgroundRefresh } from './backgroundRefresh';
import { MAX_AGE_BEFORE_FORCE_REFRESH } from './constants';

export const refreshCacheIfStale = async (request, env, cacheResponse) => {
	const cacheControl = request.headers.get('cache-control');

	let maxAge = MAX_AGE_BEFORE_FORCE_REFRESH;
	if (cacheControl) {
		const maxAgeMatch = cacheControl.match(/max-age=(\d+)/);
		if (maxAgeMatch && maxAgeMatch[1]) {
			maxAge = parseInt(maxAgeMatch[1], 10) || maxAge;
		}
		console.log('cache-control header found in request:', cacheControl, maxAgeMatch, maxAge);
	} else {
		console.log('No cache-control header found in request');
	}

	const cacheAge = parseInt(cacheResponse.headers.get('age') || 0);
	console.log('cache-control check cache age:', cacheAge, maxAge);
	if (cacheAge > maxAge) {
		const additionalHeaders = {};
		if (request.headers.get('if-none-match')) {
			additionalHeaders['if-none-match'] = request.headers.get('if-none-match');
		}
		console.log('cache-control running background refresh');
		await backgroundRefresh(request, additionalHeaders);
	}
};
