/**
 * OAuth 2.1 in front of an API that only has a password grant.
 *
 * claude.ai's "Add custom connector" dialog speaks OAuth and nothing else, and
 * it offers exactly two free-text fields. ChatGPT's connector dialog (under
 * advanced OAuth settings) and Codex's `--oauth-client-id/--oauth-client-secret`
 * offer the same two. So this connector uses them for what Yazio actually needs:
 *
 *   OAuth Client ID     → your Yazio email
 *   OAuth Client Secret → your Yazio password
 *
 * `/token` exchanges them for a real Yazio token and hands that back as the MCP
 * access token (see `src/session.ts`). Nothing is stored, no server secret
 * exists, and every user brings their own account.
 *
 * The authorization code is a plain base64url blob rather than a signed one:
 * with no server secret there is nothing to sign with, and the code carries no
 * authority — it is only redeemable together with the Yazio password, and
 * `/token` refuses a code whose email is not the one presenting it. Discovery
 * documents and bearer parsing come from the MCP SDK, so they match the spec
 * the client checks against.
 */

import {
  OAuthError,
  OAuthErrorCode,
  getOAuthProtectedResourceMetadataUrl,
  oauthMetadataResponse,
  requireBearerAuth,
  type AuthInfo,
  type AuthMetadataOptions,
} from "@modelcontextprotocol/server";

import { allow, clientIp, RETRY_AFTER_HEADERS, type Env } from "./limits";
import {
  decodeBase64Url,
  decodeSession,
  encodeBase64Url,
  encodeSession,
  offsetMinutes,
  sha256Base64Url,
  type Session,
} from "./session";
import { getUser, login, refresh, YazioApiError, type YazioToken } from "./yazio/api";

const SCOPE = "mcp";
const CODE_TTL_SECONDS = 5 * 60;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Hosts Claude and ChatGPT use for their OAuth callbacks, plus loopback — which
 * is where Codex (and any other local client) listens, and where tests run.
 */
const REDIRECT_HOSTS = [
  "claude.ai",
  "claude.com",
  "chatgpt.com",
  "chat.openai.com",
  "localhost",
  "127.0.0.1",
];

interface AuthorizationCode {
  email: string;
  redirectUri: string;
  challenge?: string;
  /** Epoch seconds. */
  exp: number;
}

// --- helpers ---------------------------------------------------------------

function metadataOptions(mcpUrl: URL): AuthMetadataOptions {
  const issuer = mcpUrl.origin;

  return {
    resourceServerUrl: mcpUrl,
    resourceName: "Yazio",
    scopesSupported: [SCOPE],
    dangerouslyAllowInsecureIssuerUrl: mcpUrl.protocol !== "https:",
    oauthMetadata: {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
      scopes_supported: [SCOPE],
    },
  };
}

/**
 * Public URL of the MCP endpoint — the bare origin, so the connector is added
 * to Claude by host alone. Honours the proxy headers Cloudflare sets.
 */
export function publicMcpUrl(request: Request): URL {
  const url = new URL(request.url);
  const forwardedProto = request.headers.get("x-forwarded-proto");
  if (forwardedProto) url.protocol = `${forwardedProto.split(",")[0].trim()}:`;
  url.pathname = "/";
  url.search = "";
  return url;
}

/**
 * Codes may only be delivered to Claude's or ChatGPT's own callback, or to
 * loopback for Codex and testing. Matching is exact-host or a real subdomain, never a suffix, so
 * `claude.ai.evil.com` and `notclaude.ai` are refused.
 */
export function allowedRedirect(target: string): boolean {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return false;
  }

  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !loopback) return false;

  return REDIRECT_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
}

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
};

function jsonResponse(body: unknown, status = 200, extra: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...CORS_HEADERS,
      ...extra,
    },
  });
}

function oauthErrorResponse(
  error: string,
  description: string,
  status = 400,
  extra: HeadersInit = {},
): Response {
  return jsonResponse({ error, error_description: description }, status, extra);
}

/** Plain-text page for setup mistakes, which must not be redirected onwards. */
function setupError(message: string): Response {
  return new Response(`${message}\n`, {
    status: 400,
    headers: { "content-type": "text/plain; charset=utf-8", ...CORS_HEADERS },
  });
}

function redirectWithError(redirectUri: string, error: string, state: string | null): Response {
  const target = new URL(redirectUri);
  target.searchParams.set("error", error);
  if (state) target.searchParams.set("state", state);
  return Response.redirect(target.toString(), 302);
}

/** Credentials from the request body or an HTTP Basic header. */
function readClientCredentials(
  form: URLSearchParams,
  request: Request,
): { email: string; password: string } {
  const header = request.headers.get("authorization");
  if (header?.toLowerCase().startsWith("basic ")) {
    try {
      const [id, ...secret] = atob(header.slice(6)).split(":");
      return { email: decodeURIComponent(id), password: decodeURIComponent(secret.join(":")) };
    } catch {
      // Fall through to the form values.
    }
  }

  return { email: form.get("client_id") ?? "", password: form.get("client_secret") ?? "" };
}

// --- endpoints -------------------------------------------------------------

function handleAuthorize(request: Request): Response {
  const params = new URL(request.url).searchParams;
  const redirectUri = params.get("redirect_uri");
  const state = params.get("state");
  const email = params.get("client_id") ?? "";

  if (!redirectUri) return setupError("Missing redirect_uri.");
  if (!allowedRedirect(redirectUri)) {
    return setupError(
      `redirect_uri ${redirectUri} is not allowed; only Claude's, ChatGPT's and loopback callbacks are.`,
    );
  }

  // A missing or malformed email is a setup mistake, so say so in plain text
  // instead of bouncing an opaque error back into the connector dialog.
  if (!EMAIL.test(email)) {
    return setupError(
      `"${email}" is not an email address. Put your Yazio email in the connector's ` +
        `"OAuth Client ID" field and your Yazio password in "OAuth Client Secret".`,
    );
  }

  if (params.get("response_type") !== "code") {
    return redirectWithError(redirectUri, "unsupported_response_type", state);
  }

  const challenge = params.get("code_challenge");
  const challengeMethod = params.get("code_challenge_method");
  if (challenge && challengeMethod && challengeMethod !== "S256") {
    return redirectWithError(redirectUri, "invalid_request", state);
  }

  const code = encodeBase64Url({
    email,
    redirectUri,
    challenge: challenge ?? undefined,
    exp: Math.floor(Date.now() / 1000) + CODE_TTL_SECONDS,
  } satisfies AuthorizationCode);

  const target = new URL(redirectUri);
  target.searchParams.set("code", code);
  if (state) target.searchParams.set("state", state);
  return Response.redirect(target.toString(), 302);
}

/** The profile fields a session needs beyond the Yazio token itself. */
type Profile = Pick<Session, "country" | "sex" | "timezoneOffsetMinutes">;

async function fetchProfile(accessToken: string): Promise<Profile> {
  const user = await getUser(accessToken);
  return {
    country: (user.food_database_country ?? user.country ?? "US").slice(0, 2).toUpperCase(),
    sex: user.sex === "female" ? "female" : "male",
    timezoneOffsetMinutes: offsetMinutes(user.timezone_offset),
  };
}

/**
 * Turn a fresh Yazio token into the MCP token pair the client will store.
 *
 * `profile` is passed in on a refresh. Yazio's refresh tokens are single use:
 * the moment one is spent the old one is dead, so anything that can fail after
 * that point — a profile fetch, say — would strand the user with no way back
 * but reconnecting by hand. The refresh token carries the profile for exactly
 * that reason, and this function then makes no further request.
 */
async function issueTokens(token: YazioToken, profile?: Profile) {
  const session: Session = { ...token, ...(profile ?? (await fetchProfile(token.accessToken))) };

  return {
    access_token: encodeSession(session),
    token_type: "Bearer",
    expires_in: Math.max(Math.floor((session.expiresAt - Date.now()) / 1000), 0),
    scope: SCOPE,
    refresh_token: encodeBase64Url({
      refreshToken: session.refreshToken,
      country: session.country,
      sex: session.sex,
      timezoneOffsetMinutes: session.timezoneOffsetMinutes,
    }),
  };
}

async function handleToken(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return oauthErrorResponse("invalid_request", "The token endpoint only accepts POST.", 405);
  }

  // Above the grant parsing, so a refused caller never reaches Yazio's login.
  if (!(await allow(env.TOKEN_LIMIT, clientIp(request)))) {
    return oauthErrorResponse(
      "temporarily_unavailable",
      "Too many sign-in attempts from this address. Wait a minute and try again.",
      429,
      RETRY_AFTER_HEADERS,
    );
  }

  const form = new URLSearchParams(await request.text());
  const grantType = form.get("grant_type");

  try {
    if (grantType === "refresh_token") {
      const stored = decodeBase64Url<{ refreshToken?: string } & Partial<Profile>>(
        form.get("refresh_token") ?? "",
      );
      if (!stored?.refreshToken) {
        return oauthErrorResponse("invalid_grant", "The refresh token is not valid.");
      }

      // Tokens issued before the profile was carried here have to ask for it,
      // and rotate into the new shape on the way out.
      const profile: Profile | undefined =
        stored.country && stored.sex
          ? {
              country: stored.country,
              sex: stored.sex,
              timezoneOffsetMinutes: stored.timezoneOffsetMinutes,
            }
          : undefined;

      /**
       * Sign in again rather than use Yazio's refresh grant.
       *
       * A Yazio refresh invalidates every other access token on the account —
       * not just the one it replaces — so refreshing here kills the session on
       * the user's phone, and the phone refreshing kills this one. Signing in
       * afresh costs one request and disturbs nothing. Credentials come with
       * every renewal because this connector's OAuth client id and secret are
       * the Yazio email and password.
       */
      const { email, password } = readClientCredentials(form, request);
      const renewed =
        email && password ? await login(email, password) : await refresh(stored.refreshToken);

      return jsonResponse(await issueTokens(renewed, profile));
    }

    if (grantType !== "authorization_code") {
      return oauthErrorResponse(
        "unsupported_grant_type",
        "Supported grants are authorization_code and refresh_token.",
      );
    }

    const code = decodeBase64Url<AuthorizationCode>(form.get("code") ?? "");
    if (!code?.email || !code.redirectUri || code.exp < Math.floor(Date.now() / 1000)) {
      return oauthErrorResponse("invalid_grant", "The authorization code is not valid or expired.");
    }

    const redirectUri = form.get("redirect_uri");
    if (redirectUri && redirectUri !== code.redirectUri) {
      return oauthErrorResponse(
        "invalid_grant",
        "redirect_uri does not match the /authorize call.",
      );
    }

    if (code.challenge) {
      const verifier = form.get("code_verifier");
      if (!verifier) {
        return oauthErrorResponse("invalid_request", "Missing code_verifier (PKCE).");
      }
      if ((await sha256Base64Url(verifier)) !== code.challenge) {
        return oauthErrorResponse("invalid_grant", "code_verifier does not match code_challenge.");
      }
    }

    const { email, password } = readClientCredentials(form, request);
    if (email.toLowerCase() !== code.email.toLowerCase()) {
      return oauthErrorResponse(
        "invalid_grant",
        "The code was issued for a different email than the one presenting it.",
        401,
      );
    }
    if (!password) {
      return oauthErrorResponse(
        "invalid_client",
        'Missing client_secret — put your Yazio password in the connector\'s "OAuth Client Secret" field.',
        401,
      );
    }

    return jsonResponse(await issueTokens(await login(email, password)));
  } catch (error) {
    if (error instanceof YazioApiError && (error.status === 400 || error.status === 401)) {
      // On a refused refresh the client must start the flow again, which only
      // `invalid_grant` tells it to do.
      return grantType === "refresh_token"
        ? oauthErrorResponse("invalid_grant", "Yazio no longer accepts this session.")
        : oauthErrorResponse(
            "invalid_client",
            "Yazio rejected these credentials. Check the email and password in the connector settings.",
            401,
          );
    }
    return oauthErrorResponse("temporarily_unavailable", "Yazio did not answer. Try again.", 503);
  }
}

// --- public surface --------------------------------------------------------

/**
 * Handle discovery, `/authorize`, `/token` and `/register`.
 * Returns `undefined` when the request is none of those.
 */
export async function handleOAuthRequest(
  request: Request,
  env: Env,
): Promise<Response | undefined> {
  const { pathname } = new URL(request.url);

  const discovery = oauthMetadataResponse(request, metadataOptions(publicMcpUrl(request)));
  if (discovery) return discovery;

  if (request.method === "OPTIONS" && ["/authorize", "/token", "/register"].includes(pathname)) {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  switch (pathname) {
    case "/authorize":
      return handleAuthorize(request);
    case "/token":
      return handleToken(request, env);
    case "/register":
      // Claude falls back to the configured credentials when DCR is refused.
      return oauthErrorResponse(
        "invalid_client_metadata",
        'Dynamic client registration is off. Enter your Yazio email as "OAuth Client ID" and ' +
          'your Yazio password as "OAuth Client Secret" in the connector settings.',
        400,
      );
    default:
      return undefined;
  }
}

/**
 * Bearer gate for the MCP endpoint. Resolves to the verified token info, or to
 * a ready-to-return 401 carrying the discovery hint.
 */
/**
 * The 401 that tells the client to renew, in the shape the SDK's bearer gate
 * uses — same header, so a client that handles one handles both.
 *
 * Yazio can invalidate a session at any moment, and it happens mid-call rather
 * than at the gate. Answering the call with an error inside a 200 leaves the
 * client with nothing to act on; this gives it the one signal it reads.
 */
export function sessionRejectedResponse(request: Request): Response {
  const metadata = getOAuthProtectedResourceMetadataUrl(publicMcpUrl(request));
  return new Response(null, {
    status: 401,
    headers: {
      "www-authenticate":
        `Bearer error="invalid_token", ` +
        `error_description="Yazio no longer accepts this session", ` +
        `scope="${SCOPE}", resource_metadata="${metadata.toString()}"`,
    },
  });
}

export function authorizeMcpRequest(request: Request): Promise<AuthInfo | Response> {
  const gate = requireBearerAuth({
    requiredScopes: [SCOPE],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(publicMcpUrl(request)),
    verifier: {
      verifyAccessToken(token: string): Promise<AuthInfo> {
        const session = decodeSession(token);
        if (!session) {
          throw new OAuthError(
            OAuthErrorCode.InvalidToken,
            "Access token is not valid or expired.",
          );
        }

        return Promise.resolve({
          token,
          clientId: "yazio",
          scopes: [SCOPE],
          expiresAt: Math.floor(session.expiresAt / 1000),
        });
      },
    },
  });

  return gate(request);
}
