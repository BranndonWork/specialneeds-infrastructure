# Phase 1 — API Gateway Worker: Passthrough

## Problem Statement

`api.specialneeds.com` routes directly through Cloudflare to the Django origin with no Worker in the path. We are building a Cloudflare Worker API gateway that will eventually handle rate limiting, caching, JWT parsing, and origin hardening. Phase 1 establishes the Worker infrastructure and confirms it intercepts and forwards traffic correctly — no logic yet.

This is the foundation everything else builds on.

## Context

Full design rationale and rollback strategy:
- `specialneeds-infrastructure/docs/api-gateway-worker-design.md`
- `specialneeds-infrastructure/terraform/docs/api-client-readiness-audit.md`

Existing Workers to reference for patterns:
- `cloudflare/workers/meilisearch-proxy/` — TypeScript, JSONC wrangler config, CORS, proxy pattern

## What This Phase Does

Create a new TypeScript Worker at `cloudflare/workers/api-gateway/`. The Worker intercepts all requests to `api.specialneeds.com/*` and proxies them to the Django origin unchanged — same method, headers, body, response. Functionally identical to current Cloudflare→origin routing.

## Files to Create

```
cloudflare/workers/api-gateway/
├── src/index.ts
├── wrangler.jsonc
├── package.json
└── tsconfig.json
```

Copy `package.json` and `tsconfig.json` from `cloudflare/workers/meilisearch-proxy/` as the base — same devDependencies pattern.

### `wrangler.jsonc`

> **Permanent deviation from original plan:** Route uses `zone_name` not `custom_domain: true`. Wrangler rejects `custom_domain: true` with path wildcards (`/*`). DNS for `api.specialneeds.com` is already managed by Terraform — `zone_name` is the correct pattern.

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
  ]
}
```

KV namespaces, Durable Objects, and secrets are NOT added yet. Keep this minimal.

### `src/index.ts`

> **Permanent deviation from original plan:** `ORIGIN_URL` must be `http://` not `https://`. The Worker's `fetch()` enforces strict SSL validation (equivalent to a browser). The origin cert (issued by Traefik/Coolify for `api.specialneeds.com`) does not cover the sslip.io hostname used for direct connection — Worker rejects it with error 526. Traefik already has an HTTP router for the sslip.io hostname; Django ALLOWED_HOSTS wildcard `*.46.224.10.193.sslip.io` covers it. Never change ORIGIN_URL back to https.

```typescript
export interface Env {
  ORIGIN_URL: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = new URL(env.ORIGIN_URL);
    const url = new URL(request.url);
    url.protocol = origin.protocol;
    url.hostname = origin.hostname;
    url.port = origin.port;

    const response = await fetch(new Request(url.toString(), {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: 'follow',
    }));

    return new Response(response.body, { status: response.status, headers: response.headers });
  },
};
```

## Infrastructure to Provision

The origin URL is in `terraform/dns.tf` — the CNAME content for `api.specialneeds.com`. Use the HTTP form of the sslip.io URL.

```bash
cd cloudflare/workers/api-gateway
npm install
wrangler secret put ORIGIN_URL
# Enter the HTTP URL: http://u84kg8wkkowgw0ook4ggg8sk.46.224.10.193.sslip.io
```

## Deploy

```bash
wrangler deploy
```

Confirm route `api.specialneeds.com/*` appears in Cloudflare dashboard → Workers & Pages → api-gateway → Domains & Routes.

## Verification

```bash
curl -s https://api.specialneeds.com/health/

curl -s -X POST https://api.specialneeds.com/api/v1/token/ \
  -H "Content-Type: application/json" \
  -d '{"email": "x@x.com", "password": "x"}' | python3 -m json.tool
# Expect 401, not 502/503

curl -s "https://api.specialneeds.com/api/v1/listings/" | python3 -m json.tool
```

Check Worker logs: Workers & Pages → api-gateway → Observability. Confirm requests appear with no errors.

## Rollback

```bash
wrangler delete
# or remove the routes block from wrangler.jsonc and redeploy
```

Instantly reverts `api.specialneeds.com` to standard Cloudflare proxying. No Django, DNS, or Terraform changes needed.

## Gate Before Phase 2

- [x] Route appears in Cloudflare dashboard
- [x] All existing API consumers return correct responses
- [x] Worker logs show requests flowing through (`X-Worker-Response-Time` header confirms Worker in path)
- [x] No elevated error rate

**Phase 1 complete and stable. Phase 2 (rate limiting) deployed on top.**

## What's Next

Phase 2 adds three-tier rate limiting via KV counters. Once confirmed stable, the native Cloudflare rate limit rule in `terraform/rulesets.tf` is removed.
