import type { Env } from './index';
import { isAuthorized } from './kv-endpoint';

// Primary/standby failover. A cron probe decides whether the gateway reads from the primary
// Django or the read-only warm standby, and `fetch` reads that decision once per isolate every
// 30 seconds. Writes are paused while the standby serves: it cannot take them.

export const FAILOVER_STATE_KEY = 'failover:state';
export const FAIL_THRESHOLD = 3;
export const RECOVER_THRESHOLD = 10;
export const STANDBY_FAIL_THRESHOLD = 10;
export const MANAGEMENT_PATH = '/__failover';
const PROBE_TIMEOUT_MS = 10_000;
const STATE_CACHE_MS = 30_000;
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface FailoverState {
  active: boolean;
  pinned: boolean;
  fails: number;
  passes: number;
  standby_fails: number;
  standby_alerted: boolean;
  changed_at: string;
  reason: string;
}

type AlertEnv = Pick<Env, 'TELEGRAM_ALERTS_BOT_TOKEN' | 'TELEGRAM_ALERTS_CHAT_ID'>;

export function initialState(): FailoverState {
  return {
    active: false,
    pinned: false,
    fails: 0,
    passes: 0,
    standby_fails: 0,
    standby_alerted: false,
    changed_at: new Date(0).toISOString(),
    reason: 'initial',
  };
}

export function isReadMethod(method: string): boolean {
  return READ_METHODS.has(method);
}

function flip(state: FailoverState, active: boolean, reason: string, now: Date): FailoverState {
  return { ...state, active, reason, changed_at: now.toISOString() };
}

// Counters saturate at their threshold so a steady primary leaves the state untouched and the
// probe writes nothing. A pinned state keeps counting, so the next probe after an unpin acts on
// what the counters already say.
export function applyPrimaryResult(
  state: FailoverState,
  healthy: boolean,
  now: Date = new Date(),
): { state: FailoverState; flipped: boolean } {
  const next = { ...state };
  if (healthy) {
    next.fails = 0;
    next.passes = Math.min(state.passes + 1, RECOVER_THRESHOLD);
  } else {
    next.passes = 0;
    next.fails = Math.min(state.fails + 1, FAIL_THRESHOLD);
  }
  if (next.pinned) return { state: next, flipped: false };
  if (!next.active && next.fails >= FAIL_THRESHOLD) {
    return { state: flip(next, true, 'primary unhealthy', now), flipped: true };
  }
  if (next.active && next.passes >= RECOVER_THRESHOLD) {
    return { state: flip(next, false, 'primary recovered', now), flipped: true };
  }
  return { state: next, flipped: false };
}

// One alert when the standby has been down for the threshold, re-armed once it passes again.
export function applyStandbyResult(
  state: FailoverState,
  healthy: boolean,
): { state: FailoverState; alert: boolean } {
  const next = { ...state };
  if (healthy) {
    next.standby_fails = 0;
    next.standby_alerted = false;
    return { state: next, alert: false };
  }
  next.standby_fails = Math.min(state.standby_fails + 1, STANDBY_FAIL_THRESHOLD);
  const alert = next.standby_fails >= STANDBY_FAIL_THRESHOLD && !next.standby_alerted;
  if (alert) next.standby_alerted = true;
  return { state: next, alert };
}

export function flipMessage(active: boolean, cause: string): string {
  return active
    ? `api-gateway: failover ON, serving read-only from standby (${cause})`
    : `api-gateway: failover OFF, back on primary (${cause})`;
}

export async function sendTelegram(env: AlertEnv, text: string): Promise<void> {
  const token = env.TELEGRAM_ALERTS_BOT_TOKEN;
  const chatId = env.TELEGRAM_ALERTS_CHAT_ID;
  if (!token || !chatId) {
    console.log('[failover:telegram] not configured, skipped');
    return;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    console.log(`[failover:telegram] status=${res.status}`);
  } catch (err) {
    console.log(`[failover:telegram] error: ${err}`);
  }
}

// --- KV state ---

export async function readState(kv: KVNamespace): Promise<FailoverState> {
  try {
    const raw = await kv.get(FAILOVER_STATE_KEY);
    if (!raw) return initialState();
    return { ...initialState(), ...JSON.parse(raw) };
  } catch (err) {
    console.log(`[failover] state read error, assuming primary: ${err}`);
    return initialState();
  }
}

async function writeState(kv: KVNamespace, state: FailoverState): Promise<void> {
  await kv.put(FAILOVER_STATE_KEY, JSON.stringify(state));
  invalidateFailoverCache();
}

let cached: { state: FailoverState; at: number } | null = null;

export async function getFailoverState(kv: KVNamespace): Promise<FailoverState> {
  if (cached && Date.now() - cached.at < STATE_CACHE_MS) return cached.state;
  const state = await readState(kv);
  cached = { state, at: Date.now() };
  return state;
}

export function invalidateFailoverCache(): void {
  cached = null;
}

// --- Probe (cron) ---

async function probe(baseUrl: string, originSecret: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/health/?simple=true`, {
      headers: { 'x-worker-origin-secret': originSecret },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function runProbe(env: Env): Promise<FailoverState> {
  const stored = await readState(env.FAILOVER_KV);
  const [primaryOk, standbyOk] = await Promise.all([
    probe(env.ORIGIN_URL, env.WORKER_ORIGIN_SECRET),
    probe(env.STANDBY_ORIGIN_URL, env.WORKER_ORIGIN_SECRET),
  ]);

  const primary = applyPrimaryResult(stored, primaryOk);
  const standby = applyStandbyResult(primary.state, standbyOk);
  const next = standby.state;
  console.log(`[failover:probe] primary=${primaryOk ? 'ok' : 'fail'} standby=${standbyOk ? 'ok' : 'fail'} active=${next.active} pinned=${next.pinned} fails=${next.fails} passes=${next.passes} standby_fails=${next.standby_fails}`);

  if (JSON.stringify(next) !== JSON.stringify(stored)) await writeState(env.FAILOVER_KV, next);

  if (primary.flipped) {
    const cause = next.active ? `primary ${FAIL_THRESHOLD} failed probes` : `primary ${RECOVER_THRESHOLD} passed probes`;
    await sendTelegram(env, flipMessage(next.active, cause));
  }
  if (standby.alert) {
    await sendTelegram(env, `api-gateway: standby unhealthy (${STANDBY_FAIL_THRESHOLD} failed probes), failover has no target`);
  }
  return next;
}

// --- Management: GET/POST /__failover behind the cache management token ---

function stateResponse(state: FailoverState): Response {
  return new Response(JSON.stringify(state), { headers: { 'Content-Type': 'application/json' } });
}

function isOptionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === 'boolean';
}

export async function handleFailoverEndpoint(request: Request, env: Env): Promise<Response | null> {
  if (new URL(request.url).pathname !== MANAGEMENT_PATH) return null;
  if (!isAuthorized(request, env.CACHE_MGMT_TOKEN)) return new Response('Forbidden', { status: 403 });

  if (request.method === 'GET') return stateResponse(await readState(env.FAILOVER_KV));
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  let body: { active?: unknown; pinned?: unknown };
  try {
    body = await request.json();
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }
  if (!isOptionalBoolean(body.active) || !isOptionalBoolean(body.pinned)) {
    return new Response('active and pinned must be booleans', { status: 400 });
  }

  const current = await readState(env.FAILOVER_KV);
  const next: FailoverState = {
    ...current,
    active: body.active ?? current.active,
    pinned: body.pinned ?? current.pinned,
    fails: 0,
    passes: 0,
    reason: 'manual',
    changed_at: new Date().toISOString(),
  };
  await writeState(env.FAILOVER_KV, next);
  console.log(`[failover:manual] active=${next.active} pinned=${next.pinned}`);
  if (next.active !== current.active) await sendTelegram(env, flipMessage(next.active, 'manual'));
  return stateResponse(next);
}
