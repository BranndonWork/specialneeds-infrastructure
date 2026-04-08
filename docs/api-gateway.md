# API Gateway Worker — As-Built Reference

**Worker:** `api-gateway`
**Route:** `api.specialneeds.com/*`
**Location:** `cloudflare/workers/api-gateway/`
**Language:** TypeScript
**Status:** Production ✅ (Phases 1–5 complete)

---

## What It Is

A Cloudflare Worker that is the sole public entry point for all API traffic to `api.specialneeds.com`. Before this Worker existed, Cloudflare proxied requests directly to the Django origin. Now the Worker sits between Cloudflare's edge and the origin, handling rate limiting, caching, cache invalidation, and origin hardening.

The Django origin is unreachable without going through this Worker.

---

## Request Flow

```
Client request → api.specialneeds.com
  ↓
Cloudflare Edge
  ↓
api-gateway Worker
  ├─ 0. CrowdSec ban check → 403 if IP is in CROWDSEC_KV (~2ms overhead)
  ├─ 1. KV endpoint check  (/v1/cache/*)  → short-circuits, skips everything below
  ├─ 2. Rate limit check   → 429 if exceeded
  ├─ 3. Cache check (GET only)
  │       L1: Cache API (per-PoP, fast) ─── HIT → return with X-Cache: HIT
  │       L2: KV (global, persistent)  ─── HIT → backfill L1, return with X-Cache: KV-HIT
  │       MISS → continue
  ├─ 4. Origin fetch
  │       Injects x-worker-origin-secret header
  │       GET: fetch → populate L1 + L2 → return with X-Cache: MISS
  │       non-GET: proxy directly, redirect: manual
  └─ 5. Error handling
          Connection error → 503 { error: 'Service unavailable' }
          5xx from origin  → same status, generic JSON body (origin URL never exposed)
```

---

## Features

### Rate Limiting

Three tiers evaluated in order. Counters stored in `RATE_LIMIT_KV`, keyed by `<datacenter>:<ip>`.

| Tier | Path match | Limit | Block duration |
|---|---|---|---|
| Auth | `/api/v1/token/` | 5 req / 60s | 10 min |
| Browse | `/api/v1/listings/` or `/api/v1/articles/` | 30 req / 60s | 5 min |
| Fallback | all `api.specialneeds.com/*` | 60 req / 60s | 5 min |

Returns `429 Too Many Requests` with `Retry-After` header. No Cloudflare challenge pages — API clients are JSON consumers.

---

### Two-Tier Caching

GET requests only. Cache key is a SHA-256 hash of the normalized URL (sorted query params, no fragment).

**L1 — Cache API (`caches.default`)**
- Per Cloudflare PoP (datacenter)
- Fast in-memory lookup
- Respects `Cache-Control: max-age` from origin response
- Cleared per-PoP on invalidation (best-effort)

**L2 — KV (`CACHE_KV`)**
- Global, replicated across all PoPs
- No expiry — entries live permanently until explicitly deleted via invalidation
- Cleared globally on invalidation

**Stale-if-error:** If the origin is unreachable (connection error), the Worker serves the L2 KV value rather than returning an error. The backend being down does not surface to users as long as a cached version exists.

**Cache-Control passthrough:** The origin's `Cache-Control` header sets the L1 TTL. If Django sends `no-store`, `private`, or `no-cache`, the response is not cached.

**Response header:** `X-Cache: HIT | KV-HIT | MISS | STALE-ERROR`

---

### Full-Chain Cache Invalidation

Endpoints on `/v1/cache?url=<encoded-url>`:

| Method | Auth | Purpose |
|--------|------|---------|
| `HEAD` | No | Check if URL exists in KV (200=cached, 404=not) |
| `PUT` | Yes | Push response body into KV (no TTL = permanent). Used by cache warming. |
| `DELETE` | Yes | Full-chain invalidation (see below) |

Auth: `X-Sn-Service-Token: <CACHE_MGMT_TOKEN>`

On DELETE, the Worker:
1. Deletes from KV (`CACHE_KV`) — global, synchronous
2. Deletes from Cache API (`caches.default`) — current PoP, synchronous
3. `ctx.waitUntil()` → Cloudflare Zone API purge by URL (clears CF CDN edge cache globally)
4. `ctx.waitUntil()` → `POST https://www.specialneeds.com/api/admin/revalidate/` (triggers Next.js ISR)

Steps 3 and 4 are fire-and-forget — the Worker returns `200 OK` immediately. CF CDN purge and ISR revalidation happen in the background.

**Who calls this:** Django's `invalidate_frontend_cache` Celery task. Triggered from `post_save` and `post_delete` signals on `Article` and `Listing` models whenever content is published, updated, or deleted.

**Frontend URL patterns invalidated:**
- Articles: `https://www.specialneeds.com/articles/<category>/<slug>`
- Listings: `https://www.specialneeds.com/listings/<slug>`

---

### General-Purpose KV Store

Replaces `cache.specialneeds.com` — a Redis wrapper that was co-located with the origin (if origin went down, cache went down too). KV is edge-distributed with Cloudflare's SLA, fully decoupled from origin health.

```
GET    /v1/cache/:key              — public, no auth required
PUT    /v1/cache/:key?ttl=<sec>   — requires X-Sn-Service-Token: <CACHE_MGMT_TOKEN>
DELETE /v1/cache/:key              — requires X-Sn-Service-Token: <CACHE_MGMT_TOKEN>
```

Key format: URL path segments map to colon-separated KV keys.
`/v1/cache/geocache/tampa-fl` → KV key `geocache:tampa-fl`

---

### Origin Hardening

Every request the Worker forwards to Django includes:

```
x-worker-origin-secret: <WORKER_ORIGIN_SECRET>
```

Django's `CustomServerAuthMiddleware` validates this header when the waffle switch `require_origin_secret` is active. Requests missing or with an incorrect value return `403` immediately.

**Result:** Direct requests to the Coolify/sslip.io origin URL return 403. The Worker is the only viable path.

**Bypassed paths** (exempt from enforcement — origin must be reachable directly for these):
- `/health/` — Coolify health checks
- `/admin/` — Django admin
- `/api/v1/token/` and token refresh endpoints
- `/static/`, `/favicon.ico`

**Rollback (instant, no deploy):** Django admin → Waffle → Switches → `require_origin_secret` → uncheck Active → Save.

---

### Origin Error Concealment

Cloudflare's 504 error page exposes the upstream hostname in its error UI. To prevent the Coolify/sslip.io URL and server IP from being leaked:

- `proxyToOrigin()` wraps the fetch in try/catch — connection errors return `503 { error: 'Service unavailable' }` from the Worker, never reaching Cloudflare's error handler
- Any `response.status >= 500` from origin is intercepted before the final response — returned as generic JSON with no origin details

The origin URL is never visible in any error response.

---

## Token Model

Three separate credentials with distinct directions and purposes:

| Token | Direction | Django env var | Worker secret |
|---|---|---|---|
| `SERVER_TO_SERVER_TOKEN` | Internal services → Django | `SERVER_TO_SERVER_TOKEN` | — |
| `CACHE_MGMT_TOKEN` | Callers → Worker `/v1/cache/*` | `CACHE_MGMT_TOKEN` | `CACHE_MGMT_TOKEN` |
| `WORKER_ORIGIN_SECRET` | Worker → Django | `CLOUDFLARE_WORKER__AUTH_KEY_SECRET` | `WORKER_ORIGIN_SECRET` |

`SERVER_TO_SERVER_TOKEN` is the existing general-purpose backend credential used by Celery tasks and internal scripts. It is never touched by this Worker.

---

## Worker Secrets (Wrangler)

| Secret | Purpose |
|---|---|
| `CACHE_MGMT_TOKEN` | Authenticates inbound cache management requests |
| `WORKER_ORIGIN_SECRET` | Injected into every origin request to prove it came through the Worker |
| `CF_API_TOKEN` | Cloudflare Zone API — purges CDN cache on invalidation |
| `REVALIDATE_SECRET` | Authenticates Next.js ISR revalidation calls |

---

## KV Namespaces

| Binding | Purpose |
|---|---|
| `RATE_LIMIT_KV` | Rate limit counters (short TTL, per-IP per-datacenter) |
| `CACHE_KV` | Cached API responses + general-purpose KV store |
| `CROWDSEC_KV` | CrowdSec ban list — keys are IP addresses, values are `ban` or `captcha`. Shared with CrowdSec's Cloudflare Worker bouncer. |

---

## Response Headers Added by Worker

| Header | Value |
|---|---|
| `X-Cache` | `HIT`, `KV-HIT`, `MISS`, or `STALE-ERROR` |
| `X-Worker-Response-Time` | Milliseconds from Worker entry to response |

---

## Django Integration Points

| Signal | Task | What it does |
|---|---|---|
| `Article` post_save | `invalidate_frontend_cache.delay(url)` | ISR revalidation for frontend URL |
| `Article` post_save | `invalidate_api_cache.delay(urls)` | KV DELETE for all affected API URLs (display + aggregates) |
| `Article` post_save | `warm_article_api_cache.apply_async(countdown=5)` | KV PUT with fresh response 5s after invalidation |
| `Listing` post_save | Same three tasks | Same pattern for listings |
| Scanner request | `ban_scanner_ip.delay(ip)` | Writes IP to `CROWDSEC_KV` for immediate blocking |

Tasks in `core.tasks`: `invalidate_frontend_cache`, `invalidate_api_cache`, `warm_article_api_cache`, `warm_listing_api_cache`, `ban_scanner_ip`
Queue: `low_priority`. Fire-and-forget — failures are logged, never propagate to the save.
All skip in development (`skip_run=lambda: settings.ENV == "development"`).

---

## Files

| File | Responsibility |
|---|---|
| `src/index.ts` | Entry point, request routing, `proxyToOrigin()`, error handling |
| `src/cache.ts` | `checkCache()`, `fetchAndCache()`, cache key generation |
| `src/kv-endpoint.ts` | `/v1/cache/*` handler, CF CDN purge, ISR revalidation |
| `src/ratelimit.ts` | Rate limit counters and tier logic |
| `wrangler.jsonc` | Worker config, KV bindings, route |

---

## Deployment

```bash
cd cloudflare/workers/api-gateway
source ~/.nvm/nvm.sh && nvm use 20
wrangler deploy
```

Or via `/deploy prod` from the infrastructure repo root (registered in `~/.claude/deploy-registry.json`).

---

## What's Pending

**Phase 6 — Retire `cache.specialneeds.com`**
- Burn-in period started: 2026-04-05
- Minimum 1 week before decommission
- Sole confirmed remaining consumer: geo-ip lookup service
- Action: remove Coolify service + DNS record from Terraform once all consumers migrated

See `docs/implementation/phase-6-retire-cache-server.md` for the plan.
