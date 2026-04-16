import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
	test: {
		poolOptions: {
			workers: {
				wrangler: { configPath: './wrangler.jsonc' },
				miniflare: {
					bindings: {
						MEILI_SEARCH_KEY: 'test-search-key',
						MEILISEARCH_STATUS_BYPASS_KEY: 'test-bypass-secret',
					},
				},
			},
		},
	},
});
