# specialneeds-infrastructure

This repository contains the Cloudflare-specific infrastructure for SpecialNeeds.com. It manages edge computing, CDN caching rules, security headers, and Cloudflare Workers that run on the global edge network. The infrastructure includes the api-gateway Worker (rate limiting, caching, cache invalidation, origin hardening for `api.specialneeds.com`), search proxy workers connecting the frontend to Meilisearch, and an R2 bucket access layer for authenticated file storage.

This repository does NOT contain Docker configurations, nginx configs, database configurations, or service-specific infrastructure — those live in their respective service repositories (specialneeds-api, specialneeds-client, etc.). This is exclusively for Cloudflare Workers, edge computing logic, and CDN configurations deployed via Wrangler CLI.

## Quick Reference

- **[API Gateway](docs/api-gateway.md)** — As-built reference for the api-gateway Worker: rate limiting, caching, cache invalidation, KV store, origin hardening
- **[Workers](docs/workers.md)** — All deployed workers: api-gateway, meilisearch-proxy (production/staging), special-needs R2 bucket worker
- **[Architecture](docs/architecture.md)** — Tech stack, directory structure, R2 bucket architecture, environment routing pattern, file organization
- **[Commands](docs/commands.md)** — Development commands for each worker, setting secrets, viewing logs, local testing
- **[Deployment](docs/deployment.md)** — Deployment workflow, testing approach, secrets management
- **[Cloudflare Workers Reference](docs/cloudflare-workers-reference.md)** — General best practices, common patterns, security and performance tips
