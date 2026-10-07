/**
 * The MCP access token.
 *
 * The connector stores nothing, so everything a tool call needs travels in the
 * bearer token: the Yazio token pair plus the two profile bits that would
 * otherwise cost a `/user` request on every call. It is base64url JSON, not a
 * signed blob — there is no server secret to sign with, and nothing here is a
 * claim the connector makes. The token *is* a Yazio session; whoever holds it
 * can use that account until it expires.
 */

import type { Sex } from "./yazio/api";

export interface Session {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds, from Yazio's own `expires_in`. */
  expiresAt: number;
  /** Food database to search by default, e.g. `DE`. */
  country: string;
  /** Product search is refused without it, though it does not change results. */
  sex: Sex;
  /** Minutes from UTC, when the profile reported a plausible value. */
  timezoneOffsetMinutes?: number;
}

const encoder = new TextEncoder();

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

export function encodeBase64Url(value: unknown): string {
  return bytesToBase64Url(encoder.encode(JSON.stringify(value)));
}

export function decodeBase64Url<T>(value: string): T | null {
  try {
    return JSON.parse(new TextDecoder().decode(fromBase64Url(value))) as T;
  } catch {
    return null;
  }
}

/** SHA-256 as base64url. Used for PKCE challenges and for rate-limit keys. */
export async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

export function encodeSession(session: Session): string {
  return encodeBase64Url(session);
}

/** Decode a bearer token, rejecting anything malformed or expired. */
export function decodeSession(token: string): Session | null {
  const session = decodeBase64Url<Partial<Session>>(token);
  if (
    !session ||
    typeof session.accessToken !== "string" ||
    typeof session.refreshToken !== "string" ||
    typeof session.expiresAt !== "number" ||
    typeof session.country !== "string" ||
    (session.sex !== "male" && session.sex !== "female") ||
    session.expiresAt <= Date.now()
  ) {
    return null;
  }
  return session as Session;
}

/**
 * Normalise Yazio's `timezone_offset`, whose unit is undocumented.
 *
 * Real UTC offsets make the three candidate units disjoint: no zone is more
 * than 14 hours out, none is a non-zero number of minutes below 15, and none is
 * a number of seconds that is not a multiple of 900. So each range below has
 * exactly one possible reading, and anything outside them is ignored.
 */
export function offsetMinutes(raw: number | null | undefined): number | undefined {
  if (typeof raw !== "number" || !Number.isInteger(raw)) return undefined;
  const magnitude = Math.abs(raw);

  if (magnitude <= 14) return raw * 60; // hours
  if (magnitude <= 840 && raw % 15 === 0) return raw; // minutes
  if (magnitude <= 50_400 && raw % 900 === 0) return raw / 60; // seconds
  return undefined;
}
