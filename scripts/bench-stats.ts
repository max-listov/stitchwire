/** The middle of a set of samples, by its length. Refuses an empty set and a non-finite value:
 *  a missing measurement must fail the benchmark, never sort into the middle as NaN. */
export function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error('median of no samples');
  if (!values.every(Number.isFinite)) throw new Error('median over a missing or non-finite sample');
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}
