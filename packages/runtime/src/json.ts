/** A JSON object whose members are not yet known. */
export type Json = Record<string, unknown>;

/** JSON dictionaries have own entries; Object.prototype never grants a named capability. */
export function ownEntry<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

export function isRecord(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** `value` when it is a JSON object, otherwise an empty one: for reading tables out of a document. */
export function asJson(value: unknown): Json {
  return isRecord(value) ? value : {};
}

/**
 * `value` with its object keys in code-unit order at every depth and `undefined` members dropped,
 * so two values that mean the same print the same bytes. Arrays keep their order unless
 * `orderRows` is given, which sorts them too (a table whose row order is only a rendering detail).
 * Code-unit order rather than locale order: the result is signed bytes, and a locale must not
 * change a signature.
 */
export function sortedDeep(value: unknown, orderRows?: (left: unknown, right: unknown) => number): unknown {
  if (Array.isArray(value)) {
    const items = value.map((item) => sortedDeep(item, orderRows));
    return orderRows === undefined ? items : items.sort(orderRows);
  }
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, member]) => member !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, member]) => [key, sortedDeep(member, orderRows)]),
  );
}
