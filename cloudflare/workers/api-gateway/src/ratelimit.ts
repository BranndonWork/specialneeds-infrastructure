import { RENDER_IDENTITY } from './identity';

export interface RateLimitResult {
  limited: boolean;
  retryAfter?: number;
}

const TIERS = {
  auth:    { limit: 5,   windowSeconds: 60, blockSeconds: 600 },
  browse:  { limit: 60,  windowSeconds: 60, blockSeconds: 60 },
  general: { limit: 120, windowSeconds: 60, blockSeconds: 60 },
  render:  { limit: 300, windowSeconds: 60, blockSeconds: 60 },
} as const;

type TierName = keyof typeof TIERS;

function getTier(pathname: string): TierName {
  if (pathname.startsWith('/api/v1/token/')) return 'auth';
  if (pathname.includes('/api/v1/listings/') || pathname.includes('/api/v1/articles/')) return 'browse';
  return 'general';
}

// --- Cache API helpers (per-PoP, sub-ms reads) ---

function rlRequest(key: string): Request {
  return new Request(`https://rl.internal/${key}`);
}

async function rlGet(key: string): Promise<string | null> {
  const res = await caches.default.match(rlRequest(key));
  if (!res) return null;
  return res.text();
}

async function rlPut(key: string, value: string, ttlSeconds: number): Promise<void> {
  await caches.default.put(
    rlRequest(key),
    new Response(value, {
      headers: { 'Cache-Control': `public, max-age=${ttlSeconds}` },
    }),
  );
}

// ---

export async function checkRateLimit(
  request: Request,
  identity: string,
): Promise<RateLimitResult> {
  const t0 = Date.now();
  const pathname = new URL(request.url).pathname;
  // Server-side render fetches are one trusted caller doing many requests: their own tier,
  // regardless of which paths they happen to hit.
  const tier = identity === RENDER_IDENTITY ? 'render' : getTier(pathname);
  const config = TIERS[tier];
  const now = Math.floor(Date.now() / 1000);

  const blockKey = `block:${identity}:${tier}`;
  const t1 = Date.now();
  const block = await rlGet(blockKey);
  console.log(`[rl:block-get] ${Date.now() - t1}ms`);
  if (block) {
    const { blockedUntil } = JSON.parse(block) as { blockedUntil: number };
    if (now < blockedUntil) {
      console.log(`[rl] limited=true (block) identity=${identity} tier=${tier} ${Date.now() - t0}ms`);
      return { limited: true, retryAfter: blockedUntil - now };
    }
  }

  const countKey = `rl:${identity}:${tier}`;
  const t2 = Date.now();
  const raw = await rlGet(countKey);
  console.log(`[rl:count-get] ${Date.now() - t2}ms`);

  if (raw) {
    const data = JSON.parse(raw) as { count: number; resetAt: number };

    if (now >= data.resetAt) {
      const t3 = Date.now();
      await rlPut(countKey, JSON.stringify({ count: 1, resetAt: now + config.windowSeconds }), config.windowSeconds + 60);
      console.log(`[rl:put-reset] ${Date.now() - t3}ms`);
      console.log(`[rl] limited=false (window-reset) identity=${identity} tier=${tier} ${Date.now() - t0}ms`);
      return { limited: false };
    }

    const newCount = data.count + 1;
    if (newCount > config.limit) {
      const blockedUntil = now + config.blockSeconds;
      const t3 = Date.now();
      await rlPut(blockKey, JSON.stringify({ blockedUntil }), config.blockSeconds + 60);
      console.log(`[rl:put-block] ${Date.now() - t3}ms`);
      console.log(`[rl] limited=true (limit-exceeded) identity=${identity} tier=${tier} ${Date.now() - t0}ms`);
      return { limited: true, retryAfter: config.blockSeconds };
    }

    const t3 = Date.now();
    await rlPut(countKey, JSON.stringify({ count: newCount, resetAt: data.resetAt }), config.windowSeconds + 60);
    console.log(`[rl:put-increment] ${Date.now() - t3}ms`);
    console.log(`[rl] limited=false count=${newCount} identity=${identity} tier=${tier} ${Date.now() - t0}ms`);
    return { limited: false };
  }

  const t3 = Date.now();
  await rlPut(countKey, JSON.stringify({ count: 1, resetAt: now + config.windowSeconds }), config.windowSeconds + 60);
  console.log(`[rl:put-new] ${Date.now() - t3}ms`);
  console.log(`[rl] limited=false (new) identity=${identity} tier=${tier} ${Date.now() - t0}ms`);
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
