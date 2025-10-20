export default class RequestWrapper {
	constructor(request) {
		this.request = request;
		this.url = new URL(this.request.url);
	}

	isADisplayRequest() {
		console.log('requestWrapper.isADisplayRequest()');
		const hasSlug = this.url.searchParams.get('slug') !== null;
		const isDisplayLevel = this.url.searchParams.get('level') === 'display';
		const result = hasSlug && isDisplayLevel;
		console.log(`hasSlug: ${hasSlug}`);
		console.log(`isDisplayLevel: ${isDisplayLevel}`);
		console.log(`result: ${result}`);
		return result;
	}

	isListingRequest() {
		console.log('requestWrapper.isListingRequest()');
		const isDisplay = this.isADisplayRequest();
		const isListing = this.url.pathname === '/api/v1/listings/';
		const result = isListing && isDisplay;
		console.log(`isListing: ${isListing}`);
		console.log(`isDisplay: ${isDisplay}`);
		console.log(`result: ${result}`);
		return result;
	}

	isArticleRequest() {
		console.log('requestWrapper.isArticleRequest()');
		const isDisplay = this.isADisplayRequest();
		const isArticle = this.url.pathname === '/api/v1/articles/';
		const result = isArticle && isDisplay;
		console.log(`isArticle: ${isArticle}`);
		console.log(`isDisplay: ${isDisplay}`);
		console.log(`result: ${result}`);
		return result;
	}

	isEventRequest() {
		console.log('requestWrapper.isEventRequest()');
		const isDisplay = this.isADisplayRequest();
		const isEvent = this.url.pathname === '/api/v1/events/';
		const result = isEvent && isDisplay;
		console.log(`isEvent: ${isEvent}`);
		console.log(`isDisplay: ${isDisplay}`);
		console.log(`result: ${result}`);
		return result;
	}
}
