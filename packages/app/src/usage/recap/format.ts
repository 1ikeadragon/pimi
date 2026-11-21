export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function formatHours(ms: number, locale: string | undefined): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: ms < 36_000_000 ? 1 : 0 }).format(
    ms / 3_600_000,
  );
}

export function formatHour(hour: number, locale: string | undefined): string {
  return new Intl.DateTimeFormat(locale, { hour: "numeric" }).format(new Date(2000, 0, 1, hour));
}

/** A YYYY-MM-DD local day, as "Tue, Nov 18". */
export function formatDay(day: string, locale: string | undefined): string {
  const [year, month, date] = day.split("-").map(Number);
  return new Intl.DateTimeFormat(locale, {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(year, month - 1, date));
}

export function formatRange(startMs: number, endMs: number, locale: string | undefined): string {
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).formatRange(new Date(startMs), new Date(endMs - 1));
}

export function formatCount(value: number, locale: string | undefined): string {
  return new Intl.NumberFormat(locale).format(value);
}
