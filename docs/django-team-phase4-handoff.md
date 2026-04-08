# Phase 4 — Django Team Handoff

The api-gateway Worker now exposes two endpoints that Django needs to call.

---

## 1. Cache Invalidation

When a listing or article is published, updated, or deleted, call this endpoint to bust the Worker's response cache for that resource.

**Endpoint**
```
DELETE https://api.specialneeds.com/v1/cache/invalidate?url=<encoded-url>
```

**Auth header**
```
X-Sn-Service-Token: <SN_SERVICE_TOKEN>
```

**`url` param** — the full API URL whose cache should be cleared, URL-encoded.

**Example**
```
DELETE /v1/cache/invalidate?url=https%3A%2F%2Fapi.specialneeds.com%2Fapi%2Fv1%2Flistings%2F%3Fslug%3Dsome-listing-slug%26level%3Ddisplay
X-Sn-Service-Token: <token>
```

**Responses:** `200 OK`, `400` (missing url), `403` (bad/missing token), `405` (wrong method)

---

## 2. General KV Store

A key/value store at the Worker edge. Replaces `cache.specialneeds.com` (the Redis wrapper). Any code currently writing to or reading from `cache.specialneeds.com` should migrate to this endpoint.

**Endpoints**
```
GET    https://api.specialneeds.com/v1/cache/<key>
PUT    https://api.specialneeds.com/v1/cache/<key>?ttl=<seconds>
DELETE https://api.specialneeds.com/v1/cache/<key>
```

- `<key>` — any string; forward slashes are converted to colons (e.g. `geocache/tampa-fl` → `geocache:tampa-fl`)
- `ttl` — optional, seconds until expiry
- GET is unauthenticated. PUT and DELETE require `X-Sn-Service-Token`.

**Responses:** `200 OK` / body on GET, `404` if key not found, `403` if auth missing/wrong

---

## Auth

Use the existing `SN_SERVICE_TOKEN` env var — the same token already used for server-to-server requests.
