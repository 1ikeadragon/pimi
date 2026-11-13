function channel(hex: string, offset: number): number {
  return Number.parseInt(hex.slice(offset, offset + 2), 16);
}

function parse(hex: string): [number, number, number] {
  const value = hex.startsWith("#") ? hex.slice(1) : hex;
  const full = value.length === 3 ? [...value].map((digit) => digit + digit).join("") : value;
  return [channel(full, 0), channel(full, 2), channel(full, 4)];
}

/** A color `amount` of the way from `from` to `to`, both `#rgb` or `#rrggbb`. */
export function mix(from: string, to: string, amount: number): string {
  const start = parse(from);
  const end = parse(to);
  const rgb = start.map((value, index) => Math.round(value + (end[index] - value) * amount));
  return `#${rgb.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}
