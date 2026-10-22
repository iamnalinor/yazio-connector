# yazio-mcp

A remote MCP server that gives Claude access to a [Yazio](https://www.yazio.com/) food diary:
search the product catalogue, log what you ate, read the diary, and check calories and macros
against your goals.

It runs as a **custom connector** in claude.ai (web, desktop, mobile), and works the same way in
ChatGPT and Codex — the client calls it from its side, so there is nothing to run locally.

## Setup

### 1. Deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/iamnalinor/yazio-mcp)

The button signs you in to Cloudflare, copies this repository into your own GitHub account and
deploys it from there. Nothing to install, and nothing to fill in: no secrets, no variables, no KV
namespace, no database. (The two rate limiters are bindings, but they are declared in
`wrangler.jsonc` and need no provisioning.) Note the `*.workers.dev` URL it gives you at the end —
you need it below.

<details>
<summary>Or from a terminal</summary>

```bash
bun install
```

```bash
bunx wrangler login
```

```bash
bun run deploy
```

</details>

### 2. Add it to Claude

Settings → Connectors → **Add custom connector**:

- **URL** — `https://yazio-mcp.<your-subdomain>.workers.dev`
- **OAuth Client ID** — your **Yazio email**
- **OAuth Client Secret** — your **Yazio password**

Claude then runs the OAuth flow by itself. There is no login page and none is needed: those two
fields already are the credentials. The Worker exchanges them with Yazio once, hands Claude back
Yazio's own 48-hour token, and forgets both. Claude renews it through Yazio's refresh grant, so the
password is never sent again.

### Or add it to ChatGPT

Custom connectors in ChatGPT need **Developer mode**, which is available on Pro, Business,
Enterprise and Edu plans.

1. Settings → Apps & Connectors → Advanced settings → turn on **Developer mode**.
2. Back in Apps & Connectors, **Create** a connector:
   - **MCP Server URL** — `https://yazio-mcp.<your-subdomain>.workers.dev`
   - **Authentication** — **OAuth**
3. Open the OAuth advanced settings and fill in the client yourself — the connector does not offer
   dynamic registration, so ChatGPT will not do it for you:
   - **Client ID** — your **Yazio email**
   - **Client Secret** — your **Yazio password**
4. Tick that you trust the connector, then **Create**. ChatGPT runs the OAuth flow and comes back
   connected.

To use it in a chat, pick it from the **+** menu → Developer mode. ChatGPT asks for confirmation
before each write (logging food, deleting entries); reads go through without asking.

### Or add it to Codex

```bash
codex mcp add yazio --url https://yazio-mcp.<your-subdomain>.workers.dev --oauth-client-id you@example.com --oauth-client-secret 'your-yazio-password'
```

```bash
codex mcp login yazio
```

Codex keeps the secret in `~/.codex/config.toml`, so keep that file private.

If you don't have password (e.g. registered via Google), reset it [here](https://www.yazio.com/en/app/account/forgot-password).

## Tools

| Tool                      | What it does                                                                                   |
| ------------------------- | ---------------------------------------------------------------------------------------------- |
| `search_products`         | Search the Yazio catalogue. Returns ids, kcal and macros per 100 g/ml, default portion         |
| `get_product`             | One product in full, with every portion size Yazio knows for it                                |
| `get_recent_products`     | What you eat regularly for a meal, with your usual portion                                     |
| `create_product`          | Add a food Yazio does not have, private to you, and get its `product_id` back                  |
| `log_food`                | Write products into the diary — a whole meal in one call                                       |
| `quick_add_food`          | Log calories with no product behind them, the app's Quick Add                                  |
| `list_food_log`           | The day's diary by meal, with the `entry_id` to delete a row and the `product_id` to repeat it |
| `delete_food_log_entries` | Remove one or more entries by `entry_id`                                                       |
| `get_daily_summary`       | Eaten versus goal for a day, or a day-by-day table plus averages (up to 31 days)               |
| `get_nutrient_history`    | One nutrient day by day: fibre, sugar, sodium, a vitamin                                       |
| `log_water`               | Set the day's water total in millilitres                                                       |
| `list_exercises`          | Workouts logged for a day and what they burned                                                 |
| `get_goals`               | Calorie, macro, water and step targets, diet split, restriction, current and target weight     |

Every write answers with the macros of that meal, the day's totals so far and the calories left, so
Claude can report them back without a second call.

## Security

- **Your Yazio password goes to whoever runs the Worker.** Yazio offers third parties no OAuth,
  only a password grant, so there is no way around it. Deploy your own Worker rather than trusting
  someone else's.
- **Nothing is stored.** No database, no credential logging. The password exists only for
  the duration of one `/token` request. Obtained token is returned to Claude.
- **`/token` is an unauthenticated login proxy**, so it is rate-limited: 10 requests a minute per
  IP, and 60 a minute per session on the MCP endpoint.
- **The Yazio API is unofficial** (`https://yzapi.yazio.com/v20`) and can change without notice. It
  gates writes on the client's user agent — a request that does not look like the Android app is
  refused with `version_blocked`, so `src/yazio/api.ts` sends the app's own.
- **A Yazio refresh invalidates every access token on the account**, not just the one it replaces —
  including the session on your phone, and the phone's own refresh kills this one. Two things follow.
  The connector never calls Yazio's refresh grant: it signs in again instead, which disturbs nothing.
  And when Yazio does turn a session down mid-call, the Worker answers `401` with
  `WWW-Authenticate`, so Claude renews and retries by itself rather than leaving you to reconnect.

## Limitations

- A food you create is yours alone and can be logged straight away, but it does not turn up in the
  Yazio app's own search until the app rebuilds its catalogue. Nothing here can force that, which is
  what `list_my_products` is for.
- Deleting one of your foods takes it off your list; diary entries already logged with it keep
  their calories, as they do in the app.
- Recipe portions are counted but not described — `list_food_log` says so on its own line. They
  still count towards `get_daily_summary`.
- Energy is always kcal; portions are grams or millilitres, whichever the product uses.
- `log_water` sets the day's total rather than adding to it, which is all Yazio offers.
- Exercise is read-only: `list_exercises` shows what is there, nothing writes to it.

## Development

```bash
bun run dev
```

```bash
bun test
```

```bash
bun run smoke
```

```bash
bun run check
```

```bash
bun run lint
```

- `bun test` — units: dates, nutrient maths, portion resolution, rendering, and the exact requests
  the Yazio client sends.
- `bun run smoke` — every service path against a live account: searches, logs one test entry, reads
  the diary, **deletes the entry again**.
- `bun run check` — the whole path claude.ai walks: discovery documents, the OAuth flow with PKCE,
  then MCP over HTTP with the resulting token. Covers the failure cases too (no token, tampered
  token, foreign `redirect_uri`, wrong password, someone else's code, wrong `code_verifier`) and
  prints exactly the text a model would see. It finishes by bursting `/token` until the rate
  limiter refuses it, which spends that IP's budget — **wait a minute between runs**. Pass a URL to
  check a deployed Worker.
- `bun run lint` — prettier, eslint, tsc and knip.

`wrangler dev` needs Node even when everything else runs on Bun. On a Bun-only machine:
`bun add -d node-linux-x64` (or the package for your platform) and put its `bin` on `PATH`.

Both live scripts need `YAZIO_EMAIL` and `YAZIO_PASSWORD` in the environment or in a gitignored
`.env`. Liveness check: `GET /health`.
