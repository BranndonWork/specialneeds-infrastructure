export const cloneResponse = (response) => {
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers: Object.fromEntries(response.headers.entries()),
	});
};
