/**
 * MCP tool surface.
 *
 * A fresh server is built per request, so nothing is kept here between calls.
 * Descriptions are written in the words a user would use — calories, macros,
 * what did I eat — so a model reaches for this connector on any food question
 * without being told to, and kept short because every word costs tokens.
 */

import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { dateRange, resolveDate, todayAtOffset } from "./dates";
import {
  formatDaySummary,
  formatDiary,
  formatExercises,
  formatOwnProducts,
  formatGoals,
  formatLogged,
  formatNutrientHistory,
  formatProduct,
  formatQuickAdded,
  formatRangeSummary,
  formatSearchHits,
  formatSuggested,
} from "./format";
import type { Session } from "./session";
import { YazioApiError, YazioShapeError } from "./yazio/api";
import { MEALS } from "./yazio/meals";
import { NUTRIENTS, PRODUCT_CATEGORIES, SERVING_NAMES, YazioService } from "./yazio/service";

const MAX_RANGE_DAYS = 31;
const MAX_LOG_ITEMS = 20;
const SEARCH_LIMIT_DEFAULT = 8;
const SUGGESTION_LIMIT_DEFAULT = 8;
const OWN_PRODUCTS_LIMIT_DEFAULT = 25;
const MAX_WATER_ML = 10_000;

const INSTRUCTIONS = `The user's food and calorie diary. Use it for anything about eating,
nutrition or weight: what they ate, calories or protein left against their goal, logging a meal,
weekly averages, their targets. Do not guess nutrition values or ask for numbers they already track.

Get a product id from search_products, get_recent_products or list_food_log before log_food; never
invent one. When the user logs something they have eaten before, reuse the product_id the diary
already gives you instead of searching by name again. If a food is not in the catalogue at all, make
it once with create_product; for a one-off with no product behind it, use quick_add_food.

product_id is a catalogue food, entry_id is one diary row (that is what deletion takes). Ids are
for your own next call, not for the user.
Amounts are grams, or ml for drinks. Dates default to today.

After writing anything to the diary, tell the user the macros of that meal, the day's macros totals so far
and the calories left.`;

/** Said in both write tools, because that is where the model decides what to report. */
const REPORT_BACK =
  "After logging, tell the user three things: the macros of this meal, the day's macros totals so far, " +
  "and how many calories are left.";

const dateArg = z
  .string()
  .optional()
  .describe('YYYY-MM-DD, "today", "yesterday", or an offset like "-3". Default: today.');

const mealArg = z.enum(MEALS).describe("breakfast, lunch, dinner or snack.");

function text(body: string) {
  return { content: [{ type: "text" as const, text: body }] };
}

/** Yazio refuses a write whose user agent it does not recognise. */
function isVersionBlocked(error: YazioApiError): boolean {
  return error.status === 403 && error.body.includes("version_blocked");
}

/** A session Yazio has invalidated; only a new token gets past it. */
function isSessionRejected(error: unknown): boolean {
  return error instanceof YazioApiError && error.status === 401;
}

function describe(error: unknown): string {
  if (error instanceof YazioApiError) {
    const detail = error.body ? ` It said: ${error.body}` : "";
    if (isSessionRejected(error)) return `Yazio no longer accepts this session.${detail}`;
    if (isVersionBlocked(error)) {
      return (
        "Yazio refused the write because it does not recognise this client. That is a bug in " +
        "the connector, not something the user can fix."
      );
    }
    return `Yazio answered ${error.status}.${detail}`;
  }

  if (error instanceof YazioShapeError) {
    return `Yazio answered in an unexpected shape; its API is unofficial and may have changed. ${error.message}`;
  }

  return error instanceof Error ? error.message : String(error);
}

/** Turn an upstream failure into a readable tool error instead of a crash. */
function toolError(error: unknown, onSessionRejected?: () => void) {
  if (isSessionRejected(error)) onSessionRejected?.();
  return { content: [{ type: "text" as const, text: describe(error) }], isError: true };
}

/**
 * @param onSessionRejected called when Yazio turns the session down, so the
 * Worker can answer 401 and have the client renew instead of leaving the user
 * to reconnect by hand.
 */
export function createServer(session: Session, onSessionRejected?: () => void): McpServer {
  const server = new McpServer(
    { name: "yazio", title: "Yazio food and calorie diary", version: "1.0.0" },
    { instructions: INSTRUCTIONS },
  );

  const yazio = new YazioService(session);
  const today = todayAtOffset(session.timezoneOffsetMinutes ?? 0);

  server.registerTool(
    "search_products",
    {
      title: "Search the food catalogue",
      description:
        "Find a food by name. Returns product ids for log_food, kcal and macros per 100 g/ml, and " +
        "the default portion. The catalogue is multilingual — query in the language the food is " +
        "labelled in. Nothing found means the food may not be in Yazio: create_product then.",
      inputSchema: z.object({
        query: z.string().min(2).describe("Product name, in the user's own language."),
        country: z
          .string()
          .length(2)
          .optional()
          .describe("Country code of the food database. Default: the user's own."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(25)
          .optional()
          .describe(`Hits to return. Default: ${SEARCH_LIMIT_DEFAULT}.`),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, country, limit }) => {
      try {
        const found = await yazio.searchProducts({
          query,
          country,
          limit: limit ?? SEARCH_LIMIT_DEFAULT,
        });
        return text(formatSearchHits(query, found.hits, found.country));
      } catch (error) {
        return toolError(error, onSessionRejected);
      }
    },
  );

  server.registerTool(
    "get_product",
    {
      title: "Product details",
      description:
        "Full nutrition for one product, with every portion size Yazio knows for it. Those portion " +
        "names are what `serving` takes in log_food.",
      inputSchema: z.object({
        product_id: z
          .string()
          .describe("From search_products, get_recent_products or list_food_log."),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ product_id }) => {
      try {
        return text(formatProduct(await yazio.getProduct(product_id)));
      } catch (error) {
        return toolError(error, onSessionRejected);
      }
    },
  );

  server.registerTool(
    "get_recent_products",
    {
      title: "Usual and recent foods",
      description:
        "What the user eats regularly for this meal, with their usual portion. Try this before " +
        "search_products when logging habitual food.",
      inputSchema: z.object({
        meal: mealArg,
        date: dateArg,
        limit: z
          .number()
          .int()
          .min(1)
          .max(15)
          .optional()
          .describe(`Suggestions to return. Default: ${SUGGESTION_LIMIT_DEFAULT}.`),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ meal, date, limit }) => {
      try {
        const day = resolveDate(date, today);
        const items = await yazio.suggestedProducts(day, meal, limit ?? SUGGESTION_LIMIT_DEFAULT);
        return text(formatSuggested(meal, items));
      } catch (error) {
        return toolError(error, onSessionRejected);
      }
    },
  );

  server.registerTool(
    "create_product",
    {
      title: "Create a food of your own",
      description:
        "Add a food the Yazio catalogue does not have, so it can be logged now and reused later. " +
        "Give nutrition per 100 g/ml, off the label. The food is private to the user, and " +
        "search_products will not find it — list_my_products is where it turns up afterwards. " +
        "Pass the product_id it returns straight to log_food.",
      inputSchema: z.object({
        name: z.string().min(3).describe("What the user calls this food."),
        kcal_per_100: z.number().min(0).describe("Calories in 100 g (or 100 ml)."),
        protein_per_100: z.number().min(0).describe("Protein in grams per 100."),
        fat_per_100: z.number().min(0).describe("Fat in grams per 100."),
        carb_per_100: z.number().min(0).describe("Carbs in grams per 100."),
        base_unit: z
          .enum(["g", "ml"])
          .optional()
          .describe("ml for drinks, g for everything else. Default: g."),
        category: z
          .enum(PRODUCT_CATEGORIES)
          .optional()
          .describe("Default: miscellaneous, which is always safe."),
        servings: z
          .array(
            z.object({
              serving: z.enum(SERVING_NAMES).describe("Portion name the app understands."),
              amount: z.number().positive().describe("How many g/ml one such portion weighs."),
            }),
          )
          .max(10)
          .optional()
          .describe('Named portions, e.g. one "slice" = 30 g. Default: portion = 100.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (args) => {
      try {
        const product = await yazio.createProduct({
          name: args.name,
          baseUnit: args.base_unit ?? "g",
          category: args.category ?? "miscellaneous",
          per100: {
            kcal: args.kcal_per_100,
            protein: args.protein_per_100,
            fat: args.fat_per_100,
            carb: args.carb_per_100,
          },
          servings: args.servings ?? [],
        });
        return text(`Created.\n${formatProduct(product)}\nLog it with log_food.`);
      } catch (error) {
        return toolError(error, onSessionRejected);
      }
    },
  );

  server.registerTool(
    "list_my_products",
    {
      title: "Foods the user made themselves",
      description:
        "Everything the user added with create_product. Look here when they ask for a food of " +
        "their own by name — search_products does not cover these.",
      inputSchema: z.object({
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe(`Foods to return. Default: ${OWN_PRODUCTS_LIMIT_DEFAULT}.`),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ limit }) => {
      try {
        return text(
          formatOwnProducts(await yazio.ownProducts(limit ?? OWN_PRODUCTS_LIMIT_DEFAULT)),
        );
      } catch (error) {
        return toolError(error, onSessionRejected);
      }
    },
  );

  server.registerTool(
    "delete_product",
    {
      title: "Delete a food of the user's own",
      description:
        "Remove a food the user created. Only their own foods can go — the Yazio catalogue cannot. " +
        "Diary entries already logged with it stay as they are; delete those separately if the " +
        "user wants them gone too.",
      inputSchema: z.object({
        product_id: z.string().describe("From list_my_products or create_product."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ product_id }) => {
      try {
        const product = await yazio.deleteProduct(product_id);
        return text(`Deleted "${product.name}" from the user's own foods.`);
      } catch (error) {
        return toolError(error, onSessionRejected);
      }
    },
  );

  server.registerTool(
    "log_food",
    {
      title: "Log food to the diary",
      description:
        "Write products into the diary — a whole meal in one call. Per item give `amount` in " +
        "grams/ml, or `serving` plus `serving_quantity`. Returns an entry_id and a product_id per " +
        `item and the new day total. Nothing is written unless every item is valid. ${REPORT_BACK}`,
      inputSchema: z.object({
        meal: mealArg,
        items: z
          .array(
            z.object({
              product_id: z
                .string()
                .describe(
                  "From search_products, get_recent_products, list_food_log or create_product.",
                ),
              amount: z.number().positive().optional().describe("Grams, or ml for drinks."),
              serving: z.string().optional().describe("Portion name from get_product."),
              serving_quantity: z
                .number()
                .positive()
                .optional()
                .describe("How many portions. Default: 1. Only with `serving`."),
            }),
          )
          .min(1)
          .max(MAX_LOG_ITEMS)
          .describe("Products for one meal on one day."),
        date: dateArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ meal, items, date }) => {
      try {
        const day = resolveDate(date, today);
        const logged = await yazio.logFood(
          day,
          items.map((item) => ({
            productId: item.product_id,
            meal,
            amount: item.amount,
            serving: item.serving,
            servingQuantity: item.serving_quantity,
          })),
        );

        // The entries are saved; a failing summary must not make this look failed.
        const summary = await yazio.daySummary(day).catch(() => null);
        return text(formatLogged(day, meal, logged, summary));
      } catch (error) {
        return toolError(error, onSessionRejected);
      }
    },
  );

  server.registerTool(
    "quick_add_food",
    {
      title: "Quick-add calories",
      description:
        "Log calories with no product behind them — Yazio's Quick Add. For a one-off: a restaurant " +
        "dish, a friend's cooking, a number off a menu. Use create_product instead when the user " +
        `will eat this again and wants it by name later. ${REPORT_BACK}`,
      inputSchema: z.object({
        meal: mealArg,
        items: z
          .array(
            z.object({
              name: z.string().min(1).describe("What it was, as the user would name it."),
              kcal: z.number().min(0).describe("Calories actually eaten, not per 100 g."),
              protein: z.number().min(0).optional().describe("Grams eaten."),
              fat: z.number().min(0).optional().describe("Grams eaten."),
              carb: z.number().min(0).optional().describe("Grams eaten."),
            }),
          )
          .min(1)
          .max(MAX_LOG_ITEMS),
        date: dateArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ meal, items, date }) => {
      try {
        const day = resolveDate(date, today);
        const added = await yazio.quickAdd(day, meal, items);
        const summary = await yazio.daySummary(day).catch(() => null);
        return text(formatQuickAdded(day, meal, added, summary));
      } catch (error) {
        return toolError(error, onSessionRejected);
      }
    },
  );

  server.registerTool(
    "list_food_log",
    {
      title: "Read the food diary",
      description:
        "Everything logged on a day, by meal, with kcal and macros per entry, the entry_id that " +
        "delete_food_log_entries needs and the product_id to log the same food again.",
      inputSchema: z.object({ date: dateArg }),
      annotations: { readOnlyHint: true },
    },
    async ({ date }) => {
      try {
        return text(formatDiary(await yazio.diary(resolveDate(date, today))));
      } catch (error) {
        return toolError(error, onSessionRejected);
      }
    },
  );

  server.registerTool(
    "delete_food_log_entries",
    {
      title: "Delete diary entries",
      description: "Remove logged items by entry_id, not by product id. Cannot be undone.",
      inputSchema: z.object({
        entry_ids: z
          .array(z.string())
          .min(1)
          .max(MAX_LOG_ITEMS)
          .describe("From list_food_log, log_food or quick_add_food."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ entry_ids }) => {
      try {
        await yazio.deleteEntries(entry_ids);
        return text(`Deleted ${entry_ids.length} entr${entry_ids.length === 1 ? "y" : "ies"}.`);
      } catch (error) {
        return toolError(error, onSessionRejected);
      }
    },
  );

  server.registerTool(
    "get_daily_summary",
    {
      title: "Calories eaten versus goal",
      description:
        "Eaten versus goal for one day, or a day-by-day table with averages for a range. Answers " +
        "'how many calories are left', 'did I hit my protein', 'how was last week'. The goal here " +
        "includes the bonus Yazio adds for logged activity.",
      inputSchema: z.object({
        date: dateArg,
        start_date: z.string().optional().describe("Start of a range."),
        end_date: z.string().optional().describe("End of a range. Default: today."),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ date, start_date, end_date }) => {
      try {
        if (start_date) {
          const dates = dateRange(
            resolveDate(start_date, today),
            resolveDate(end_date, today),
            MAX_RANGE_DAYS,
          );
          if (dates.length === 1) {
            return text(formatDaySummary(await yazio.daySummary(dates[0])));
          }
          return text(formatRangeSummary(await yazio.rangeSummary(dates)));
        }

        return text(formatDaySummary(await yazio.daySummary(resolveDate(date, today))));
      } catch (error) {
        return toolError(error, onSessionRejected);
      }
    },
  );

  server.registerTool(
    "get_nutrient_history",
    {
      title: "One nutrient day by day",
      description:
        "How much of a single nutrient the user got each day: fibre, sugar, sodium, saturated fat, " +
        "iron, a vitamin. Answers 'am I getting enough fibre', 'how much sugar last week'. For " +
        "calories and the three macros together, get_daily_summary with a range is better.",
      inputSchema: z.object({
        nutrient: z
          .enum(Object.keys(NUTRIENTS) as [keyof typeof NUTRIENTS])
          .describe("Which nutrient to chart."),
        start_date: z.string().describe("Start of the range."),
        end_date: z.string().optional().describe("End of the range. Default: today."),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ nutrient, start_date, end_date }) => {
      try {
        const dates = dateRange(
          resolveDate(start_date, today),
          resolveDate(end_date, today),
          MAX_RANGE_DAYS,
        );
        return text(formatNutrientHistory(await yazio.nutrientHistory(nutrient, dates)));
      } catch (error) {
        return toolError(error, onSessionRejected);
      }
    },
  );

  server.registerTool(
    "log_water",
    {
      title: "Set water drunk",
      description:
        "Set how much water the user has drunk on a day, in millilitres. This replaces the day's " +
        "total rather than adding to it — read the current figure from get_daily_summary first if " +
        "the user says 'another glass'.",
      inputSchema: z.object({
        milliliters: z.number().min(0).max(MAX_WATER_ML).describe("The day's total, in ml."),
        date: dateArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ milliliters, date }) => {
      try {
        const day = resolveDate(date, today);
        await yazio.setWater(day, milliliters);
        const summary = await yazio.daySummary(day).catch(() => null);
        const goal = summary && summary.waterGoal > 0 ? ` of ${summary.waterGoal} ml` : "";
        return text(`Water on ${day}: ${milliliters} ml${goal}.`);
      } catch (error) {
        return toolError(error, onSessionRejected);
      }
    },
  );

  server.registerTool(
    "list_exercises",
    {
      title: "Exercise logged on a day",
      description:
        "Workouts recorded for a day, with the calories each burned. Yazio adds this energy to the " +
        "calorie goal shown by get_daily_summary.",
      inputSchema: z.object({ date: dateArg }),
      annotations: { readOnlyHint: true },
    },
    async ({ date }) => {
      try {
        const day = resolveDate(date, today);
        return text(formatExercises(day, await yazio.exercises(day)));
      } catch (error) {
        return toolError(error, onSessionRejected);
      }
    },
  );

  server.registerTool(
    "get_goals",
    {
      title: "Nutrition goals",
      description:
        "The user's targets: calories, protein/fat/carbs, water, steps, diet split, dietary " +
        "restriction, current and target weight.",
      inputSchema: z.object({ date: dateArg }),
      annotations: { readOnlyHint: true },
    },
    async ({ date }) => {
      try {
        return text(formatGoals(await yazio.goals(resolveDate(date, today))));
      } catch (error) {
        return toolError(error, onSessionRejected);
      }
    },
  );

  return server;
}
