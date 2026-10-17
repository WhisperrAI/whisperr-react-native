/**
 * Screen tracking for React Navigation without depending on it: the tracker
 * reads the current route from the navigation container ref.
 */
import { Whisperr } from "./singleton.js";
import type { WhisperrApi } from "./types.js";

/** What the tracker needs from a React Navigation container ref. */
interface RouteSource {
  getCurrentRoute?: () => { name?: unknown } | undefined;
}

export interface NavigationTrackerOptions {
  /** The client to report to. Default: the `Whisperr.init()` singleton at the time of each change. */
  client?: WhisperrApi | null;
}

/**
 * Sends `screen_viewed` with the route name each time the focused route
 * changes (a repeat of the same name is skipped). Pass the container ref and
 * use the result for both callbacks:
 *
 * ```tsx
 * const ref = useNavigationContainerRef();
 * const onNavigation = useMemo(() => whisperrNavigationTracker(ref), [ref]);
 * <NavigationContainer ref={ref} onReady={onNavigation} onStateChange={onNavigation}>
 * ```
 */
export function whisperrNavigationTracker(
  ref: (RouteSource & { current?: RouteSource | null }) | { current?: RouteSource | null },
  options: NavigationTrackerOptions = {},
): () => void {
  let last: string | null = null;
  return () => {
    const source: RouteSource | null | undefined =
      typeof (ref as RouteSource).getCurrentRoute === "function" ? (ref as RouteSource) : ref.current;
    let name: unknown;
    try {
      name = source?.getCurrentRoute?.()?.name;
    } catch {
      return; // the container is not ready yet
    }
    if (typeof name !== "string" || !name || name === last) return;
    last = name;
    (options.client ?? Whisperr.instance)?.screen(name);
  };
}
