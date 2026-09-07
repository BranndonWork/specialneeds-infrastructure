// POST /v1/ratelimit/:upstream — claim the next deployment-wide call slot for a named upstream.
// The request is held until the slot comes up, then answers 200. Same service token as the KV
// store, because the same server-side callers (the client's API routes) use both.

const PATH_PREFIX = '/v1/ratelimit/';

function isAuthorized(request: Request, secret: string): boolean {
  return Boolean(secret && request.headers.get('X-Sn-Service-Token') === secret);
}

export async function handleRateLimitSlot(
  request: Request,
  slots: DurableObjectNamespace,
  serviceToken: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(PATH_PREFIX)) return null;

  const upstream = url.pathname.slice(PATH_PREFIX.length).replace(/\/+$/, '');
  if (!upstream || upstream.includes('/')) return new Response('Missing upstream', { status: 400 });
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
  if (!isAuthorized(request, serviceToken)) return new Response('Forbidden', { status: 403 });

  const stub = slots.get(slots.idFromName(upstream));
  return stub.fetch(new Request('https://slot.internal/claim', { method: 'POST', body: request.body, headers: request.headers }));
}
