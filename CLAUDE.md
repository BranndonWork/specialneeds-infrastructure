# specialneeds-infrastructure

This repository contains the Cloudflare-specific infrastructure for SpecialNeeds.com. It manages edge computing, CDN caching rules, security headers, and Cloudflare Workers that run on the global edge network. The infrastructure includes the api-gateway Worker (rate limiting, caching, cache invalidation, origin hardening for `api.specialneeds.com`), a search proxy worker connecting the frontend to Meilisearch, and an R2 bucket access layer for authenticated file storage.

This repository does NOT contain Docker configurations, nginx configs, database configurations, or service-specific infrastructure — those live in their respective service repositories (specialneeds-api, specialneeds-client, etc.). This is exclusively for Cloudflare Workers, edge computing logic, and CDN configurations deployed via Wrangler CLI.

## Quick Reference

- **[Cache Policy (SSOT)](docs/cache-policy.md)** — Cross-repo cache map: every layer (origin headers, worker L1/KV, CDN, ISR), authority order, TTLs, the single invalidation mechanism, known gaps. **Start here for any cache question.**
- **[API Gateway](docs/api-gateway.md)** — As-built reference for the api-gateway Worker: rate limiting, caching, cache invalidation, KV store, origin hardening
- **[Workers](docs/workers.md)** — All deployed workers: api-gateway, meilisearch-proxy, special-needs R2 bucket worker
- **[Architecture](docs/architecture.md)** — Tech stack, directory structure, R2 bucket architecture, environment routing pattern, file organization
- **[Commands](docs/commands.md)** — Development commands for each worker, setting secrets, viewing logs, local testing
- **[Deployment](docs/deployment.md)** — Deployment workflow, testing approach, secrets management
- **[Cloudflare Workers Reference](docs/cloudflare-workers-reference.md)** — General best practices, common patterns, security and performance tips

## Agent skills

### Issue tracker

Issues live on the central company tracker `BranndonWork/special-needs` (never this repo), managed via `gh -R BranndonWork/special-needs` with the `repo: specialneeds-infrastructure` label. PRs stay here. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`), each label string equal to its role name. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout — `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
