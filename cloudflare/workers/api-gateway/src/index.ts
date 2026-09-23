import { checkRateLimit, rateLimitResponse } from './ratelimit';
import { checkCache, fetchAndCache } from './cache';
import { handleKvEndpoint } from './kv-endpoint';
import { handleRateLimitSlot } from './ratelimit-slot-endpoint';
export { UpstreamSlot } from './upstream-slot';
import { resolveIdentity, stripIdentityHeaders, RENDER_IDENTITY } from './identity';
import { toOriginUrl } from './origin';
import { requiresVerifiedIdentity } from './send-paths';

export interface Env {
  ORIGIN_URL: string;
  RATE_LIMIT_KV: KVNamespace;
  CACHE_KV: KVNamespace;
  CROWDSEC_KV: KVNamespace;
  UPSTREAM_SLOT: DurableObjectNamespace;
  CACHE_MGMT_TOKEN: string;
  WORKER_ORIGIN_SECRET: string;
  CF_API_TOKEN: string;
  REVALIDATE_SECRET: string;
  SN_SERVICE_TOKEN: string;
  IDENTITY_SIGNING_SECRET: string;
  IDENTITY_SIGNING_SECRET_PREVIOUS?: string;
}

async function proxyToOrigin(request: Request, originUrl: string, originSecret: string, visitorIp: string | null): Promise<Response> {
  const url = toOriginUrl(request.url, originUrl);
  const headers = new Headers(request.headers);
  headers.set('x-worker-origin-secret', originSecret);
  stripIdentityHeaders(headers);
  // Django's request_logger attributes and bans on CF-Connecting-IP. Behind the www proxy that
  // header is our own egress, so a verified visitor IP replaces it.
  if (visitorIp) headers.set('CF-Connecting-IP', visitorIp);
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

    const identity = await resolveIdentity(request, env);
    const isRender = identity.value === RENDER_IDENTITY;
    // Only a verified visitor IP is safe to present to origin as the client address.
    const visitorIp = identity.verified && !isRender ? identity.value : null;

    // CrowdSec ban check — lookup the resolved identity in the shared KV ban list. Keying on the
    // raw header would let a banned visitor arriving through the www proxy sail through on our
    // egress IP, and would ban that egress for everyone when it trips.
    if (!isRender && identity.value !== 'unknown') {
      const t0 = Date.now();
      const decision = await env.CROWDSEC_KV.get(identity.value);
      const banMs = Date.now() - t0;
      console.log(`[crowdsec] ip=${identity.value} verified=${identity.verified} decision=${decision ?? 'none'} ${banMs}ms`);
      if (decision === 'ban') {
        return new Response('Forbidden', { status: 403, headers: { 'X-Worker-Response-Time': `${Date.now() - start}ms` } });
      }
    }

    // Deployment-wide call slots for a named upstream (Nominatim today). Held open until the
    // slot comes up, so it sits before the origin path and never reaches Django.
    const slotResponse = await handleRateLimitSlot(request, env.UPSTREAM_SLOT, env.CACHE_MGMT_TOKEN);
    if (slotResponse) {
      console.log(`[ratelimit-slot] ${slotResponse.status} ${Date.now() - start}ms`);
      const headers = new Headers(slotResponse.headers);
      headers.set('X-Worker-Response-Time', `${Date.now() - start}ms`);
      return new Response(slotResponse.body, { status: slotResponse.status, headers });
    }

    const t1 = Date.now();
    const kvResponse = await handleKvEndpoint(request, env.CACHE_KV, env.CACHE_MGMT_TOKEN, ctx, env.CF_API_TOKEN, env.REVALIDATE_SECRET, env.SN_SERVICE_TOKEN);
    if (kvResponse) {
      console.log(`[kv-endpoint] handled ${Date.now() - t1}ms`);
      const headers = new Headers(kvResponse.headers);
      headers.set('X-Worker-Response-Time', `${Date.now() - start}ms`);
      return new Response(kvResponse.body, { status: kvResponse.status, statusText: kvResponse.statusText, headers });
    }

    if (requiresVerifiedIdentity(method, pathname) && !identity.verified) {
      console.log(`[identity-gate] rejected ${method} ${pathname} identity=${identity.value}`);
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json', 'X-Worker-Response-Time': `${Date.now() - start}ms` },
      });
    }

    // No S2S exemption here: the www /api/* proxy routes forward PUBLIC requests with the S2S
    // header attached, so exempting it removes rate limiting from publicly reachable endpoints
    // (shipped and reverted 2026-07-27, see docs/incident-reports in the parent repo). Bulk
    // rebuild jobs must pace themselves under the browse limit instead.
    //
    // A signed identity is different in kind from that exemption. It does not remove rate
    // limiting, it asserts a scoped identity: bound to one pathname and a short time window,
    // and unforgeable without the signing secret. A visitor cannot attach one to public
    // traffic, so the www proxy can name its own render fetches without also handing every
    // request it forwards a free pass.
    const t2 = Date.now();
    const rlResult = await checkRateLimit(request, identity.value);
    console.log(`[rate-limit] limited=${rlResult.limited} ${Date.now() - t2}ms`);
    if (rlResult.limited) return rateLimitResponse(rlResult.retryAfter!);

    let response: Response;

    const bypassCache = request.headers.has('authorization');

    if (method === 'GET' && !bypassCache) {
      const t3 = Date.now();
      const cached = await checkCache(request, env.CACHE_KV, ctx);
      if (cached) {
        console.log(`[cache-hit] ${Date.now() - t3}ms`);
        response = cached;
      } else {
        const t4 = Date.now();
        response = await fetchAndCache(request, env.ORIGIN_URL, env.CACHE_KV, ctx, env.WORKER_ORIGIN_SECRET, visitorIp);
        console.log(`[origin-fetch] status=${response.status} ${Date.now() - t4}ms`);
      }
    } else {
      const t4 = Date.now();
      response = await proxyToOrigin(request, env.ORIGIN_URL, env.WORKER_ORIGIN_SECRET, visitorIp);
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
