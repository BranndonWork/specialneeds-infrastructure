import { DurableObject } from 'cloudflare:workers';

// One Durable Object per named upstream (e.g. "nominatim") hands out call slots in arrival order,
// one per interval, to every caller across the whole deployment. A caller makes one request and
// is held until its slot comes up, so nobody polls. The object is single-threaded, so the slot
// assignment runs to completion before any other claim can read the clock.

export const DEFAULT_INTERVAL_MS = 1000;
export const MAX_INTERVAL_MS = 60_000;
export const MAX_WAIT_MS = 5000;
export const MAX_QUEUE_DEPTH = 8;

export interface SlotClock {
  nextFreeAt: number;
  waiting: number;
}

export type SlotDecision = { accepted: true; wait: number } | { accepted: false };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function clampInterval(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_INTERVAL_MS;
  return Math.min(Math.max(parsed, 1), MAX_INTERVAL_MS);
}

// The whole scheduling rule, kept synchronous and free of I/O so it can be tested without the
// object: a claim takes the next free instant on the clock, unless the line is already full or
// that instant is too far off, in which case the clock is left untouched and the claim refused.
export function planClaim(clock: SlotClock, intervalMs: number, now: number): SlotDecision {
  const slotAt = Math.max(now, clock.nextFreeAt);
  const wait = slotAt - now;
  if (clock.waiting >= MAX_QUEUE_DEPTH || wait > MAX_WAIT_MS) return { accepted: false };
  clock.nextFreeAt = slotAt + intervalMs;
  return { accepted: true, wait };
}

export class UpstreamSlot extends DurableObject {
  private clock: SlotClock = { nextFreeAt: 0, waiting: 0 };

  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

    let intervalMs = DEFAULT_INTERVAL_MS;
    try {
      const body = (await request.json()) as { interval_ms?: unknown };
      intervalMs = clampInterval(body?.interval_ms);
    } catch {
      // No body, or not JSON: the default interval applies.
    }

    const decision = planClaim(this.clock, intervalMs, Date.now());
    if (!decision.accepted) {
      return Response.json({ allowed: false, reason: 'queue full' }, { status: 503, headers: { 'Retry-After': '1' } });
    }

    this.clock.waiting += 1;
    try {
      if (decision.wait > 0) await sleep(decision.wait);
    } finally {
      this.clock.waiting -= 1;
    }

    return Response.json({ allowed: true, waited_ms: decision.wait });
  }
}
