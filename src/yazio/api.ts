/**
 * Thin client for the Yazio API.
 *
 * The API is unofficial and reverse-engineered, so this module is the only place
 * that knows its shape. Schemas describe just the fields we use and ignore the
 * rest, so upstream additions cannot break a tool call.
 *
 * Facts established against the live API:
 * - base URL is `/v20` — what the Android app itself uses; energy is in kcal;
 * - nutrients are given per **one** base unit (per gram / per ml), except on a
 *   diary row, where they are the totals actually eaten;
 * - a diary entry's `amount` is always in base units — `serving` and
 *   `serving_quantity` only describe how the app displays it;
 * - `POST` and `DELETE /user/consumed-items` take arrays, so a whole meal is
 *   one request; `simple_products` in the same payload is the app's Quick Add;
 * - `POST /user/products` creates a private product. It answers 204 and the
 *   product is readable by id at once, but it does **not** show up in
 *   `/products/search`; `GET /user/products` is the list it does show up in;
 * - `DELETE /user/products/{id}` takes a product off that list. The product
 *   document survives — diary rows still reference it — so the list, not
 *   `is_deleted`, is what says whether it worked;
 * - `POST /user/water-intake` sets the day's total, it does not add to it, and
 *   its payload is an array — a bare object answers 201 and changes nothing;
 * - product search needs `countries` and `sex`, and rejects the request without
 *   them. `locales` is accepted but changes nothing: what a query matches is
 *   decided by the language the query itself is written in;
 * - a failed write answers with a JSON array of `{property_path, message}`,
 *   which is worth passing on verbatim — hence `YazioApiError.body`;
 * - a **refresh invalidates the access token it replaces**, immediately: any
 *   client still holding the old one is answered
 *   `401 {"message":"Invalid credentials."}`.
 */

import { z } from "zod";

import { MEALS, type Meal } from "./meals";

const BASE_URL = "https://yzapi.yazio.com/v20";

/**
 * The Android app's own agent, and **not** decoration.
 *
 * Yazio gates writes on it: a request whose user-agent does not name the
 * Android package is answered `403 {"error":"version_blocked"}`, while reads
 * still go through. Observed against the live API on 2026-09-07. The version
 * itself is not checked — `YAZIO/11.0.0 (com.yazio.android; …)` is accepted —
 * but the shape is, so do not trim this string.
 */
const USER_AGENT = "YAZIO/12.89.0 (com.yazio.android; build:606121218; Android 36)";

/** Enough of a failure to act on, short enough not to flood a tool result. */
const ERROR_BODY_LIMIT = 500;

/**
 * The Yazio app's own OAuth client. Public by construction — every Yazio client
 * ships these values, and `/oauth/token` refuses the request without them.
 */
const APP_CLIENT_ID = "1_4hiybetvfksgw40o0sog4s884kwc840wwso8go4k8c04goo4c";
const APP_CLIENT_SECRET = "6rok2m65xuskgkgogw40wkkk8sw0osg84s8cggsc4woos4s8o";

/** Yazio answered with a non-2xx status. */
export class YazioApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    /** What Yazio answered. Its 400s name the offending field; keep the words. */
    readonly body = "",
  ) {
    super(`Yazio answered ${status} for ${path}${body ? `: ${body}` : "."}`);
    this.name = "YazioApiError";
  }
}

/** First few mismatches, so a shape change says which field moved. */
function describeIssues(cause: unknown): string {
  if (!(cause instanceof z.ZodError)) return "";
  return cause.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

/** Yazio answered 2xx, but not in a shape this client recognises. */
export class YazioShapeError extends Error {
  constructor(
    readonly path: string,
    override readonly cause: unknown,
  ) {
    const detail = describeIssues(cause);
    super(`Unexpected response shape from ${path}${detail ? `: ${detail}` : "."}`);
    this.name = "YazioShapeError";
  }
}

// --- schemas ---------------------------------------------------------------

/** Yazio keeps adding nutrients; keep the numbers, drop anything else. */
const NutrientMap = z
  .record(z.string(), z.unknown())
  .transform((raw) =>
    Object.fromEntries(
      Object.entries(raw).filter(
        (entry): entry is [string, number] =>
          typeof entry[1] === "number" && Number.isFinite(entry[1]),
      ),
    ),
  );

/** Raw `{ "energy.energy": 0.98, … }` map as Yazio reports it. */
export type NutrientValues = z.infer<typeof NutrientMap>;

const TokenResponse = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  expires_in: z.number(),
});

/** Search insists on one of these two; there is no third choice upstream. */
export type Sex = "male" | "female";

const UserResponse = z.object({
  country: z.string().nullish(),
  food_database_country: z.string().nullish(),
  timezone_offset: z.number().nullish(),
  sex: z.string().nullish(),
  diet: z
    .object({
      name: z.string(),
      carb_percentage: z.number(),
      fat_percentage: z.number(),
      protein_percentage: z.number(),
    })
    .nullish(),
});

const SearchResults = z
  .array(
    z.object({
      product_id: z.string(),
      name: z.string(),
      producer: z.string().nullish(),
      base_unit: z.string(),
      is_verified: z.boolean().nullish(),
      nutrients: NutrientMap,
      serving: z.string().nullish(),
      serving_quantity: z.number().nullish(),
      amount: z.number().nullish(),
    }),
  )
  .default([]);

const ProductResponse = z.object({
  name: z.string(),
  producer: z.string().nullish(),
  base_unit: z.string(),
  is_verified: z.boolean().nullish(),
  is_private: z.boolean().nullish(),
  nutrients: NutrientMap,
  servings: z.array(z.object({ serving: z.string(), amount: z.number() })).default([]),
});

const ConsumedItemsResponse = z.object({
  products: z
    .array(
      z.object({
        id: z.string(),
        product_id: z.string(),
        daytime: z.enum(MEALS),
        amount: z.number(),
        serving: z.string().nullish(),
        serving_quantity: z.number().nullish(),
      }),
    )
    .default([]),
  // Quick Add: a name and the totals eaten, with no product behind it.
  simple_products: z
    .array(
      z.object({
        id: z.string(),
        daytime: z.enum(MEALS),
        name: z.string(),
        nutrients: NutrientMap,
      }),
    )
    .default([]),
  // Recipes: counted, not described. Their shape is unstable and no tool reads them.
  recipe_portions: z.array(z.unknown()).default([]),
});

const DailySummaryResponse = z.object({
  meals: z.record(z.string(), z.object({ nutrients: NutrientMap })).default({}),
  goals: NutrientMap,
  activity_energy: z.number().nullish(),
  consume_activity_energy: z.boolean().nullish(),
  steps: z.number().nullish(),
  water_intake: z.number().nullish(),
  user: z.object({ current_weight: z.number().nullish() }).nullish(),
});

const WeightResponse = z.object({ value: z.number().nullish() });

const SuggestedProductsResponse = z
  .array(
    z.object({
      product_id: z.string(),
      amount: z.number(),
      serving: z.string().nullish(),
      serving_quantity: z.number().nullish(),
    }),
  )
  .default([]);

/** Eaten per day for a whole range, goal included — one request, not one per day. */
const NutrientsDailyResponse = z
  .array(
    z.object({
      date: z.string(),
      energy: z.number().nullish(),
      carb: z.number().nullish(),
      fat: z.number().nullish(),
      protein: z.number().nullish(),
      energy_goal: z.number().nullish(),
    }),
  )
  .default([]);

/** `{ "2026-09-01": 5.75, … }` for one nutrient over a range. */
const SpecificNutrientDailyResponse = z.record(z.string(), z.number()).default({});

const WaterIntakeResponse = z.object({ water_intake: z.number().nullish() });

const ExerciseSchema = z.object({
  id: z.string(),
  name: z.string(),
  note: z.string().nullish(),
  date: z.string().nullish(),
  energy: z.number().nullish(),
  distance: z.number().nullish(),
  duration: z.number().nullish(),
  steps: z.number().nullish(),
});

const ExercisesResponse = z.object({
  training: z.array(ExerciseSchema).default([]),
  custom_training: z.array(ExerciseSchema).default([]),
});

const SettingsResponse = z.object({ consume_activity_calories: z.boolean().nullish() });

const DietaryPreferencesResponse = z.object({ restriction: z.string().nullish() });

export type YazioUser = z.infer<typeof UserResponse>;
type YazioSearchHit = z.infer<typeof SearchResults>[number];
type YazioProduct = z.infer<typeof ProductResponse>;
type YazioDiary = z.infer<typeof ConsumedItemsResponse>;
type YazioDailySummary = z.infer<typeof DailySummaryResponse>;
type YazioSuggestion = z.infer<typeof SuggestedProductsResponse>[number];
type YazioDailyNutrients = z.infer<typeof NutrientsDailyResponse>[number];
type YazioExercises = z.infer<typeof ExercisesResponse>;

/** One diary row as Yazio wants it written. */
interface ConsumedItemInput {
  id: string;
  product_id: string;
  date: string;
  daytime: Meal;
  amount: number;
  serving: string;
  serving_quantity: number;
}

/** One Quick Add row: no product, nutrients are the totals eaten. */
interface SimpleProductInput {
  id: string;
  date: string;
  daytime: Meal;
  name: string;
  nutrients: Record<string, number>;
}

/** A product the user owns. `nutrients` are per one base unit, like everywhere. */
interface CustomProductInput {
  id: string;
  name: string;
  category: string;
  base_unit: string;
  is_private: boolean;
  nutrients: Record<string, number>;
  servings: Array<{ serving: string; amount: number }>;
}

export interface YazioToken {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

// --- transport -------------------------------------------------------------

async function send(path: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(`${BASE_URL}${path}`, init);

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new YazioApiError(response.status, path, detail.trim().slice(0, ERROR_BODY_LIMIT));
  }

  const body = await response.text();
  return body === "" ? null : (JSON.parse(body) as unknown);
}

async function call<T>(schema: z.ZodType<T>, path: string, init: RequestInit): Promise<T> {
  const parsed = schema.safeParse(await send(path, init));
  if (!parsed.success) throw new YazioShapeError(path, parsed.error);
  return parsed.data;
}

function get<T>(schema: z.ZodType<T>, token: string, path: string): Promise<T> {
  return call(schema, path, {
    headers: { authorization: `Bearer ${token}`, "user-agent": USER_AGENT },
  });
}

async function write(
  token: string,
  path: string,
  method: "POST" | "DELETE",
  body?: unknown,
): Promise<void> {
  await send(path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": USER_AGENT,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function requestToken(form: Record<string, string>): Promise<YazioToken> {
  const issued = await call(TokenResponse, "/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": USER_AGENT },
    body: new URLSearchParams({
      client_id: APP_CLIENT_ID,
      client_secret: APP_CLIENT_SECRET,
      ...form,
    }),
  });

  return {
    accessToken: issued.access_token,
    refreshToken: issued.refresh_token,
    expiresAt: Date.now() + issued.expires_in * 1000,
  };
}

// --- endpoints -------------------------------------------------------------

/** Exchange an email and password for a token pair (Yazio has no other grant). */
export function login(email: string, password: string): Promise<YazioToken> {
  return requestToken({ grant_type: "password", username: email, password });
}

export function refresh(refreshToken: string): Promise<YazioToken> {
  return requestToken({ grant_type: "refresh_token", refresh_token: refreshToken });
}

export function getUser(token: string): Promise<YazioUser> {
  return get(UserResponse, token, "/user");
}

export function getSettings(token: string) {
  return get(SettingsResponse, token, "/user/settings");
}

export function getDietaryPreferences(token: string) {
  return get(DietaryPreferencesResponse, token, "/user/dietary-preferences");
}

export function searchProducts(
  token: string,
  options: { query: string; country: string; sex: Sex },
): Promise<YazioSearchHit[]> {
  const params = new URLSearchParams({
    query: options.query,
    countries: options.country,
    sex: options.sex,
  });
  return get(SearchResults, token, `/products/search?${params.toString()}`);
}

/** Resolves to `null` when Yazio has no such product. */
export async function getProduct(token: string, productId: string): Promise<YazioProduct | null> {
  try {
    return await get(ProductResponse, token, `/products/${productId}`);
  } catch (error) {
    if (error instanceof YazioApiError && error.status === 404) return null;
    throw error;
  }
}

/**
 * Create a product owned by the user.
 *
 * Yazio answers 204 with no body, so the id has to be minted by the caller —
 * which is just as well, since the product stays out of `/products/search`
 * until the app rebuilds its catalogue and the id is the only handle on it.
 */
export function createProduct(token: string, product: CustomProductInput): Promise<void> {
  return write(token, "/user/products", "POST", product);
}

/** Ids of the products this user owns — the app's "my foods". */
export function getOwnProductIds(token: string): Promise<string[]> {
  return get(z.array(z.string()).default([]), token, "/user/products");
}

/** Removes a product from the user's own list; 403 if it is not theirs. */
export function deleteProduct(token: string, productId: string): Promise<void> {
  return write(token, `/user/products/${productId}`, "DELETE", undefined);
}

export function getDiary(token: string, date: string): Promise<YazioDiary> {
  return get(ConsumedItemsResponse, token, `/user/consumed-items?date=${date}`);
}

export function addConsumedItems(
  token: string,
  items: { products?: ConsumedItemInput[]; simpleProducts?: SimpleProductInput[] },
): Promise<void> {
  return write(token, "/user/consumed-items", "POST", {
    products: items.products ?? [],
    simple_products: items.simpleProducts ?? [],
    recipe_portions: [],
  });
}

export function deleteConsumedItems(token: string, entryIds: string[]): Promise<void> {
  return write(token, "/user/consumed-items", "DELETE", entryIds);
}

export function getDailySummary(token: string, date: string): Promise<YazioDailySummary> {
  return get(DailySummaryResponse, token, `/user/widgets/daily-summary?date=${date}`);
}

/** Calories and macros eaten per day, with the calorie goal, for a whole range. */
export function getNutrientsDaily(
  token: string,
  start: string,
  end: string,
): Promise<YazioDailyNutrients[]> {
  return get(
    NutrientsDailyResponse,
    token,
    `/user/consumed-items/nutrients-daily?start=${start}&end=${end}`,
  );
}

/** One nutrient per day. Days with nothing logged are simply absent. */
export function getNutrientDaily(
  token: string,
  nutrient: string,
  start: string,
  end: string,
): Promise<Record<string, number>> {
  const params = new URLSearchParams({ start, end, nutrient });
  return get(
    SpecificNutrientDailyResponse,
    token,
    `/user/consumed-items/specific-nutrient-daily?${params.toString()}`,
  );
}

/** Goals as set by the user, without the bonus Yazio adds for logged activity. */
export function getGoals(token: string, date: string): Promise<NutrientValues> {
  return get(NutrientMap, token, `/user/goals/unmodified?date=${date}`);
}

export async function getWeight(token: string, date: string): Promise<number | null> {
  const weight = await get(WeightResponse, token, `/user/bodyvalues/weight/last?date=${date}`);
  return weight.value ?? null;
}

export async function getWaterIntake(token: string, date: string): Promise<number> {
  const water = await get(WaterIntakeResponse, token, `/user/water-intake?date=${date}`);
  return water.water_intake ?? 0;
}

/**
 * Sets the day's total; it does not add to what is already there.
 *
 * The payload has to be an array — a bare object is accepted with 201 and then
 * quietly ignored.
 */
export function setWaterIntake(token: string, date: string, ml: number): Promise<void> {
  return write(token, "/user/water-intake", "POST", [
    { date: `${date} 12:00:00`, water_intake: ml },
  ]);
}

export function getExercises(token: string, date: string): Promise<YazioExercises> {
  return get(ExercisesResponse, token, `/user/exercises?date=${date}`);
}

/** What Yazio offers for that meal — in practice, what the user eats regularly. */
export function getSuggestedProducts(
  token: string,
  date: string,
  meal: Meal,
): Promise<YazioSuggestion[]> {
  return get(
    SuggestedProductsResponse,
    token,
    `/user/products/suggested?date=${date}&daytime=${meal}`,
  );
}
