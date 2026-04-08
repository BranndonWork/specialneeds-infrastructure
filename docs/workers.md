# Deployed Workers

## api-gateway

**Location:** `cloudflare/workers/api-gateway/`
**Language:** TypeScript
**Route:** `api.specialneeds.com/*`

**Purpose:** Primary API gateway for all traffic to `api.specialneeds.com`. Handles rate limiting, two-tier caching, full-chain cache invalidation, general-purpose KV store, and origin hardening. The Django origin is unreachable without going through this Worker.

See **[api-gateway.md](api-gateway.md)** for full as-built reference.

---

## meilisearch-proxy (Production)

**Location:** `cloudflare/workers/meilisearch-proxy/`
**Language:** TypeScript
**Route:** `search.specialneeds.com`

**Purpose:** Proxies search requests from client-side to production Meilisearch instance hosted on Hetzner

**Implementation Details:**
- Source: `cloudflare/workers/meilisearch-proxy/src/index.ts:1`
- CORS-enabled (allows all origins)
- Health check endpoint at `/health`
- Only allows requests to `/indexes/*` paths
- Injects `MEILI_SEARCH_KEY` from secrets into Authorization header
- Caches successful searches for 5 minutes (`max-age=300`)
- Returns 503 if Meilisearch is unavailable

**Environment Variables:**
- `MEILI_HOST`: Meilisearch server URL (set in wrangler.jsonc)
- `MEILI_SEARCH_KEY`: API key (secret, set via `wrangler secret put`)

## meilisearch-proxy-staging (Staging)

**Location:** `cloudflare/workers/meilisearch-proxy-staging/`
**Language:** TypeScript
**Route:** `staging-search.specialneeds.com`

**Purpose:** Proxies search requests from client-side to staging Meilisearch instance hosted on Hetzner

**Implementation Details:**
- Identical to production meilisearch-proxy
- Routes to staging-search.specialneeds.com
- Points to staging Meilisearch instance

**Environment Variables:**
- `MEILI_HOST`: Staging Meilisearch server URL (set in wrangler.jsonc)
- `MEILI_SEARCH_KEY`: Staging API key (secret, set via `wrangler secret put`)

## special-needs

**Location:** `cloudflare/workers/special-needs/`
**Language:** JavaScript
**R2 Buckets:** PROD_BUCKET, PROD_LOG_BUCKET, DEV_BUCKET, DEV_LOG_BUCKET

**Purpose:** R2 bucket access layer with authentication for file storage

**Implementation Details:**
- Source: `cloudflare/workers/special-needs/src/index.js:1`
- Serves files from R2 buckets with GET/PUT/DELETE operations
- Public read access for files in `public/` directory
- Authenticated access required for all writes and non-public reads
- Returns 304 Not Modified when appropriate (If-Modified-Since, If-None-Match)
- Supports TTL-based expiration via custom metadata
- Logs errors to separate R2 log bucket
- Uses `x-specialneeds-env` header to route to prod/dev buckets

**Authentication:**
- Requires custom header authentication (AUTH_HEADER_KEY/AUTH_KEY_SECRET)
- PUT/DELETE: Always requires authentication
- GET: Public for `public/*` paths, otherwise requires auth

**HTTP Operations:**
- GET: Retrieve objects from R2
- PUT: Upload objects to R2
- DELETE: Remove objects from R2
- Returns appropriate status codes (200, 201, 204, 304, 403, 404, 405)
