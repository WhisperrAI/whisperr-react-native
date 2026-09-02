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

/** Calls back when the app leaves the foreground. Returns an unsubscribe. */
export function onAppBackground(callback: () => void): () => void {
  try {
    const listener = (state: AppStateStatus) => {
      if (state === "background" || state === "inactive") callback();
    };
    const subscription = AppState.addEventListener("change", listener);
    return () => subscription?.remove?.();
  } catch {
    return () => {};
  }
}

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
