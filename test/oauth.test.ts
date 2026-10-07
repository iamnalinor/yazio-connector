import { afterEach, describe, expect, it } from "bun:test";

import worker from "../src/index";
import { allowedRedirect, handleOAuthRequest, publicMcpUrl } from "../src/oauth";
import {
  decodeBase64Url,
  decodeSession,
  encodeBase64Url,
  encodeSession,
  offsetMinutes,
  type Session,
} from "../src/session";

describe("allowedRedirect", () => {
  it("accepts Claude's callbacks", () => {
    expect(allowedRedirect("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(allowedRedirect("https://claude.com/api/mcp/auth_callback")).toBe(true);
    expect(allowedRedirect("https://app.claude.ai/callback")).toBe(true);
  });

  it("accepts loopback over http for local testing", () => {
    expect(allowedRedirect("http://localhost:6274/oauth/callback")).toBe(true);
    expect(allowedRedirect("http://127.0.0.1:6274/callback")).toBe(true);
  });

  it("refuses hosts that merely look like Claude", () => {
    expect(allowedRedirect("https://claude.ai.evil.com/steal")).toBe(false);
    expect(allowedRedirect("https://notclaude.ai/steal")).toBe(false);
    expect(allowedRedirect("https://evil.com/?x=claude.ai")).toBe(false);
  });

  it("refuses plain http for non-loopback hosts", () => {
    expect(allowedRedirect("http://claude.ai/api/mcp/auth_callback")).toBe(false);
  });

  it("refuses junk and non-http schemes", () => {
    expect(allowedRedirect("not a url")).toBe(false);
    expect(allowedRedirect("javascript:alert(1)")).toBe(false);
    expect(allowedRedirect("data:text/html,<script>")).toBe(false);
  });

  it("refuses anything else", () => {
    expect(allowedRedirect("https://example.org/cb")).toBe(false);
  });
});

describe("publicMcpUrl", () => {
  it("always points at the bare request origin", () => {
    const url = publicMcpUrl(new Request("https://worker.workers.dev/token?x=1"));
    expect(url.toString()).toBe("https://worker.workers.dev/");
  });

  it("trusts x-forwarded-proto so the issuer stays https behind a proxy", () => {
    const url = publicMcpUrl(
      new Request("http://worker.workers.dev/authorize", {
        headers: { "x-forwarded-proto": "https,http" },
      }),
    );
    expect(url.toString()).toBe("https://worker.workers.dev/");
  });
});

describe("session tokens", () => {
  const session: Session = {
    accessToken: "yazio-access",
    refreshToken: "yazio-refresh",
    expiresAt: Date.now() + 60_000,
    country: "DE",
    sex: "male",
    timezoneOffsetMinutes: 180,
  };

  it("survives a round trip through the bearer token", () => {
    expect(decodeSession(encodeSession(session))).toEqual(session);
  });

  it("refuses an expired session", () => {
    expect(decodeSession(encodeSession({ ...session, expiresAt: Date.now() - 1 }))).toBeNull();
  });

  it("refuses junk and truncated tokens", () => {
    expect(decodeSession("not-a-token")).toBeNull();
    expect(decodeSession(encodeSession(session).slice(0, -4))).toBeNull();
    expect(decodeSession(btoa(JSON.stringify({ accessToken: "only" })))).toBeNull();
  });
});

describe("offsetMinutes", () => {
  it("reads each unit Yazio might be using", () => {
    expect(offsetMinutes(3)).toBe(180); // hours
    expect(offsetMinutes(-5)).toBe(-300);
    expect(offsetMinutes(180)).toBe(180); // minutes
    expect(offsetMinutes(-330)).toBe(-330);
    expect(offsetMinutes(10_800)).toBe(180); // seconds
    expect(offsetMinutes(-19_800)).toBe(-330);
  });

  it("ignores values that cannot be an offset at all", () => {
    expect(offsetMinutes(null)).toBeUndefined();
    expect(offsetMinutes(undefined)).toBeUndefined();
    expect(offsetMinutes(1.5)).toBeUndefined();
    expect(offsetMinutes(97)).toBeUndefined();
    expect(offsetMinutes(999_999)).toBeUndefined();
  });
});

describe("the refresh grant", () => {
  const realFetch = globalThis.fetch;
  const paths: string[] = [];
  const grants: string[] = [];

  /** Yazio answers a token grant, and would answer /user if anything asked. */
  function stubYazio() {
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(new Request(input).url).pathname;
      paths.push(path);
      if (path.endsWith("/oauth/token")) {
        const body = init?.body;
        const form = body instanceof URLSearchParams ? body : new URLSearchParams();
        grants.push(form.get("grant_type") ?? "");
      }
      const body = path.endsWith("/oauth/token")
        ? { access_token: "access-2", refresh_token: "rotated", expires_in: 172_800 }
        : { country: "de", sex: "female", timezone_offset: 60 };
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    }) as typeof fetch;
  }

  /** Yazio refusing a spent refresh token: 400 with an empty body, as it really does. */
  function stubRefusal() {
    globalThis.fetch = ((input: RequestInfo | URL) => {
      paths.push(new URL(new Request(input).url).pathname);
      return Promise.resolve(new Response("", { status: 400 }));
    }) as typeof fetch;
  }

  afterEach(() => {
    globalThis.fetch = realFetch;
    paths.length = 0;
    grants.length = 0;
  });

  const carry = (payload: Record<string, unknown>): string => encodeBase64Url(payload);

  /** The bodies here are our own; read them at the shape we issue. */
  async function issuedBy(response: Response | undefined) {
    const body: unknown = await response!.json();
    return body as { access_token: string; refresh_token: string };
  }

  const post = (refreshToken: string) =>
    handleOAuthRequest(
      new Request("https://connector.test/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
      }),
      {},
    );

  it("spends the one-shot Yazio token on nothing but the refresh itself", async () => {
    stubYazio();
    const carried = carry({
      refreshToken: "yazio-refresh-1",
      country: "RU",
      sex: "male",
      timezoneOffsetMinutes: 180,
    });

    const response = await post(carried);
    const issued = await issuedBy(response);

    // One request, and it is the grant. A second call here could fail after the
    // old refresh token was already burnt, stranding the user.
    expect(paths).toEqual(["/v20/oauth/token"]);

    const session = decodeSession(issued.access_token);
    expect(session?.country).toBe("RU");
    expect(session?.sex).toBe("male");
    expect(session?.timezoneOffsetMinutes).toBe(180);
  });

  it("signs in again rather than spending a Yazio refresh, which would kill other sessions", async () => {
    stubYazio();
    const response = await handleOAuthRequest(
      new Request("https://connector.test/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: carry({ refreshToken: "yazio-refresh-1", country: "RU", sex: "male" }),
          client_id: "someone@example.com",
          client_secret: "hunter2",
        }),
      }),
      {},
    );
    await issuedBy(response);

    expect(grants).toEqual(["password"]);
  });

  it("falls back to the refresh grant when no credentials came with the renewal", async () => {
    stubYazio();
    await post(carry({ refreshToken: "yazio-refresh-1", country: "RU", sex: "male" }));

    expect(grants).toEqual(["refresh_token"]);
  });

  it("hands back a refresh token that carries the profile on to the next one", async () => {
    stubYazio();
    const response = await post(
      carry({ refreshToken: "yazio-refresh-1", country: "RU", sex: "male" }),
    );
    const issued = await issuedBy(response);

    expect(decodeBase64Url(issued.refresh_token)).toMatchObject({
      refreshToken: "rotated",
      country: "RU",
      sex: "male",
    });
  });

  it("still asks for the profile when an old refresh token has none", async () => {
    stubYazio();
    const response = await post(carry({ refreshToken: "yazio-refresh-1" }));
    const issued = await issuedBy(response);

    expect(paths).toEqual(["/v20/oauth/token", "/v20/user"]);
    expect(decodeSession(issued.access_token)?.country).toBe("DE");
  });

  it("tells the client to start over when Yazio refuses the refresh", async () => {
    stubRefusal();
    const response = await post(carry({ refreshToken: "spent", country: "RU", sex: "male" }));

    expect(response!.status).toBe(400);
    expect(await response!.json()).toMatchObject({ error: "invalid_grant" });
  });
});

describe("a session Yazio turns down mid-call", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const dead: Session = {
    accessToken: "no-longer-valid",
    refreshToken: "r",
    // Decodes cleanly and has not expired: the bearer gate cannot catch this.
    expiresAt: Date.now() + 3_600_000,
    country: "RU",
    sex: "male",
  };

  async function call(method: string, params: unknown, sessionId?: string) {
    const headers: Record<string, string> = {
      authorization: `Bearer ${encodeSession(dead)}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (sessionId) headers["mcp-session-id"] = sessionId;

    return worker.fetch(
      new Request("https://connector.test/", {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      }),
      {},
    );
  }

  it("answers 401 so the client renews instead of showing a dead end", async () => {
    // Yazio refuses everything this token asks for.
    globalThis.fetch = ((input: RequestInfo | URL) => {
      void new Request(input);
      return Promise.resolve(
        new Response(JSON.stringify({ message: "Invalid credentials." }), { status: 401 }),
      );
    }) as typeof fetch;

    const opened = await call("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    const response = await call(
      "tools/call",
      { name: "get_goals", arguments: {} },
      opened.headers.get("mcp-session-id") ?? undefined,
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });
});
