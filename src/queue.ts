/**
 * The push→pull adapter at the heart of pull(): client events PUSH batches in,
 * the async generator PULLs them out. Single-consumer by design — pull() is
 * the only reader, so one parked waiter is enough.
 */
export class AsyncBatchQueue<T> {
  private items: T[] = [];

  private waiter: (() => void) | null = null;

  private closedFlag = false;

  /** Enqueue and wake the parked consumer. Dropped silently after close(). */
  push(item: T): void {
    if (this.closedFlag) return;
    this.items.push(item);
    this.wake();
  }

  /**
   * No more pushes will be accepted; the consumer drains what is queued and
   * then receives null. Idempotent. Wakes a parked consumer so shutdown is
   * prompt even when the queue is empty.
   */
  close(): void {
    this.closedFlag = true;
    this.wake();
  }

  get closed(): boolean {
    return this.closedFlag;
  }

  /**
   * Next queued item in FIFO order; parks until one arrives. Resolves null
   * once the queue is closed AND drained.
   */
  async next(): Promise<T | null> {
    for (;;) {
      if (this.items.length > 0) return this.items.shift()!;
      if (this.closedFlag) return null;
      // eslint-disable-next-line no-await-in-loop
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
  }

  private wake(): void {
    const w = this.waiter;
    this.waiter = null;
    w?.();
  }
}
