import { cloneResponse } from './cloneResponse';

export const addHeadersToResponse = (originalResponse, additionalHeaders) => {
	const clonedResponse = cloneResponse(originalResponse);
	const clonedResponseHeaders = Object.fromEntries(clonedResponse.headers.entries());
	const combinedHeaders = new Headers(clonedResponseHeaders);

	for (let [key, value] of Object.entries(additionalHeaders)) {
		combinedHeaders.set(key, value);
	}

	return new Response(clonedResponse.body, {
		status: clonedResponse.status,
		statusText: clonedResponse.statusText,
		headers: combinedHeaders,
	});
};
