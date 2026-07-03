/**
 * The only react-native import in the SDK, kept in one seam so tests can alias
 * it and so a defensive try/catch shields exotic runtimes (headless JS tasks,
 * Jest without a preset) where AppState may be unavailable.
 */
import { AppState, Platform, type AppStateStatus } from "react-native";

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
