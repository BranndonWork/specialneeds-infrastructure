import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
	test: {
		poolOptions: {
			workers: {
				wrangler: { configPath: './wrangler.jsonc' },
				miniflare: {
					bindings: {
						CACHE_MGMT_TOKEN: 'test-cache-mgmt-token',
						WORKER_ORIGIN_SECRET: 'test-origin-secret',
						CF_API_TOKEN: 'test-cf-api-token',
						REVALIDATE_SECRET: 'test-revalidate-secret',
						SN_SERVICE_TOKEN: 'test-sn-service-token',
						ORIGIN_URL: 'https://origin.test',
						IDENTITY_SIGNING_SECRET: 'test-identity-signing-secret',
						IDENTITY_SIGNING_SECRET_PREVIOUS: 'test-identity-signing-secret-previous',
					},
				},
			},
		},
	},
});
