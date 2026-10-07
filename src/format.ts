/**
 * Yazio data rendered as compact text.
 *
 * Raw payloads are verbose (a product carries 30+ nutrients) and every tool
 * result costs tokens on each call, so tools answer with short text rather than
 * JSON. Ids are always included: they are what the next call needs. A diary row
 * carries both — `entry_id` to delete it, `product_id` to log the same food
 * again without searching for it by name.
 */

import { labelDate } from "./dates";
import { MEALS, type Meal } from "./yazio/meals";
import { addNutrients } from "./yazio/service";
import type {
  DaySummary,
  DayTotals,
  DiaryDay,
  Exercise,
  Goals,
  LoggedEntry,
  NutrientHistory,
  Nutrients,
  Product,
  QuickAddedEntry,
  SearchHit,
} from "./yazio/service";

export function macros(nutrients: Nutrients): string {
  return `${nutrients.kcal} kcal · P ${nutrients.protein} · F ${nutrients.fat} · C ${nutrients.carb}`;
}

function title(item: { name: string; producer: string | null; isVerified: boolean }): string {
  return `${item.name}${item.producer ? ` — ${item.producer}` : ""}${item.isVerified ? " ✓" : ""}`;
}

function servingList(product: Product): string {
  if (product.servings.length === 0) return `${product.baseUnit} only`;
  return product.servings
    .map((item) => `${item.serving} = ${item.amount} ${product.baseUnit}`)
    .join(", ");
}

export function formatSearchHits(query: string, hits: SearchHit[], country: string): string {
  if (hits.length === 0) {
    return (
      `Nothing found for "${query}" in the ${country} database. Try another spelling or a more ` +
      `general word — or create_product, if this food is not in Yazio at all.`
    );
  }

  const lines = hits.map((hit, index) => {
    const serving = hit.defaultServing
      ? `; portion: ${hit.defaultServing.serving} = ${hit.defaultServing.amount} ${hit.baseUnit}`
      : "";
    return (
      `${index + 1}. ${title(hit)}\n` +
      `   product_id: ${hit.id}\n` +
      `   per 100 ${hit.baseUnit}: ${macros(hit.per100)}${serving}`
    );
  });

  return `${country} database:\n\n${lines.join("\n")}`;
}

export function formatProduct(product: Product): string {
  return [
    `${title(product)}${product.isPrivate ? " (your own product)" : ""}`,
    `product_id: ${product.id}`,
    `per 100 ${product.baseUnit}: ${macros(product.per100)}`,
    `servings: ${servingList(product)}`,
  ].join("\n");
}

export function formatOwnProducts(products: Product[]): string {
  if (products.length === 0) {
    return "The user has no foods of their own yet; create_product makes one.";
  }

  const lines = products.map(
    (product, index) =>
      `${index + 1}. ${product.name}\n` +
      `   product_id: ${product.id}\n` +
      `   per 100 ${product.baseUnit}: ${macros(product.per100)}`,
  );

  return `Foods the user made themselves:\n\n${lines.join("\n")}`;
}

export function formatDiary(day: DiaryDay): string {
  if (day.entries.length === 0 && day.otherEntryCount === 0) {
    return `${labelDate(day.date)}: nothing logged.`;
  }

  const sections = MEALS.flatMap((meal) => {
    const entries = day.entries.filter((entry) => entry.meal === meal);
    if (entries.length === 0) return [];

    const mealKcal = Math.round(entries.reduce((sum, entry) => sum + entry.nutrients.kcal, 0));
    const lines = entries.map((entry) => {
      const portion =
        entry.amount === null
          ? "quick add"
          : entry.serving && entry.serving !== "gram" && entry.serving !== "milliliter"
            ? `${entry.servingQuantity} × ${entry.serving} = ${entry.amount} ${entry.baseUnit}`
            : `${entry.amount} ${entry.baseUnit}`;
      const ids =
        `entry_id: ${entry.entryId}` + (entry.productId ? `, product_id: ${entry.productId}` : "");
      return `  · ${entry.name} — ${portion} — ${macros(entry.nutrients)}\n    ${ids}`;
    });

    return [`${meal} (${mealKcal} kcal):\n${lines.join("\n")}`];
  });

  const tail =
    day.otherEntryCount > 0
      ? `\n\nPlus ${day.otherEntryCount} recipe portion${day.otherEntryCount === 1 ? "" : "s"} ` +
        `this connector cannot read; they still count in get_daily_summary.`
      : "";

  return `${labelDate(day.date)}\n\n${sections.join("\n\n")}\n\nDay total: ${macros(day.totals)}${tail}`;
}

function remaining(goalKcal: number, eatenKcal: number): string {
  const left = Math.round(goalKcal - eatenKcal);
  return left >= 0 ? `${left} kcal left` : `${Math.abs(left)} kcal over`;
}

export function formatDaySummary(summary: DaySummary): string {
  const lines = [
    labelDate(summary.date),
    `Eaten: ${macros(summary.consumed)}`,
    `Goal: ${macros(summary.goal)} → ${remaining(summary.goal.kcal, summary.consumed.kcal)}`,
    `Activity: ${summary.activityEnergy} kcal, ${summary.steps} steps` +
      (summary.consumeActivityEnergy ? " (activity is added to the goal)" : ""),
  ];

  const byMeal = MEALS.filter((meal) => summary.mealNutrients[meal].kcal > 0)
    .map((meal) => `${meal} ${summary.mealNutrients[meal].kcal}`)
    .join(", ");

  if (byMeal) lines.push(`By meal, kcal: ${byMeal}`);
  if (summary.waterGoal > 0) lines.push(`Water: ${summary.waterIntake} / ${summary.waterGoal} ml`);
  if (summary.currentWeight !== null) lines.push(`Weight: ${summary.currentWeight} kg`);

  return lines.join("\n");
}

export function formatRangeSummary(days: DayTotals[]): string {
  if (days.length === 0) return "No days in that range.";

  const rows = days.map((day) => {
    const delta = Math.round(day.consumed.kcal - day.goalKcal);
    return (
      `${day.date}  ${String(Math.round(day.consumed.kcal)).padStart(5)} / ` +
      `${String(Math.round(day.goalKcal)).padStart(5)} kcal  (${delta > 0 ? `+${delta}` : delta})  ` +
      `P ${day.consumed.protein} F ${day.consumed.fat} C ${day.consumed.carb}`
    );
  });

  const logged = days.filter((day) => day.consumed.kcal > 0);
  const average = (pick: (day: DayTotals) => number) =>
    Math.round(logged.reduce((sum, day) => sum + pick(day), 0) / logged.length);

  const tail =
    logged.length === 0
      ? "Nothing logged on any of these days."
      : `Average of the ${logged.length} logged day(s): ${average((day) => day.consumed.kcal)} kcal ` +
        `(goal ${average((day) => day.goalKcal)}), P ${average((day) => day.consumed.protein)} · ` +
        `F ${average((day) => day.consumed.fat)} · C ${average((day) => day.consumed.carb)}`;

  return [
    `${days[0].date} — ${days[days.length - 1].date}`,
    "",
    "date         eaten / goal        macros",
    ...rows,
    "",
    tail,
  ].join("\n");
}

export function formatNutrientHistory(history: NutrientHistory): string {
  const rows = history.days.map(
    (day) => `${day.date}  ${String(day.value).padStart(8)} ${history.unit}`,
  );

  const logged = history.days.filter((day) => day.value > 0);
  const tail =
    logged.length === 0
      ? "Nothing logged on any of these days."
      : `Average of the ${logged.length} logged day(s): ` +
        `${Math.round((logged.reduce((sum, day) => sum + day.value, 0) / logged.length) * 10) / 10} ${history.unit}`;

  return [`${history.nutrient} per day:`, "", ...rows, "", tail].join("\n");
}

export function formatGoals(goals: Goals): string {
  const lines = [
    `Goals for ${labelDate(goals.date)} (without the activity bonus):`,
    `Calories: ${goals.goal.kcal} kcal`,
    `Protein ${goals.goal.protein} g · fat ${goals.goal.fat} g · carbs ${goals.goal.carb} g`,
    `Water: ${goals.waterGoal} ml · steps: ${goals.stepGoal}`,
  ];

  if (goals.diet) {
    lines.push(
      `Diet "${goals.diet.name}": C ${goals.diet.carb}% / F ${goals.diet.fat}% / P ${goals.diet.protein}%`,
    );
  }

  if (goals.restriction) lines.push(`Dietary restriction: ${goals.restriction}`);

  lines.push(`Weight: ${goals.currentWeight ?? "?"} kg → target ${goals.targetWeight} kg`);
  lines.push(
    goals.consumeActivityEnergy
      ? "get_daily_summary shows this goal raised by the energy spent on logged activity."
      : "The user has turned off eating back activity calories, so this goal is the whole story.",
  );

  return lines.join("\n");
}

export function formatExercises(date: string, exercises: Exercise[]): string {
  if (exercises.length === 0) return `${labelDate(date)}: no exercise logged.`;

  const lines = exercises.map((item) => {
    const parts = [`${item.energy} kcal`];
    if (item.duration > 0) parts.push(`${item.duration} min`);
    if (item.steps > 0) parts.push(`${item.steps} steps`);
    return `  · ${item.name} — ${parts.join(", ")}${item.note ? ` (${item.note})` : ""}`;
  });

  const total = exercises.reduce((sum, item) => sum + item.energy, 0);
  return `${labelDate(date)}\n\n${lines.join("\n")}\n\nBurned: ${total} kcal`;
}

/** What the model reports after a write: this meal, the day so far, what is left. */
function writeReport(meal: Meal, added: Nutrients, summary: DaySummary | null): string[] {
  if (!summary) return [`Added in total: ${macros(added)}`];

  return [
    `This meal (${meal}): ${macros(summary.mealNutrients[meal])}`,
    `Day so far: ${macros(summary.consumed)} of ${summary.goal.kcal} kcal`,
    `Remaining: ${remaining(summary.goal.kcal, summary.consumed.kcal)}`,
  ];
}

function sum(entries: Array<{ nutrients: Nutrients }>): Nutrients {
  return entries.reduce((total, entry) => addNutrients(total, entry.nutrients), {
    kcal: 0,
    carb: 0,
    fat: 0,
    protein: 0,
  });
}

export function formatLogged(
  date: string,
  meal: Meal,
  entries: LoggedEntry[],
  summary: DaySummary | null,
): string {
  const lines = [`Logged to ${meal}, ${date}:`];

  for (const entry of entries) {
    lines.push(
      `  · ${entry.product.name} — ${entry.amount} ${entry.product.baseUnit} — ${macros(entry.nutrients)}\n` +
        `    entry_id: ${entry.entryId}, product_id: ${entry.product.id}`,
    );
  }

  return [...lines, ...writeReport(meal, sum(entries), summary)].join("\n");
}

export function formatQuickAdded(
  date: string,
  meal: Meal,
  entries: QuickAddedEntry[],
  summary: DaySummary | null,
): string {
  const lines = [`Quick-added to ${meal}, ${date}:`];

  for (const entry of entries) {
    lines.push(`  · ${entry.name} — ${macros(entry.nutrients)}\n    entry_id: ${entry.entryId}`);
  }

  return [...lines, ...writeReport(meal, sum(entries), summary)].join("\n");
}

export function formatSuggested(
  meal: Meal,
  items: Array<{ product: Product; amount: number; nutrients: Nutrients }>,
): string {
  if (items.length === 0) {
    return `No suggestions for ${meal}; use search_products.`;
  }

  const lines = items.map(
    (item, index) =>
      `${index + 1}. ${title(item.product)}\n` +
      `   product_id: ${item.product.id}\n` +
      `   usual portion: ${item.amount} ${item.product.baseUnit} — ${macros(item.nutrients)}`,
  );

  return `Usual for ${meal}:\n\n${lines.join("\n")}`;
}
