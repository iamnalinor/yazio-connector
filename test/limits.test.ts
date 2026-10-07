import { describe, expect, it } from "bun:test";

import { allow, clientIp, tokenKey, tooManyRequests } from "../src/limits";

/** A limiter that answers as told, and records the keys it was given. */
function fakeLimiter(success: boolean): RateLimit & { keys: string[] } {
  const keys: string[] = [];
  return {
    keys,
    limit({ key }) {
      keys.push(key);
      return Promise.resolve({ success });
    },
  };
}

const requestWith = (headers: HeadersInit) => new Request("https://worker.dev/token", { headers });

describe("clientIp", () => {
  it("reads the header Cloudflare sets", () => {
    expect(clientIp(requestWith({ "cf-connecting-ip": "203.0.113.7" }))).toBe("203.0.113.7");
  });

  it("trims it", () => {
    expect(clientIp(requestWith({ "cf-connecting-ip": " 203.0.113.7 " }))).toBe("203.0.113.7");
  });

  it("puts every caller without one on a single shared key", () => {
    const missing = clientIp(requestWith({}));
    const blank = clientIp(requestWith({ "cf-connecting-ip": "  " }));
    expect(missing).toBe(blank);
    expect(missing).not.toBe("");
  });
});

describe("tokenKey", () => {
  const token = "eyJhY2Nlc3NUb2tlbiI6InNlY3JldCJ9";

  it("is stable for the same token", async () => {
    expect(await tokenKey(token)).toBe(await tokenKey(token));
  });

  it("differs per token", async () => {
    expect(await tokenKey(token)).not.toBe(await tokenKey(`${token}x`));
  });

  it("does not carry the token — it is the Yazio session", async () => {
    const key = await tokenKey(token);
    expect(key).not.toContain(token);
    expect(token).not.toContain(key);
    expect(key).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("allow", () => {
  it("lets the request through when no limiter is bound", async () => {
    expect(await allow(undefined, "key")).toBe(true);
  });

  it("passes the key on and honours the answer", async () => {
    const permissive = fakeLimiter(true);
    expect(await allow(permissive, "key")).toBe(true);
    expect(permissive.keys).toEqual(["key"]);

    expect(await allow(fakeLimiter(false), "key")).toBe(false);
  });

  it("fails open when the limiter throws", async () => {
    const broken: RateLimit = {
      limit: () => Promise.reject(new Error("limiter is down")),
    };
    expect(await allow(broken, "key")).toBe(true);
  });
});

describe("tooManyRequests", () => {
  it("is a 429 telling the caller how long to wait", () => {
    const response = tooManyRequests("Slow down.");
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
  });
});
