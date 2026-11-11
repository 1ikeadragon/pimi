// Hermes on Android and iOS lacks the ES2023 change-array-by-copy methods. App and protocol code
// use them (the lint config prefers them over in-place sort/reverse), so define them where missing.
// Without this, opening a chat with a flow diagram crashed the native app.

interface ArrayCopyMethods {
  toSorted?: unknown;
  toReversed?: unknown;
  toSpliced?: unknown;
  with?: unknown;
}

function define(name: keyof ArrayCopyMethods, value: (...args: never[]) => unknown): void {
  if (typeof (Array.prototype as ArrayCopyMethods)[name] === "function") return;
  // oxlint-disable-next-line no-extend-native -- A spec polyfill, defined only when the engine lacks it.
  Object.defineProperty(Array.prototype, name, {
    value,
    writable: true,
    configurable: true,
    enumerable: false,
  });
}

export function polyfillArrayCopyMethods(): void {
  define("toSorted", function (this: unknown[], compare?: (a: unknown, b: unknown) => number) {
    if (compare !== undefined && typeof compare !== "function") {
      throw new TypeError("The comparison function must be either a function or undefined");
    }
    // oxlint-disable-next-line unicorn/no-array-sort -- This is the copy; sorting it in place is the point.
    return Array.prototype.slice.call(this).sort(compare);
  });
  define("toReversed", function (this: unknown[]) {
    // oxlint-disable-next-line unicorn/no-array-reverse -- This is the copy; reversing it in place is the point.
    return Array.prototype.slice.call(this).reverse();
  });
  define(
    "toSpliced",
    function (this: unknown[], start: number, deleteCount?: number, ...items: unknown[]) {
      const copy = Array.prototype.slice.call(this);
      if (arguments.length === 0) return copy;
      if (arguments.length === 1) {
        copy.splice(start);
        return copy;
      }
      copy.splice(start, deleteCount ?? 0, ...items);
      return copy;
    },
  );
  define("with", function (this: unknown[], index: number, value: unknown) {
    const length = this.length;
    const relative = Math.trunc(Number(index)) || 0;
    const actual = relative < 0 ? length + relative : relative;
    if (actual < 0 || actual >= length) throw new RangeError("Invalid index");
    const copy = Array.prototype.slice.call(this);
    copy[actual] = value;
    return copy;
  });
}
