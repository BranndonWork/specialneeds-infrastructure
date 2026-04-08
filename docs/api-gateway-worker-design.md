# API Gateway Worker — Design & Implementation Plan

**Date:** 2026-04-04
**Status:** Pre-implementation — approved for build
**Scope:** Cloudflare Worker on `api.specialneeds.com/*` replacing direct Cloudflare → origin routing

---

## What We're Building

A single Cloudflare Worker that sits in front of `api.specialneeds.com` and becomes the only public surface for all API traffic. The Django origin becomes unreachable except through the Worker.

This is not a microservice. It is one Worker with several responsibilities stacked in request order.

---

## Features

### 1. Rate Limiting

Three tiers, evaluated top-down. Implemented in the Worker using KV counters keyed by `cf.colo.id + ip.src` (per-datacenter, per-IP).

| Tier | Match | Limit | Block duration |
|---|---|---|---|
| Auth | `/api/v1/token/` | 5 req / 60s | 10 min |
| Browse | `/api/v1/listings/` or `/api/v1/articles/` | 30 req / 60s | 5 min |
| Fallback | all `api.specialneeds.com/*` | 60 req / 60s | 5 min |

Action on breach: `429 Too Many Requests`. No challenge pages — API clients are JSON consumers.

JWT role parsing (see feature 3) allows admin/editor tokens to bypass or receive higher limits.

The native Cloudflare rate limit rule currently deployed in Terraform stays in place during the transition as a backstop. It is removed once the Worker rate limiting is confirmed stable.

---

### 2. Two-Tier Caching with Request Coalescing

Request flow:

```
→ check Cache API (L1: per-PoP edge cache, fast, evictable)
→ miss → check KV (L2: persistent, globally replicated, ~10ms)
→ miss → acquire origin lock (Durable Object)
  → if lock already held: wait, then serve from cache when populated
  → if no lock: fetch origin, populate L1 + L2, release lock, return
```

**Request coalescing** prevents thundering herd — ten concurrent cache-miss requests produce one origin fetch. The other nine wait for the first to populate the cache.

**Stale-while-revalidate**: on cache hit with an expired TTL, serve the stale response immediately and kick off a background origin fetch to refresh. User sees no latency penalty.

**Stale-if-error**: if the origin fetch fails (5xx, timeout >3s), serve the stale cached response rather than returning an error. The backend being slow or down does not surface to users as long as any cached version exists.

These behaviors are enforced programmatically in the Worker regardless of what `Cache-Control` headers the origin sends.

---

### 3. JWT Role Parsing

The Worker parses the `Authorization: Bearer <token>` header using the Web Crypto API. The JWT signing secret is stored as a Worker secret (never in code).

Extracted claims are used to:
- Apply different rate limit thresholds per role (admin/editor bypass or higher limits)
- Future: role-based cache bypass for content that should never be served stale to editors

This is a capability the native Cloudflare rate limiter cannot provide — it has no concept of token identity.

---

### 4. Origin Hardening (Secret Header)

The Worker is the only entity that knows the actual Django origin URL. The origin URL is stored as a Worker secret, never committed to code or DNS.

Every request the Worker forwards to origin includes:

```
X-Origin-Secret: <uuid>
```

Django middleware validates this header on every request. Requests missing or with an incorrect value return `403` immediately — direct origin hits are rejected regardless of source.

This makes `api.specialneeds.com` the only viable attack surface. Even if the origin URL is discovered, it cannot be used without the secret.

**Django middleware rollback toggle**: the middleware checks the waffle switch `require_origin_secret`. This is the rollback mechanism for Phase 5 — flip the switch off in Django admin, instant enforcement stop, no deploy or restart needed. Remove Worker route afterward. Permanent toggle removal happens once Phase 5 is confirmed stable.

---

### 5. General-Purpose KV Cache Endpoint

The Worker exposes a dedicated cache namespace at:

```
GET  /v1/cache/:key    → returns cached value or 404
PUT  /v1/cache/:key    → sets value with optional TTL
DELETE /v1/cache/:key  → removes value
```

Key format: `prefix:identifier` — e.g. `geocache:tampa-fl`, `session:abc123`.
URL path uses `/` as separator which the Worker normalizes to `:` before KV lookup.

This replaces `cache.specialneeds.com` — a Redis wrapper currently co-located on the same server as the API. Co-location means if the API server goes down, the cache server goes down with it. KV is edge-distributed with Cloudflare's SLA, fully decoupled from origin health.

Services that currently call `cache.specialneeds.com` migrate to `api.specialneeds.com/v1/cache/:key`. The Worker handles get/set/delete against KV.

---

## Architecture

```
Client
  ↓
api.specialneeds.com (DNS, proxied through Cloudflare — unchanged)
  ↓
Cloudflare Worker (new)
  ├── Rate limit check (KV counters + Durable Object lock)
  ├── JWT parse (role extraction)
  ├── Cache check (Cache API → KV)
  │     hit: return response
  │     miss: continue
  ├── Origin fetch (URL from Worker secret)
  │     + X-Origin-Secret header
  │     + 3s timeout, stale-if-error fallback
  ├── Populate cache (Cache API + KV)
  └── Return response

Django origin (no public DNS name — Worker secret only)
  ├── Validates X-Origin-Secret header
  └── Processes request normally
```

**KV namespaces:**
- `RATE_LIMIT_KV` — rate limit counters (short TTL)
- `CACHE_KV` — cached API responses and general-purpose cache values

**Durable Objects:**
- `OriginLock` — per-resource lock for request coalescing

---

## What This Replaces / Retires

| Current | Replaced by | When |
|---|---|---|
| Native CF rate limit rule (Terraform) | Worker rate limiting | Phase 2 confirmed stable |
| Direct Cloudflare → origin routing | Worker caching layer | Phase 3 |
| `cache.specialneeds.com` Redis wrapper | Worker KV endpoint | Phase 6 confirmed stable |

---

## Phased Implementation Plan

### Phase 1 — Worker passthrough

Deploy Worker on `api.specialneeds.com/*`. Worker intercepts all requests and forwards to origin unchanged. No rate limiting, no caching, no secret header. Functionally identical to today.

**Goal:** confirm Worker routing is correct. All existing API consumers continue working.

**Rollback:** `wrangler delete` or remove the Worker route. Zero impact to anything.

---

### Phase 2 — Rate limiting

Add rate limit logic to Worker (KV counters, three-tier rules). Keep native Cloudflare rate limit rule in Terraform but mark disabled — one-line re-enable if needed.

**Goal:** verify 429s fire correctly. Test all three tiers under controlled load. Confirm legitimate traffic is not blocked.

**Rollback:** remove Worker route + uncomment native rate limit rule in Terraform + `terraform apply`.

---

### Phase 3 — Two-tier caching

Add Cache API + KV cache logic. Add request coalescing via Durable Objects. Add stale-while-revalidate and stale-if-error behavior.

**Goal:** verify cache hits/misses are correct. Verify stale-if-error fires when origin is deliberately taken down. Verify origin request count drops.

**Rollback:** remove Worker route. KV cache data is orphaned but harmless. Cache API drains on its own TTL. No data loss.

---

### Phase 4 — JWT role parsing

Add JWT decode and verification. Route admin/editor tokens to higher rate limit tiers or bypass.

**Goal:** verify role extraction is correct. Verify different limits apply per role.

**Rollback:** remove Worker route.

---

### Phase 5 — Origin hardening (secret header)

**Sequence (order matters):**
1. Deploy Django middleware with `REQUIRE_ORIGIN_SECRET=false` — middleware is present but not enforcing
2. Confirm Django deployed successfully
3. Add `X-Origin-Secret` to Worker — Worker begins sending header
4. Confirm requests are flowing correctly with header present
5. Set `REQUIRE_ORIGIN_SECRET=true` in Coolify — trigger container restart
6. Confirm Django is now rejecting headerless requests
7. Remove origin URL from DNS (or leave CNAME pointing nowhere meaningful)

**Goal:** origin is unreachable without the secret. Direct hammering of origin URL returns 403.

**Rollback:**
1. Django admin → Waffle → Switches → `require_origin_secret` → uncheck Active → Save (instant, no restart)
2. Remove Worker route

This rollback is instant with no service restart required. The waffle switch change takes effect immediately.

---

### Phase 6 — KV cache endpoint

Add `/v1/cache/:key` GET/PUT/DELETE handlers to Worker. Migrate services from `cache.specialneeds.com` one at a time. `cache.specialneeds.com` remains running until all consumers are migrated and confirmed stable.

**Goal:** all services using `cache.specialneeds.com` now use `api.specialneeds.com/v1/cache/:key`. Verify cache hit/miss behavior matches expectations.

**Rollback:** point services back to `cache.specialneeds.com`. It is still running.

---

### Phase 7 — Retire `cache.specialneeds.com`

Only after Phase 6 is confirmed stable. Audit all service configs to confirm no remaining references. Decommission the Coolify service.

**Goal:** eliminate co-located Redis cache dependency.

**Rollback:** redeploy `cache.specialneeds.com` from its repo. This is the only phase with no instant rollback — allow adequate burn-in time before executing.

---

## Rollback Summary

| Phase | Rollback | Time |
|---|---|---|
| 1 | Remove Worker route | Seconds |
| 2 | Remove Worker route + re-enable native CF rate limit rule | ~2 min |
| 3 | Remove Worker route | Seconds |
| 4 | Remove Worker route | Seconds |
| 5 | Flip waffle switch `require_origin_secret` off + remove Worker route | Seconds |
| 6 | Point services back to `cache.specialneeds.com` | Config change |
| 7 | Redeploy `cache.specialneeds.com` | Minutes |

---

## What Is Not In This Worker

- Workers for `search.specialneeds.com` (Meilisearch proxy) — separate Worker, unchanged
- DNS management — stays in Terraform
- Django application logic — stays in Django
- Vercel ISR cache invalidation — out of scope for this Worker, separate concern

---

## Resolved Pre-Build Questions

1. **Durable Objects** — Workers Paid plan ($5/mo) confirmed active. Durable Objects are available. Request coalescing will use a Durable Object lock for strongly consistent, precise thundering herd protection.

2. **KV namespace provisioning** — Wrangler, not Terraform. Workers infrastructure lives in Wrangler. `wrangler kv namespace create` and bind in `wrangler.toml`. Keeping Workers and zone/DNS management in separate tools avoids split ownership.

3. **JWT algorithm** — HS256 symmetric, signed with Django's `SECRET_KEY`. No `ALGORITHM` or `SIGNING_KEY` override in `config/auth.py`. Worker stores Django's `SECRET_KEY` as a Worker secret (`JWT_SECRET`) and verifies tokens using the Web Crypto API (`HMAC`, `SHA-256`). Security note: the Worker holds a copy of Django's most sensitive secret — rotate `SECRET_KEY` requires updating the Worker secret simultaneously.
4. Determine per-phase burn-in window before proceeding to next phase.
