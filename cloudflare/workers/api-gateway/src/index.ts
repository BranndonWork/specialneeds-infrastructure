import { checkRateLimit, rateLimitResponse } from './ratelimit';
import { checkCache, fetchAndCache } from './cache';
import { handleKvEndpoint } from './kv-endpoint';

export interface Env {
  ORIGIN_URL: string;
  RATE_LIMIT_KV: KVNamespace;
  CACHE_KV: KVNamespace;
  CROWDSEC_KV: KVNamespace;
  CACHE_MGMT_TOKEN: string;
  WORKER_ORIGIN_SECRET: string;
  CF_API_TOKEN: string;
  REVALIDATE_SECRET: string;
}

async function proxyToOrigin(request: Request, originUrl: string, originSecret: string): Promise<Response> {
  const origin = new URL(originUrl);
  const url = new URL(request.url);
  url.protocol = origin.protocol;
  url.hostname = origin.hostname;
  url.port = origin.port;
  if (!url.pathname.endsWith('/')) {
    url.pathname += '/';
  }
  const headers = new Headers(request.headers);
  headers.set('x-worker-origin-secret', originSecret);
  try {
    return await fetch(new Request(url.toString(), {
      method: request.method,
      headers,
      body: request.body,
      redirect: 'manual',
    }));
  } catch {
    return new Response(JSON.stringify({ error: 'Service unavailable' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const start = Date.now();
    const { method } = request;
    const { pathname } = new URL(request.url);
    console.log(`[req] ${method} ${pathname}`);

    // CrowdSec ban check — lookup client IP in the shared KV ban list
    const clientIp = request.headers.get('cf-connecting-ip') ?? '';
    if (clientIp) {
      const t0 = Date.now();
      const decision = await env.CROWDSEC_KV.get(clientIp);
      const banMs = Date.now() - t0;
      console.log(`[crowdsec] ip=${clientIp} decision=${decision ?? 'none'} ${banMs}ms`);
      if (decision === 'ban') {
        return new Response('Forbidden', { status: 403, headers: { 'X-Worker-Response-Time': `${Date.now() - start}ms` } });
      }
    }

    const t1 = Date.now();
    const kvResponse = await handleKvEndpoint(request, env.CACHE_KV, env.CACHE_MGMT_TOKEN, ctx, env.CF_API_TOKEN, env.REVALIDATE_SECRET);
    if (kvResponse) {
      console.log(`[kv-endpoint] handled ${Date.now() - t1}ms`);
      const headers = new Headers(kvResponse.headers);
      headers.set('X-Worker-Response-Time', `${Date.now() - start}ms`);
      return new Response(kvResponse.body, { status: kvResponse.status, statusText: kvResponse.statusText, headers });
    }

    const t2 = Date.now();
    const rlResult = await checkRateLimit(request);
    console.log(`[rate-limit] limited=${rlResult.limited} ${Date.now() - t2}ms`);
    if (rlResult.limited) return rateLimitResponse(rlResult.retryAfter!);

    let response: Response;

    if (method === 'GET') {
      const t3 = Date.now();
      const cached = await checkCache(request, env.CACHE_KV, ctx);
      if (cached) {
        console.log(`[cache-hit] ${Date.now() - t3}ms`);
        response = cached;
      } else {
        const t4 = Date.now();
        response = await fetchAndCache(request, env.ORIGIN_URL, env.CACHE_KV, ctx, env.WORKER_ORIGIN_SECRET);
        console.log(`[origin-fetch] status=${response.status} ${Date.now() - t4}ms`);
      }
    } else {
      const t4 = Date.now();
      response = await proxyToOrigin(request, env.ORIGIN_URL, env.WORKER_ORIGIN_SECRET);
      console.log(`[origin-proxy] status=${response.status} ${Date.now() - t4}ms`);
    }

    if (response.status >= 500) {
      console.log(`[total] error=${response.status} ${Date.now() - start}ms`);
      return new Response(JSON.stringify({ error: 'Service unavailable' }), {
        status: response.status,
        headers: { 'Content-Type': 'application/json', 'X-Worker-Response-Time': `${Date.now() - start}ms` },
      });
    }

    console.log(`[total] status=${response.status} ${Date.now() - start}ms`);
    const headers = new Headers(response.headers);
    headers.set('X-Worker-Response-Time', `${Date.now() - start}ms`);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
};
