declare module 'cloudflare:test' {
	// Secrets are absent from the generated Env; vitest.config.mts binds a test value for each.
	interface ProvidedEnv extends Env {
		ORIGIN_URL: string;
		CACHE_MGMT_TOKEN: string;
		WORKER_ORIGIN_SECRET: string;
		CF_API_TOKEN: string;
		REVALIDATE_SECRET: string;
		SN_SERVICE_TOKEN: string;
		IDENTITY_SIGNING_SECRET: string;
		IDENTITY_SIGNING_SECRET_PREVIOUS: string;
	}
}
