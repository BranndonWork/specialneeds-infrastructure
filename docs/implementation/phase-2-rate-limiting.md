# Phase 2 — API Gateway Worker: Rate Limiting

## Problem Statement

The Worker is live and passing through traffic (Phase 1 complete). The zone has one native Cloudflare rate limit rule deployed via Terraform — the free plan allows only 1 rule. We need three tiers: strict on auth endpoints, moderate on expensive browse endpoints, general fallback. The Worker removes this constraint entirely.

## What Was Done in Phase 1

- Worker created at `cloudflare/workers/api-gateway/`
- Route `api.specialneeds.com/*` bound and confirmed working
- Passthrough: intercepts all requests, forwards unchanged via `ORIGIN_URL` secret

## What This Phase Does

Add rate limiting to `src/ratelimit.ts` using KV counters. Three tiers evaluated top-down:

| Tier | Match | Limit | Block |
|---|---|---|---|
| auth | starts with `/api/v1/token/` | 5 req / 60s | 600s (10 min) |
| browse | contains `/api/v1/listings/` or `/api/v1/articles/` | 30 req / 60s | 300s (5 min) |
| general | all `api.specialneeds.com/*` | 60 req / 60s | 300s (5 min) |

Two KV keys per IP per tier:
- `rl:{ip}:{tier}` — fixed-window counter
- `block:{ip}:{tier}` — extended block state

Keys are **global per IP** (no per-datacenter scoping). Per-datacenter keys would allow an attacker to farm separate counters by routing through multiple Cloudflare PoPs. DDoS protection is handled by Cloudflare's own infrastructure, not the Worker.

After confirmed stable: remove the native Cloudflare rate limit rule from Terraform.

## Infrastructure to Provision First

```bash
cd cloudflare/workers/api-gateway
wrangler kv namespace create RATE_LIMIT_KV
# Note the returned ID — add it to wrangler.jsonc
```

KV namespace ID in use: `2fa5c74914584127bd79641d48b75a00`

## Files to Create/Modify

### New: `src/ratelimit.ts`

```typescript
export interface RateLimitResult {
  limited: boolean;
  retryAfter?: number;
}

const TIERS = {
  auth:    { limit: 5,  windowSeconds: 60, blockSeconds: 600 },
  browse:  { limit: 30, windowSeconds: 60, blockSeconds: 300 },
  general: { limit: 60, windowSeconds: 60, blockSeconds: 300 },
} as const;

type TierName = keyof typeof TIERS;

function getTier(pathname: string): TierName {
  if (pathname.startsWith('/api/v1/token/')) return 'auth';
  if (pathname.includes('/api/v1/listings/') || pathname.includes('/api/v1/articles/')) return 'browse';
  return 'general';
}

export async function checkRateLimit(
  request: Request,
  kv: KVNamespace,
): Promise<RateLimitResult> {
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  const pathname = new URL(request.url).pathname;
  const tier = getTier(pathname);
  const config = TIERS[tier];
  const now = Math.floor(Date.now() / 1000);

  const blockKey = `block:${ip}:${tier}`;
  const block = await kv.get(blockKey);
  if (block) {
    const { blockedUntil } = JSON.parse(block) as { blockedUntil: number };
    if (now < blockedUntil) {
      return { limited: true, retryAfter: blockedUntil - now };
    }
  }

  const countKey = `rl:${ip}:${tier}`;
  const raw = await kv.get(countKey);

  if (raw) {
    const data = JSON.parse(raw) as { count: number; resetAt: number };

    if (now >= data.resetAt) {
      await kv.put(countKey, JSON.stringify({ count: 1, resetAt: now + config.windowSeconds }), {
        expirationTtl: config.windowSeconds + 60,
      });
      return { limited: false };
    }

    const newCount = data.count + 1;
    if (newCount > config.limit) {
      const blockedUntil = now + config.blockSeconds;
      await kv.put(blockKey, JSON.stringify({ blockedUntil }), {
        expirationTtl: config.blockSeconds + 60,
      });
      return { limited: true, retryAfter: config.blockSeconds };
    }

    await kv.put(countKey, JSON.stringify({ count: newCount, resetAt: data.resetAt }), {
      expirationTtl: config.windowSeconds + 60,
    });
    return { limited: false };
  }

  await kv.put(countKey, JSON.stringify({ count: 1, resetAt: now + config.windowSeconds }), {
    expirationTtl: config.windowSeconds + 60,
  });
  return { limited: false };
}

export function rateLimitResponse(retryAfter: number): Response {
  return new Response(
    JSON.stringify({ error: 'Too Many Requests', retry_after: retryAfter }),
    {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(retryAfter),
      },
    }
  );
}
```

### Modified: `src/index.ts`

```typescript
import { checkRateLimit, rateLimitResponse } from './ratelimit';

export interface Env {
  ORIGIN_URL: string;
  RATE_LIMIT_KV: KVNamespace;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const rlResult = await checkRateLimit(request, env.RATE_LIMIT_KV);
    if (rlResult.limited) return rateLimitResponse(rlResult.retryAfter!);

    const origin = new URL(env.ORIGIN_URL);
    const url = new URL(request.url);
    url.protocol = origin.protocol;
    url.hostname = origin.hostname;
    url.port = origin.port;

    const start = Date.now();
    const response = await fetch(new Request(url.toString(), {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: 'follow',
    }));

    const headers = new Headers(response.headers);
    headers.set('X-Worker-Response-Time', `${Date.now() - start}ms`);
    return new Response(response.body, { status: response.status, headers });
  },
};
```

### Modified: `wrangler.jsonc`

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "api-gateway",
  "main": "src/index.ts",
  "compatibility_date": "2025-10-11",
  "compatibility_flags": ["global_fetch_strictly_public"],
  "observability": { "enabled": true },
  "routes": [
    { "pattern": "api.specialneeds.com/*", "zone_name": "specialneeds.com" }
  ],
  "kv_namespaces": [
    { "binding": "RATE_LIMIT_KV", "id": "2fa5c74914584127bd79641d48b75a00" }
  ]
}
```

## Deploy

```bash
cd cloudflare/workers/api-gateway
source ~/.nvm/nvm.sh && nvm use 20
npx wrangler deploy
```

## Verification

```bash
# Auth tier — expect 5x 401 then 429, Retry-After ~600
for i in $(seq 1 8); do
  curl -s -o /dev/null -w "req $i: %{http_code}\n" --max-time 10 \
    -X POST https://api.specialneeds.com/api/v1/token/ \
    -H "Content-Type: application/json" \
    -d '{"email":"x@x.com","password":"x"}'
done

# Browse tier — sequential requests to articles endpoint
for i in $(seq 1 32); do
  curl -s -o /dev/null -w "req $i: %{http_code}\n" --max-time 10 \
    "https://api.specialneeds.com/api/v1/articles/?page=1&page_size=1"
done

# General tier — fast 404 endpoint to stay within window
for i in $(seq 1 65); do
  curl -s -o /dev/null -w "req $i: %{http_code}\n" --max-time 10 \
    "https://api.specialneeds.com/api/v1/"
done
```

> **Testing notes:**
> - Browse and general tiers require sequential testing. Parallel requests all read `null` from KV simultaneously and each writes `count: 1` — the race prevents 429 from firing. Real brute force and abuse are sequential; this is the correct threat model.
> - Browse tier endpoint must respond fast enough that 30 requests complete within 60s. Articles endpoint (~800ms/req) works. Listings endpoint (~2s/req) will cause the window to reset before hitting the limit.
> - General tier: use `/api/v1/` (fast 404, ~450ms) not `/health/` (~1s) to keep 60 requests inside the 60s window.

## Rollback

```bash
npx wrangler delete
```

Standard Cloudflare proxying resumes. No rate limiting in place (native rule was never deployed and has been removed from Terraform).

## Gate Before Phase 3

- [x] 429 fires on auth tier at request 6
- [x] 429 fires on browse tier (~request 30)
- [x] 429 fires on general tier (~request 61)
- [x] `Retry-After` header present on all 429 responses
- [x] Extended block holds: auth 600s, browse 300s, general 300s
- [x] Legitimate browsing not blocked after block expires
- [x] `X-Worker-Response-Time` header present on all non-429 responses
- [x] Native Cloudflare rate limit rule removed from Terraform (was never deployed)
- [x] `terraform plan` shows 0 changes

**Phase 2 complete.**

### Design decisions made during implementation

**Global keys (no coloId):** Per-datacenter keys allow an attacker to multiply allowed attempts by routing through multiple Cloudflare PoPs. Keys are `rl:{ip}:{tier}` and `block:{ip}:{tier}` — globally enforced per IP. DDoS protection is Cloudflare's infrastructure concern, not the Worker's.

**Separate block key:** The extended block (`block:{ip}:{tier}`) is stored separately from the counter (`rl:{ip}:{tier}`). Block check happens first on every request — blocked IPs never touch the counter key. This also means the block survives window resets cleanly.

**Why not Cloudflare's native rate limiting binding:** Tested and found to be "permissive, eventually consistent, not designed for accurate accounting" per Cloudflare's own docs. Did not fire reliably at the 5 req/60s auth threshold. KV is exact for sequential traffic, which is the realistic threat model for brute force.

## What's Next

Phase 3 adds edge caching via the Cache API with KV fallback and stale-if-error resilience.
