// Django's STATIC_URL. Whitenoise serves these as literal filenames, so a trailing slash is a
// 404 rather than a redirect to the real file.
const STATIC_PREFIX = '/static/';

// Django's APPEND_SLASH answers a slash-less app path with a 301, costing a second round trip,
// so the gateway appends the slash itself. Static files are the exception: appending there
// 404s the file. Three such 404s under /static/admin/ are all CrowdSec's admin-probing
// scenario needs to ban the visitor, which is how opening the Django admin locked the founder
// out of the whole API on 2026-09-02.
function originPathname(pathname: string): string {
  if (pathname.endsWith('/')) return pathname;
  if (pathname.startsWith(STATIC_PREFIX)) return pathname;
  return `${pathname}/`;
}

// The origin server percent-decodes the path before Django routes it, so `/api/v1/toke%6e/` reaches
// the token view. Anything that decides by path matches this, never the raw pathname, or an
// encoded letter moves a request onto a looser tier or past a gate.
export function routedPath(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

export const CLIENT_IP_HEADER = 'x-sn-client-ip';

// The origin sits behind a Cloudflare Tunnel, so this fetch re-enters Cloudflare and the edge
// resets CF-Connecting-IP to the Worker's own egress address. The visitor's address therefore
// rides in a header of ours, which Django trusts only next to the origin secret, and in
// X-Forwarded-For, where Cloudflare appends its own address and Traefik logs the list for
// CrowdSec. A verified identity wins over the connecting address, which behind the www proxy
// is Vercel's egress.
export function forwardVisitorIp(headers: Headers, request: Request, verifiedIp: string | null): void {
  const visitorIp = verifiedIp ?? request.headers.get('cf-connecting-ip');
  if (!visitorIp) return;
  headers.set('CF-Connecting-IP', visitorIp);
  headers.set(CLIENT_IP_HEADER, visitorIp);
  headers.set('X-Forwarded-For', visitorIp);
}

// Both origin paths — the cached GET fetch and the pass-through proxy — address the origin
// through here, so the slash rule cannot drift between them.
export function toOriginUrl(requestUrl: string, originBase: string): URL {
  const origin = new URL(originBase);
  const target = new URL(requestUrl);
  target.protocol = origin.protocol;
  target.hostname = origin.hostname;
  target.port = origin.port;
  target.pathname = originPathname(target.pathname);
  return target;
}
