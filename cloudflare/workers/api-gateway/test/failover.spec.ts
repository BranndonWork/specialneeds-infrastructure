import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext, fetchMock } from 'cloudflare:test';
import worker from '../src/index';
import {
	FAILOVER_STATE_KEY,
	FAIL_THRESHOLD,
	RECOVER_THRESHOLD,
	STANDBY_FAIL_THRESHOLD,
	applyPrimaryResult,
	applyStandbyResult,
	getFailoverState,
	initialState,
	invalidateFailoverCache,
	readState,
	runProbe,
	type FailoverState,
} from '../src/failover';

// Must match the miniflare bindings in vitest.config.mts.
const MGMT_TOKEN = 'test-cache-mgmt-token';
const TELEGRAM_PATH = '/bottest-telegram-token/sendMessage';

function uniquePath(label: string): string {
	return `/api/v1/${label}-${crypto.randomUUID()}/`;
}

async function seedState(overrides: Partial<FailoverState>): Promise<void> {
	await env.FAILOVER_KV.put(FAILOVER_STATE_KEY, JSON.stringify({ ...initialState(), ...overrides }));
	invalidateFailoverCache();
}

async function storedState(): Promise<FailoverState> {
	return readState(env.FAILOVER_KV);
}

async function dispatch(request: Request): Promise<Response> {
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

function gatewayRequest(path: string, method = 'GET', body?: string): Request {
	return new Request(`https://api.test${path}`, {
		method,
		headers: { 'cf-connecting-ip': '198.51.100.77', 'content-type': 'application/json' },
		body,
	});
}

function mgmtRequest(method: string, body?: string, token: string | null = MGMT_TOKEN): Request {
	const headers = new Headers({ 'cf-connecting-ip': '198.51.100.78', 'content-type': 'application/json' });
	if (token) headers.set('X-Sn-Service-Token', token);
	return new Request('https://api.test/__failover', { method, headers, body });
}

function expectHealth(host: string, status: number): void {
	fetchMock.get(host).intercept({ path: '/health/?simple=true' }).reply(status, status === 200 ? 'ok' : 'down');
}

function expectTelegram(onText: (text: string) => void): void {
	fetchMock
		.get('https://api.telegram.org')
		.intercept({ path: TELEGRAM_PATH, method: 'POST' })
		.reply(200, (req) => {
			const body = JSON.parse(req.body as string);
			expect(body.chat_id).toBe('test-telegram-chat');
			onText(body.text);
			return '{"ok":true}';
		});
}

function repeat(state: FailoverState, healthy: boolean, times: number): FailoverState {
	let current = state;
	for (let i = 0; i < times; i++) current = applyPrimaryResult(current, healthy).state;
	return current;
}

describe('primary probe state rules', () => {
	it('flips on after the third consecutive failed probe and not before', () => {
		const twoFails = repeat(initialState(), false, FAIL_THRESHOLD - 1);
		expect(twoFails.active).toBe(false);
		expect(twoFails.fails).toBe(2);

		const third = applyPrimaryResult(twoFails, false);
		expect(third.flipped).toBe(true);
		expect(third.state.active).toBe(true);
		expect(third.state.reason).toBe('primary unhealthy');
	});

	it('flips off after the tenth consecutive passed probe and not before', () => {
		const active = { ...initialState(), active: true, reason: 'primary unhealthy' };
		const ninePasses = repeat(active, true, RECOVER_THRESHOLD - 1);
		expect(ninePasses.active).toBe(true);

		const tenth = applyPrimaryResult(ninePasses, true);
		expect(tenth.flipped).toBe(true);
		expect(tenth.state.active).toBe(false);
		expect(tenth.state.reason).toBe('primary recovered');
	});

	it('resets the fail counter on a pass and the pass counter on a fail', () => {
		const twoFails = repeat(initialState(), false, 2);
		const afterPass = applyPrimaryResult(twoFails, true).state;
		expect(afterPass.fails).toBe(0);
		expect(afterPass.passes).toBe(1);

		const afterFail = applyPrimaryResult(afterPass, false).state;
		expect(afterFail.passes).toBe(0);
		expect(afterFail.fails).toBe(1);
	});

	it('never flips on while pinned off, but keeps counting', () => {
		const pinned = { ...initialState(), pinned: true };
		const result = repeat(pinned, false, FAIL_THRESHOLD + 2);
		expect(result.active).toBe(false);
		expect(result.fails).toBe(FAIL_THRESHOLD);
	});

	it('never flips off while pinned on, but keeps counting', () => {
		const pinned = { ...initialState(), active: true, pinned: true };
		const result = repeat(pinned, true, RECOVER_THRESHOLD + 2);
		expect(result.active).toBe(true);
		expect(result.passes).toBe(RECOVER_THRESHOLD);
	});

	it('acts on the saturated counter on the first probe after an unpin', () => {
		const pinnedFailing = repeat({ ...initialState(), pinned: true }, false, FAIL_THRESHOLD);
		const unpinned = applyPrimaryResult({ ...pinnedFailing, pinned: false }, false);
		expect(unpinned.flipped).toBe(true);
		expect(unpinned.state.active).toBe(true);
	});

	it('leaves a steady healthy primary unchanged, so the probe has nothing to write', () => {
		const steady = repeat(initialState(), true, RECOVER_THRESHOLD);
		const next = applyPrimaryResult(steady, true);
		expect(next.flipped).toBe(false);
		expect(next.state).toEqual(steady);
	});
});

describe('standby probe alerting', () => {
	it('alerts once when the standby reaches the failure threshold', () => {
		let current = initialState();
		let alerts = 0;
		for (let i = 0; i < STANDBY_FAIL_THRESHOLD + 3; i++) {
			const result = applyStandbyResult(current, false);
			if (result.alert) alerts++;
			current = result.state;
		}
		expect(alerts).toBe(1);
		expect(current.standby_alerted).toBe(true);
	});

	it('re-arms the alert once the standby passes again', () => {
		let current = initialState();
		for (let i = 0; i < STANDBY_FAIL_THRESHOLD; i++) current = applyStandbyResult(current, false).state;
		current = applyStandbyResult(current, true).state;
		expect(current.standby_fails).toBe(0);
		expect(current.standby_alerted).toBe(false);

		for (let i = 0; i < STANDBY_FAIL_THRESHOLD - 1; i++) current = applyStandbyResult(current, false).state;
		expect(applyStandbyResult(current, false).alert).toBe(true);
	});
});

describe('runProbe against the origins', () => {
	beforeAll(() => {
		fetchMock.activate();
		fetchMock.disableNetConnect();
	});
	beforeEach(() => seedState({}));
	afterEach(() => fetchMock.assertNoPendingInterceptors());

	it('sends the origin secret on both health probes', async () => {
		for (const host of ['https://origin.test', 'https://standby.test']) {
			fetchMock
				.get(host)
				.intercept({ path: '/health/?simple=true', headers: { 'x-worker-origin-secret': 'test-origin-secret' } })
				.reply(200, 'ok');
		}

		const state = await runProbe(env);

		expect(state.passes).toBe(1);
		expect(state.standby_fails).toBe(0);
	});

	it('counts a non-2xx primary answer as a failure', async () => {
		expectHealth('https://origin.test', 502);
		expectHealth('https://standby.test', 200);

		const state = await runProbe(env);

		expect(state.fails).toBe(1);
		expect(state.active).toBe(false);
	});

	it('counts an unreachable primary as a failure', async () => {
		fetchMock.get('https://origin.test').intercept({ path: '/health/?simple=true' }).replyWithError(new Error('connection refused'));
		expectHealth('https://standby.test', 200);

		const state = await runProbe(env);

		expect(state.fails).toBe(1);
	});

	it('flips on at the third failure, persists it, and tells Telegram', async () => {
		await seedState({ fails: FAIL_THRESHOLD - 1 });
		expectHealth('https://origin.test', 500);
		expectHealth('https://standby.test', 200);
		let sent = '';
		expectTelegram((text) => { sent = text; });

		await runProbe(env);

		const stored = await storedState();
		expect(stored.active).toBe(true);
		expect(stored.reason).toBe('primary unhealthy');
		expect(sent).toBe('api-gateway: failover ON, serving read-only from standby (primary 3 failed probes)');
	});

	it('skips its write and its alert when the state changed during the probes', async () => {
		await seedState({ fails: FAIL_THRESHOLD - 1 });
		expectHealth('https://origin.test', 500);
		expectHealth('https://standby.test', 200);
		const manualPin = JSON.stringify({ ...initialState(), pinned: true, reason: 'manual' });
		let reads = 0;
		const racingKv = {
			get: async (key: string) => (++reads === 2 ? manualPin : env.FAILOVER_KV.get(key)),
			put: (key: string, value: string) => env.FAILOVER_KV.put(key, value),
		} as unknown as KVNamespace;

		const result = await runProbe({ ...env, FAILOVER_KV: racingKv });

		expect(result?.pinned).toBe(true);
		const stored = await storedState();
		expect(stored.active).toBe(false);
		expect(stored.fails).toBe(FAIL_THRESHOLD - 1);
	});

	it('skips the cycle when the state cannot be read', async () => {
		const brokenKv = {
			get: async () => { throw new Error('kv unavailable'); },
			put: (key: string, value: string) => env.FAILOVER_KV.put(key, value),
		} as unknown as KVNamespace;

		const result = await runProbe({ ...env, FAILOVER_KV: brokenKv });

		expect(result).toBeNull();
		expect((await storedState()).fails).toBe(0);
	});

	it('flips off at the tenth pass and tells Telegram', async () => {
		await seedState({ active: true, passes: RECOVER_THRESHOLD - 1, reason: 'primary unhealthy' });
		expectHealth('https://origin.test', 200);
		expectHealth('https://standby.test', 200);
		let sent = '';
		expectTelegram((text) => { sent = text; });

		await runProbe(env);

		expect((await storedState()).active).toBe(false);
		expect(sent).toBe(`api-gateway: failover OFF, back on primary (primary ${RECOVER_THRESHOLD} passed probes)`);
	});

	it('alerts once when the standby has failed ten probes', async () => {
		await seedState({ standby_fails: STANDBY_FAIL_THRESHOLD - 1 });
		expectHealth('https://origin.test', 200);
		expectHealth('https://standby.test', 503);
		let sent = '';
		expectTelegram((text) => { sent = text; });

		await runProbe(env);

		expect(sent).toContain('standby unhealthy');
		expect((await storedState()).standby_alerted).toBe(true);
	});

	it('does not write KV when nothing changed', async () => {
		await seedState({ passes: RECOVER_THRESHOLD });
		const before = await env.FAILOVER_KV.get(FAILOVER_STATE_KEY);
		expectHealth('https://origin.test', 200);
		expectHealth('https://standby.test', 200);

		await runProbe(env);

		expect(await env.FAILOVER_KV.get(FAILOVER_STATE_KEY)).toBe(before);
	});

	it('runs from the scheduled handler', async () => {
		expectHealth('https://origin.test', 200);
		expectHealth('https://standby.test', 200);

		const ctx = createExecutionContext();
		await worker.scheduled({ scheduledTime: Date.now(), cron: '* * * * *', noRetry() {} } as ScheduledController, env, ctx);
		await waitOnExecutionContext(ctx);

		expect((await storedState()).passes).toBe(1);
	});
});

describe('in-memory state cache', () => {
	it('serves the cached decision until invalidated', async () => {
		await seedState({ active: false });
		expect((await getFailoverState(env.FAILOVER_KV)).active).toBe(false);

		await env.FAILOVER_KV.put(FAILOVER_STATE_KEY, JSON.stringify({ ...initialState(), active: true }));
		expect((await getFailoverState(env.FAILOVER_KV)).active).toBe(false);

		invalidateFailoverCache();
		expect((await getFailoverState(env.FAILOVER_KV)).active).toBe(true);
	});

	it('assumes primary when no state has been written', async () => {
		await env.FAILOVER_KV.delete(FAILOVER_STATE_KEY);
		invalidateFailoverCache();
		expect((await getFailoverState(env.FAILOVER_KV)).active).toBe(false);
	});
});

describe('fetch routing while failover is active', () => {
	beforeAll(() => {
		fetchMock.activate();
		fetchMock.disableNetConnect();
	});
	afterEach(() => fetchMock.assertNoPendingInterceptors());

	it('sends a GET to the standby and labels the response', async () => {
		await seedState({ active: true });
		const path = uniquePath('standby-get');
		fetchMock
			.get('https://standby.test')
			.intercept({ path, headers: { 'x-worker-origin-secret': 'test-origin-secret' } })
			.reply(200, '{"from":"standby"}', { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

		const response = await dispatch(gatewayRequest(path));

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ from: 'standby' });
		expect(response.headers.get('x-sn-origin')).toBe('standby');
	});

	it('sends a HEAD to the standby through the proxy path', async () => {
		await seedState({ active: true });
		const path = uniquePath('standby-head');
		fetchMock.get('https://standby.test').intercept({ path, method: 'HEAD' }).reply(200, '');

		const response = await dispatch(gatewayRequest(path, 'HEAD'));

		expect(response.status).toBe(200);
		expect(response.headers.get('x-sn-origin')).toBe('standby');
	});

	// With net connect disabled, a POST that reached either origin would surface as the proxy's
	// 503 "Service unavailable", so the read-only body proves no origin was called.
	it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('pauses a %s with a 503 read-only answer', async (method) => {
		await seedState({ active: true });

		const response = await dispatch(gatewayRequest(uniquePath('write'), method, '{}'));

		expect(response.status).toBe(503);
		expect(response.headers.get('Retry-After')).toBe('300');
		expect(response.headers.get('content-type')).toBe('application/json');
		expect(await response.json()).toEqual({ error: 'read-only', detail: 'primary unavailable, writes are paused' });
	});

	it('sends a GET to the primary and labels the response when not active', async () => {
		await seedState({ active: false });
		const path = uniquePath('primary-get');
		fetchMock
			.get('https://origin.test')
			.intercept({ path })
			.reply(200, '{"from":"primary"}', { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

		const response = await dispatch(gatewayRequest(path));

		expect(await response.json()).toEqual({ from: 'primary' });
		expect(response.headers.get('x-sn-origin')).toBe('primary');
	});

	it('lets a POST through to the primary when not active', async () => {
		await seedState({ active: false });
		const path = uniquePath('primary-post');
		fetchMock.get('https://origin.test').intercept({ path, method: 'POST' }).reply(201, '{"ok":true}', { headers: { 'content-type': 'application/json' } });

		const response = await dispatch(gatewayRequest(path, 'POST', '{}'));

		expect(response.status).toBe(201);
		expect(response.headers.get('x-sn-origin')).toBe('primary');
	});
});

describe('GET/POST /__failover management route', () => {
	beforeAll(() => {
		fetchMock.activate();
		fetchMock.disableNetConnect();
	});
	beforeEach(() => seedState({}));
	afterEach(() => fetchMock.assertNoPendingInterceptors());

	it('answers an unauthenticated request the way the cache management route does', async () => {
		const response = await dispatch(mgmtRequest('GET', undefined, null));

		expect(response.status).toBe(403);
		expect(await response.text()).toBe('Forbidden');
	});

	it('rejects a wrong token', async () => {
		const response = await dispatch(mgmtRequest('GET', undefined, 'wrong-token'));

		expect(response.status).toBe(403);
	});

	it('returns the stored state on GET', async () => {
		await seedState({ active: true, pinned: true, fails: 3, reason: 'primary unhealthy' });

		const response = await dispatch(mgmtRequest('GET'));

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ active: true, pinned: true, fails: 3, reason: 'primary unhealthy' });
	});

	it('turns failover on by hand, resets counters, writes KV, and tells Telegram', async () => {
		await seedState({ active: false, fails: 2, passes: 0 });
		let sent = '';
		expectTelegram((text) => { sent = text; });

		const response = await dispatch(mgmtRequest('POST', JSON.stringify({ active: true })));

		expect(response.status).toBe(200);
		const stored = await storedState();
		expect(stored).toMatchObject({ active: true, fails: 0, passes: 0, reason: 'manual' });
		expect(sent).toBe('api-gateway: failover ON, serving read-only from standby (manual)');
	});

	it('turns failover off by hand and tells Telegram', async () => {
		await seedState({ active: true, passes: 7 });
		let sent = '';
		expectTelegram((text) => { sent = text; });

		await dispatch(mgmtRequest('POST', JSON.stringify({ active: false })));

		expect((await storedState()).active).toBe(false);
		expect(sent).toBe('api-gateway: failover OFF, back on primary (manual)');
	});

	it('pins without flipping and sends no Telegram message', async () => {
		await seedState({ active: false, fails: 2 });

		const response = await dispatch(mgmtRequest('POST', JSON.stringify({ pinned: true })));

		expect(await response.json()).toMatchObject({ active: false, pinned: true, fails: 0 });
	});

	// The warm-up request fills the 30 s in-memory cache with "not active"; the manual flip must
	// drop that cache or the next request would still go to the primary.
	it('takes effect on the very next request', async () => {
		await seedState({ active: false });
		const warmPath = uniquePath('warm-cache');
		fetchMock.get('https://origin.test').intercept({ path: warmPath, method: 'POST' }).reply(200, '{}');
		expect((await dispatch(gatewayRequest(warmPath, 'POST', '{}'))).status).toBe(200);
		expectTelegram(() => undefined);

		await dispatch(mgmtRequest('POST', JSON.stringify({ active: true })));
		const response = await dispatch(gatewayRequest(uniquePath('after-flip'), 'POST', '{}'));

		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({ error: 'read-only' });
	});

	it('rejects a non-boolean field', async () => {
		const response = await dispatch(mgmtRequest('POST', JSON.stringify({ active: 'yes' })));

		expect(response.status).toBe(400);
	});

	it('rejects a method other than GET or POST', async () => {
		const response = await dispatch(mgmtRequest('DELETE'));

		expect(response.status).toBe(405);
	});
});
