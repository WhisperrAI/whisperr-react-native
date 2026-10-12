/**
 * The app's own version and build number, read from an optional peer the app
 * may already have — never a hard dependency, so the SDK stays pure JS and
 * keeps working in Expo Go and in apps without either package.
 *
 * The same peers give the bundle id / package name (`clientAppId`), which push
 * registrations carry as `client_app_id`.
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
  /** The iOS bundle id / Android package name (push `client_app_id`). */
  clientAppId?: string;
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
  const clientAppId = clean(explicit.clientAppId);
  if (version) out.version = version;
  if (build) out.build = build;
  if (clientAppId) out.clientAppId = clientAppId;
  // Version and build come from one source; never mix two packages' answers.
  let versionDone = !!(out.version && out.build);
  for (const load of peers) {
    if (versionDone && out.clientAppId) break;
    let info: AppInfo | undefined;
    try {
      info = load();
    } catch {
      info = undefined;
    }
    if (!info) continue;
    if (!versionDone && (info.version || info.build)) {
      if (!out.version && info.version) out.version = info.version;
      if (!out.build && info.build) out.build = info.build;
      versionDone = true;
    }
    if (!out.clientAppId && info.clientAppId) out.clientAppId = info.clientAppId;
  }
  return out;
}

/** expo-application: `nativeApplicationVersion` / `nativeBuildVersion` / `applicationId` (string | null). */
export function fromExpoApplication(mod: unknown): AppInfo | undefined {
  const m = unwrapDefault(mod) as
    | { nativeApplicationVersion?: unknown; nativeBuildVersion?: unknown; applicationId?: unknown }
    | undefined;
  if (!m) return undefined;
  const info: AppInfo = {};
  const version = clean(m.nativeApplicationVersion);
  const build = clean(m.nativeBuildVersion);
  const clientAppId = clean(m.applicationId);
  if (version) info.version = version;
  if (build) info.build = build;
  if (clientAppId) info.clientAppId = clientAppId;
  return info.version || info.build || info.clientAppId ? info : undefined;
}

/** react-native-device-info: `getVersion()` / `getBuildNumber()` / `getBundleId()`. */
export function fromDeviceInfo(mod: unknown): AppInfo | undefined {
  const m = unwrapDefault(mod) as
    | { getVersion?: unknown; getBuildNumber?: unknown; getBundleId?: unknown }
    | undefined;
  if (!m) return undefined;
  const info: AppInfo = {};
  const version = typeof m.getVersion === "function" ? clean(safeCall(m.getVersion)) : undefined;
  const build = typeof m.getBuildNumber === "function" ? clean(safeCall(m.getBuildNumber)) : undefined;
  const clientAppId = typeof m.getBundleId === "function" ? clean(safeCall(m.getBundleId)) : undefined;
  if (version) info.version = version;
  if (build) info.build = build;
  if (clientAppId) info.clientAppId = clientAppId;
  return info.version || info.build || info.clientAppId ? info : undefined;
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
