/**
 * expo-router screen tracking. expo-router is an optional peer: it is loaded
 * with a guarded `require`, so apps without it can still use @whisperr/expo
 * (the hook then does nothing).
 */
import { useEffect, useRef } from "react";
import { useWhisperrClient, type WhisperrApi } from "@whisperr/react-native";

declare const require: (name: string) => unknown;

interface ExpoRouter {
  useSegments: () => readonly string[];
}

function loadExpoRouter(): ExpoRouter | null {
  try {
    // Literal and inside try: Metro bundles a missing optional module as a stub that throws.
    const mod = require("expo-router") as Partial<ExpoRouter> | null;
    return mod && typeof mod.useSegments === "function" ? (mod as ExpoRouter) : null;
  } catch {
    return null;
  }
}

let router = loadExpoRouter();

/** Test hook: the expo-router module the hook uses (null: not installed). */
export function __setExpoRouter(mod: ExpoRouter | null): void {
  router = mod;
}

export interface WhisperrScreensOptions {
  /** The client to report to. Default: the nearest <WhisperrProvider>, else the `Whisperr.init()` singleton. */
  client?: WhisperrApi | null;
}

/**
 * The route template of expo-router segments: `["(tabs)", "lesson", "[id]"]`
 * is `/lesson/[id]`. Groups are dropped, so the name never holds an id or
 * other user data.
 */
export function routeTemplate(segments: readonly string[]): string {
  const parts = segments.filter((s) => s && !(s.startsWith("(") && s.endsWith(")")));
  return `/${parts.join("/")}`;
}

/**
 * Sends `screen_viewed` for each expo-router route the user visits, with the
 * route template (`/lesson/[id]`, not `/lesson/42`) as `screen_name`. Call it
 * once in your root `app/_layout.tsx`. A repeat of the same template is skipped.
 */
export function useWhisperrScreens(options: WhisperrScreensOptions = {}): void {
  const contextClient = useWhisperrClient();
  const client = options.client ?? contextClient;
  // Whether expo-router is installed never changes, so the hook order is stable.
  const segments = router ? router.useSegments() : null;
  const name = segments ? routeTemplate(segments) : null;
  const last = useRef<string | null>(null);
  useEffect(() => {
    if (!client || !name || name === last.current) return;
    last.current = name;
    client.screen(name);
  }, [client, name]);
}
