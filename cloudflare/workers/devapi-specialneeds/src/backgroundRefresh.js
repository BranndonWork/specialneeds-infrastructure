const cache = caches.default;

const createCacheKey = (request) => {
	const cacheUrl = new URL(request.url);
	return new Request(cacheUrl.toString(), request);
};

const setCache = async (request, response) => {
	if (response.status !== 200) {
		console.log('Background Refresh - Not caching non-200 response', {
			url: request.url,
			status: response.status,
			statusText: response.statusText,
		});
		return;
	}
	const cacheKey = createCacheKey(request);
	const clonedResponse = response.clone();
	const newHeaders = new Headers(clonedResponse.headers);
	newHeaders.set('x-cache-set', new Date().toISOString());
	const updatedResponse = new Response(clonedResponse.body, {
		status: clonedResponse.status,
		statusText: clonedResponse.statusText,
		headers: newHeaders,
	});
	console.log('Background Refresh - Storing response in cache with x-cache-set header:', newHeaders.get('x-cache-set'));
	await cache.put(cacheKey, updatedResponse);
};

export const backgroundRefresh = async (request, additionalHeaders = {}) => {
	const cacheBusterUrl = new URL(request.url);
	cacheBusterUrl.searchParams.set('cacheBuster', Date.now().toString());
	const modifiedRequest = new Request(cacheBusterUrl.toString(), request);
	console.log('Background Refresh - fetching fresh response', {
		url: modifiedRequest.url,
		headers: Object.fromEntries(request.headers.entries()),
	});

	for (const [key, value] of Object.entries(additionalHeaders)) {
		modifiedRequest.headers.set(key, value);
	}

	const freshResponse = await fetch(modifiedRequest);
	const requestHeaders = Object.fromEntries(request.headers.entries());
	const responseHeaders = Object.fromEntries(freshResponse.headers.entries());
	console.log('Background Refresh - fetched fresh response', {
		url: modifiedRequest.url,
		status: freshResponse.status,
		requestHeaders,
		responseHeaders,
	});
	await setCache(request, freshResponse);
	return freshResponse;
};
