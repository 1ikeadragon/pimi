export type RecapPeriod = "this-week" | "last-week" | "this-month" | "last-month";

export interface RecapRange {
  startMs: number;
  endMs: number;
}

/** Local calendar bounds: weeks start on Monday, the current period ends at its natural end. */
export function recapRange(period: RecapPeriod, now = new Date()): RecapRange {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  if (period === "this-week" || period === "last-week") {
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7) - (period === "last-week" ? 7 : 0));
    end.setTime(start.getTime());
    end.setDate(end.getDate() + 7);
  } else {
    start.setDate(1);
    if (period === "last-month") start.setMonth(start.getMonth() - 1);
    end.setTime(start.getTime());
    end.setMonth(end.getMonth() + 1);
  }
  return { startMs: start.getTime(), endMs: end.getTime() };
}
