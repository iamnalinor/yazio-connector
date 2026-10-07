import { describe, expect, it } from "bun:test";

import {
  formatDiary,
  formatLogged,
  formatNutrientHistory,
  formatOwnProducts,
  formatRangeSummary,
  macros,
} from "../src/format";
import {
  addNutrients,
  per100,
  perBaseUnit,
  resolveAmount,
  scaleFrom100,
  type DaySummary,
  type DayTotals,
  type DiaryDay,
  type Product,
} from "../src/yazio/service";

const curd: Product = {
  id: "p1",
  name: "Quark 5%",
  producer: null,
  baseUnit: "g",
  isVerified: false,
  isPrivate: false,
  // 117 kcal / 100 g
  per100: { kcal: 117, carb: 3, fat: 5, protein: 15 },
  servings: [
    { serving: "portion", amount: 80 },
    { serving: "tablespoon", amount: 50 },
  ],
};

describe("per100", () => {
  it("converts Yazio's per-base-unit values to per 100", () => {
    // Straight from the live API: 0.98 kcal per gram.
    expect(per100({ "energy.energy": 0.98, "nutrient.protein": 0.1112 })).toEqual({
      kcal: 98,
      carb: 0,
      fat: 0,
      protein: 11.1,
    });
  });
});

describe("perBaseUnit", () => {
  it("is the inverse of per100, which is what writing a product needs", () => {
    const values = perBaseUnit({ kcal: 98, carb: 0, fat: 0, protein: 11.1 });
    expect(values["energy.energy"]).toBeCloseTo(0.98, 10);
    expect(per100(values)).toEqual({ kcal: 98, carb: 0, fat: 0, protein: 11.1 });
  });
});

describe("scaleFrom100", () => {
  it("scales to the logged amount", () => {
    expect(scaleFrom100(curd.per100, 123)).toEqual({
      kcal: 144,
      carb: 3.7,
      fat: 6.2,
      protein: 18.5,
    });
  });

  it("is a no-op at exactly 100", () => {
    expect(scaleFrom100(curd.per100, 100)).toEqual(curd.per100);
  });
});

describe("addNutrients", () => {
  it("sums without float noise", () => {
    const total = [
      { kcal: 168, carb: 10.5, fat: 5, protein: 20 },
      { kcal: 159, carb: 18.2, fat: 8.8, protein: 1.9 },
    ].reduce(addNutrients, { kcal: 0, carb: 0, fat: 0, protein: 0 });

    expect(total).toEqual({ kcal: 327, carb: 28.7, fat: 13.8, protein: 21.9 });
  });
});

describe("resolveAmount", () => {
  it("logs a raw amount as gram/quantity, the way the app does", () => {
    expect(resolveAmount(curd, { amount: 123 })).toEqual({
      amount: 123,
      serving: "gram",
      servingQuantity: 123,
    });
  });

  it("uses milliliter for drinks", () => {
    const drink = { ...curd, baseUnit: "ml", servings: [] };
    expect(resolveAmount(drink, { amount: 250 })).toEqual({
      amount: 250,
      serving: "milliliter",
      servingQuantity: 250,
    });
  });

  it("converts a named serving into base units", () => {
    expect(resolveAmount(curd, { serving: "portion", servingQuantity: 2 })).toEqual({
      amount: 160,
      serving: "portion",
      servingQuantity: 2,
    });
  });

  it("defaults a named serving to one portion and ignores case", () => {
    expect(resolveAmount(curd, { serving: "Tablespoon" })).toEqual({
      amount: 50,
      serving: "tablespoon",
      servingQuantity: 1,
    });
  });

  it("accepts a base-unit serving name as a raw amount", () => {
    expect(resolveAmount(curd, { serving: "g", amount: 40 })).toEqual({
      amount: 40,
      serving: "gram",
      servingQuantity: 40,
    });
  });

  it("lists the real portions when an unknown one is asked for", () => {
    expect(() => resolveAmount(curd, { serving: "cup" })).toThrow(
      /no serving called "cup".*portion \(80 g\), tablespoon \(50 g\)/s,
    );
  });

  it("refuses an empty request", () => {
    expect(() => resolveAmount(curd, {})).toThrow(/"Quark 5%" needs either amount/);
    expect(() => resolveAmount(curd, { amount: 0 })).toThrow(/greater than zero/);
  });
});

describe("formatDiary", () => {
  const day: DiaryDay = {
    date: "2026-07-30",
    entries: [
      {
        entryId: "e1",
        productId: "p1",
        name: "Quark 5%",
        producer: null,
        meal: "snack",
        amount: 123,
        baseUnit: "g",
        serving: "gram",
        servingQuantity: 123,
        nutrients: { kcal: 144, carb: 3.7, fat: 6.2, protein: 18.5 },
      },
      {
        entryId: "e2",
        productId: "p2",
        name: "Chicken nuggets",
        producer: null,
        meal: "breakfast",
        amount: 69,
        baseUnit: "g",
        serving: "each",
        servingQuantity: 3,
        nutrients: { kcal: 126, carb: 11, fat: 5.1, protein: 9 },
      },
    ],
    otherEntryCount: 0,
    totals: { kcal: 270, carb: 14.7, fat: 11.3, protein: 27.5 },
  };

  it("groups by meal in canonical order and keeps entry ids", () => {
    const rendered = formatDiary(day);
    expect(rendered.indexOf("breakfast")).toBeLessThan(rendered.indexOf("snack"));
    expect(rendered).toContain("entry_id: e1, product_id: p1");
    expect(rendered).toContain("3 × each = 69 g");
    // A raw gram amount should not be dressed up as a portion.
    expect(rendered).toContain("· Quark 5% — 123 g");
    expect(rendered).toContain("Day total: 270 kcal");
  });

  it("mentions the recipe portions it cannot describe", () => {
    expect(formatDiary({ ...day, otherEntryCount: 2 })).toContain("Plus 2 recipe portions");
  });

  it("shows a quick-added row without pretending it has a product", () => {
    const rendered = formatDiary({
      ...day,
      entries: [
        {
          entryId: "e3",
          productId: null,
          name: "canteen soup",
          producer: null,
          meal: "lunch",
          amount: null,
          baseUnit: null,
          serving: null,
          servingQuantity: null,
          nutrients: { kcal: 320, carb: 30, fat: 12, protein: 14 },
        },
      ],
    });

    expect(rendered).toContain("· canteen soup — quick add — 320 kcal");
    expect(rendered).toContain("entry_id: e3");
    expect(rendered).not.toContain("product_id");
  });

  it("says so when the day is empty", () => {
    expect(
      formatDiary({
        date: "2026-07-29",
        entries: [],
        otherEntryCount: 0,
        totals: { kcal: 0, carb: 0, fat: 0, protein: 0 },
      }),
    ).toContain("nothing logged");
  });
});

describe("formatRangeSummary", () => {
  const day = (date: string, kcal: number): DayTotals => ({
    date,
    consumed: { kcal, carb: 0, fat: 0, protein: 0 },
    goalKcal: 2000,
  });

  it("averages only the days that actually have food logged", () => {
    const rendered = formatRangeSummary([
      day("2026-07-28", 1800),
      day("2026-07-29", 0),
      day("2026-07-30", 2200),
    ]);

    expect(rendered).toContain("Average of the 2 logged day(s)");
    expect(rendered).toContain("2000 kcal");
    expect(rendered).toContain("(+200)");
  });

  it("keeps a day with nothing logged in the table", () => {
    const rendered = formatRangeSummary([day("2026-07-29", 0), day("2026-07-30", 2200)]);
    expect(rendered).toContain("2026-07-29");
    expect(rendered).toContain("Average of the 1 logged day(s)");
  });
});

describe("formatNutrientHistory", () => {
  it("keeps the unit and averages only the logged days", () => {
    const rendered = formatNutrientHistory({
      nutrient: "fiber",
      unit: "g",
      days: [
        { date: "2026-07-28", value: 10 },
        { date: "2026-07-29", value: 0 },
        { date: "2026-07-30", value: 20 },
      ],
    });

    expect(rendered).toContain("fiber per day:");
    expect(rendered).toContain("10 g");
    expect(rendered).toContain("Average of the 2 logged day(s): 15 g");
  });
});

describe("formatLogged", () => {
  const summary: DaySummary = {
    date: "2026-07-30",
    consumed: { kcal: 1500, carb: 150, fat: 50, protein: 100 },
    goal: { kcal: 2000, carb: 200, fat: 60, protein: 150 },
    activityEnergy: 0,
    consumeActivityEnergy: false,
    steps: 0,
    waterIntake: 0,
    waterGoal: 0,
    currentWeight: null,
    mealNutrients: {
      breakfast: { kcal: 0, carb: 0, fat: 0, protein: 0 },
      lunch: { kcal: 0, carb: 0, fat: 0, protein: 0 },
      dinner: { kcal: 0, carb: 0, fat: 0, protein: 0 },
      snack: { kcal: 400, carb: 20, fat: 15, protein: 30 },
    },
  };

  const entry = {
    entryId: "e1",
    product: curd,
    meal: "snack" as const,
    amount: 123,
    nutrients: { kcal: 144, carb: 3.7, fat: 6.2, protein: 18.5 },
  };

  it("reports the meal, the day and what is left, and gives both ids back", () => {
    const rendered = formatLogged("2026-07-30", "snack", [entry], summary);

    expect(rendered).toContain("entry_id: e1, product_id: p1");
    expect(rendered).toContain("This meal (snack): 400 kcal");
    expect(rendered).toContain("Day so far: 1500 kcal · P 100 · F 50 · C 150 of 2000 kcal");
    expect(rendered).toContain("Remaining: 500 kcal left");
  });

  it("still confirms the write when the summary could not be fetched", () => {
    const rendered = formatLogged("2026-07-30", "snack", [entry], null);

    expect(rendered).toContain("entry_id: e1");
    expect(rendered).toContain("Added in total: 144 kcal");
    expect(rendered).not.toContain("Remaining");
  });
});

describe("formatOwnProducts", () => {
  it("lists the user's own foods with the id the next call needs", () => {
    const rendered = formatOwnProducts([curd]);
    expect(rendered).toContain("Quark 5%");
    expect(rendered).toContain("product_id: p1");
  });

  it("points at create_product when there are none", () => {
    expect(formatOwnProducts([])).toContain("create_product");
  });
});

describe("macros", () => {
  it("is compact and ordered protein/fat/carbs", () => {
    expect(macros({ kcal: 144, carb: 3.7, fat: 6.2, protein: 18.5 })).toBe(
      "144 kcal · P 18.5 · F 6.2 · C 3.7",
    );
  });
});
