import { afterEach, describe, expect, it, setSystemTime } from "bun:test";

import { dateRange, labelDate, resolveDate, shiftDate, todayAtOffset } from "../src/dates";

afterEach(() => {
  setSystemTime();
});

/** Freeze the clock at a UTC instant. */
function at(utc: string) {
  setSystemTime(new Date(utc));
}

describe("todayAtOffset", () => {
  it("rolls over with the offset, not with UTC", () => {
    // 21:30 UTC is already the next day three hours east.
    at("2026-07-30T21:30:00Z");
    expect(todayAtOffset(0)).toBe("2026-07-30");
    expect(todayAtOffset(180)).toBe("2026-07-31");
  });

  it("handles offsets behind UTC", () => {
    at("2026-07-30T02:00:00Z");
    expect(todayAtOffset(-300)).toBe("2026-07-29");
  });
});

describe("shiftDate", () => {
  it("crosses month and year boundaries", () => {
    expect(shiftDate("2026-07-31", 1)).toBe("2026-08-01");
    expect(shiftDate("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftDate("2026-01-01", -1)).toBe("2025-12-31");
    expect(shiftDate("2024-02-28", 1)).toBe("2024-02-29");
  });
});

describe("resolveDate", () => {
  const today = "2026-07-30";

  it("defaults to the day it was given", () => {
    expect(resolveDate(undefined, today)).toBe(today);
    expect(resolveDate("", today)).toBe(today);
  });

  it("understands day words, whatever the case", () => {
    expect(resolveDate("today", today)).toBe("2026-07-30");
    expect(resolveDate("Yesterday", today)).toBe("2026-07-29");
    expect(resolveDate("TOMORROW", today)).toBe("2026-07-31");
  });

  it("understands relative offsets", () => {
    expect(resolveDate("-3", today)).toBe("2026-07-27");
    expect(resolveDate("-6d", today)).toBe("2026-07-24");
    expect(resolveDate("+2 days", today)).toBe("2026-08-01");
  });

  it("passes ISO dates through untouched", () => {
    expect(resolveDate("2025-01-05", today)).toBe("2025-01-05");
  });

  it("rejects garbage instead of silently using today", () => {
    expect(() => resolveDate("last summer", today)).toThrow(/Bad date/);
    expect(() => resolveDate("30.07.2026", today)).toThrow();
  });
});

describe("dateRange", () => {
  it("is inclusive on both ends", () => {
    expect(dateRange("2026-07-28", "2026-07-30", 31)).toEqual([
      "2026-07-28",
      "2026-07-29",
      "2026-07-30",
    ]);
  });

  it("normalises a reversed range and honours the cap", () => {
    expect(dateRange("2026-07-30", "2026-07-28", 31)).toEqual([
      "2026-07-28",
      "2026-07-29",
      "2026-07-30",
    ]);
    expect(dateRange("2026-01-01", "2026-12-31", 5)).toHaveLength(5);
  });
});

describe("labelDate", () => {
  it("appends the weekday", () => {
    expect(labelDate("2026-07-30")).toBe("2026-07-30 (Thu)");
  });
});
