# Dev protocol — project addendum (specialneeds-infrastructure)

<!-- Read by /dev (~/.claude/skills/dev) at task start and audit. -->

## Stack & entry points

- Cloudflare Workers (TypeScript) deployed via Wrangler; Terraform for zone/CDN rules; Ansible under `hetzner/` for origin hosts
- Workers: `cloudflare/workers/api-gateway` (rate limiting, caching, cache invalidation, origin hardening for api.specialneeds.com), `cloudflare/workers/meilisearch-proxy` (search filter injection; POST `/indexes/{index}/search` only), `cloudflare/workers/special-needs` (R2 access layer — dormant, routes commented out)
- Node ≥ 20.12 required for worker tests (shell default is 18): use `~/.nvm/versions/node/v22.1.0/bin`

## Where things go

- Worker code: `cloudflare/workers/<name>/src/`, tests beside it (vitest)
- CDN/cache/security rules: `terraform/`
- Origin host provisioning: `hetzner/ansible/`

## Decisions already made

- **There is no staging environment** — the staging search stack was decommissioned 2026-07-05. Verification happens on prod, carefully.
- **Search proxies allow only `POST /indexes/{index}/search`** — GET search → 405, other `/indexes/` paths and `/multi-search` → 404, querystring dropped.
- **Cache invalidation is worker-only** (`DELETE /v1/cache`) — the API's legacy Cloudflare zone purge is gone; the worker must stay compatible with the API's invalidation registry.
- **Cloudflare global API key is in active use** (scanner bans and more) — never rotate, revoke, or migrate it without explicit owner approval.

## Checks — run before declaring done

- per worker: `npx vitest run` and `npx tsc --noEmit` (with Node ≥ 20.12 on PATH)
- deploys are explicit: `npx wrangler deploy` only when the task calls for it, then verify live behavior (curl the deployed route)

## Fences

- `hetzner/ansible/secrets.yml` — plaintext secrets, gitignored; never commit, never print
- Do not create or modify Cloudflare resources (workers, routes, DNS, rulesets) beyond what the task names

## Deep-dive references

- `docs/api-gateway.md` — as-built worker reference
- `docs/workers.md` — all deployed workers
- `docs/cache-policy.md` — cross-repo cache SSOT: every cache layer, TTL, and invalidation path
- `docs/deployment.md`, `docs/commands.md` — wrangler workflow
