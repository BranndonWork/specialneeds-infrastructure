# Phase 5 — API Gateway Worker: Origin Hardening

**Status: Complete ✅**

## Problem Statement

The Worker is the intended public surface for `api.specialneeds.com`, but the Django origin is still directly reachable via its Coolify/sslip.io URL. Anyone who finds it can bypass the Worker entirely, bypassing rate limiting, caching, and all security logic.

This phase makes the Worker the only viable path by requiring a secret header on every request to origin. Additionally, the Worker now intercepts all 5xx responses and connection errors — returning a generic error rather than letting Cloudflare's error page expose the origin hostname.

## Token Model

Three separate credentials — each with a distinct direction and purpose:

| Token | Direction | Purpose |
|---|---|---|
| `SERVER_TO_SERVER_TOKEN` | Internal services → Django | Existing general-purpose backend credential (Celery, scripts). Bypasses CSRF. Left untouched. |
| `CACHE_MGMT_TOKEN` | Callers → Worker `/v1/cache/*` | Authorizes cache management operations. Replaces `SN_SERVICE_TOKEN`. |
| `WORKER_ORIGIN_SECRET` | Worker → Django | Proves request came through the Worker. Django 403s anything missing it. |

## What Was Done in Previous Phases

- **Phase 1:** Worker passthrough, route confirmed
- **Phase 2:** Three-tier KV rate limiting, native CF rule removed
- **Phase 3:** Two-tier caching, stale-if-error
- **Phase 4:** Full-chain cache invalidation, Django signals, all consumers identified

## What This Phase Does

**Worker (`src/index.ts`, `src/cache.ts`):**
- `proxyToOrigin()` injects `x-worker-origin-secret` header on every origin request
- `fetchAndCache()` injects `x-worker-origin-secret` header on every origin fetch
- Both functions catch connection errors and return `{ error: 'Service unavailable' }` (503) instead of throwing
- All 5xx responses from origin are intercepted and returned as generic JSON — origin hostname never reaches Cloudflare's error page handler

**Django (`specialneeds/middlewares/auth.py`):**
- When waffle switch `require_origin_secret` is active, checks `x-worker-origin-secret` header
- Missing or incorrect value → 403
- Bypassed paths (health, admin, token endpoints) are exempt

## Env Vars (Coolify `sn-django`)

| Var | Value |
|---|---|
| `CLOUDFLARE_WORKER__AUTH_HEADER_KEY` | `x-worker-origin-secret` |
| `CLOUDFLARE_WORKER__AUTH_KEY_SECRET` | `<WORKER_ORIGIN_SECRET value>` |

## Worker Secrets

| Secret | Wrangler name |
|---|---|
| Cache management token | `CACHE_MGMT_TOKEN` |
| Worker → Django origin secret | `WORKER_ORIGIN_SECRET` |

`SN_SERVICE_TOKEN` was deleted and replaced by the two tokens above.

## Bypassed Paths (no enforcement even with switch on)

- `/health/` — Coolify health checks call origin directly
- `/admin/` — Django admin
- `/api/v1/token/` and token refresh endpoints
- `/static/`, `/favicon.ico`

## Origin Leak Prevention

Cloudflare's 504 error page exposes the upstream hostname (e.g. `u84kg8wkkowgw0ook4ggg8sk.46.224.10.193.sslip.io`) when the Worker throws an unhandled exception on origin timeout.

Fix in `src/index.ts`:
1. `proxyToOrigin()` wrapped in try/catch — connection errors return clean 503
2. Any `response.status >= 500` from either proxy path is intercepted before the final `new Response()` — returns `{ error: 'Service unavailable' }` with the same status code

The origin URL is never forwarded to Cloudflare's error handler.

## Rollback

Instant, no deploy: Django admin → Waffle → Switches → `require_origin_secret` → uncheck Active → Save.

## Verification

```bash
# Via Worker — must return 200
curl -si "https://api.specialneeds.com/api/v1/listings/?limit=1" | grep "^HTTP"

# Direct origin — must return 403
curl -si "https://<coolify-sslip-url>/api/v1/listings/?limit=1" | grep "^HTTP"

# Health check direct — must return 200 (Coolify stays healthy)
curl -si "https://<coolify-sslip-url>/health/" | grep "^HTTP"

# Admin direct — must return 200 (bypass working)
curl -si "https://<coolify-sslip-url>/admin/" | grep "^HTTP"
```

## Gate — Complete

- [x] Direct origin request returns 403 (switch on)
- [x] All Worker-proxied requests return correct responses
- [x] Django admin (`/admin/`) accessible directly (bypass working)
- [x] Django health check (`/health/`) accessible directly (Coolify health checks passing)
- [x] Token auth flow unaffected (admin panel login works)
- [x] Coolify shows `sn-django` as healthy
- [x] Worker catches connection errors — no Cloudflare error page with origin hostname exposed
- [x] Worker intercepts 5xx — returns generic JSON, origin URL never leaked

## What's Next

Phase 6 — retire `cache.specialneeds.com`. Remove Coolify service and DNS record after 1-week burn-in from Phase 4 completion (minimum burn-in start: 2026-04-05).
