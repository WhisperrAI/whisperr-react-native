/**
 * What the runtime tells about this app's push setup, for the token fields of
 * whisperr-spec contract v2 (platform, client_app_id, provider_project,
 * push_env). Read from optional peers the app may already have; a value
 * nothing can provide is left out, never guessed. Explicit values on the
 * token (or in WhisperrOptions) always win.
 *
 * - platform: `Platform.OS`
 * - client_app_id: `expo-application` / `react-native-device-info` (app-info.ts)
 * - provider_project: for `expo` tokens the EAS project id (`expo-constants`),
 *   for `fcm` tokens the Firebase project id (`@react-native-firebase/app`)
 * - push_env: not readable from JS without a native module; `@whisperr/expo`
 *   and the app pass it.
 *
 * The `require` calls sit directly inside `try` (see app-info.ts).
 */
import { resolveAppInfo } from "./app-info.js";
import { currentOSInfo } from "./lifecycle.js";
import type { PushEnvironment, PushPlatform, PushTokenKind } from "./types.js";

declare const require: (name: string) => unknown;

export interface PushEnvironmentInfo {
  platform?: PushPlatform;
  clientAppId?: string;
  /** The provider project for a token of `kind`, when the runtime knows it. */
  providerProject(kind: PushTokenKind): string | undefined;
  /** The APNs environment of this build, when the runtime knows it. */
  pushEnv?: PushEnvironment;
}

const PLATFORMS: ReadonlySet<string> = new Set<PushPlatform>(["ios", "android", "web", "macos", "windows", "linux"]);

export function detectPushEnvironment(): PushEnvironmentInfo {
  const os = currentOSInfo().platform;
  const platform = os && PLATFORMS.has(os) ? (os as PushPlatform) : undefined;
  const { clientAppId } = resolveAppInfo({});
  let expoProject: string | undefined | null = null; // null: not read yet
  let firebaseProject: string | undefined | null = null;
  return {
    ...(platform ? { platform } : {}),
    ...(clientAppId ? { clientAppId } : {}),
    providerProject(kind) {
      if (kind === "expo") {
        if (expoProject === null) expoProject = easProjectId();
        return expoProject;
      }
      if (kind === "fcm") {
        if (firebaseProject === null) firebaseProject = firebaseProjectId();
        return firebaseProject;
      }
      return undefined;
    },
  };
}

/** The EAS project id from expo-constants (`extra.eas.projectId`, then `easConfig.projectId`). */
export function easProjectId(load: () => unknown = loadExpoConstants): string | undefined {
  try {
    const mod = load() as { default?: unknown } | undefined;
    const c = (mod && typeof mod.default === "object" ? mod.default : mod) as
      | { expoConfig?: { extra?: { eas?: { projectId?: unknown } } } | null; easConfig?: { projectId?: unknown } | null }
      | undefined;
    return clean(c?.expoConfig?.extra?.eas?.projectId) ?? clean(c?.easConfig?.projectId);
  } catch {
    return undefined;
  }
}

/** The Firebase project id of the default app (`@react-native-firebase/app`). */
export function firebaseProjectId(load: () => unknown = loadFirebaseApp): string | undefined {
  try {
    const m = load() as
      | {
          getApp?: () => { options?: { projectId?: unknown } };
          default?: { app?: () => { options?: { projectId?: unknown } } } | (() => unknown);
          firebase?: { app?: () => { options?: { projectId?: unknown } } };
        }
      | undefined;
    if (!m) return undefined;
    if (typeof m.getApp === "function") return clean(m.getApp().options?.projectId);
    const ns = (typeof m.default === "object" ? m.default : undefined) ?? m.firebase;
    if (ns && typeof ns.app === "function") return clean(ns.app().options?.projectId);
    return undefined;
  } catch {
    return undefined; // not installed, or no default Firebase app
  }
}

function loadExpoConstants(): unknown {
  try {
    return require("expo-constants");
  } catch {
    return undefined;
  }
}

function loadFirebaseApp(): unknown {
  try {
    return require("@react-native-firebase/app");
  } catch {
    return undefined;
  }
}

function clean(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim();
  return v && !v.includes("|") ? v : undefined;
}
