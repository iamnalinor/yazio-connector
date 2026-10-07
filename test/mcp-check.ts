/**
 * Protocol-level check of a running connector.
 *
 * Walks the same path claude.ai does — discovery documents, the OAuth
 * authorization-code flow with PKCE, then MCP over HTTP with the resulting
 * bearer token — and prints exactly what a model would see. Also checks the
 * auth failure modes and cleans up the diary entry it writes.
 *
 *   bun run check                                  # local wrangler dev
 *   bun run check https://host.workers.dev         # a deployed worker
 *
 * Credentials are the Yazio ones, from the environment or a gitignored `.env`.
 */

export {}; // Makes this a module, so top-level await is allowed.

const CALLBACK = "https://claude.ai/api/mcp/auth_callback";

const { YAZIO_EMAIL: email, YAZIO_PASSWORD: password } = Bun.env;
if (!email || !password) {
  throw new Error("Set YAZIO_EMAIL and YAZIO_PASSWORD (in the environment or in .env).");
}

const server = new URL(Bun.argv[2] ?? "http://127.0.0.1:8787").origin;
const mcpUrl = `${server}/`;

const failures: string[] = [];
const log = (title: string, body: string) => console.log(`\n──────── ${title} ────────\n${body}`);
const expect = (label: string, actual: unknown, wanted: unknown) => {
  if (actual !== wanted) failures.push(`${label}: got ${String(actual)}, wanted ${String(wanted)}`);
};

const base64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

/** Response bodies here are our own; read them at the shape we expect. */
async function json<T>(response: Response): Promise<T> {
  const body: unknown = await response.json();
  return body as T;
}

async function pkce() {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

console.log(`Checking ${mcpUrl}`);

// --- discovery ---------------------------------------------------------------

const health = await fetch(`${server}/health`);
log("health", `${health.status} ${await health.text()}`);
expect("GET /health", health.status, 200);

const resourceMeta = await fetch(`${server}/.well-known/oauth-protected-resource`);
const resourceJson = await json<{ resource?: string }>(resourceMeta);
log("protected resource metadata", JSON.stringify(resourceJson, null, 2));
expect("resource metadata", resourceMeta.status, 200);
expect("resource", resourceJson.resource, mcpUrl);

const asMeta = await fetch(`${server}/.well-known/oauth-authorization-server`);
const asJson = await json<{ authorization_endpoint: string; token_endpoint: string }>(asMeta);
log("authorization server metadata", JSON.stringify(asJson, null, 2));
expect("AS metadata", asMeta.status, 200);

// --- unauthenticated access is refused --------------------------------------

const anonymous = await fetch(mcpUrl, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
});
const challenge = anonymous.headers.get("www-authenticate") ?? "";
log("POST / without a token", `${anonymous.status}\nWWW-Authenticate: ${challenge}`);
expect("POST / without a token", anonymous.status, 401);
if (!challenge.includes("resource_metadata")) {
  failures.push("WWW-Authenticate has no resource_metadata — clients cannot find the AS");
}

// The endpoint is the bare origin, so a pasted /mcp must fail loudly rather
// than look like an auth problem.
const suffixed = await fetch(`${server}/mcp`, { method: "POST" });
expect("POST /mcp", suffixed.status, 404);

// --- the authorization code flow --------------------------------------------

const { verifier, challenge: codeChallenge } = await pkce();
const state = base64url(crypto.getRandomValues(new Uint8Array(8)));

const authorizeUrl = new URL(asJson.authorization_endpoint);
authorizeUrl.searchParams.set("response_type", "code");
authorizeUrl.searchParams.set("client_id", email);
authorizeUrl.searchParams.set("redirect_uri", CALLBACK);
authorizeUrl.searchParams.set("code_challenge", codeChallenge);
authorizeUrl.searchParams.set("code_challenge_method", "S256");
authorizeUrl.searchParams.set("state", state);
authorizeUrl.searchParams.set("scope", "mcp");

const authorize = await fetch(authorizeUrl, { redirect: "manual" });
const location = authorize.headers.get("location") ?? "";
log("GET /authorize", `${authorize.status} → ${location.replace(/code=[^&]+/, "code=…")}`);
expect("/authorize", authorize.status, 302);

const callback = new URL(location);
const code = callback.searchParams.get("code");
expect("state came back unchanged", callback.searchParams.get("state"), state);
if (!code) throw new Error("/authorize returned no code");

const badRedirect = await fetch(
  `${asJson.authorization_endpoint}?response_type=code&client_id=${encodeURIComponent(email)}` +
    `&redirect_uri=${encodeURIComponent("https://evil.example.com/steal")}`,
  { redirect: "manual" },
);
expect("/authorize with a foreign redirect_uri", badRedirect.status, 400);

const notAnEmail = await fetch(
  `${asJson.authorization_endpoint}?response_type=code&client_id=whoever&redirect_uri=${encodeURIComponent(CALLBACK)}`,
  { redirect: "manual" },
);
log("/authorize with a non-email client_id", `${notAnEmail.status} ${await notAnEmail.text()}`);
expect("/authorize with a non-email client_id", notAnEmail.status, 400);

async function tokenRequest(body: Record<string, string>) {
  const response = await fetch(asJson.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  return { status: response.status, body: await json<Record<string, string>>(response) };
}

const wrongPassword = await tokenRequest({
  grant_type: "authorization_code",
  code,
  redirect_uri: CALLBACK,
  code_verifier: verifier,
  client_id: email,
  client_secret: "definitely-not-the-password",
});
log(
  "/token with a wrong password",
  `${wrongPassword.status} ${JSON.stringify(wrongPassword.body)}`,
);
expect("/token with a wrong password", wrongPassword.status, 401);

const foreignCode = await tokenRequest({
  grant_type: "authorization_code",
  code,
  redirect_uri: CALLBACK,
  code_verifier: verifier,
  client_id: "someone.else@example.com",
  client_secret: password,
});
log("/token with someone else's code", `${foreignCode.status} ${JSON.stringify(foreignCode.body)}`);
expect("/token with someone else's code", foreignCode.status, 401);

const wrongVerifier = await tokenRequest({
  grant_type: "authorization_code",
  code,
  redirect_uri: CALLBACK,
  code_verifier: base64url(crypto.getRandomValues(new Uint8Array(32))),
  client_id: email,
  client_secret: password,
});
log(
  "/token with a foreign code_verifier",
  `${wrongVerifier.status} ${JSON.stringify(wrongVerifier.body)}`,
);
expect("PKCE is checked", wrongVerifier.status, 400);

const issued = await tokenRequest({
  grant_type: "authorization_code",
  code,
  redirect_uri: CALLBACK,
  code_verifier: verifier,
  client_id: email,
  client_secret: password,
});
log(
  "/token",
  `${issued.status} token_type=${issued.body.token_type} expires_in=${issued.body.expires_in} ` +
    `scope=${issued.body.scope} refresh_token=${issued.body.refresh_token ? "yes" : "no"}`,
);
expect("/token", issued.status, 200);

let accessToken = issued.body.access_token;
if (!accessToken) throw new Error("/token returned no access_token");

const refreshed = await tokenRequest({
  grant_type: "refresh_token",
  refresh_token: issued.body.refresh_token,
  client_id: email,
  client_secret: password,
});
log(
  "/token (refresh)",
  `${refreshed.status} new access_token: ${refreshed.body.access_token ? "yes" : "no"}`,
);
expect("refresh_token grant", refreshed.status, 200);
accessToken = refreshed.body.access_token ?? accessToken;

const registration = await fetch(`${server}/register`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ redirect_uris: [CALLBACK] }),
});
log("/register (DCR is off)", `${registration.status} ${JSON.stringify(await json(registration))}`);
expect("/register", registration.status, 400);

const tampered = await fetch(mcpUrl, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${accessToken.slice(0, -3)}xyz`,
  },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
});
expect("tampered token", tampered.status, 401);

// --- MCP with the token ------------------------------------------------------

interface RpcResult {
  status: number;
  payload: {
    error?: unknown;
    result?: {
      isError?: boolean;
      content?: { text?: string }[];
      tools?: { name: string; inputSchema?: { properties?: Record<string, unknown> } }[];
      protocolVersion?: string;
      instructions?: string;
    };
  } | null;
}

let requestId = 0;
let sessionId: string | null = null;
let protocolVersion = "2025-06-18";

async function rpc(method: string, params: unknown, notification = false): Promise<RpcResult> {
  const body = notification
    ? { jsonrpc: "2.0", method, params }
    : { jsonrpc: "2.0", id: ++requestId, method, params };

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": protocolVersion,
    authorization: `Bearer ${accessToken}`,
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;

  const response = await fetch(mcpUrl, { method: "POST", headers, body: JSON.stringify(body) });
  sessionId = response.headers.get("mcp-session-id") ?? sessionId;

  const raw = await response.text();
  if (notification) return { status: response.status, payload: null };

  // A stateless server may answer with JSON or with a one-shot SSE stream.
  const text = (response.headers.get("content-type") ?? "").includes("text/event-stream")
    ? (raw
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .at(-1) ?? "null")
    : raw || "null";

  return { status: response.status, payload: JSON.parse(text) as RpcResult["payload"] };
}

const call = (name: string, args: unknown) => rpc("tools/call", { name, arguments: args });

function toolText(response: RpcResult): string {
  const payload = response.payload;
  if (payload?.error) return `ERROR ${JSON.stringify(payload.error)}`;
  const prefix = payload?.result?.isError ? "[isError] " : "";
  return prefix + (payload?.result?.content ?? []).map((part) => part.text).join("\n");
}

const init = await rpc("initialize", {
  protocolVersion,
  capabilities: {},
  clientInfo: { name: "mcp-check", version: "1.0.0" },
});
protocolVersion = init.payload?.result?.protocolVersion ?? protocolVersion;
log("initialize", JSON.stringify(init.payload?.result ?? init.payload, null, 2));
expect("initialize", init.status, 200);
if (!init.payload?.result?.instructions) {
  failures.push(
    "initialize carries no instructions — the model gets no hint about when to use this",
  );
}

await rpc("notifications/initialized", {}, true);

const tools = (await rpc("tools/list", {})).payload?.result?.tools ?? [];
log(
  "tools/list",
  tools
    .map((tool) => `${tool.name}(${Object.keys(tool.inputSchema?.properties ?? {}).join(", ")})`)
    .join("\n"),
);
expect("number of tools", tools.length, 15);

log("get_goals", toolText(await call("get_goals", {})));
log("get_daily_summary (day)", toolText(await call("get_daily_summary", {})));
log(
  "get_daily_summary (range)",
  toolText(await call("get_daily_summary", { start_date: "-2", end_date: "today" })),
);

const searchText = toolText(await call("search_products", { query: "oatmeal", limit: 3 }));
log("search_products", searchText);
log(
  "search_products (Russian query)",
  toolText(await call("search_products", { query: "творог 5%", limit: 3 })),
);

const productId = /product_id: ([0-9a-f-]{36})/.exec(searchText)?.[1];
if (!productId) throw new Error("No product id in the search results.");

log("get_product", toolText(await call("get_product", { product_id: productId })));
log(
  "get_recent_products",
  toolText(await call("get_recent_products", { meal: "lunch", limit: 3 })),
);
log("list_exercises", toolText(await call("list_exercises", {})));
log(
  "get_nutrient_history",
  toolText(await call("get_nutrient_history", { nutrient: "fiber", start_date: "-6" })),
);

// --- write path, cleaned up afterwards --------------------------------------

// A food of the user's own: the id it hands back is the only way to reach it,
// since Yazio will not have it in search for a while.
const createdText = toolText(
  await call("create_product", {
    name: "mcp check test food",
    kcal_per_100: 200,
    protein_per_100: 10,
    fat_per_100: 8,
    carb_per_100: 20,
    servings: [{ serving: "piece", amount: 50 }],
  }),
);
log("create_product", createdText);

const ownProductId = /product_id: ([0-9a-f-]{36})/.exec(createdText)?.[1];
if (!ownProductId) throw new Error("create_product returned no product_id.");

const ownLoggedText = toolText(
  await call("log_food", {
    meal: "snack",
    items: [{ product_id: ownProductId, serving: "piece", serving_quantity: 2 }],
  }),
);
log("log_food (own product)", ownLoggedText);
for (const line of ["This meal (snack)", "Day so far", "Remaining"]) {
  if (!ownLoggedText.includes(line)) failures.push(`log_food did not report "${line}"`);
}

const quickText = toolText(
  await call("quick_add_food", {
    meal: "snack",
    items: [{ name: "mcp check quick add", kcal: 123, protein: 5, fat: 4, carb: 3 }],
  }),
);
log("quick_add_food", quickText);

const extraEntryIds = [ownLoggedText, quickText].map((body) => {
  const id = /entry_id: ([0-9a-f-]{36})/.exec(body)?.[1];
  if (!id) throw new Error("a write returned no entry_id — a test entry may be left behind!");
  return id;
});

const loggedText = toolText(
  await call("log_food", {
    meal: "snack",
    items: [{ product_id: productId, amount: 111 }],
    date: "today",
  }),
);
log("log_food", loggedText);

const entryId = /entry_id: ([0-9a-f-]{36})/.exec(loggedText)?.[1];
if (!entryId) throw new Error("log_food returned no entry_id — a test entry may be left behind!");

const withEntry = toolText(await call("list_food_log", {}));
log("list_food_log", withEntry);
if (!withEntry.includes(entryId)) failures.push("the new entry is not visible in list_food_log");
// The point of the whole change: the diary hands a product id back, so the same
// food can be logged again tomorrow without searching for its name.
if (!withEntry.includes(`product_id: ${productId}`)) {
  failures.push("list_food_log does not give the product_id back");
}

const waterBefore = Number(
  /Water: (\d+) \//.exec(toolText(await call("get_daily_summary", {})))?.[1] ?? 0,
);
const water = toolText(await call("log_water", { milliliters: waterBefore + 250 }));
log("log_water", water);
if (!water.includes(`${waterBefore + 250} ml`)) {
  failures.push("log_water did not confirm the amount");
}

const entryIds = [entryId, ...extraEntryIds];
log(
  "delete_food_log_entries",
  toolText(await call("delete_food_log_entries", { entry_ids: entryIds })),
);

const afterDelete = toolText(await call("list_food_log", {}));
for (const id of entryIds) {
  if (afterDelete.includes(id))
    failures.push(`entry ${id} was NOT deleted — clean the diary by hand`);
}
log("log_water (restored)", toolText(await call("log_water", { milliliters: waterBefore })));

// A food of the user's own is invisible to search, so this list is the only way
// back to it — and the only way to prove it is gone afterwards.
const ownList = toolText(await call("list_my_products", {}));
log("list_my_products", ownList);
if (!ownList.includes(ownProductId)) failures.push("list_my_products does not show the new food");

log("delete_product", toolText(await call("delete_product", { product_id: ownProductId })));
if (toolText(await call("list_my_products", {})).includes(ownProductId)) {
  failures.push(`product ${ownProductId} was NOT deleted — remove it in the app`);
}

// --- error paths -------------------------------------------------------------

log(
  "log_food without an amount",
  toolText(await call("log_food", { meal: "snack", items: [{ product_id: productId }] })),
);
log(
  "get_product with a junk id",
  toolText(await call("get_product", { product_id: "not-a-uuid" })),
);
log(
  "get_daily_summary with a bad date",
  toolText(await call("get_daily_summary", { date: "last summer" })),
);
// A refused write must come back with what Yazio actually said, not a bare code.
log(
  "create_product with a name Yazio refuses",
  toolText(
    await call("create_product", {
      name: "  a  ",
      kcal_per_100: 1,
      protein_per_100: 0,
      fat_per_100: 0,
      carb_per_100: 0,
    }),
  ),
);

// --- rate limit --------------------------------------------------------------

// Last, because it spends this IP's whole /token budget. The limiter sits above
// the grant parsing, so junk bodies prove it without one Yazio login attempt.
const burst: number[] = [];
for (let attempt = 0; attempt < 15; attempt++) {
  const response = await fetch(asJson.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "grant_type=nonsense",
  });
  burst.push(response.status);
  if (response.status === 429) {
    expect("429 carries Retry-After", response.headers.get("retry-after"), "60");
    break;
  }
}

log("/token rate limit", `statuses: ${burst.join(" ")}`);
if (!burst.includes(429)) {
  failures.push(
    "15 rapid POSTs to /token were never refused — no TOKEN_LIMIT binding? " +
      "(`wrangler dev` may not implement it; re-check against a deployed Worker)",
  );
}

if (failures.length > 0) {
  console.error(`\n❌ Problems:\n${failures.map((item) => `  - ${item}`).join("\n")}`);
  process.exit(1);
}
console.log("\n✅ mcp-check passed");
console.log("   /token is now rate-limited for this IP — wait a minute before re-running.");
