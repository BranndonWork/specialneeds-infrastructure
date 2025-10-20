import { cache, REDIRECT_CACHE_TTL } from '.';

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

		console.log('getCachedRedirect', redirectCacheKey, {
			status: clonedResponse.status,
			statusText: clonedResponse.statusText,
			headers: Object.fromEntries(clonedResponse.headers.entries()),
			setAt,
			expired: Date.now() - setAt > REDIRECT_CACHE_TTL,
		});
		if (Date.now() - setAt < REDIRECT_CACHE_TTL) {
			return cachedRedirect;
		}
		await cache.delete(redirectCacheKey);
		console.log('getCachedRedirect', redirectCacheKey, 'deleted');
	}
	console.log('getCachedRedirect', redirectCacheKey, 'not found');
	return null;
};
