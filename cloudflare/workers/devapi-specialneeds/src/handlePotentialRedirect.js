import Redirect from './Redirect';
import RequestWrapper from './RequestWrapper';
import { addHeadersToResponse } from './addHeadersToResponse';
const cache = caches.default;

const cacheRedirectInMinutes = 10;
export const REDIRECT_CACHE_TTL = cacheRedirectInMinutes * 60 * 1000; // 60 seconds

export const getCachedRedirect = async function (cacheKey) {
	const redirectCacheKey = cacheKey.includes('?') ? `${cacheKey}&hasRedirect=true` : `${cacheKey}?hasRedirect=true`;
	const cachedRedirect = await cache.match(redirectCacheKey);
	if (cachedRedirect) {
		const setAt = parseInt(cachedRedirect.headers.get('x-cache-redirect-set'), 10);
		const clonedResponse = new Response(cachedRedirect.body, {
			status: cachedRedirect.status,
			statusText: cachedRedirect.statusText,
			headers: cachedRedirect.headers,
		});

		const now = Date.now();

		console.log('getCachedRedirect debug', redirectCacheKey, {
			status: clonedResponse.status,
			statusText: clonedResponse.statusText,
			headers: Object.fromEntries(clonedResponse.headers.entries()),
			setAt,
			now: now,
			diff: now - setAt,
			setAtLocale: new Date(setAt).toLocaleString(),
			nowLocale: new Date(now).toLocaleString(),
			expired: now - setAt > REDIRECT_CACHE_TTL,
			ttl: REDIRECT_CACHE_TTL,
		});

		if (now - setAt < REDIRECT_CACHE_TTL) {
			return cachedRedirect;
		}
		await cache.delete(redirectCacheKey);
		console.log('getCachedRedirect', { redirectCacheKey }, 'deleted');
	}
	console.log('getCachedRedirect', redirectCacheKey, 'not found');
	return null;
};

export const setCachedRedirect = async function (request, response) {
	const redirectCacheKey = request.url.includes('?') ? `${request.url}&hasRedirect=true` : `${request.url}?hasRedirect=true`;
	let cachedResponse = addHeadersToResponse(response, { 'x-cache-redirect-set': Date.now().toString() });
	await cache.put(redirectCacheKey, cachedResponse);
	const cachedRedirect = await cache.match(redirectCacheKey);
	if (cachedRedirect) {
		console.log('setCachedRedirect Cache set:', {
			redirectCacheKey,
			status: cachedRedirect.status,
			headers: Object.fromEntries(cachedRedirect.headers.entries()),
		});
	} else {
		console.log('Cache not set for', redirectCacheKey);
	}
	return null;
};

export const handlePotentialRedirect = async (request, response, r2Bucket) => {
	const requestWrapper = new RequestWrapper(request);

	console.log('handlePotentialRedirect', {
		url: requestWrapper.url,
		status: response.status,
		location: response.headers.get('Location'),
		isdisplay: requestWrapper.isADisplayRequest(),
		islisting: requestWrapper.isListingRequest(),
		slug: requestWrapper.url.searchParams.get('slug'),
	});

	if (response.status === 301 || response.status === 302) {
		console.log('Redirect found', { status: response.status, url: response.headers.get('Location') });
		await setCachedRedirect(request, response);
		return response;
	}

	if (response.status === 404 && requestWrapper.isADisplayRequest()) {
		let sourceUrl = requestWrapper.url.searchParams.get('slug');
		console.log('Checking for redirect', { sourceUrl });
		let redirect = await new Redirect(request, r2Bucket).get(sourceUrl);

		if (!redirect && requestWrapper.isListingRequest()) {
			sourceUrl = 'directory/' + sourceUrl;
			redirect = await new Redirect(request, r2Bucket).get(sourceUrl);
		}

		console.log('Redirect Found?', { sourceUrl, redirect });
		if (redirect) {
			console.log('Found redirect', { sourceUrl, redirect });
			const redirectResponse = new Response(null, { status: 301, headers: { Location: redirect } });
			await setCachedRedirect(request, redirectResponse);
			return redirectResponse;
		}
	}
	return response;
};
