/** Runtime primitives shared across the SDK. */

import type { SafeStorage } from "./storage.js";

export const LIB_VERSION = "0.2.0";

/** RFC4122-ish v4 id; uses crypto when available, falls back gracefully. */
export function uuid(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  // Fallback (non-crypto): fine for a client message/anonymous id.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function nowISO(): string {
  return new Date().toISOString();
}

// ---- session ----

const SESSION_KEY = "whisperr.session";
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * A 30-minute-inactivity session id. State lives in memory (reads must be
 * synchronous at track() time); persistence is write-behind so sessions
 * continue across quick app restarts.
 */
export class Session {
  private id: string | null = null;
  private last = 0;

  constructor(private readonly storage: SafeStorage) {}

  /** Adopt a persisted session if it hasn't expired. Called once at init. */
  async restore(): Promise<void> {
    const raw = await this.storage.get(SESSION_KEY);
    if (!raw || this.id) return; // an event already started a session — keep it
    try {
      const s = JSON.parse(raw) as { id: string; last: number };
      if (typeof s.id === "string" && Date.now() - s.last < SESSION_TIMEOUT_MS) {
        this.id = s.id;
        this.last = s.last;
      }
    } catch {
      /* corrupt — start fresh on next use */
    }
  }

  /** Returns the current session id, rolling it over after inactivity. */
  current(): string {
    const now = Date.now();
    if (!this.id || now - this.last >= SESSION_TIMEOUT_MS) {
      this.id = `sess_${uuid()}`;
    }
    this.last = now;
    void this.storage.set(SESSION_KEY, JSON.stringify({ id: this.id, last: now }));
    return this.id;
  }
}
