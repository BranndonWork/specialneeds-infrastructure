import { routedPath } from './origin';

// The POSTs that make the API email an address the caller typed: a login code, a signup
// verification, a claim verification. Anchored so a neighbouring path never matches, with the
// trailing slash optional because the gateway appends it on the way to origin.
const LOGIN_PATH = /^\/api\/v1\/user\/login\/?$/;
const SIGNUP_PATH = /^\/api\/v1\/listings\/signup\/?$/;
// The id segment is Django's <uuid:> converter, which accepts lowercase hex only.
const CLAIM_PATH = /^\/api\/v1\/listings\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/claim\/?$/;

function isSignupOrClaim(path: string): boolean {
  return SIGNUP_PATH.test(path) || CLAIM_PATH.test(path);
}

export function isSendRequest(method: string, pathname: string): boolean {
  if (method !== 'POST') return false;
  const path = routedPath(pathname);
  return LOGIN_PATH.test(path) || isSignupOrClaim(path);
}

// Signup and claim are reached legitimately only through the www proxy routes, which sign the
// visitor's identity. The claim route also runs the ALTCHA check a direct call would skip.
// Login is not listed: internal scripts post to it directly and carry no signature.
export function requiresVerifiedIdentity(method: string, pathname: string): boolean {
  return method === 'POST' && isSignupOrClaim(routedPath(pathname));
}
