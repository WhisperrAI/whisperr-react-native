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

export const Platform = { OS: "ios" as const };

/** Test hook: simulate an app-state transition. */
export function __setAppState(state: AppStateStatus): void {
  AppState.currentState = state;
  for (const listener of [...listeners]) listener(state);
}

/** Test hook: number of live AppState subscriptions. */
export function __listenerCount(): number {
  return listeners.size;
}
