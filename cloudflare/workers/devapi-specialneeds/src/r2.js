export default class R2 {
	static LOCK_KEY_PATH = 'persistent-storage/lock-';

	constructor(r2Bucket) {
		this.r2Bucket = r2Bucket;
	}

	buildKey(lockKey) {
		if (!lockKey || typeof lockKey !== 'string') {
			throw new Error('lockKey is required');
		}
		lockKey = lockKey.toLowerCase();
		lockKey = lockKey.replace('persistent-storage', '');

		// replace any remaining slashes with dashes
		lockKey = lockKey.replace(/\//g, '-');
		// remove any dashes from start or end of string
		lockKey = lockKey.replace(/^-+|-+$/g, '');
		// replace multiple dashes with single dash
		lockKey = lockKey.replace(/-+/g, '-');
		return this.constructor.LOCK_KEY_PATH + lockKey;
	}

	async acquireLock(lockKey, maxWaitTime = 25000, retryInterval = 333) {
		const endTime = Date.now() + maxWaitTime;
		const lockFile = this.buildKey(lockKey);
		while (Date.now() < endTime) {
			const existingLock = await this.r2Bucket.get(lockFile);
			if (!existingLock) {
				await this.r2Bucket.put(lockFile, new Date().toISOString());
				return true;
			}
			await new Promise((resolve) => setTimeout(resolve, retryInterval));
		}
		return false;
	}

	async releaseLock(lockKey) {
		const lockFile = this.buildKey(lockKey);
		await this.r2Bucket.delete(lockFile);
	}

	async putWithLock(key, value) {
		if (await this.acquireLock(key)) {
			try {
				await this.r2Bucket.put(key, value);
			} catch (error) {
				console.error(`An error occurred while putting [${key}]:`, error);
			}
			await this.releaseLock(key);
		} else {
			console.log(`unable to acquire lock to put [${key}]`);
		}
	}

	async getJson(key) {
		try {
			const response = await this.get(key);
			return await response.json();
		} catch (error) {
			return null;
		}
	}

	async get(key) {
		try {
			return await this.r2Bucket.get(key);
		} catch (error) {
			return null;
		}
	}

	async put(key, value) {
		try {
			await this.r2Bucket.put(key, value);
		} catch (error) {
			console.error(`An error occurred while putting [${key}]:`, error);
		}
	}

	async delete(key) {
		try {
			await this.r2Bucket.delete(key);
		} catch (error) {
			console.error(`An error occurred while deleting [${key}]:`, error);
		}
	}
}
