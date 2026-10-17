/** Runtime primitives shared across the SDK. */

export const LIB_VERSION = "0.7.0";

/**
 * RFC4122 v4 id. Uses crypto.randomUUID, then crypto.getRandomValues, when the
 * runtime has them. Hermes has no global crypto unless the app installs a
 * polyfill (for example react-native-get-random-values), so there the
 * Math.random fallback is the normal path. The ids are identifiers (anonymous
 * handle, session, message ids), never secrets.
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
  // No crypto: ids stay unique enough for attribution, but are predictable.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function nowISO(): string {
  return new Date().toISOString();
}

// ---- clocks ----

type Clock = () => number;

function defaultMonotonic(): number {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance;
  return perf && typeof perf.now === "function" ? perf.now() : Date.now();
}

let monotonic: Clock = defaultMonotonic;

/**
 * Milliseconds on a clock that never jumps (performance.now in Hermes), for
 * durations such as `foreground_ms`. Falls back to the wall clock.
 */
export function monotonicNow(): number {
  return monotonic();
}

/** Test hook: replace the monotonic clock (null restores the default). */
export function __setMonotonicClock(clock: Clock | null): void {
  monotonic = clock ?? defaultMonotonic;
}

/** A development build (React Native's `__DEV__`). Tests set `globalThis.__DEV__`. */
export function isDevBuild(): boolean {
  return (globalThis as { __DEV__?: unknown }).__DEV__ === true;
}

// ---- session ----

const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * The session id (`sess_<uuid>`): a new one on every cold start (each client
 * starts without one) and after 30 minutes with no event. In memory only:
 * reads must be synchronous at track() time, and a new process is a new session.
 */
export class Session {
  private id: string | null = null;
  private last = 0;
  private lastMono = 0;

  /**
   * Returns the current session id, rolling it over after inactivity. The gap
   * is measured on both clocks and either one reaching 30 minutes rolls it:
   * the monotonic clock can stop while the device sleeps, and the wall clock
   * can be set back.
   */
  current(): string {
    const now = Date.now();
    const mono = monotonicNow();
    if (!this.id || now - this.last >= SESSION_TIMEOUT_MS || mono - this.lastMono >= SESSION_TIMEOUT_MS) {
      this.id = `sess_${uuid()}`;
    }
    this.last = now;
    this.lastMono = mono;
    return this.id;
  }
}
