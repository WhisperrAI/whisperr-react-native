/** Runtime primitives shared across the SDK. */

import type { SafeStorage } from "./storage.js";

export const LIB_VERSION = "0.2.1";

/**
 * RFC4122 v4 id. Prefers crypto.randomUUID, then crypto.getRandomValues
 * (present on modern Hermes and on JSC/Expo with the usual polyfills); only
 * engines with no crypto at all hit the insecure last resort.
 */
export function uuid(): string {
  const c = (
    globalThis as {
      crypto?: {
        randomUUID?: () => string;
        getRandomValues?: (array: Uint8Array) => Uint8Array;
      };
    }
  ).crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  if (c && typeof c.getRandomValues === "function") {
    const bytes = c.getRandomValues(new Uint8Array(16));
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40; // version 4
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // variant 10xx
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  // Last resort (non-crypto): ids stay unique enough for attribution, but are
  // predictable — acceptable because they are identifiers, never secrets.
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
