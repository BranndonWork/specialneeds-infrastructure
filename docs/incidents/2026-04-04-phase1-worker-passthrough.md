# Incident Report — Phase 1 Worker Passthrough Attempt

**Date:** 2026-04-04
**Duration:** ~45 minutes
**Severity:** Production outage — api.specialneeds.com unreachable
**Resolution:** Hetzner server restart

---

## What Was Attempted

Deploying Phase 1 of the API Gateway Worker: a passthrough proxy on `api.specialneeds.com/*` that intercepts all requests and forwards to origin unchanged.

---

## Failure Chain

### Failure 1 — Incorrect self-trigger assumption
The initial Worker implementation called `fetch(request)` to pass through to origin, assuming Cloudflare subrequests don't re-trigger Workers on the same route. They do. This caused infinite recursion and Cloudflare error 1019 (Compute server error).

### Failure 2 — SSL cert mismatch (error 526)
Reverted to fetching the origin URL directly (`https://u84kg8wkkowgw0ook4ggg8sk.46.224.10.193.sslip.io`). Worker's `fetch()` uses strict browser-like SSL validation. The origin's SSL cert is issued for the sslip.io hostname by Traefik/Coolify, but the Worker runtime rejected it with error 526. Cloudflare's direct proxy used zone `ssl = "full"` which tolerates unverified certs — the Worker does not.

### Failure 3 — Traefik host routing mismatch (503)
Added `origin-api.specialneeds.com` CNAME → same sslip.io backend, with no Worker route. Worker fetched this subdomain to route through Cloudflare's proxy (bypassing strict SSL). Cloudflare sent `Host: origin-api.specialneeds.com` to origin. Traefik had no routing rule for that hostname → 503 "no available server".

Attempted to fix via Cloudflare Transform Rule to rewrite Host header. Cloudflare API error 20087: Host header cannot be modified via Transform Rules.

### Failure 4 — Coolify redeploy caused outage
Added `https://origin-api.specialneeds.com` as a domain in Coolify sn-django service and triggered redeploy. Coolify/Traefik began a health check loop. The server became unreachable on port 22. Hetzner restart required to recover.

---

## Root Cause

The Worker's `fetch()` API enforces strict SSL validation, incompatible with Coolify/Traefik's SSL setup where the cert is for `api.specialneeds.com` but the sslip.io URL is used for direct connection. No Cloudflare-native mechanism exists to route a Worker subrequest through the zone proxy (which would use `ssl = "full"`) without re-triggering the Worker.

---

## What Was Left in Place After Rollback

- Worker deleted from Cloudflare (`wrangler delete`)
- `origin-api.specialneeds.com` DNS record never persisted (destroyed before outage)
- `dns.tf` and `rulesets.tf` cleaned up — zero Terraform drift
- `cloudflare/workers/api-gateway/` scaffold remains on disk — safe, not deployed
- `origin-api.specialneeds.com` domain still in Coolify sn-django — **needs to be removed**

---

## What Needs to Happen Before Next Attempt

### Immediate
- [ ] Remove `https://origin-api.specialneeds.com` from Coolify sn-django domains (leftover from this incident)

### Resolved architecture questions before re-attempting Phase 1

The core problem: how does the Worker reach origin without SSL validation failure?

**Option A — Fix origin SSL**
Confirm Coolify/Traefik has a valid cert for the sslip.io hostname, or reconfigure to expose HTTP on an internal port. If Traefik presents the correct cert for the sslip.io URL, the Worker can fetch it directly.

**Option B — Add `origin-api.specialneeds.com` to Django ALLOWED_HOSTS and Traefik**
Add the subdomain as an accepted host in Django settings and Coolify. Worker fetches `origin-api.specialneeds.com` (CNAME to same backend, no Worker route). Cloudflare proxy handles SSL. Traefik routes correctly because the Host matches. This requires:
1. `origin-api.specialneeds.com` in `ALLOWED_HOSTS` env var in Coolify
2. Coolify domain entry as `http://` (not `https://`) to avoid cert provisioning for this internal subdomain
3. DNS record in `dns.tf`

**Option C — Use HTTP for Worker→origin**
Configure Coolify to expose the Django service on HTTP (port 80) for internal routing. Worker fetches `http://` origin URL. No SSL validation. Unencrypted last-mile but Cloudflare handles HTTPS termination for end users.

---

## Files Changed (and current state)

| File | Change | State |
|---|---|---|
| `cloudflare/workers/api-gateway/src/index.ts` | Created | On disk, not deployed |
| `cloudflare/workers/api-gateway/wrangler.jsonc` | Created | On disk, not deployed |
| `cloudflare/workers/api-gateway/package.json` | Created | On disk, not deployed |
| `cloudflare/workers/api-gateway/tsconfig.json` | Created | On disk, not deployed |
| `terraform/dns.tf` | No net change | Zero drift |
| `terraform/rulesets.tf` | No net change | Zero drift |
