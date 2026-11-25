/**
 * Array.prototype.push/unshift/splice with a spread argument pass every element as an argument,
 * and V8 throws a RangeError past roughly 100,000 of them. History blocks of a huge chat reach
 * that, so these helpers copy element by element.
 */
export function pushAll<T>(target: T[], items: readonly T[]): void {
  for (const item of items) target.push(item);
}

/** Put `older` in front of `target`, in order, without replacing the array. */
export function prependInPlace<T>(target: T[], older: readonly T[]): void {
  const newer = target.slice();
  target.length = 0;
  pushAll(target, older);
  pushAll(target, newer);
}
