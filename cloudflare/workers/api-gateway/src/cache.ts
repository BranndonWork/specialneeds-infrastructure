import { stripIdentityHeaders } from './identity';

const DEFAULT_MAX_AGE = 300;  // fallback if Django sends no Cache-Control
const DEFAULT_STALE_IF_ERROR = 86400;  // how long an expired entry is kept purely as an origin-down fallback
const KV_MIN_TTL = 60;  // Cloudflare KV rejects expirationTtl below 60s

interface CacheMeta {
  contentType: string;
  cacheControl: string;
  storedAt?: number;
  maxAge?: number;
}

// An entry past its max-age is not served, but is kept in KV so fetchAndCache can fall back to it
// if the origin is unreachable. Entries written before storedAt existed are treated as expired so
// they refresh once on next request.
function isFresh(meta: CacheMeta | null | undefined): boolean {
  if (!meta?.storedAt || meta.maxAge === undefined) return false;
  return (Date.now() - meta.storedAt) / 1000 < meta.maxAge;
}

export async function cacheKey(url: string): Promise<string> {
  const u = new URL(url);
  const params = Array.from(u.searchParams.entries()).sort(([a], [b]) => a.localeCompare(b));
  u.search = new URLSearchParams(params).toString();
  u.hash = '';
  const encoded = new TextEncoder().encode(u.toString());
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function parseCacheControl(header: string | null): { cacheable: boolean; maxAge: number; staleIfError: number } {
  if (!header) return { cacheable: true, maxAge: DEFAULT_MAX_AGE, staleIfError: DEFAULT_STALE_IF_ERROR };
  const cc = header.toLowerCase();
  if (cc.includes('no-store') || cc.includes('private') || cc.includes('no-cache')) {
    return { cacheable: false, maxAge: 0, staleIfError: 0 };
  }
  const match = cc.match(/max-age=(\d+)/);
  const stale = cc.match(/stale-if-error=(\d+)/);
  return {
    cacheable: true,
    maxAge: match ? parseInt(match[1], 10) : DEFAULT_MAX_AGE,
    staleIfError: stale ? parseInt(stale[1], 10) : DEFAULT_STALE_IF_ERROR,
  };
}

function isCacheable(request: Request): boolean {
  return request.method === 'GET';
}

function withHeader(response: Response, key: string, value: string): Response {
  const headers = new Headers(response.headers);
  headers.set(key, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export async function checkCache(
  request: Request,
  cacheKv: KVNamespace,
  ctx: ExecutionContext,
): Promise<Response | null> {
  if (!isCacheable(request)) return null;

  const t0 = Date.now();
  const key = await cacheKey(request.url);
  const cacheRequest = new Request(`https://cache.internal/${key}`);

  // L1 — Cache API (per-PoP, respects Cache-Control TTL from stored response)
  const t1 = Date.now();
  const l1 = await caches.default.match(cacheRequest);
  console.log(`[cache:l1] ${l1 ? 'HIT' : 'MISS'} ${Date.now() - t1}ms`);
  if (l1) {
    const kvCheck = await cacheKv.get(key);
    if (kvCheck !== null) {
      return withHeader(l1, 'X-Cache', 'HIT');
    }
    // KV was invalidated — L1 is stale, evict it and fall through
    console.log(`[cache:l1-stale] KV invalidated, evicting L1`);
    ctx.waitUntil(caches.default.delete(cacheRequest));
  }

  // L2 — KV (global, stale fallback)
  const t2 = Date.now();
  const stored = await cacheKv.getWithMetadata<CacheMeta>(key, 'text');
  console.log(`[cache:l2-kv] ${stored.value ? 'HIT' : 'MISS'} ${Date.now() - t2}ms`);
  if (stored.value && !isFresh(stored.metadata)) {
    // Past Django's max-age. Fall through to the origin. The entry stays in KV for the
    // origin-down fallback in fetchAndCache.
    console.log(`[cache:l2-expired] age exceeded max-age=${stored.metadata?.maxAge ?? 'unset'}`);
    return null;
  }
  if (stored.value) {
    const kvResponse = new Response(stored.value, {
      headers: {
        'Content-Type': stored.metadata?.contentType ?? 'application/json',
        'Cache-Control': stored.metadata?.cacheControl ?? `public, max-age=${DEFAULT_MAX_AGE}`,
        'X-Cache': 'KV-HIT',
      },
    });
    ctx.waitUntil(caches.default.put(cacheRequest, kvResponse.clone()));
    console.log(`[cache] KV-HIT ${Date.now() - t0}ms`);
    return kvResponse;
  }

  console.log(`[cache] MISS ${Date.now() - t0}ms`);
  return null;
}

export async function fetchAndCache(
  request: Request,
  originUrl: string,
  cacheKv: KVNamespace,
  ctx: ExecutionContext,
  originSecret: string,
  visitorIp: string | null,
): Promise<Response> {
  const cacheable = isCacheable(request);
  const key = cacheable ? await cacheKey(request.url) : '';
  const cacheRequest = cacheable ? new Request(`https://cache.internal/${key}`) : null;

  const origin = new URL(originUrl);
  const target = new URL(request.url);
  target.protocol = origin.protocol;
  target.hostname = origin.hostname;
  target.port = origin.port;

  // Append trailing slash to avoid Django APPEND_SLASH 301 double round-trip
  if (!target.pathname.endsWith('/')) {
    target.pathname += '/';
  }

  const originHeaders = new Headers(request.headers);
  originHeaders.set('x-worker-origin-secret', originSecret);
  stripIdentityHeaders(originHeaders);
  // Django's request_logger attributes and bans on CF-Connecting-IP. Behind the www proxy that
  // header is our own egress, so a verified visitor IP replaces it.
  if (visitorIp) originHeaders.set('CF-Connecting-IP', visitorIp);

  let res: Response;
  try {
    const t0 = Date.now();
    res = await fetch(new Request(target.toString(), {
      method: request.method,
      headers: originHeaders,
      // A GET/HEAD Request may not carry a body, but axios GETs (the Next.js render fetches)
      // arrive with an empty body stream attached. Passing it through throws
      // "Request with a GET or HEAD method cannot have a body" and turned every cache-miss
      // render fetch into a 503 (2026-07-27: 24k directory pages cached as 404s).
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
    }));
    console.log(`[origin:fetch] status=${res.status} ${Date.now() - t0}ms ${target.pathname}`);
  } catch (err) {
    console.log(`[origin:fetch] error: ${err}`);
    // Origin unreachable — serve stale if available
    if (cacheable) {
      const stale = await cacheKv.getWithMetadata<CacheMeta>(key, 'text');
      if (stale.value) {
        console.log(`[origin:stale-fallback] serving stale from KV`);
        return new Response(stale.value, {
          status: 200,
          headers: {
            'Content-Type': stale.metadata?.contentType ?? 'application/json',
            'X-Cache': 'STALE-ERROR',
          },
        });
      }
    }
    return new Response(JSON.stringify({ error: 'Service unavailable' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (cacheable && res.ok) {
    const { cacheable: shouldCache, maxAge, staleIfError } = parseCacheControl(res.headers.get('Cache-Control'));

    if (shouldCache && maxAge > 0) {
      const body = await res.text();
      const contentType = res.headers.get('Content-Type') ?? 'application/json';
      const cacheControl = `public, max-age=${maxAge}`;
      const toCache = new Response(body, {
        headers: {
          'Content-Type': contentType,
          'Cache-Control': cacheControl,
          'X-Cache': 'MISS',
        },
      });
      ctx.waitUntil(
        Promise.all([
          caches.default.put(cacheRequest!, toCache.clone()),
          cacheKv.put(key, body, {
            expirationTtl: Math.max(maxAge + staleIfError, KV_MIN_TTL),
            metadata: { contentType, cacheControl, storedAt: Date.now(), maxAge },
          }),
        ])
          .then(() => console.log(`[cache:write] l1+l2 ok key=${key.slice(0, 12)}`))
          .catch((err) => console.log(`[cache:write] error: ${err}`))
      );

      const responseHeaders = new Headers(res.headers);
      responseHeaders.set('X-Cache', 'MISS');
      return new Response(body, { status: res.status, headers: responseHeaders });
    } else {
      console.log(`[cache:skip] cacheable=${shouldCache} maxAge=${maxAge}`);
    }
  }

  return res;
}
