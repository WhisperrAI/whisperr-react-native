/**
 * Pure helpers for the engagement signals (whisperr-spec → Engagement
 * signals): error fingerprints, and launch-link parsing for `app_opened`.
 * Nothing here sends events or touches React Native.
 */

export const APP_ERROR = "app_error";
export const APP_CRASHED = "app_crashed";

/** `launch_source` values, highest precedence first. */
export const LAUNCH_SOURCES = [
  "push",
  "shortcut",
  "widget",
  "email",
  "universal_link",
  "deep_link",
  "direct",
] as const;
export type LaunchSource = (typeof LAUNCH_SOURCES)[number];

/** A launch signal: where an open came from, and the properties only the winning signal supplies. */
export interface LaunchSignal {
  source: Exclude<LaunchSource, "direct">;
  properties: Record<string, string>;
}

/** The higher-precedence of two signals (the first one on a tie). */
export function strongerSignal(a: LaunchSignal | null, b: LaunchSignal): LaunchSignal {
  if (!a) return b;
  return LAUNCH_SOURCES.indexOf(b.source) < LAUNCH_SOURCES.indexOf(a.source) ? b : a;
}

const MAX_ROUTE = 256;
const MAX_SHORT = 128;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A URL path with id-like segments (all digits, UUIDs, 16+ characters)
 * replaced by `:id`. Query and fragment are never part of the input.
 */
export function redactRoute(path: string): string {
  const segments = path
    .split("/")
    .filter(Boolean)
    .map((raw) => {
      const segment = safeDecode(raw);
      return /^\d+$/.test(segment) || UUID.test(segment) || segment.length >= 16 ? ":id" : segment;
    });
  return `/${segments.join("/")}`.slice(0, MAX_ROUTE);
}

const URL_PARTS = /^([a-z][a-z0-9+.-]*):(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?/i;

/**
 * The launch signal of a URL the app was opened with: `wsrc=widget|shortcut`
 * marks a widget or shortcut, `wmid` an email link (its value is the
 * whisperr_message_id), else http(s) is a universal/app link and any other
 * scheme a deep link. Null for something that is not a URL.
 */
export function linkSignal(url: string): LaunchSignal | null {
  const match = URL_PARTS.exec(url.trim());
  if (!match) return null;
  const [, rawScheme = "", authority, rawPath = "", query = ""] = match;
  const scheme = rawScheme.toLowerCase();
  const web = scheme === "http" || scheme === "https";
  const params = parseQuery(query);

  let path = rawPath;
  if (!web) {
    // `myapp://offers/annual`: the first segment parses as the host.
    path = `/${[authority ?? "", rawPath].filter(Boolean).join("/")}`;
    // Expo development URLs: `exp://192.168.1.2:8081/--/offers/annual`.
    const expo = path.indexOf("/--/");
    if (expo >= 0) path = path.slice(expo + 3);
    else if (path.endsWith("/--")) path = "/";
  }

  const properties: Record<string, string> = { link_route: redactRoute(path) };
  if (web && authority) {
    const host = authority.replace(/^.*@/, "").replace(/:\d*$/, "").toLowerCase();
    if (host) properties.link_host = host;
  }
  for (const key of ["utm_source", "utm_medium", "utm_campaign"]) {
    const value = params.get(key);
    if (value) properties[key] = value.slice(0, MAX_SHORT);
  }

  const wsrc = params.get("wsrc")?.toLowerCase();
  const wmid = params.get("wmid");
  let source: LaunchSignal["source"];
  if (wsrc === "widget" || wsrc === "shortcut") source = wsrc;
  else if (wmid) {
    source = "email";
    properties.whisperr_message_id = wmid.slice(0, MAX_SHORT);
  } else source = web ? "universal_link" : "deep_link";
  return { source, properties };
}

function parseQuery(query: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const pair of query.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const key = safeDecode((eq < 0 ? pair : pair.slice(0, eq)).replace(/\+/g, " "));
    const value = eq < 0 ? "" : safeDecode(pair.slice(eq + 1).replace(/\+/g, " ")).trim();
    if (key && !out.has(key)) out.set(key, value);
  }
  return out;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// ---- errors ----

export const ERROR_KINDS = ["js", "dart", "native", "handled", "network", "screen"] as const;
export type ErrorKind = (typeof ERROR_KINDS)[number];

const MAX_ERROR_NAME = 64;

/**
 * The class or type of a thrown value, never its message: `error.name`, or
 * the constructor name when `name` is the generic "Error" (a subclass that
 * does not set `name`). Only identifier-like characters survive.
 */
export function errorName(error: unknown): string {
  let name: string | undefined;
  if (error && typeof error === "object") {
    const own = (error as { name?: unknown }).name;
    if (typeof own === "string" && own.trim()) name = own;
    const ctor = (error as { constructor?: { name?: unknown } }).constructor?.name;
    if ((!name || name === "Error") && typeof ctor === "string" && ctor.length > 1 && ctor !== "Object") name = ctor;
  }
  const clean = (name ?? "Error").replace(/[^A-Za-z0-9_$.:-]/g, "").slice(0, MAX_ERROR_NAME);
  return clean || "Error";
}

/**
 * The function names of the top three stack frames (Hermes/V8 `at fn (…)`
 * and JSC `fn@…` formats). Paths, line and column numbers are dropped; an
 * anonymous frame is `?`. The first line of a V8 stack (the message) is skipped.
 */
export function stackFrames(stack: unknown, limit = 3): string[] {
  if (typeof stack !== "string") return [];
  const frames: string[] = [];
  // Plain string scans, no backtracking regex: stacks can be long and odd.
  for (const raw of stack.split("\n")) {
    const line = raw.trim();
    let name: string;
    if (line.startsWith("at ")) {
      // Hermes / V8: `at fn (file:1:2)`, `at new Foo (…)`, `at async fn (…)`, or `at file:1:2`.
      let rest = line.slice(3).trimStart();
      for (const prefix of ["new ", "async "]) if (rest.startsWith(prefix)) rest = rest.slice(prefix.length).trimStart();
      const paren = rest.indexOf(" (");
      name = paren > 0 ? rest.slice(0, paren).trim() : "";
    } else {
      // JSC: `fn@file:1:2` or `@file:1:2`.
      const at = line.indexOf("@");
      if (at < 0) continue;
      name = line.slice(0, at);
      if (/\s/.test(name)) continue;
    }
    // `Object.loadCart` (V8) and `loadCart` (Hermes) are the same function.
    const short = name.split(".").pop() ?? "";
    frames.push(short && short !== "<anonymous>" && short !== "anonymous" ? short : "?");
    if (frames.length >= limit) break;
  }
  return frames;
}

/** 16 lowercase hex characters: SHA-256 of the name and the frame names, joined by `\n`. */
export function errorFingerprint(name: string, frames: readonly string[]): string {
  return sha256Hex([name, ...frames.slice(0, 3)].join("\n")).slice(0, 16);
}

// ---- SHA-256 (no crypto.subtle in Hermes; the inputs are tiny) ----

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
]);

function utf8(text: string): number[] {
  const bytes: number[] = [];
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return bytes;
}

export function sha256Hex(text: string): string {
  const bytes = utf8(text);
  const bitLength = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const high = Math.floor(bitLength / 0x100000000);
  for (const word of [high, bitLength >>> 0]) bytes.push((word >>> 24) & 255, (word >>> 16) & 255, (word >>> 8) & 255, word & 255);

  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let i = 0; i < 16; i++) {
      const j = offset + i * 4;
      w[i] = ((bytes[j]! << 24) | (bytes[j + 1]! << 16) | (bytes[j + 2]! << 8) | bytes[j + 3]!) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15]!;
      const b = w[i - 2]!;
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = [h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!];
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i]! + w[i]!) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0]! + a) >>> 0;
    h[1] = (h[1]! + b) >>> 0;
    h[2] = (h[2]! + c) >>> 0;
    h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0;
    h[5] = (h[5]! + f) >>> 0;
    h[6] = (h[6]! + g) >>> 0;
    h[7] = (h[7]! + hh) >>> 0;
  }
  return Array.from(h, (x) => x.toString(16).padStart(8, "0")).join("");
}
