/** Yazio's four daytimes, in the order the app shows them. */
export const MEALS = ["breakfast", "lunch", "dinner", "snack"] as const;

export type Meal = (typeof MEALS)[number];
