/**
 * A question a broker left unanswered is asked again after this many polls. A broker that was busy
 * for one acknowledgement window is asked again soon; one that never answers costs a request every
 * few polls, never one per poll. It follows the caller's own poll interval rather than a clock of its
 * own so a node that polls fast (a test, a short-lived stand) recovers as fast as it polls.
 */
const RETRY_POLLS = 6;

/**
 * The questions a node has put to its broker lanes, per lane: which are still open, and when the last
 * one went unanswered. A question asked once at connect or on a change would otherwise stay
 * unanswered until the lane next reconnected; with this it is asked again on a later poll, and never
 * beside one still open; a change that arrives while one is open is asked once it closes. A refusal is
 * an answer and is not asked again.
 */
export class UnansweredQuestions {
  private readonly open = new Map<string, number>();
  private readonly lostAt = new Map<string, number>();
  /** The newest question put to each lane: only its answer says whether the lane is still unanswered. */
  private readonly newest = new Map<string, number>();
  private asked = 0;
  private readonly deferred = new Set<string>();

  isOpen(id: string): boolean {
    return (this.open.get(id) ?? 0) > 0;
  }

  /** Remember that something changed while a question to this lane was open, so it is asked again. */
  defer(id: string): void {
    this.deferred.add(id);
  }

  /** Whether a change was deferred for this lane and nothing is open to it now; clears the memory. */
  takeDeferred(id: string): boolean {
    return !this.isOpen(id) && this.deferred.delete(id);
  }

  /**
   * Runs `ask` and remembers whether it was answered (`null` is no answer). Questions to one lane can
   * overlap (a changed request is sent beside an unanswered one), and a late result of an older one
   * says nothing about the newest: it neither marks the lane lost nor clears a loss recorded by the
   * newest, so `current` tells the caller whether this result is the newest question's.
   */
  async track<T>(id: string, ask: () => Promise<T | null>): Promise<{ answer: T | null; current: boolean }> {
    const ticket = ++this.asked;
    this.newest.set(id, ticket);
    this.open.set(id, (this.open.get(id) ?? 0) + 1);
    try {
      const answer = await ask();
      const current = this.newest.get(id) === ticket;
      if (current) {
        if (answer === null) this.lostAt.set(id, Date.now());
        else this.lostAt.delete(id);
      }
      return { answer, current };
    } finally {
      const left = (this.open.get(id) ?? 1) - 1;
      if (left <= 0) this.open.delete(id);
      else this.open.set(id, left);
    }
  }

  /** The lanes whose last question went unanswered long enough ago, with nothing open to them. */
  due(pollMs: number): string[] {
    const cutoff = Date.now() - RETRY_POLLS * pollMs;
    return [...this.lostAt].filter(([id, at]) => at <= cutoff && !this.isOpen(id)).map(([id]) => id);
  }
}
