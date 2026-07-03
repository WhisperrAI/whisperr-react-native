import type { WhisperrStorage } from "./types.js";

/** In-memory storage — the fallback when no durable storage is injected. */
export class MemoryStorage implements WhisperrStorage {
  private m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, v);
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
}

/**
 * Wraps a host-provided storage so a broken adapter (full disk, revoked
 * permissions, a throwing shim) can never take the SDK down — reads degrade to
 * null, writes become fire-and-forget no-ops.
 */
export class SafeStorage {
  constructor(private readonly inner: WhisperrStorage) {}

  async get(key: string): Promise<string | null> {
    try {
      return (await this.inner.getItem(key)) ?? null;
    } catch {
      return null;
    }
  }

  async set(key: string, value: string): Promise<void> {
    try {
      await this.inner.setItem(key, value);
    } catch {
      /* storage unavailable — drop silently */
    }
  }

  async remove(key: string): Promise<void> {
    try {
      await this.inner.removeItem(key);
    } catch {
      /* noop */
    }
  }
}
