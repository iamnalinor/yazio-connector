/**
 * Rate limits.
 *
 * Two surfaces need a ceiling. `/token` is an unauthenticated login proxy: it
 * hands whatever it is given to Yazio's password grant, so an open deployment
 * can be driven as a password-guessing oracle. The MCP endpoint amplifies: one
 * tool call can fan out into dozens of Yazio requests, and a runaway client gets
 * the Worker throttled upstream.
 *
 * Cloudflare's rate limit binding does this with nothing to provision — the
 * namespaces live in `wrangler.jsonc` alone, so the deploy button still asks
 * for nothing. Its two limits shape everything here: counting is **per-colo**,
 * not global, and the window is only 10 or 60 seconds. That makes this a ceiling
 * on abuse, not a guarantee; a public deployment still wants a Cloudflare
 * rate-limiting rule in front of it.
 *
 * Everything fails open. A missing binding or a limiter that throws lets the
 * request through: locking someone out of their own food diary is the worse
 * outcome, and the hard guarantee was never on offer anyway.
 */

import { sha256Base64Url } from "./session";

export interface Env {
  /** `/token`, keyed by client IP. */
  TOKEN_LIMIT?: RateLimit;
  /** The MCP endpoint, keyed by session. */
  MCP_LIMIT?: RateLimit;
}

/** Every caller Cloudflare gave no IP for shares this one, rather than a key of "". */
const UNKNOWN_IP = "unknown-ip";

export function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip")?.trim() || UNKNOWN_IP;
}

/**
 * A rate-limit key for a bearer token.
 *
 * The token *is* the Yazio session, so it never leaves this Worker as a key;
 * only its digest does.
 */
export function tokenKey(token: string): Promise<string> {
  return sha256Base64Url(token);
}

/** Whether the request may proceed. */
export async function allow(limiter: RateLimit | undefined, key: string): Promise<boolean> {
  if (!limiter) return true;
  try {
    const { success } = await limiter.limit({ key });
    return success;
  } catch {
    return true;
  }
}

/** Seconds a refused caller is told to wait — one full window. */
const RETRY_AFTER_SECONDS = 60;

export const RETRY_AFTER_HEADERS = { "retry-after": String(RETRY_AFTER_SECONDS) };

export function tooManyRequests(message: string): Response {
  return new Response(`${message}\n`, {
    status: 429,
    headers: { "content-type": "text/plain; charset=utf-8", ...RETRY_AFTER_HEADERS },
  });
}
