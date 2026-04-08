# Phase 3 — API Gateway Worker: Two-Tier Caching + Stale-if-Error

## What This Phase Does

Two-tier caching (Cache API + KV) with stale-if-error resilience. Django's `Cache-Control` headers are fully respected — TTL, `no-store`, `private`. No Durable Objects (coalescing removed — not needed at current scale).

| Layer | Storage | Scope | TTL |
|---|---|---|---|
| L1 | Cache API (`caches.default`) | Per-PoP, in-memory | Django's `max-age` |
| L2 | KV (`CACHE_KV`) | Global, persistent | `max(max-age × 12, 604800)` — minimum 7 days |

### What is cached

- **GET requests only.** POST/PUT/DELETE/PATCH pass through to origin unchanged.
- **Authenticated GET requests ARE cached.** Public list endpoints (`/api/v1/listings/`, `/api/v1/articles/`, etc.) return the same response regardless of auth state. Authenticated and unauthenticated users share the same cache entry.
- **User-specific responses are NOT cached** — Django signals this via `Cache-Control: private` or `no-store`. The Worker respects those headers and never stores the response.
- **4xx responses are not cached.** Only 2xx responses are stored.

### Why authenticated GETs are cached

The original implementation skipped cache for any request with an `Authorization` header. This was overly conservative. Django controls what is and isn't cacheable via `Cache-Control: private` for user-specific endpoints. The Worker trusts those headers — not the presence of an auth header — to determine cacheability. Skipping cache on all authenticated GETs means authenticated users always hit origin for public list data, defeating the purpose of caching.

### Cache-Control handling

Django's response headers are the authority:

| Django sends | Worker behavior |
|---|---|
| `Cache-Control: public, max-age=3600` | Cache in L1 (3600s) + L2 (7 days) |
| `Cache-Control: private` | Do not cache, pass through |
| `Cache-Control: no-store` | Do not cache, pass through |
| `Cache-Control: no-cache` | Do not cache, pass through |
| No `Cache-Control` | Cache with 300s default TTL |

### Stale-if-error

When origin is unreachable (connection failure), the Worker checks L2 (KV) for a stale response. If found, returns it with `X-Cache: STALE-ERROR`. KV entries persist for at minimum 7 days — backend can be fully down for 7 days and users still see cached content for previously-visited pages.

### Request flow

```
GET request arrives
→ compute cache key (SHA-256 hash of normalized URL — sorted query params, no fragment)
→ L1: caches.default.match() → hit: return, X-Cache: HIT
  (Cache API enforces TTL — a match() hit is always fresh)
→ L1 miss → L2: kv.get(key) → hit: repopulate L1 async, return, X-Cache: KV-HIT
→ L1+L2 miss: fetch origin (no timeout — origin is slow, that's why caching exists)
  → 2xx + cacheable: store L1 + L2, return, X-Cache: MISS
  → 2xx + not cacheable (private/no-store): pass through, no storage
  → 4xx: pass through, no storage
  → connection failure + KV has data: serve KV data, X-Cache: STALE-ERROR
  → connection failure + no KV: 503

POST/PUT/DELETE/PATCH → skip cache entirely, proxy to origin
```

## Infrastructure

```bash
cd cloudflare/workers/api-gateway
source ~/.nvm/nvm.sh && nvm use 20
npx wrangler kv namespace create CACHE_KV
```

KV namespace ID in use: `9c21ddcb4d4b4577af54fd6e4f4148c8`

## Files

| File | Change |
|---|---|
| `src/cache.ts` | Created |
| `src/index.ts` | Updated — cache layer wired in, `proxyToOrigin` helper extracted |
| `wrangler.jsonc` | Updated — `CACHE_KV` binding added |

## Response headers

| Header | Value | When |
|---|---|---|
| `X-Cache` | `MISS` | Origin fetched, response now cached |
| `X-Cache` | `HIT` | Served from Cache API (L1) |
| `X-Cache` | `KV-HIT` | Served from KV (L2), L1 repopulated async |
| `X-Cache` | `STALE-ERROR` | Origin down, served from KV stale data |
| `X-Worker-Response-Time` | e.g. `174ms` | All responses |

## Rollback

```bash
npx wrangler delete
```

KV cache data orphaned but harmless. Cache API drains on TTL. No Django changes needed.

## Gate Before Phase 4

- [x] `X-Cache: MISS` on first request to a fresh URL
- [x] `X-Cache: HIT` on second request to same URL (174ms vs 3s+ origin)
- [x] Django's `Cache-Control` headers respected — `max-age=3600` used, not hardcoded 300s
- [x] `private`/`no-store` responses not cached
- [x] Authenticated GET requests served from cache (same entry as anonymous)
- [x] POST requests pass through, not cached
- [x] `X-Worker-Response-Time` present on all responses
- [x] 7-day KV stale TTL — backend can be down for a week, cached content still served
- [ ] `X-Cache: KV-HIT` — verify after 1hr (L1 TTL expires, L2 still warm)
- [ ] `X-Cache: STALE-ERROR` — verify when origin is down

## What's Next

Phase 4 — cache invalidation endpoint + general KV store. Django calls the Worker to bust specific cache entries on publish/update/delete (makes the 7-day TTL safe). Also replaces `cache.specialneeds.com` with a KV-backed endpoint at the edge.
