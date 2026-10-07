/**
 * Date helpers.
 *
 * Yazio talks in plain `YYYY-MM-DD` calendar dates, but a Worker always runs in
 * UTC. Resolving "today" with `new Date()` would roll over at the wrong moment
 * for the user, so "today" is worked out once per request from the offset in
 * their Yazio profile and then passed around as a date string.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const RELATIVE_DAYS = /^([+-]\d{1,3})\s*(?:d|day|days)?$/;

/** Current calendar date at a fixed offset from UTC, as `YYYY-MM-DD`. */
export function todayAtOffset(offsetMinutes: number): string {
  return new Date(Date.now() + offsetMinutes * 60_000).toISOString().slice(0, 10);
}

/** Shift an ISO date by whole days. Calendar-safe (no DST involved). */
export function shiftDate(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/**
 * Turn whatever the model passed into an ISO date: an ISO date, an empty value
 * ("today"), a day word, or an offset like `-3` / `-3d`.
 */
export function resolveDate(input: string | undefined | null, today: string): string {
  const value = (input ?? "").trim().toLowerCase();

  if (value === "") return today;
  if (ISO_DATE.test(value)) return value;

  switch (value) {
    case "today":
      return today;
    case "yesterday":
      return shiftDate(today, -1);
    case "tomorrow":
      return shiftDate(today, 1);
  }

  const relative = RELATIVE_DAYS.exec(value);
  if (relative) return shiftDate(today, Number(relative[1]));

  throw new Error(
    `Bad date "${input}". Use YYYY-MM-DD, "today", "yesterday" or an offset like -3.`,
  );
}

/** Inclusive list of ISO dates between two dates, capped to `limit` days. */
export function dateRange(start: string, end: string, limit: number): string[] {
  if (end < start) [start, end] = [end, start];

  const dates: string[] = [];
  for (let date = start; date <= end && dates.length < limit; date = shiftDate(date, 1)) {
    dates.push(date);
  }
  return dates;
}

/** Weekday + date, e.g. `2026-07-30 (Thu)`. */
export function labelDate(isoDate: string): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  const weekday = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, day)));
  return `${isoDate} (${weekday})`;
}
