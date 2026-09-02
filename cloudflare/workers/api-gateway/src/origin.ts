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
