import { RENDER_IDENTITY, IDENTITY_HEADER, type ResolvedIdentity } from './identity';

// A scanner gets almost nothing but 404s, and a real visitor rarely gets more than one or two.
// Ten in ten seconds stops a fast scan about half a second in, long before the CrowdSec ban
// reaches the edge through KV. CrowdSec still sees the first probes and issues its own ban.
const NOT_FOUND_LIMIT = 10;
const WINDOW_SECONDS = 10;
const BLOCK_SECONDS = 3600;

// Counters live in caches.default, so they are per-PoP like the rate limit counters.
function cacheRequest(key: string): Request {
  return new Request(`https://scanner-block.internal/${key}`);
}

async function cacheGet<T>(key: string): Promise<T | null> {
  const res = await caches.default.match(cacheRequest(key));
  return res ? ((await res.json()) as T) : null;
}

async function cachePut(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  await caches.default.put(
    cacheRequest(key),
    new Response(JSON.stringify(value), { headers: { 'Cache-Control': `public, max-age=${ttlSeconds}` } }),
  );
}

// A signed request that failed verification falls back to the sender's egress IP. For the www
// proxy that is Vercel's address for the whole site, so its 404s must never block anyone.
export function isScannerBlockCandidate(request: Request, identity: ResolvedIdentity): boolean {
  if (identity.value === RENDER_IDENTITY || identity.value === 'unknown') return false;
  if (identity.verified) return true;
  return !request.headers.has(IDENTITY_HEADER);
}

export async function isScannerBlocked(identity: string): Promise<boolean> {
  const block = await cacheGet<{ blockedUntil: number }>(`block:${identity}`);
  return block !== null && Math.floor(Date.now() / 1000) < block.blockedUntil;
}

export async function recordNotFound(identity: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const countKey = `404:${identity}`;
  const window = await cacheGet<{ count: number; resetAt: number }>(countKey);
  const current = window && now < window.resetAt ? window : { count: 0, resetAt: now + WINDOW_SECONDS };
  const count = current.count + 1;

  if (count >= NOT_FOUND_LIMIT) {
    await cachePut(`block:${identity}`, { blockedUntil: now + BLOCK_SECONDS }, BLOCK_SECONDS);
    console.log(`[scanner-block] blocked identity=${identity} for ${BLOCK_SECONDS}s after ${count} 404s`);
    return;
  }
  await cachePut(countKey, { count, resetAt: current.resetAt }, WINDOW_SECONDS);
}
