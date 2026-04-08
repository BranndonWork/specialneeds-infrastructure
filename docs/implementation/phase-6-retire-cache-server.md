# Phase 6 — Retire cache.specialneeds.com

## Problem Statement

`cache.specialneeds.com` is a co-located Redis wrapper on the same Coolify server as the Django API. All consumers have been migrated to the Worker KV endpoint in Phase 4. The service now serves no purpose and occupies server resources. This phase decommissions it.

## What Was Done in Previous Phases

- **Phase 1:** Worker passthrough, route confirmed
- **Phase 2:** Three-tier KV rate limiting, native CF rule removed
- **Phase 3:** Two-tier caching (Cache API + KV), stale-if-error, 7-day KV TTL
- **Phase 4:** Cache invalidation endpoint + general KV store, all consumers migrated from `cache.specialneeds.com`
- **Phase 5:** Origin hardening — direct origin hits return 403, Worker is the only path

## What This Phase Does

Decommission `cache.specialneeds.com`:
1. Verify zero active consumers across all repos
2. Remove the Coolify service
3. Remove or archive the DNS record in Terraform

**This is the only phase with no instant rollback.** Redeployment is required if something was missed. Do not proceed until Phase 4 has had a minimum of 1 week stable burn-in with all consumers confirmed migrated.

## Pre-Decommission Audit

Run this across all repos and confirm zero hits (excluding docs and plan files):

```bash
grep -r "cache.specialneeds.com" \
  /Volumes/Storage/Dropbox/workspace/projects/special-needs/ \
  --include="*.py" \
  --include="*.ts" \
  --include="*.tsx" \
  --include="*.js" \
  --include="*.json" \
  --include="*.env" \
  --include="*.yml" \
  --include="*.yaml" \
  --include="*.toml"
```

Any hit is a blocker. Migrate it before proceeding.

Also check Cloudflare Worker logs for `cache.specialneeds.com` traffic over the past week. Confirm zero requests are hitting it.

## Steps

### 1. Remove Coolify service

In Coolify: navigate to the `cache.specialneeds.com` service → Stop → Delete.

### 2. Remove DNS record from Terraform

In `specialneeds-infrastructure/terraform/dns.tf`, find and remove the `cache.specialneeds.com` DNS record.

**Find the record:**
```bash
cd /Volumes/Storage/Dropbox/workspace/projects/special-needs/specialneeds-infrastructure/terraform
grep -A5 '"cache.specialneeds.com"' dns.tf
```

This will show the resource block and its auto-generated Terraform resource name. The record looks like:
```hcl
resource "cloudflare_dns_record" "terraform_managed_resource_XXXXXX_N" {
  content = "zlb70x4zfxl5thskavt96cq7.46.224.10.193.sslip.io"
  name    = "cache.specialneeds.com"
  proxied = true
  ...
}
```

**Remove the record:**
1. Copy the full resource name from the grep output (e.g., `cloudflare_dns_record.terraform_managed_resource_784ab148105853b75b3c1881b0ea77a9_9`)
2. Remove it from Terraform state first:
   ```bash
   poetry run python scripts/cf.py terraform state rm \
     cloudflare_dns_record.terraform_managed_resource_XXXXXX_N
   ```
3. Remove the resource block from `dns.tf`
4. Find and remove the corresponding `import` block (search for the same resource name)
5. Verify zero drift:
   ```bash
   poetry run python scripts/cf.py terraform plan  # Should show 0 changes
   ```

Alternatively, to let Terraform manage the deletion:
```bash
# Remove only the import block, keep the resource block
poetry run python scripts/cf.py terraform plan   # confirm 1 to destroy
poetry run python scripts/cf.py terraform apply
# Then remove the resource block from dns.tf
```

### 3. Update CLAUDE.md

Remove references to `cache.specialneeds.com` from:
- `specialneeds-infrastructure/CLAUDE.md`
- The parent `specialneeds/CLAUDE.md` if referenced there

## Verification

```bash
# DNS should no longer resolve
dig cache.specialneeds.com
# Expect: NXDOMAIN or no A/CNAME record

# HTTP request should fail
curl -sv "https://cache.specialneeds.com/" 2>&1 | grep "< HTTP\|curl:"
# Expect: connection error or 521 from Cloudflare (no origin)

# Confirm Worker KV endpoint still working
curl -s -o /dev/null -w "%{http_code}" "https://api.specialneeds.com/v1/cache/test/probe"
# Expect: 404 (key doesn't exist, but endpoint responds)
```

## Rollback

No instant rollback. To restore:
1. Redeploy `cache.specialneeds.com` service in Coolify
2. Restore DNS record in `terraform/dns.tf` and apply
3. Point any affected consumers back to `cache.specialneeds.com`

This is why Phase 4 requires a minimum 1-week burn-in before this phase runs.

## Final State After Phase 6

The API gateway is complete:

| Concern | Solution |
|---|---|
| Rate limiting | Worker KV (3 tiers, global per-IP) |
| Edge caching | Worker Cache API + KV (L1 + L2, stale-if-error, 7-day TTL) |
| Cache invalidation | Worker `/v1/cache/invalidate` (Django calls on publish/update/delete) |
| Origin hardening | `X-Origin-Secret` + Django waffle switch |
| General KV cache | Worker `/v1/cache/:key` |
| cache.specialneeds.com | Retired |

## Completion Checklist

- [ ] Zero `cache.specialneeds.com` references in codebase (all repos)
- [ ] Zero traffic to `cache.specialneeds.com` in Cloudflare logs (past 7 days)
- [ ] Coolify service stopped and deleted
- [ ] DNS record removed from Terraform and applied
- [ ] CLAUDE.md files updated
- [ ] `terraform plan` shows no changes (zero drift)
