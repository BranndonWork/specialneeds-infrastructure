import { addHeadersToResponse } from './addHeadersToResponse';
import { getCachedRedirect, handlePotentialRedirect } from './handlePotentialRedirect';
// import { refreshCacheIfStale } from './refreshCacheIfStale';

export const cache = caches.default;
const BYPASS_CACHE_HEADER = 'x-specialneeds-bypass-cache';
const cacheBuster = 'cacheBuster';

const getCacheDetails = function (request) {
	// Use the request's URL as the cache key
	const cacheUrl = new URL(request.url);
	const cacheKey = cacheUrl.toString();

	console.log('cacheKey', cacheKey);

	let bypassCache = request.headers.get(BYPASS_CACHE_HEADER) === 'true';
	// if the request has quary param level and the level is not display, bypass cache
	if (!bypassCache || true) {
		const level = cacheUrl.searchParams.get('level');
		console.log('level', level);
		console.log('request.url', request.url);
		if (level && level !== 'display') bypassCache = true;
		if (request.url.endsWith('&level=editor')) {
			bypassCache = true;
			console.log('bypassCache because level=editor');
		}
	}
	return { cacheKey, bypassCache };
};

async function decompressBrotli(response) {
	const text = new TextDecoder('utf-8').decode(new Uint8Array(await response.arrayBuffer()));
	return new Response(text, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
}

const cacheResponse = async (response, headers, cacheKey, ctx) => {
	console.log('CACHE KEY IN SETTING CACHE RESPONSE', cacheKey);

	console.log('caching response 1', {
		status: response.status,
		statusText: response.statusText,
		headers: Object.fromEntries(response.headers.entries()),
	});

	headers['x-cache-set'] = new Date().toISOString();
	const newHeaders = new Headers(response.headers);

	console.log('caching response 2');

	// Add headers if they don't exist
	if (!newHeaders.has('x-env')) newHeaders.append('x-env', headers['x-env']);
	if (!newHeaders.has('x-cache-set')) newHeaders.append('x-cache-set', headers['x-cache-set']);

	// Clone the response for both reading the body and caching
	const clonedResponseForBody = response.clone();
	const clonedResponseForCaching = response.clone();
	console.log('caching response 3');

	// Read the body as JSON from one clone
	const responseBody = await clonedResponseForBody.json();
	console.log('caching response 4');

	// Use another clone for caching
	try {
		ctx.waitUntil(cache.put(cacheKey, clonedResponseForCaching));
		console.log('caching response 5', {
			status: clonedResponseForCaching.status,
			statusText: clonedResponseForCaching.statusText,
			headers: Object.fromEntries(clonedResponseForCaching.headers.entries()),
			body: responseBody,
		});
		const cachedResult = await cache.match(cacheKey);
		console.log('caching response  6 cachedResult', {
			status: cachedResult.status,
			statusText: cachedResult.statusText,
			headers: Object.fromEntries(cachedResult.headers.entries()),
			body: await cachedResult.text(),
		});
	} catch (error) {
		console.error('Error in caching response:', error);
	}
};

const processRequest = async function (request, r2Bucket, headers, cacheKey, ctx) {
	console.log('processRequest', {
		url: request.url,
		headers: Object.fromEntries(request.headers.entries()),
		cacheKey,
	});
	headers['x-specialneeds-processing-time-1'] = Date.now() - request.startTime;
	let response = await fetch(request, { headers: Object.fromEntries(request.headers.entries()) });
	headers['x-specialneeds-processing-time-2'] = Date.now() - request.startTime;
	let responseHeaders = {};

	for (let [key, value] of new Headers(response.headers).entries()) {
		responseHeaders[key] = value;
	}

	if (!response.ok) {
		console.log('response not ok', {
			status: response.status,
			statusText: response.statusText,
			responseHeaders,
		});
		response = await handlePotentialRedirect(request, response, r2Bucket, cacheKey);
	} else if (request.method === 'GET') {
		console.log('response ok', {
			status: response.status,
			statusText: response.statusText,
			responseHeaders,
		});
		await cacheResponse(response, headers, cacheKey, ctx);
	}
	headers['x-specialneeds-processing-time-3'] = Date.now() - request.startTime;
	return response;
};

const parseEtagHeader = (headers) => {
	let etag = headers?.etag;
	if (!etag && headers['x-etag']) etag = headers['x-etag'];
	return etag;
};

export default {
	async fetch(request, env, ctx) {
		request.startTime = Date.now();
		const requestEnvironment = request.headers.get('x-specialneeds-env') === 'production' ? 'production' : 'development';
		const r2Bucket = requestEnvironment === 'production' ? env.PROD_BUCKET : env.DEV_BUCKET;

		const headers = { 'x-env': requestEnvironment };
		const { cacheKey, bypassCache } = getCacheDetails(request);
		let response;

		let redirectResponse = bypassCache ? false : await getCachedRedirect(cacheKey);
		console.log('redirectResponse', {
			bypassCache,
			cacheKey,
			redirectResponse: redirectResponse ? true : false,
		});

		if (redirectResponse) {
			headers['x-specialneeds-processing-time-cached'] = Date.now() - request.startTime;
			console.log('Redirecting to cached redirect:', redirectResponse.headers.get('location'));
			return addHeadersToResponse(redirectResponse, headers);
		}
		console.log('CACHE KEY BEFORE CHECKING CACHED RESPONSE', cacheKey);
		let cachedResponse = bypassCache ? false : await cache.match(cacheKey);
		console.log('cachedResponse', cachedResponse);
		if (!bypassCache && cachedResponse) {
			const cachedEtag = parseEtagHeader(Object.fromEntries(cachedResponse.headers.entries()));
			const ifNoneMatch = request.headers.get('if-none-match');
			if (cachedEtag && ifNoneMatch && cachedEtag === ifNoneMatch) {
				console.log('Returning 304 Not Modified');
				cachedResponse = new Response(null, { status: 304 });
				headers['x-specialneeds-processing-time-304'] = Date.now() - request.startTime;
			} else {
				console.log('Returning cached response');
				const clonedCachedResponse = cachedResponse ? cachedResponse.clone() : null;
				console.log(
					'cachedResponse',
					JSON.stringify({
						cachedResponse: await clonedCachedResponse.json(),
						bypassCache,
						cacheKey,
						cacheHeaders: Object.fromEntries(cachedResponse.headers.entries()),
					})
				);
				headers['x-specialneeds-processing-time-cached'] = Date.now() - request.startTime;
			}
			// ctx.waitUntil(refreshCacheIfStale(request, env, cachedResponse));
			return addHeadersToResponse(cachedResponse, headers);
		} else {
			console.log('cachedResponse missing', JSON.stringify({ cachedResponse: typeof cachedResponse, bypassCache, cacheKey }));
		}

		try {
			console.log('Fetching fresh response');
			// if bypass cache, add the bypass cache header
			if (bypassCache) {
				headers[BYPASS_CACHE_HEADER] = 'true';
				// append the query param cacheBuster to the url no matter if it has params or not
				const cacheBusterUrl = new URL(request.url);
				cacheBusterUrl.searchParams.set(cacheBuster, Date.now().toString());
				request = new Request(cacheBusterUrl.toString(), request);
			}

			response = await processRequest(request, r2Bucket, headers, cacheKey, ctx);
			console.log('response status', response.status);
			console.log('response headers', JSON.stringify(Object.fromEntries(response.headers.entries())));
		} catch (error) {
			const message = JSON.stringify(error.message || String(error));
			console.error('An error occurred:', message);
			response = new Response(JSON.stringify({ error: `An internal error occurred: ${message}` }), { status: 500 });
		}

		const headerCopy = new Headers(response.headers);
		const headerEntries = headerCopy.entries();
		console.log('headerEntries', headerEntries);
		const contentEncoding = headerEntries['content-encoding'];
		console.log('contentEncoding', contentEncoding);
		if (contentEncoding === 'br') {
			console.log('decompressing brotli');

			const bodyBuffer = await response.arrayBuffer();
			const bodyClone1 = new Uint8Array(bodyBuffer);
			const bodyClone2 = new Uint8Array(bodyBuffer);

			let testResponse = await decompressBrotli(
				new Response(bodyClone1, {
					status: response.status,
					statusText: response.statusText,
					headers: response.headers,
				})
			);
			console.log('response', {
				status: testResponse.status,
				statusText: testResponse.statusText,
				headers: testResponse.headers,
				body: await testResponse.text(),
			});

			response = await decompressBrotli(
				new Response(bodyClone2, {
					status: response.status,
					statusText: response.statusText,
					headers: response.headers,
				})
			);
		} else {
			console.log('not decompressing brotli');

			// Convert the response body to an ArrayBuffer
			const bodyBuffer = await response.arrayBuffer();

			// Create a Uint8Array view for logging and decoding attempts
			const bodyClone = new Uint8Array(bodyBuffer);

			// Log the original body
			console.log('Original body:', new TextDecoder('utf-8').decode(bodyClone));

			try {
				// Attempt to decode as brotli
				const decodedResponse = await decompressBrotli(
					new Response(bodyClone, {
						status: response.status,
						statusText: response.statusText,
						headers: response.headers,
					})
				);
				console.log('Decoded body:', await decodedResponse.text());
			} catch (error) {
				console.error('Error decoding body:', error.message);
			}

			// Restore the original body to the response variable
			response = new Response(bodyBuffer, {
				status: response.status,
				statusText: response.statusText,
				headers: response.headers,
			});
		}

		headers['x-specialneeds-processing-time'] = Date.now() - request.startTime;
		const dupHeaders = new Headers(response.headers);
		console.log('final response', {
			headers: Object.fromEntries(dupHeaders.entries()),
			status: response.status,
			statusText: response.statusText,
		});
		return addHeadersToResponse(response, headers);
	},
};
