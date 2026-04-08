# Phase 4 — API Gateway Worker: Cache Invalidation + General KV Endpoint

**Status: Complete ✅**

## What This Phase Does

The Worker is the **central cache control layer** for the entire platform. Any service — Django, scripts, client-side admin — calls a single endpoint to invalidate or manage cache. The Worker fans out to all layers so callers don't have to know about the internals.

Two endpoints, both backed by `CACHE_KV`:

1. **Full-chain cache invalidation** — `DELETE /v1/cache?url=<url>` clears every cache layer for a given URL. Django calls this once on publish/update/delete.
2. **General KV store** — `GET|PUT|DELETE /v1/cache/:key` replaces `cache.specialneeds.com` (Redis wrapper co-located with the origin — fails when origin is down).

## What Was Done in Previous Phases

- **Phase 1:** Worker passthrough, route confirmed
- **Phase 2:** Three-tier KV rate limiting, native CF rule removed
- **Phase 3:** Two-tier caching (Cache API L1 + KV L2), stale-if-error, 7-day KV TTL

## Cache Layers

| Layer | Key format | Scope | How we clear it |
|---|---|---|---|
| Worker L1 (`caches.default`) | `https://cache.internal/<sha256>` | Current PoP only | `caches.default.delete()` |
| Worker L2 KV (`CACHE_KV`) | SHA-256 hex of URL | Global | `kv.delete()` |
| Cloudflare CDN | Request URL | Global | CF Zone API purge by URL |
| Next.js ISR + Redis | Path as `isr:<colon-separated>` | Per server | `POST /api/admin/revalidate/` |

L1 and L2 are cleared synchronously. CF CDN and Next.js ISR are fire-and-forget via `ctx.waitUntil()` — the Worker returns `OK` immediately and the slow network calls happen in the background.

## Endpoint Design

### Full-chain invalidation

```
DELETE /v1/cache?url=<encoded-url>
X-Sn-Service-Token: <CACHE_MGMT_TOKEN>
```

Worker does on every call:
1. Delete from KV (L2 — global, immediate)
2. `caches.default.delete()` (L1 — current PoP, best-effort)
3. `ctx.waitUntil()` → CF Zone API purge by URL
4. `ctx.waitUntil()` → `POST www.specialneeds.com/api/admin/revalidate/` with `{ paths: ["/extracted/path"] }` and `X-Revalidate-Token`

The path for Next.js is extracted from the URL param — e.g. `https://www.specialneeds.com/articles/some-slug` → `/articles/some-slug`.

**Note:** The revalidate URL requires a trailing slash. Without it Django returns a 308 redirect, the POST body is dropped, and ISR fails silently.

### General KV store

```
GET    /v1/cache/:key              — public, no auth
PUT    /v1/cache/:key?ttl=<sec>   — requires X-Sn-Service-Token
DELETE /v1/cache/:key              — requires X-Sn-Service-Token
```

Key separator: `/` in URL path is stored as `:` in KV (e.g. `/v1/cache/geocache/tampa-fl` → key `geocache:tampa-fl`).

## Auth

All write operations use `X-Sn-Service-Token` with the `CACHE_MGMT_TOKEN` secret. This is a dedicated token for cache management — separate from `SERVER_TO_SERVER_TOKEN` (Django internal auth) and `WORKER_ORIGIN_SECRET` (Worker → Django origin hardening, Phase 5).

## Secrets

| Secret | Wrangler name | Status |
|---|---|---|
| Cache management token (callers → Worker) | `CACHE_MGMT_TOKEN` | ✅ Provisioned |
| Cloudflare API token (cache purge permission) | `CF_API_TOKEN` | ✅ Provisioned |
| Next.js revalidate secret | `REVALIDATE_SECRET` | ✅ Provisioned |

Zone ID is a constant — no secret needed: `3df33cbd8f514275c7074407989b5b12`

Next.js revalidate endpoint: `https://www.specialneeds.com/api/admin/revalidate/` (trailing slash required)

## Django Integration

Django's `post_save` and `post_delete` signals for `Article` and `Listing` models call `invalidate_frontend_cache.delay(frontend_url)` via Celery. The task hits `DELETE https://api.specialneeds.com/v1/cache?url=<encoded-url>` with `X-Sn-Service-Token: <CACHE_MGMT_TOKEN>`.

Frontend URL patterns:
- Articles: `https://www.specialneeds.com/articles/<category>/<slug>` (slug already includes category)
- Listings: `https://www.specialneeds.com/listings/<slug>`

The task is fire-and-forget — failures are logged but do not block the save.

## Files

| File | Change |
|---|---|
| `src/cache.ts` | Export `cacheKey()` |
| `src/kv-endpoint.ts` | Full-chain invalidation + CF CDN purge + ISR revalidation |
| `src/index.ts` | `CACHE_MGMT_TOKEN` in `Env`, short-circuit before rate limit |
| Django `core/tasks/cache_invalidation.py` | `invalidate_frontend_cache` Celery task |
| Django `articles/signals.py` | `post_save`/`post_delete` fire `invalidate_frontend_cache` |
| Django `listings/signals.py` | `post_save`/`post_delete` fire `invalidate_frontend_cache` |

## Request Flow

```
Request arrives
→ DELETE /v1/cache?url=...  or  /v1/cache/:key
  → handleKvEndpoint() → short-circuits, skips rate limit + cache + proxy
→ all other paths → rate limit → cache → proxy to origin (unchanged)
```

## Migrating from cache.specialneeds.com

**Old pattern:**
```
GET  http://cache.specialneeds.com/get?key=geocache:tampa-fl
POST http://cache.specialneeds.com/set  { key, value, ttl }
POST http://cache.specialneeds.com/del  { key }
```

**New pattern:**
```bash
# Read (public, no auth)
GET https://api.specialneeds.com/v1/cache/geocache/tampa-fl

# Write
PUT https://api.specialneeds.com/v1/cache/geocache/tampa-fl?ttl=3600
  X-Sn-Service-Token: <CACHE_MGMT_TOKEN>
  Body: <json value>

# Delete
DELETE https://api.specialneeds.com/v1/cache/geocache/tampa-fl
  X-Sn-Service-Token: <CACHE_MGMT_TOKEN>
```

## Gate — Complete

- [x] Cache invalidation: MISS → HIT → invalidate → MISS cycle confirmed
- [x] Unauthorized invalidation returns 403
- [x] General KV: GET/PUT/DELETE round-trip confirmed
- [x] Unauthorized PUT/DELETE returns 403
- [x] `X-Worker-Response-Time` present on all KV endpoint responses
- [x] `CF_API_TOKEN` provisioned and CF CDN purge wired into invalidation
- [x] `REVALIDATE_SECRET` provisioned and Next.js ISR revalidation wired into invalidation
- [x] Full-chain verified: single invalidation call clears L1, L2, CF CDN, and Next.js ISR
- [x] Django `post_save`/`post_delete` signals fire `invalidate_frontend_cache` for Article and Listing
- [x] All consumers of `cache.specialneeds.com` identified (geo-ip lookup confirmed as sole remaining consumer)

## What's Next

Phase 5 — origin hardening (complete). Phase 6 — retire `cache.specialneeds.com` after 1-week burn-in.
