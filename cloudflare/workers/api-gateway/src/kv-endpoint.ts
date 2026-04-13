import { cacheKey } from './cache';

const CF_ZONE_ID = '3df33cbd8f514275c7074407989b5b12';
const REVALIDATE_URL = 'https://www.specialneeds.com/api/admin/revalidate/';
// www.specialneeds.com is Vercel-hosted and not Cloudflare-proxied.
// Cloudflare CDN purge calls for this host are no-ops — skip them.
const CF_PROXIED_HOST = 'api.specialneeds.com';

function isAuthorized(request: Request, secret: string): boolean {
  return Boolean(secret && request.headers.get('X-Sn-Service-Token') === secret);
}

async function purgeCfCdn(targetUrl: string, cfApiToken: string): Promise<void> {
  const host = new URL(targetUrl).hostname;
  if (host !== CF_PROXIED_HOST) {
    console.log(`[purge-cdn] skipped — ${host} is not Cloudflare-proxied`);
    return;
  }
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/purge_cache`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${cfApiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ files: [targetUrl] }),
    },
  );
  console.log(`[purge-cdn] ${targetUrl} → ${res.status}`);
}

async function revalidateNextJs(targetUrl: string, revalidateSecret: string): Promise<void> {
  const path = new URL(targetUrl).pathname;
  const res = await fetch(REVALIDATE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Revalidate-Token': revalidateSecret,
    },
    body: JSON.stringify({ paths: [path] }),
  });
  console.log(`[revalidate-isr] ${path} → ${res.status}`);
}


export async function handleKvEndpoint(
  request: Request,
  kv: KVNamespace,
  serviceToken: string,
  ctx: ExecutionContext,
  cfApiToken: string,
  revalidateSecret: string,
): Promise<Response | null> {
  const url = new URL(request.url);

  if (!url.pathname.startsWith('/v1/cache')) return null;

  // Cache management — HEAD|PUT|DELETE /v1/cache?url=<encoded-url>
  if (url.pathname === '/v1/cache' && url.searchParams.has('url')) {
    const targetUrl = url.searchParams.get('url')!;
    const hash = await cacheKey(targetUrl);

    switch (request.method) {
      case 'HEAD': {
        const stored = await kv.getWithMetadata(hash, 'text');
        return new Response(null, { status: stored.value ? 200 : 404 });
      }
      case 'PUT': {
        if (!isAuthorized(request, serviceToken)) return new Response('Forbidden', { status: 403 });
        const body = await request.text();
        const contentType = url.searchParams.get('content_type') ?? 'application/json';
        const cacheControl = url.searchParams.get('cache_control') ?? 'public, max-age=3600';
        await kv.put(hash, body, { metadata: { contentType, cacheControl } });
        return new Response('OK');
      }
      case 'DELETE': {
        if (!isAuthorized(request, serviceToken)) return new Response('Forbidden', { status: 403 });
        const isApiUrl = new URL(targetUrl).hostname === CF_PROXIED_HOST;
        if (isApiUrl) {
          await Promise.all([
            kv.delete(hash),
            caches.default.delete(new Request(`https://cache.internal/${hash}`)),
          ]);
          if (cfApiToken) ctx.waitUntil(purgeCfCdn(targetUrl, cfApiToken));
        }
        if (revalidateSecret) ctx.waitUntil(revalidateNextJs(targetUrl, revalidateSecret));
        return new Response('OK');
      }
      default:
        return new Response('Method Not Allowed', { status: 405 });
    }
  }

  // General KV store — GET|PUT|DELETE /v1/cache/:key
  if (!url.pathname.startsWith('/v1/cache/')) return null;

  const kvKey = url.pathname.replace(/^\/v1\/cache\//, '').replace(/\//g, ':');
  if (!kvKey) return new Response('Missing key', { status: 400 });

  switch (request.method) {
    case 'GET': {
      const value = await kv.get(kvKey);
      if (value === null) return new Response('Not Found', { status: 404 });
      return new Response(value, { headers: { 'Content-Type': 'application/json' } });
    }
    case 'PUT': {
      if (!isAuthorized(request, serviceToken)) return new Response('Forbidden', { status: 403 });
      const body = await request.text();
      const ttl = url.searchParams.get('ttl');
      await kv.put(kvKey, body, ttl ? { expirationTtl: parseInt(ttl, 10) } : undefined);
      return new Response('OK');
    }
    case 'DELETE': {
      if (!isAuthorized(request, serviceToken)) return new Response('Forbidden', { status: 403 });
      await kv.delete(kvKey);
      return new Response('OK');
    }
    default:
      return new Response('Method Not Allowed', { status: 405 });
  }
}
