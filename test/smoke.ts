/**
 * End-to-end check against a real Yazio account.
 *
 * Runs every path the tools expose and prints exactly the text a model would
 * receive. It logs one test entry and deletes it again, so the diary is left as
 * it was.
 *
 *   YAZIO_EMAIL=... YAZIO_PASSWORD=... bun run smoke
 *
 * Credentials are read from the environment, or from a gitignored `.env`.
 */

import { dateRange, resolveDate, shiftDate, todayAtOffset } from "../src/dates";
import {
  formatDaySummary,
  formatDiary,
  formatExercises,
  formatGoals,
  formatLogged,
  formatNutrientHistory,
  formatOwnProducts,
  formatProduct,
  formatQuickAdded,
  formatRangeSummary,
  formatSearchHits,
  formatSuggested,
} from "../src/format";
import { offsetMinutes, type Session } from "../src/session";
import { getUser, login } from "../src/yazio/api";
import type { Meal } from "../src/yazio/meals";
import { YazioService } from "../src/yazio/service";

// Bun loads .env by itself, so both sources land in Bun.env.
const { YAZIO_EMAIL: email, YAZIO_PASSWORD: password } = Bun.env;

if (!email || !password) {
  throw new Error("Set YAZIO_EMAIL and YAZIO_PASSWORD (in the environment or in .env).");
}

function section(title: string, body: string) {
  console.log(`\n──────── ${title} ────────\n${body}`);
}

const token = await login(email, password);
const user = await getUser(token.accessToken);

section(
  "login",
  [
    `access token expires in ${Math.round((token.expiresAt - Date.now()) / 3_600_000)} h`,
    `refresh token: ${token.refreshToken ? "issued" : "missing"}`,
    `country: ${user.food_database_country ?? user.country ?? "?"}`,
    `timezone_offset: raw ${String(user.timezone_offset)} → ${String(offsetMinutes(user.timezone_offset))} min`,
  ].join("\n"),
);

const session: Session = {
  ...token,
  country: (user.food_database_country ?? user.country ?? "US").slice(0, 2).toUpperCase(),
  sex: user.sex === "female" ? "female" : "male",
  timezoneOffsetMinutes: offsetMinutes(user.timezone_offset),
};

const yazio = new YazioService(session);
const today = todayAtOffset(session.timezoneOffsetMinutes ?? 0);

const meal: Meal = "snack";
const query = "oatmeal";

const found = await yazio.searchProducts({ query, limit: 5 });
section("search_products", formatSearchHits(query, found.hits, found.country));

const russian = await yazio.searchProducts({ query: "творог 5%", limit: 3 });
section(
  "search_products (Russian query)",
  formatSearchHits("творог 5%", russian.hits, russian.country),
);

if (found.hits.length === 0) throw new Error("Search returned nothing — cannot continue.");

const product = await yazio.getProduct(found.hits[0].id);
section("get_product", formatProduct(product));

section(
  "get_recent_products",
  formatSuggested(meal, await yazio.suggestedProducts(today, meal, 3)),
);

// A product of our own: it must be readable by id straight away, even though
// Yazio will not have it in search for a while yet.
const own = await yazio.createProduct({
  name: "smoke test syrniki",
  baseUnit: "g",
  category: "miscellaneous",
  per100: { kcal: 220, carb: 18, fat: 9, protein: 14 },
  servings: [{ serving: "piece", amount: 70 }],
});
section("create_product", formatProduct(own));

const ownLogged = await yazio.logFood(today, [
  { productId: own.id, meal, serving: "piece", servingQuantity: 2 },
]);
section(
  "log_food (own product)",
  formatLogged(today, meal, ownLogged, await yazio.daySummary(today)),
);

const quick = await yazio.quickAdd(today, meal, [
  { name: "smoke test quick add", kcal: 111, protein: 4, fat: 3, carb: 2 },
]);
section("quick_add_food", formatQuickAdded(today, meal, quick, await yazio.daySummary(today)));

// Two items in one call, so the batch write is exercised for real.
const portion = product.servings[0];
const logged = await yazio.logFood(today, [
  { productId: product.id, meal, amount: 123 },
  portion
    ? { productId: product.id, meal, serving: portion.serving, servingQuantity: 2 }
    : { productId: product.id, meal, amount: 45 },
]);
section("log_food", formatLogged(today, meal, logged, await yazio.daySummary(today)));

const diary = await yazio.diary(today);
section("list_food_log", formatDiary(diary));

for (const entry of [...logged, ...ownLogged]) {
  const written = diary.entries.find((item) => item.entryId === entry.entryId);
  if (!written) throw new Error(`Entry ${entry.entryId} was written but is not in the diary.`);
  if (Math.round(written.nutrients.kcal) !== Math.round(entry.nutrients.kcal)) {
    throw new Error(
      `Calories disagree: log_food said ${entry.nutrients.kcal}, the diary says ${written.nutrients.kcal}.`,
    );
  }
}

const quickRow = diary.entries.find((entry) => entry.entryId === quick[0].entryId);
if (!quickRow) throw new Error("The quick-added row is not in the diary.");
if (quickRow.productId !== null || Math.round(quickRow.nutrients.kcal) !== 111) {
  throw new Error(`Quick Add came back wrong: ${JSON.stringify(quickRow)}`);
}

const written = [...logged, ...ownLogged, ...quick].map((entry) => entry.entryId);
await yazio.deleteEntries(written);
const afterDelete = await yazio.diary(today);
if (afterDelete.entries.some((entry) => written.includes(entry.entryId))) {
  throw new Error("A test entry was not deleted — check the diary by hand!");
}
section("delete_food_log_entries", `Removed ${written.length} entries, diary restored.`);

section("get_daily_summary (day)", formatDaySummary(await yazio.daySummary(today)));

const week = dateRange(resolveDate("-6", today), today, 31);
section("get_daily_summary (7 days)", formatRangeSummary(await yazio.rangeSummary(week)));

section(
  "get_nutrient_history (fibre)",
  formatNutrientHistory(await yazio.nutrientHistory("fiber", week)),
);

section("list_exercises", formatExercises(today, await yazio.exercises(today)));

// Water is a set, not an add, so put back exactly what was there before.
const summaryBefore = await yazio.daySummary(today);
await yazio.setWater(today, summaryBefore.waterIntake + 250);
const afterWater = await yazio.daySummary(today);
await yazio.setWater(today, summaryBefore.waterIntake);
section(
  "log_water",
  `${summaryBefore.waterIntake} ml → ${afterWater.waterIntake} ml → restored to ` +
    `${(await yazio.daySummary(today)).waterIntake} ml`,
);

section("list_my_products", formatOwnProducts(await yazio.ownProducts(5)));

const removed = await yazio.deleteProduct(own.id);
const stillMine = (await yazio.ownProducts(100)).some((item) => item.id === own.id);
if (stillMine) throw new Error(`"${removed.name}" is still in the user's own foods!`);
section("delete_product", `Removed "${removed.name}" from the user's own foods.`);

section("get_goals", formatGoals(await yazio.goals(today)));

section(
  "dates",
  [
    `today       → ${resolveDate(undefined, today)}`,
    `"yesterday" → ${resolveDate("yesterday", today)}`,
    `"-3"        → ${resolveDate("-3", today)}`,
    `shift +1    → ${shiftDate(today, 1)}`,
  ].join("\n"),
);

console.log("\n✅ smoke passed");
