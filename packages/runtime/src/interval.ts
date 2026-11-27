/**
 * A repeating timer that never keeps the process alive: a poll exists to serve a running agent or
 * broker, and one that is the last thing left must not hold a stopped process open.
 */
export function backgroundInterval(callback: () => void, intervalMs: number): ReturnType<typeof setInterval> {
  return setInterval(callback, intervalMs).unref();
}
