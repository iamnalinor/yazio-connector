/**
 * Domain layer between the MCP tools and the Yazio API.
 *
 * Tools work with the plain objects declared here and never see Yazio's own
 * field names or its per-base-unit nutrients.
 */

import * as api from "./api";
import type { NutrientValues, Sex } from "./api";
import type { Meal } from "./meals";

export interface Nutrients {
  kcal: number;
  carb: number;
  fat: number;
  protein: number;
}

export interface Serving {
  serving: string;
  /** Grams (or ml) in one such serving. */
  amount: number;
}

export interface Product {
  id: string;
  name: string;
  producer: string | null;
  baseUnit: string;
  /** Per 100 base units — the way humans and food labels talk. */
  per100: Nutrients;
  servings: Serving[];
  isVerified: boolean;
  /** The user's own product, invisible to everyone else. */
  isPrivate: boolean;
}

export interface SearchHit extends Omit<Product, "servings" | "isPrivate"> {
  /** Portion the app offers by default for this hit. */
  defaultServing: { serving: string; amount: number } | null;
}

export interface DiaryEntry {
  entryId: string;
  /** `null` for a Quick Add row: it has no product behind it. */
  productId: string | null;
  name: string;
  producer: string | null;
  meal: Meal;
  amount: number | null;
  baseUnit: string | null;
  serving: string | null;
  servingQuantity: number | null;
  nutrients: Nutrients;
}

export interface DiaryDay {
  date: string;
  entries: DiaryEntry[];
  /** Recipe portions: counted by Yazio, not described by this connector. */
  otherEntryCount: number;
  totals: Nutrients;
}

export interface DaySummary {
  date: string;
  consumed: Nutrients;
  /** Goal for that day as the app shows it, activity bonus included. */
  goal: Nutrients;
  activityEnergy: number;
  consumeActivityEnergy: boolean;
  steps: number;
  waterIntake: number;
  waterGoal: number;
  currentWeight: number | null;
  mealNutrients: Record<Meal, Nutrients>;
}

/** What a range needs, and all Yazio returns for one: eaten plus the calorie goal. */
export interface DayTotals {
  date: string;
  consumed: Nutrients;
  goalKcal: number;
}

export interface Goals {
  date: string;
  goal: Nutrients;
  stepGoal: number;
  waterGoal: number;
  targetWeight: number;
  currentWeight: number | null;
  diet: { name: string; carb: number; fat: number; protein: number } | null;
  /** Vegetarian, vegan, … as the user set it, or `null`. */
  restriction: string | null;
  /** Whether Yazio raises the calorie goal by the energy spent on activity. */
  consumeActivityEnergy: boolean;
}

export interface Exercise {
  name: string;
  energy: number;
  /** Minutes. */
  duration: number;
  steps: number;
  note: string | null;
}

/** What to write into the diary for one product. */
interface LogRequest {
  productId: string;
  meal: Meal;
  amount?: number;
  serving?: string;
  servingQuantity?: number;
}

export interface LoggedEntry {
  entryId: string;
  product: Product;
  meal: Meal;
  amount: number;
  nutrients: Nutrients;
}

/** A Quick Add row: a name and the totals actually eaten. */
interface QuickAddRequest {
  name: string;
  kcal: number;
  protein?: number;
  fat?: number;
  carb?: number;
}

export interface QuickAddedEntry {
  entryId: string;
  name: string;
  meal: Meal;
  nutrients: Nutrients;
}

/** A product the user is about to create. Nutrition is per 100 base units. */
interface NewProduct {
  name: string;
  baseUnit: string;
  category: string;
  per100: Nutrients;
  servings: Serving[];
}

const ENERGY = "energy.energy";
const CARB = "nutrient.carb";
const FAT = "nutrient.fat";
const PROTEIN = "nutrient.protein";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PRODUCT_TTL_MS = 60 * 60 * 1000;
const PRODUCT_CACHE_LIMIT = 500;

const NAME_MIN_LENGTH = 3;
const BASE_UNITS = ["g", "ml"];

/** Categories the app is known to accept. */
export const PRODUCT_CATEGORIES = [
  "miscellaneous",
  "meat",
  "cheese",
  "chocolate",
  "drinksnonalcoholic",
] as const;

/** Portion names the app understands; anything else is refused upstream. */
export const SERVING_NAMES = [
  "portion",
  "piece",
  "slice",
  "package",
  "bar",
  "bottle",
  "can",
  "cup",
  "glass",
  "tablespoon",
  "teaspoon",
  "tablet",
  "each",
] as const;

/**
 * Nutrients a history can be asked for.
 *
 * Yazio reports every mass in grams; the app shows the small ones in mg or µg,
 * so `factor` is what one display unit is worth in grams.
 */
export const NUTRIENTS = {
  energy: { key: ENERGY, unit: "kcal", factor: 1 },
  protein: { key: PROTEIN, unit: "g", factor: 1 },
  fat: { key: FAT, unit: "g", factor: 1 },
  carb: { key: CARB, unit: "g", factor: 1 },
  fiber: { key: "nutrient.dietaryfiber", unit: "g", factor: 1 },
  sugar: { key: "nutrient.sugar", unit: "g", factor: 1 },
  saturated_fat: { key: "nutrient.saturated", unit: "g", factor: 1 },
  salt: { key: "nutrient.salt", unit: "g", factor: 1 },
  alcohol: { key: "nutrient.alcohol", unit: "g", factor: 1 },
  sodium: { key: "nutrient.sodium", unit: "mg", factor: 1e-3 },
  cholesterol: { key: "nutrient.cholesterol", unit: "mg", factor: 1e-3 },
  calcium: { key: "mineral.calcium", unit: "mg", factor: 1e-3 },
  iron: { key: "mineral.iron", unit: "mg", factor: 1e-3 },
  potassium: { key: "mineral.potassium", unit: "mg", factor: 1e-3 },
  magnesium: { key: "mineral.magnesium", unit: "mg", factor: 1e-3 },
  zinc: { key: "mineral.zinc", unit: "mg", factor: 1e-3 },
  vitamin_c: { key: "vitamin.c", unit: "mg", factor: 1e-3 },
  vitamin_d: { key: "vitamin.d", unit: "µg", factor: 1e-6 },
  vitamin_b12: { key: "vitamin.b12", unit: "µg", factor: 1e-6 },
} as const;

export type NutrientName = keyof typeof NUTRIENTS;

/** The four the range endpoint already carries, so they cost no extra request. */
const DAILY_COLUMN: Partial<Record<NutrientName, "energy" | "protein" | "fat" | "carb">> = {
  energy: "energy",
  protein: "protein",
  fat: "fat",
  carb: "carb",
};

export interface NutrientHistory {
  nutrient: NutrientName;
  unit: string;
  /** One entry per requested day; days with nothing logged read zero. */
  days: Array<{ date: string; value: number }>;
}

/**
 * Product cards, shared by every request this isolate serves.
 *
 * Reading a diary day needs one product per entry and Yazio has no bulk product
 * endpoint, so this cache is what keeps a repeated day cheap. Nothing personal
 * goes in it, and it disappears with the isolate.
 */
const productCache = new Map<string, { product: Product; expiresAt: number }>();

function cacheProduct(product: Product): void {
  if (productCache.size >= PRODUCT_CACHE_LIMIT) {
    // Oldest insertion first; good enough to bound memory.
    const oldest = productCache.keys().next();
    if (!oldest.done) productCache.delete(oldest.value);
  }
  productCache.set(product.id, { product, expiresAt: Date.now() + PRODUCT_TTL_MS });
}

function cachedProduct(productId: string): Product | null {
  const hit = productCache.get(productId);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    productCache.delete(productId);
    return null;
  }
  return hit.product;
}

function round(value: number, digits = 0): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Yazio reports nutrients per one base unit; humans think per 100. */
export function per100(values: NutrientValues): Nutrients {
  return {
    kcal: round((values[ENERGY] ?? 0) * 100, 1),
    carb: round((values[CARB] ?? 0) * 100, 1),
    fat: round((values[FAT] ?? 0) * 100, 1),
    protein: round((values[PROTEIN] ?? 0) * 100, 1),
  };
}

/** The other way round, for writing a product. */
export function perBaseUnit(values: Nutrients): Record<string, number> {
  return {
    [ENERGY]: values.kcal / 100,
    [CARB]: values.carb / 100,
    [FAT]: values.fat / 100,
    [PROTEIN]: values.protein / 100,
  };
}

export function scaleFrom100(base: Nutrients, amount: number): Nutrients {
  const factor = amount / 100;
  return {
    kcal: round(base.kcal * factor),
    carb: round(base.carb * factor, 1),
    fat: round(base.fat * factor, 1),
    protein: round(base.protein * factor, 1),
  };
}

export function addNutrients(a: Nutrients, b: Nutrients): Nutrients {
  return {
    kcal: round(a.kcal + b.kcal),
    carb: round(a.carb + b.carb, 1),
    fat: round(a.fat + b.fat, 1),
    protein: round(a.protein + b.protein, 1),
  };
}

const NOTHING: Nutrients = { kcal: 0, carb: 0, fat: 0, protein: 0 };

function absolute(values: NutrientValues): Nutrients {
  return {
    kcal: round(values[ENERGY] ?? 0),
    carb: round(values[CARB] ?? 0, 1),
    fat: round(values[FAT] ?? 0, 1),
    protein: round(values[PROTEIN] ?? 0, 1),
  };
}

/** The serving name the app uses when an amount is entered in base units. */
function baseUnitServing(baseUnit: string): string {
  return baseUnit === "ml" ? "milliliter" : "gram";
}

function isBaseUnitServing(serving: string, baseUnit: string): boolean {
  const normalized = serving.toLowerCase();
  return normalized === baseUnitServing(baseUnit) || normalized === "g" || normalized === "ml";
}

/**
 * Work out what to send to Yazio for the requested portion.
 *
 * A diary entry always carries the amount in base units; `serving` and
 * `servingQuantity` are only how the app displays it, and for a raw amount the
 * app itself uses `gram` / `milliliter` with the quantity equal to the amount.
 */
export function resolveAmount(
  product: Product,
  request: Pick<LogRequest, "amount" | "serving" | "servingQuantity">,
): { amount: number; serving: string; servingQuantity: number } {
  const inBaseUnits = (amount: number) => ({
    amount,
    serving: baseUnitServing(product.baseUnit),
    servingQuantity: amount,
  });

  let resolved: { amount: number; serving: string; servingQuantity: number };

  if (request.serving === undefined) {
    if (request.amount === undefined) {
      throw new Error(`"${product.name}" needs either amount (in ${product.baseUnit}) or serving.`);
    }
    resolved = inBaseUnits(request.amount);
  } else {
    const known = product.servings.find(
      (item) => item.serving.toLowerCase() === request.serving?.toLowerCase(),
    );
    const quantity = request.servingQuantity ?? 1;

    if (known) {
      resolved = {
        amount: round(known.amount * quantity, 2),
        serving: known.serving,
        servingQuantity: quantity,
      };
    } else if (isBaseUnitServing(request.serving, product.baseUnit)) {
      resolved = inBaseUnits(request.amount ?? request.servingQuantity ?? 0);
    } else {
      const available =
        product.servings
          .map((item) => `${item.serving} (${item.amount} ${product.baseUnit})`)
          .join(", ") || "none";
      throw new Error(
        `"${product.name}" has no serving called "${request.serving}". Available: ${available}. ` +
          `Or pass amount in ${product.baseUnit}.`,
      );
    }
  }

  if (!(resolved.amount > 0)) throw new Error("Amount must be greater than zero.");
  return resolved;
}

function nonNegative(value: number | undefined, label: string): number {
  const amount = value ?? 0;
  if (!Number.isFinite(amount) || amount < 0) throw new Error(`${label} cannot be negative.`);
  return amount;
}

/** What the service needs of the caller's session; `Session` satisfies it. */
interface Account {
  accessToken: string;
  /** Food database to search when the caller names no country. */
  country: string;
  sex: Sex;
}

export class YazioService {
  private readonly token: string;
  private userPromise?: Promise<api.YazioUser>;

  constructor(private readonly account: Account) {
    this.token = account.accessToken;
  }

  /** The Yazio profile, fetched at most once per request. */
  private user(): Promise<api.YazioUser> {
    this.userPromise ??= api.getUser(this.token);
    return this.userPromise;
  }

  // --- products ------------------------------------------------------------

  async searchProducts(options: {
    query: string;
    country?: string;
    limit: number;
  }): Promise<{ country: string; hits: SearchHit[] }> {
    const country = (options.country ?? this.account.country).toUpperCase();

    const results = await api.searchProducts(this.token, {
      query: options.query,
      country,
      sex: this.account.sex,
    });

    const hits = results.slice(0, options.limit).map((hit) => ({
      id: hit.product_id,
      name: hit.name,
      producer: hit.producer || null,
      baseUnit: hit.base_unit,
      isVerified: hit.is_verified ?? false,
      per100: per100(hit.nutrients),
      defaultServing:
        hit.serving && hit.amount && !isBaseUnitServing(hit.serving, hit.base_unit)
          ? { serving: hit.serving, amount: hit.amount }
          : null,
    }));

    return { country, hits };
  }

  async getProduct(productId: string): Promise<Product> {
    if (!UUID.test(productId)) {
      throw new Error(
        `"${productId}" is not a Yazio product id (a UUID is expected). Take one from ` +
          `search_products, get_recent_products or list_food_log.`,
      );
    }

    const cached = cachedProduct(productId);
    if (cached) return cached;

    const raw = await api.getProduct(this.token, productId);
    if (!raw) throw new Error(`No product ${productId} in the Yazio catalogue.`);

    const product: Product = {
      id: productId,
      name: raw.name,
      producer: raw.producer || null,
      baseUnit: raw.base_unit,
      isVerified: raw.is_verified ?? false,
      isPrivate: raw.is_private ?? false,
      per100: per100(raw.nutrients),
      servings: raw.servings,
    };

    cacheProduct(product);
    return product;
  }

  /**
   * Create a product of the user's own and hand back its id.
   *
   * The new product does not turn up in `search_products` until Yazio rebuilds
   * its catalogue, so it is cached here right away: `get_product` and
   * `log_food` work with it from the next call on.
   */
  async createProduct(input: NewProduct): Promise<Product> {
    const name = input.name.trim();
    if (name.length < NAME_MIN_LENGTH) {
      throw new Error(`A product name needs at least ${NAME_MIN_LENGTH} characters.`);
    }

    const baseUnit = input.baseUnit.toLowerCase();
    if (!BASE_UNITS.includes(baseUnit)) {
      throw new Error(`base_unit must be one of ${BASE_UNITS.join(", ")}.`);
    }

    const per100Values: Nutrients = {
      kcal: nonNegative(input.per100.kcal, "Calories"),
      carb: nonNegative(input.per100.carb, "Carbs"),
      fat: nonNegative(input.per100.fat, "Fat"),
      protein: nonNegative(input.per100.protein, "Protein"),
    };

    for (const serving of input.servings) {
      if (!(serving.amount > 0)) {
        throw new Error(`Portion "${serving.serving}" needs an amount in ${baseUnit}.`);
      }
    }

    // The app always gives a product at least one portion; match it.
    const servings =
      input.servings.length > 0 ? input.servings : [{ serving: "portion", amount: 100 }];

    const product: Product = {
      id: crypto.randomUUID(),
      name,
      producer: null,
      baseUnit,
      isVerified: false,
      isPrivate: true,
      per100: per100Values,
      servings,
    };

    await api.createProduct(this.token, {
      id: product.id,
      name: product.name,
      category: input.category,
      base_unit: baseUnit,
      is_private: true,
      nutrients: perBaseUnit(per100Values),
      servings,
    });

    cacheProduct(product);
    return product;
  }

  /** The user's own foods — Yazio's search does not carry them. */
  async ownProducts(limit: number): Promise<Product[]> {
    const ids = (await api.getOwnProductIds(this.token)).slice(0, limit);
    const products = await this.loadProducts(ids);
    return ids.flatMap((id) => products.get(id) ?? []);
  }

  /** Takes a product off the user's own list. Diary rows already written stay. */
  async deleteProduct(productId: string): Promise<Product> {
    const product = await this.getProduct(productId);
    await api.deleteProduct(this.token, productId);
    productCache.delete(productId);
    return product;
  }

  private async loadProducts(ids: string[]): Promise<Map<string, Product>> {
    const unique = [...new Set(ids)];
    const products = await Promise.all(unique.map((id) => this.getProduct(id).catch(() => null)));

    const byId = new Map<string, Product>();
    for (const product of products) if (product) byId.set(product.id, product);
    return byId;
  }

  /** Products Yazio suggests for that meal — in effect, the usual ones. */
  async suggestedProducts(date: string, meal: Meal, limit: number) {
    const suggestions = (await api.getSuggestedProducts(this.token, date, meal)).slice(0, limit);
    const products = await this.loadProducts(suggestions.map((item) => item.product_id));

    return suggestions.flatMap((item) => {
      const product = products.get(item.product_id);
      if (!product) return [];
      return [
        {
          product,
          amount: item.amount,
          nutrients: scaleFrom100(product.per100, item.amount),
        },
      ];
    });
  }

  // --- diary ---------------------------------------------------------------

  async diary(date: string): Promise<DiaryDay> {
    const raw = await api.getDiary(this.token, date);
    const products = await this.loadProducts(raw.products.map((item) => item.product_id));

    const entries = raw.products.map((item): DiaryEntry => {
      const product = products.get(item.product_id);
      return {
        entryId: item.id,
        productId: item.product_id,
        name: product?.name ?? "(unknown product)",
        producer: product?.producer ?? null,
        meal: item.daytime,
        amount: item.amount,
        baseUnit: product?.baseUnit ?? "g",
        serving: item.serving ?? null,
        servingQuantity: item.serving_quantity ?? null,
        nutrients: product ? scaleFrom100(product.per100, item.amount) : NOTHING,
      };
    });

    // Quick Add rows carry their own totals, so nothing needs looking up.
    const quickAdded = raw.simple_products.map((item): DiaryEntry => ({
      entryId: item.id,
      productId: null,
      name: item.name,
      producer: null,
      meal: item.daytime,
      amount: null,
      baseUnit: null,
      serving: null,
      servingQuantity: null,
      nutrients: absolute(item.nutrients),
    }));

    const all = [...entries, ...quickAdded];

    return {
      date,
      entries: all,
      otherEntryCount: raw.recipe_portions.length,
      totals: all.reduce((total, entry) => addNutrients(total, entry.nutrients), NOTHING),
    };
  }

  /**
   * Write products into the diary in one request.
   *
   * Portions are resolved against each product's own serving list first, so a
   * bad serving name fails before anything is written.
   */
  async logFood(date: string, requests: LogRequest[]): Promise<LoggedEntry[]> {
    const prepared = await Promise.all(
      requests.map(async (request) => {
        const product = await this.getProduct(request.productId);
        return { request, product, portion: resolveAmount(product, request) };
      }),
    );

    const entries = prepared.map(({ request, product, portion }) => ({
      entryId: crypto.randomUUID(),
      product,
      meal: request.meal,
      amount: portion.amount,
      serving: portion.serving,
      servingQuantity: portion.servingQuantity,
      nutrients: scaleFrom100(product.per100, portion.amount),
    }));

    await api.addConsumedItems(this.token, {
      products: entries.map((entry) => ({
        id: entry.entryId,
        product_id: entry.product.id,
        date,
        daytime: entry.meal,
        amount: entry.amount,
        serving: entry.serving,
        serving_quantity: entry.servingQuantity,
      })),
    });

    return entries;
  }

  /** Yazio's Quick Add: a name and the totals eaten, with no product behind it. */
  async quickAdd(
    date: string,
    meal: Meal,
    requests: QuickAddRequest[],
  ): Promise<QuickAddedEntry[]> {
    const entries = requests.map((request): QuickAddedEntry => {
      const name = request.name.trim();
      if (name === "") throw new Error("Every quick-added item needs a name.");

      return {
        entryId: crypto.randomUUID(),
        name,
        meal,
        nutrients: {
          kcal: nonNegative(request.kcal, "Calories"),
          carb: nonNegative(request.carb, "Carbs"),
          fat: nonNegative(request.fat, "Fat"),
          protein: nonNegative(request.protein, "Protein"),
        },
      };
    });

    await api.addConsumedItems(this.token, {
      simpleProducts: entries.map((entry) => ({
        id: entry.entryId,
        // A Quick Add row is stored with a time of day, unlike a product row.
        date: `${date} 12:00:00`,
        daytime: meal,
        name: entry.name,
        nutrients: {
          [ENERGY]: entry.nutrients.kcal,
          [CARB]: entry.nutrients.carb,
          [FAT]: entry.nutrients.fat,
          [PROTEIN]: entry.nutrients.protein,
        },
      })),
    });

    return entries;
  }

  deleteEntries(entryIds: string[]): Promise<void> {
    return api.deleteConsumedItems(this.token, entryIds);
  }

  // --- water and activity --------------------------------------------------

  /** Sets the day's water total; Yazio has no way to add to it. */
  async setWater(date: string, ml: number): Promise<number> {
    if (!Number.isFinite(ml) || ml < 0) throw new Error("Water must be zero or more millilitres.");
    await api.setWaterIntake(this.token, date, ml);
    // Report what Yazio stored, not what we asked for.
    return api.getWaterIntake(this.token, date);
  }

  async exercises(date: string): Promise<Exercise[]> {
    const raw = await api.getExercises(this.token, date);
    return [...raw.training, ...raw.custom_training].map((item) => ({
      name: item.name,
      energy: round(item.energy ?? 0),
      duration: round((item.duration ?? 0) / 60),
      steps: round(item.steps ?? 0),
      note: item.note || null,
    }));
  }

  // --- summaries -----------------------------------------------------------

  async daySummary(date: string): Promise<DaySummary> {
    const raw = await api.getDailySummary(this.token, date);

    const mealNutrients = {
      breakfast: absolute(raw.meals.breakfast?.nutrients ?? {}),
      lunch: absolute(raw.meals.lunch?.nutrients ?? {}),
      dinner: absolute(raw.meals.dinner?.nutrients ?? {}),
      snack: absolute(raw.meals.snack?.nutrients ?? {}),
    };

    const consumed = Object.values(raw.meals).reduce(
      (total, meal) => addNutrients(total, absolute(meal.nutrients)),
      NOTHING,
    );

    return {
      date,
      consumed,
      goal: absolute(raw.goals),
      activityEnergy: round(raw.activity_energy ?? 0),
      consumeActivityEnergy: raw.consume_activity_energy ?? false,
      steps: raw.steps ?? 0,
      waterIntake: round(raw.water_intake ?? 0),
      waterGoal: round(raw.goals.water ?? 0),
      currentWeight: raw.user?.current_weight ?? null,
      mealNutrients,
    };
  }

  /**
   * Eaten versus the calorie goal for each day of a range, in one request.
   *
   * Yazio leaves out days with nothing logged, so they are filled back in here:
   * an empty day is part of the answer to "how was last week".
   */
  async rangeSummary(dates: string[]): Promise<DayTotals[]> {
    if (dates.length === 0) return [];

    const raw = await api.getNutrientsDaily(this.token, dates[0], dates[dates.length - 1]);
    const byDate = new Map(raw.map((day) => [day.date, day]));
    const knownGoal = raw.find((day) => (day.energy_goal ?? 0) > 0)?.energy_goal ?? 0;

    return dates.map((date) => {
      const day = byDate.get(date);
      return {
        date,
        consumed: {
          kcal: round(day?.energy ?? 0),
          carb: round(day?.carb ?? 0, 1),
          fat: round(day?.fat ?? 0, 1),
          protein: round(day?.protein ?? 0, 1),
        },
        goalKcal: round(day?.energy_goal ?? knownGoal),
      };
    });
  }

  /**
   * One nutrient day by day.
   *
   * Calories and macros come off the range endpoint that already carries them;
   * everything else has its own, which reports grams whatever the app displays.
   */
  async nutrientHistory(nutrient: NutrientName, dates: string[]): Promise<NutrientHistory> {
    const { key, unit, factor } = NUTRIENTS[nutrient];
    if (dates.length === 0) return { nutrient, unit, days: [] };

    const start = dates[0];
    const end = dates[dates.length - 1];
    const column = DAILY_COLUMN[nutrient];
    const values = new Map<string, number>();

    if (column) {
      for (const day of await api.getNutrientsDaily(this.token, start, end)) {
        values.set(day.date, day[column] ?? 0);
      }
    } else {
      const raw = await api.getNutrientDaily(this.token, key, start, end);
      for (const [date, value] of Object.entries(raw)) values.set(date, value / factor);
    }

    return {
      nutrient,
      unit,
      days: dates.map((date) => ({ date, value: round(values.get(date) ?? 0, 1) })),
    };
  }

  async goals(date: string): Promise<Goals> {
    const [raw, user, currentWeight, preferences, settings] = await Promise.all([
      api.getGoals(this.token, date),
      this.user(),
      api.getWeight(this.token, date).catch(() => null),
      api.getDietaryPreferences(this.token).catch(() => null),
      api.getSettings(this.token).catch(() => null),
    ]);

    return {
      date,
      goal: absolute(raw),
      stepGoal: round(raw["activity.step"] ?? 0),
      waterGoal: round(raw.water ?? 0),
      targetWeight: round(raw["bodyvalue.weight"] ?? 0, 1),
      currentWeight,
      diet: user.diet
        ? {
            name: user.diet.name,
            carb: user.diet.carb_percentage,
            fat: user.diet.fat_percentage,
            protein: user.diet.protein_percentage,
          }
        : null,
      restriction: preferences?.restriction || null,
      consumeActivityEnergy: settings?.consume_activity_calories ?? true,
    };
  }
}
