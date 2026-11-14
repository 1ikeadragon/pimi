import type { UsageAggregate } from "@pimi/protocol/messages";

export function formatTokens(value: number, locale?: string): string {
  return new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(
    value,
  );
}

export function formatUsd(value: number, locale?: string): string {
  let maximumFractionDigits = 3;
  if (value >= 100) maximumFractionDigits = 0;
  else if (value >= 1) maximumFractionDigits = 2;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: Math.min(2, maximumFractionDigits),
    maximumFractionDigits,
  }).format(value);
}

/** "$18.40", or null while no event in the aggregate has a priced model. */
export function formatCostUsd(usage: UsageAggregate, locale?: string): string | null {
  return usage.costUsd === null ? null : formatUsd(usage.costUsd, locale);
}

export function formatPercent(fraction: number, locale?: string): string {
  return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 }).format(
    fraction,
  );
}

/** Share of input-side tokens served from cache, or null when nothing was read or written. */
export function cacheShare(usage: UsageAggregate): number | null {
  const inputSide = usage.input + usage.cacheRead + usage.cacheWrite;
  return inputSide === 0 ? null : usage.cacheRead / inputSide;
}

/** Local timezone offset in minutes east of UTC, the unit the daemon expects. */
export function timezoneOffsetMinutes(): number {
  return -new Date().getTimezoneOffset();
}
