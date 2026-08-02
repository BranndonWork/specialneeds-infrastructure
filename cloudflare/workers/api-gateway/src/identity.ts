import type { Env } from './index';

// The www /api/* proxy routes arrive from Vercel's egress, so CF-Connecting-IP is a single
// shared address for all site traffic. A caller that holds the signing secret may instead
// assert who the request is really for: the literal "render" for its own server-side render
// fetches, or the visitor's IP for a request it is proxying on a visitor's behalf.
export const RENDER_IDENTITY = 'render';

export const IDENTITY_HEADER = 'x-sn-identity';
export const IDENTITY_TS_HEADER = 'x-sn-identity-ts';
export const IDENTITY_SIG_HEADER = 'x-sn-identity-sig';

// 60s back for latency, 5s forward for clock skew.
const MAX_AGE_SECONDS = 60;
const MAX_SKEW_SECONDS = 5;

export interface ResolvedIdentity {
  value: string;
  verified: boolean;
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0) return null;
  if (!/^[0-9a-fA-F]+$/.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

async function signatureMatches(secret: string, message: string, signature: Uint8Array): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  // crypto.subtle.verify is constant-time and returns false (never throws) on a wrong-length
  // signature, so no hand-rolled comparison is needed here.
  return crypto.subtle.verify('HMAC', key, signature, new TextEncoder().encode(message));
}

export function stripIdentityHeaders(headers: Headers): void {
  headers.delete(IDENTITY_HEADER);
  headers.delete(IDENTITY_TS_HEADER);
  headers.delete(IDENTITY_SIG_HEADER);
}

export async function resolveIdentity(request: Request, env: Env): Promise<ResolvedIdentity> {
  const fallback: ResolvedIdentity = {
    value: request.headers.get('cf-connecting-ip') ?? 'unknown',
    verified: false,
  };

  const asserted = request.headers.get(IDENTITY_HEADER);
  const ts = request.headers.get(IDENTITY_TS_HEADER);
  const sig = request.headers.get(IDENTITY_SIG_HEADER);
  if (!asserted || !ts || !sig) return fallback;

  if (!env.IDENTITY_SIGNING_SECRET) {
    // A missing secret is a permanent silent fallback to the egress IP. Say so loudly —
    // it must not look identical to working identity resolution in the logs.
    console.log('[identity] no-secret IDENTITY_SIGNING_SECRET is unset, falling back to cf-connecting-ip');
    return fallback;
  }

  if (!/^\d+$/.test(ts)) {
    console.log('[identity] verify-failed reason=malformed field=ts');
    return fallback;
  }

  const assertedAt = parseInt(ts, 10);
  const now = Math.floor(Date.now() / 1000);
  if (assertedAt < now - MAX_AGE_SECONDS || assertedAt > now + MAX_SKEW_SECONDS) {
    console.log(`[identity] verify-failed reason=stale age=${now - assertedAt}s`);
    return fallback;
  }

  const signature = hexToBytes(sig);
  if (!signature) {
    console.log('[identity] verify-failed reason=malformed field=sig');
    return fallback;
  }

  const message = `${asserted}\n${new URL(request.url).pathname}\n${ts}`;
  const secrets = [env.IDENTITY_SIGNING_SECRET, env.IDENTITY_SIGNING_SECRET_PREVIOUS];
  for (const secret of secrets) {
    if (!secret) continue;
    if (await signatureMatches(secret, message, signature)) {
      return { value: asserted, verified: true };
    }
  }

  console.log(`[identity] verify-failed reason=sig identity=${asserted}`);
  return fallback;
}
