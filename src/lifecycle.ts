/**
 * The only react-native import in the SDK, kept in one seam so tests can alias
 * it and so a defensive try/catch shields exotic runtimes (headless JS tasks,
 * Jest without a preset) where AppState may be unavailable.
 */
import { AppState, I18nManager, Platform, type AppStateStatus } from "react-native";

export function currentOS(): string | undefined {
  try {
    return Platform.OS;
  } catch {
    return undefined;
  }
}

/**
 * The OS family and version from Platform, e.g. { platform: "ios", version: "17.4" }.
 * `platform` is the lowercase OS family ("ios" | "android" | "web" | …), never
 * the framework name.
 */
export function currentOSInfo(): { platform?: string; version?: string } {
  try {
    const os = Platform.OS as string | undefined;
    if (!os) return {};
    const constants = (Platform as unknown as { constants?: { Release?: unknown } }).constants;
    const version = (Platform as unknown as { Version?: unknown }).Version;
    // Android reports Version as the API level (34); Release is the
    // user-facing version ("14"). iOS reports the system version string.
    const release = typeof constants?.Release === "string" && constants.Release ? constants.Release : undefined;
    const rawVersion = os === "android" ? (release ?? version) : version;
    return {
      platform: os.toLowerCase(),
      version: rawVersion === undefined || rawVersion === null || rawVersion === "" ? undefined : String(rawVersion),
    };
  } catch {
    return {};
  }
}

/** The app's current AppState ("active", "background", …), or undefined when unavailable. */
export function currentAppState(): AppStateStatus | undefined {
  try {
    const state = AppState.currentState as AppStateStatus | null | undefined;
    return state ?? undefined;
  } catch {
    return undefined;
  }
}

/** Calls back on every AppState change. Returns an unsubscribe. */
export function onAppStateChange(callback: (state: AppStateStatus) => void): () => void {
  try {
    const subscription = AppState.addEventListener("change", callback);
    return () => subscription?.remove?.();
  } catch {
    return () => {};
  }
}

export type { AppStateStatus };

/**
 * The device locale as React Native's own I18nManager reports it (a Java/Cocoa
 * identifier such as "de_DE", "zh_CN_#Hans", or "en_US@calendar=gregorian") —
 * no native module, no dependency. Undefined when the host doesn't expose it.
 */
export function platformLocaleIdentifier(): string | undefined {
  try {
    const manager = I18nManager as unknown as {
      getConstants?: () => { localeIdentifier?: string | null } | undefined;
    };
    const id = manager.getConstants?.()?.localeIdentifier;
    return typeof id === "string" && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}
