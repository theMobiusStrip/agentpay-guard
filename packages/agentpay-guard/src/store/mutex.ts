/**
 * Minimal async mutex: serializes an async critical section so interleaved
 * awaits cannot both observe stale state. This is what lets the in-memory store
 * be genuinely atomic under concurrent tryReserve calls — the JS event loop can
 * interleave at every `await`, so a naive read-then-write store overspends
 * exactly the way the plan warns about. An external store replaces this with a
 * Redis Lua script or a serializable DB transaction.
 */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  async runExclusive<T>(fn: () => T | Promise<T>): Promise<T> {
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
