/**
 * How many calls one owner socket runs at once. The socket is the resource: a descriptor's limit
 * may change while earlier calls still hold capacity, so the ceiling is the one each new call
 * brings, applied to everything the socket is running now.
 */
export class SocketCeiling {
  private readonly active = new Map<string, number>();

  /** One slot on the socket, or null when it already runs `limit` calls. The release counts once. */
  acquire(socket: string, limit: number): (() => void) | null {
    const running = this.active.get(socket) ?? 0;
    if (running >= limit) return null;
    this.active.set(socket, running + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.active.get(socket) ?? 1) - 1;
      if (remaining === 0) this.active.delete(socket);
      else this.active.set(socket, remaining);
    };
  }

  /** Sockets that run a call now: a socket nobody uses keeps no entry, however many were ever seen. */
  get busy(): number {
    return this.active.size;
  }
}
