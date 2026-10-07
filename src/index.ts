/**
 * Worker entrypoint.
 *
 * Routes:
 *   /.well-known/oauth-*  — OAuth discovery documents (served by the MCP SDK)
 *   /authorize, /token    — credentials in, Yazio token out; see `src/oauth.ts`
 *   /                     — MCP over HTTP, behind a bearer token
 *   /health               — unauthenticated liveness check
 *
 * Nothing to configure: no secrets, no variables, no storage. Every user brings
 * their own Yazio account. The only bindings are the rate limiters, which live
 * entirely in `wrangler.jsonc` and need no provisioning — see `src/limits.ts`.
 */

import { createMcpHandler, type McpHttpHandler } from "@modelcontextprotocol/server";

import { allow, tokenKey, tooManyRequests, type Env } from "./limits";
import { createServer } from "./mcp";
import {
  authorizeMcpRequest,
  handleOAuthRequest,
  publicMcpUrl,
  sessionRejectedResponse,
} from "./oauth";
import { decodeSession } from "./session";

/**
 * MCP answers on the bare origin, so the connector is added to Claude by host
 * alone — there is no path to get wrong in the dialog.
 */
const MCP_ROUTE = "/";

/**
 * One handler per isolate — it owns the notification bus and outlives requests.
 * The MCP server inside it is still built per request, from that request's own
 * session, so users never share state.
 */
/**
 * Sessions Yazio turned down while a call was in flight.
 *
 * The bearer gate cannot catch this: the token decodes and has not expired, and
 * Yazio only refuses it once the tool is already running. The tool notes it
 * here against its own token, and the request that carried it answers 401 —
 * which is the one thing that makes a client renew.
 */
const rejected = new Set<string>();

const handler: McpHttpHandler = createMcpHandler((ctx) => {
  const token = ctx.authInfo?.token;
  const session = token ? decodeSession(token) : null;
  if (!session || !token) {
    throw new Error("The MCP handler was reached without a valid session.");
  }
  return createServer(session, () => rejected.add(token));
});

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health" && request.method === "GET") {
      return Response.json({ status: "ok", mcp_endpoint: publicMcpUrl(request).toString() });
    }

    const oauth = await handleOAuthRequest(request, env);
    if (oauth) return oauth;

    if (url.pathname !== MCP_ROUTE) return new Response(null, { status: 404 });

    const authInfo = await authorizeMcpRequest(request);
    if (authInfo instanceof Response) return authInfo;

    // Metered per session, never per IP: claude.ai calls arrive from shared
    // addresses, so one busy user would otherwise throttle everyone. Checked
    // after the bearer gate — which is only a base64 decode — so that a junk
    // token cannot spend a real session's budget.
    if (!(await allow(env.MCP_LIMIT, await tokenKey(authInfo.token)))) {
      return tooManyRequests("Too many requests for this session. Wait a minute and try again.");
    }

    const response = await handler.fetch(request, { authInfo });

    // A POST carries exactly one reply, but the handler streams it: the tool
    // has not run yet when this resolves. Read it to the end so the tool's
    // verdict is in before the status is chosen. A GET is the open
    // server-to-client stream and must never be drained.
    if (request.method !== "POST") return response;

    const body = await response.text();
    if (rejected.delete(authInfo.token)) return sessionRejectedResponse(request);

    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  },
} satisfies ExportedHandler<Env>;
