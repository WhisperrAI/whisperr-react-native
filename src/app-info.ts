/**
 * The app's own version and build number, read from an optional peer the app
 * may already have — never a hard dependency, so the SDK stays pure JS and
 * keeps working in Expo Go and in apps without either package.
 *
 * Order: explicit options → `expo-application` → `react-native-device-info`.
 * A value nothing can provide is omitted, never guessed.
 *
 * The `require` calls sit directly inside `try` blocks on purpose: Metro (with
 * `allowOptionalDependencies`, on by default in both the React Native and the
 * Expo Metro configs) bundles a missing optional module as a stub that throws
 * at runtime, which the `catch` absorbs. tsup.config.ts keeps these calls as
 * literal `require("…")` in the ESM build so Metro can see them.
 */

export interface AppInfo {
  version?: string;
  build?: string;
}

declare const require: (name: string) => unknown;

/** Loaders for the supported optional peers, in preference order. */
export const OPTIONAL_PEERS: ReadonlyArray<() => AppInfo | undefined> = [
  () => {
    let mod: unknown;
    try {
      mod = require("expo-application");
    } catch {
      return undefined;
    }
    return fromExpoApplication(mod);
  },
  () => {
    let mod: unknown;
    try {
      mod = require("react-native-device-info");
    } catch {
      return undefined;
    }
    return fromDeviceInfo(mod);
  },
];

/** Resolves version/build: explicit values win, then the first peer that knows them. */
export function resolveAppInfo(
  explicit: AppInfo,
  peers: ReadonlyArray<() => AppInfo | undefined> = OPTIONAL_PEERS,
): AppInfo {
  const out: AppInfo = {};
  const version = clean(explicit.version);
  const build = clean(explicit.build);
  if (version) out.version = version;
  if (build) out.build = build;
  if (out.version && out.build) return out;
  for (const load of peers) {
    let info: AppInfo | undefined;
    try {
      info = load();
    } catch {
      info = undefined;
    }
    if (!info) continue;
    if (!out.version && info.version) out.version = info.version;
    if (!out.build && info.build) out.build = info.build;
    if (out.version || out.build) break; // one source; never mix two packages' answers
  }
  return out;
}

/** expo-application: `nativeApplicationVersion` / `nativeBuildVersion` (string | null). */
export function fromExpoApplication(mod: unknown): AppInfo | undefined {
  const m = unwrapDefault(mod) as { nativeApplicationVersion?: unknown; nativeBuildVersion?: unknown } | undefined;
  if (!m) return undefined;
  const info: AppInfo = {};
  const version = clean(m.nativeApplicationVersion);
  const build = clean(m.nativeBuildVersion);
  if (version) info.version = version;
  if (build) info.build = build;
  return info.version || info.build ? info : undefined;
}

/** react-native-device-info: `getVersion()` / `getBuildNumber()`. */
export function fromDeviceInfo(mod: unknown): AppInfo | undefined {
  const m = unwrapDefault(mod) as { getVersion?: unknown; getBuildNumber?: unknown } | undefined;
  if (!m) return undefined;
  const info: AppInfo = {};
  const version = typeof m.getVersion === "function" ? clean(safeCall(m.getVersion)) : undefined;
  const build = typeof m.getBuildNumber === "function" ? clean(safeCall(m.getBuildNumber)) : undefined;
  if (version) info.version = version;
  if (build) info.build = build;
  return info.version || info.build ? info : undefined;
}

function unwrapDefault(mod: unknown): unknown {
  if (!mod || typeof mod !== "object") return undefined;
  const withDefault = mod as { default?: unknown };
  return withDefault.default && typeof withDefault.default === "object" ? withDefault.default : mod;
}

function safeCall(fn: unknown): unknown {
  try {
    return (fn as () => unknown)();
  } catch {
    return undefined;
  }
}

function clean(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return undefined;
  const v = value.trim();
  // device-info answers "unknown" when its native module can't tell.
  return v && v.toLowerCase() !== "unknown" ? v : undefined;
}
