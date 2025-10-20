import R2 from './r2';

export default class Redirect {
	constructor(request, r2Bucket) {
		this.request = request;
		this.url = new URL(this.request.url);
		this.r2 = new R2(r2Bucket);
	}

	async updateLastAccessed(redirect) {
		if (!redirect?.last_accessed) {
			redirect.last_accessed = new Date().toISOString();
			await this.put(redirect);
			return;
		}

		// if last access was more than a day ago, update last_accessed
		const lastAccessed = new Date(redirect.last_accessed);
		const now = new Date();
		const diff = now - lastAccessed;
		const diffInDays = diff / (1000 * 60 * 60 * 24);
		if (diffInDays > 1) {
			redirect.last_accessed = now.toISOString();
			await this.put(redirect);
		}
	}

	async get(sourceUrl) {
		try {
			let redirects = await this.r2.getJson('persistent-storage/redirects.json');
			console.log(`[debugging] redirects: ${JSON.stringify(redirects)}`);
			if (!redirects || !redirects?.[sourceUrl]?.destination_url) {
				return null;
			}

			const hops = [sourceUrl];
			let finalDestination = sourceUrl;
			while (redirects?.[finalDestination]?.destination_url) {
				finalDestination = redirects[finalDestination].destination_url;
				hops.push(finalDestination);
			}

			// Update all hops to point to the new final destination
			if (hops.length > 1) {
				for (const hopURL of hops) {
					const hop = redirects[hopURL];
					if (hop && hop.destination_url !== finalDestination) {
						hop.destination_url = finalDestination;
						await this.put(hop);
					}
				}
			}

			await this.updateLastAccessed(redirects[sourceUrl]);
			return finalDestination;
		} catch (error) {
			console.error(`An error occurred while fetching redirects for [${sourceUrl}]:`, error);
			return null;
		}
	}

	async put(redirect) {
		if (await this.r2.acquireLock('redirect')) {
			try {
				const sourceUrl = redirect.source_url;
				let redirects = await this.r2.get('persistent-storage/redirects.json');
				redirects = await redirects.json();
				redirects[sourceUrl] = redirect;
				await this.r2.put('persistent-storage/redirects.json', JSON.stringify(redirects));
				console.log(`redirects: ${JSON.stringify(redirects)}`);
			} catch (error) {
				console.error(`An error occurred while putting redirects for [${sourceUrl}]:`, error);
			}
			await this.r2.releaseLock('redirect');
		} else {
			console.log(`unable to acquire lock to put redirects for [${sourceUrl}]`);
		}
	}
}
