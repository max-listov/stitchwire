/**
 * End a long-lived local answer when the consumer leaves, and why `for await` cannot be trusted to do it.
 *
 * `ndjsonRoute` announces a departure two ways: it aborts the signal it hands this source, and it
 * calls `return()` on the iterator we give back. The second one is the obvious hook and it is the
 * one that does not work here. A door generator is parked inside `await source.next()`, not
 * at a `yield`, and returning a generator suspended in an await only queues the return until that
 * await settles — which, on a topic that is quiet, is never. Silence is a topic's NORMAL state, so
 * this is not an edge: it is the ordinary way a consumer goes away.
 *
 * The cost of getting it wrong is not a leaked object but a leaked ADMISSION: the node's slot stays
 * taken, and after `maxEventSubscriptions` of them every later subscriber is refused `capacity`
 * while the broker's own counters look perfectly healthy. Measured on the fleet as 1251 refusals
 * across four nodes with the topic ceiling never touched.
 *
 * So departure is acted on through the signal, which arrives regardless of where the generator is
 * standing. Ending the source resolves the parked `next()` with `done`, and the generator then
 * unwinds on its own.
 */
export function endOnDeparture(signal: AbortSignal, source: { return?: () => unknown }): void {
  const end = (): void => {
    void Promise.resolve(source.return?.()).catch(() => {
      /* the consumer is already gone; there is nobody left to tell */
    });
  };
  if (signal.aborted) {
    end();
    return;
  }
  signal.addEventListener('abort', end, { once: true });
}
