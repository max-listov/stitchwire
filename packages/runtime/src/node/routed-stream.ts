/** Eager opening with cancellable routing; no extra frame queue or credit is owned here. */
export class RoutedStream<Route, Frame> implements AsyncIterableIterator<Frame> {
  private closed = false;
  private source: AsyncIterableIterator<Frame> | undefined;
  private readonly opening: Promise<void>;

  constructor(
    route: Promise<Route>,
    open: (route: Route) => AsyncIterableIterator<Frame>,
    private readonly cancelOpening: () => void = () => {},
  ) {
    this.opening = route.then((selected) => {
      if (!this.closed) this.source = open(selected);
    });
  }

  async next(): Promise<IteratorResult<Frame>> {
    await this.opening;
    if (this.closed || this.source === undefined) return { done: true, value: undefined };
    return this.source.next();
  }

  async return(): Promise<IteratorResult<Frame>> {
    this.closed = true;
    this.cancelOpening();
    await this.source?.return?.();
    return { done: true, value: undefined };
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<Frame> {
    return this;
  }
}
