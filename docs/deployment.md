# Deployment

## Deployment Notes

- **No staging environments** - Workers deploy directly to production
- **No environment-specific configs** - Environment determined at runtime via header
- **Secrets management** - Use `wrangler secret put` (never commit secrets)
- **R2 bucket binding** - Configured in wrangler.toml, accessed via `env` parameter

## Testing

Only `meilisearch-proxy` has automated tests:
- Location: `cloudflare/workers/meilisearch-proxy/test/`
- Framework: Vitest with `@cloudflare/vitest-pool-workers`
- Config: `vitest.config.mts`

Other workers should be tested manually via `wrangler dev` and local testing.
