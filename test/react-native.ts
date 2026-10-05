/** Minimal react-native stub for tests (aliased in vitest.config.ts). */

export type AppStateStatus = "active" | "background" | "inactive" | "unknown" | "extension";

type Listener = (state: AppStateStatus) => void;
const listeners = new Set<Listener>();

export const AppState = {
  currentState: "active" as AppStateStatus,
  addEventListener(_type: string, listener: Listener) {
    listeners.add(listener);
    return { remove: () => void listeners.delete(listener) };
  },
};

export const Platform: { OS: string; Version: string | number; constants: Record<string, unknown> } = {
  OS: "ios",
  Version: "17.4",
  constants: { systemName: "iOS" },
};

/** Test hook: set what Platform reports (OS, Version, constants). */
export function __setPlatform(next: Partial<typeof Platform>): void {
  Object.assign(Platform, next);
}

/** Test hook: simulate an app-state transition. */
export function __setAppState(state: AppStateStatus): void {
  AppState.currentState = state;
  for (const listener of [...listeners]) listener(state);
}

/** Test hook: number of live AppState subscriptions. */
export function __listenerCount(): number {
  return listeners.size;
}

let localeIdentifier: string | undefined;

export const I18nManager = {
  getConstants() {
    return { isRTL: false, doLeftAndRightSwapInRTL: true, localeIdentifier };
  },
};

/** Test hook: what I18nManager reports as the device locale (undefined = nothing). */
export function __setLocaleIdentifier(id: string | undefined): void {
  localeIdentifier = id;
}
