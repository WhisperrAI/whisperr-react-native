import type { SafeStorage } from "./storage.js";
import type { QueuedOp } from "./types.js";

const QUEUE_KEY = "whisperr.queue.v1";

/**
 * An ordered outbound queue. Memory is the source of truth (mobile apps are
 * single-instance — no cross-tab races); every mutation schedules a
 * write-behind persist so the queue survives app kills. `restore()` prepends
 * ops from a previous launch ahead of anything captured before it resolved.
 * Pre-identify track ops sit here with a null user id until identify()
 * backfills them.
 */
export class DurableQueue {
  private ops: QueuedOp[] = [];
  private readonly persisted: Promise<QueuedOp[]>;
  private persistChain: Promise<void>;

  constructor(
    private readonly storage: SafeStorage,
    private readonly maxSize: number,
  ) {
    // Snapshot the previous launch's queue immediately — before any mutation
    // this session can persist — and hold all writes until the read resolves,
    // so restore() can never re-ingest this session's own ops.
    this.persisted = this.loadPersisted();
    this.persistChain = this.persisted.then(() => {});
  }

  get all(): readonly QueuedOp[] {
    return this.ops;
  }

  get size(): number {
    return this.ops.length;
  }

  /** Ops evicted to stay within maxSize (empty in the common case). */
  enqueue(op: QueuedOp): QueuedOp[] {
    this.ops.push(op);
    const overflow = Math.max(0, this.ops.length - this.maxSize);
    const evicted = overflow > 0 ? this.ops.splice(0, overflow) : [];
    this.schedulePersist();
    return evicted;
  }

  /** Restore ops persisted by a previous launch, ahead of current ones. */
  async restore(): Promise<void> {
    const previous = await this.persisted;
    if (previous.length > 0) {
      this.ops = [...previous, ...this.ops];
      const overflow = Math.max(0, this.ops.length - this.maxSize);
      if (overflow > 0) this.ops.splice(0, overflow);
    }
    this.schedulePersist();
  }

  private async loadPersisted(): Promise<QueuedOp[]> {
    const raw = await this.storage.get(QUEUE_KEY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as QueuedOp[]) : [];
    } catch {
      return []; // corrupt payload — discard
    }
  }

  /** Remove the first `n` ops (the ones we just delivered). */
  removeFront(n: number): void {
    if (n <= 0) return;
    this.ops.splice(0, n);
    this.schedulePersist();
  }

  /** Assign a now-known user id to every still-anonymous track op. */
  backfillIdentity(externalUserId: string): void {
    let changed = false;
    for (const op of this.ops) {
      if (op.kind === "track" && op.externalUserId === null) {
        op.externalUserId = externalUserId;
        changed = true;
      }
    }
    if (changed) this.schedulePersist();
  }

  clear(): void {
    this.ops = [];
    this.schedulePersist();
  }

  /** Resolves when every scheduled persist has been written. */
  settle(): Promise<void> {
    return this.persistChain;
  }

  private schedulePersist(): void {
    this.persistChain = this.persistChain
      .then(() =>
        this.ops.length === 0
          ? this.storage.remove(QUEUE_KEY)
          : this.storage.set(QUEUE_KEY, JSON.stringify(this.ops)),
      )
      .catch(() => {});
  }
}
