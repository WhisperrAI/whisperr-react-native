import { createContext, createElement, useContext, useEffect, useRef, type ReactElement, type ReactNode } from "react";
import { WhisperrClient } from "./client.js";
import { Whisperr } from "./singleton.js";
import type { PushTokenInput, WhisperrApi, WhisperrOptions } from "./types.js";

const WhisperrContext = createContext<WhisperrApi | null>(null);

export interface WhisperrProviderProps {
  /** Full options, or just pass `apiKey` for the simple case. */
  options?: WhisperrOptions;
  apiKey?: string;
  /** An already-constructed client (e.g. the Whisperr.init singleton). */
  client?: WhisperrApi;
  children: ReactNode;
}

/**
 * Initializes Whisperr once and makes the client available via useWhisperr().
 * The client is created in a ref, so React StrictMode's double-render and Fast
 * Refresh don't spawn duplicates.
 */
export function WhisperrProvider({ options, apiKey, client, children }: WhisperrProviderProps): ReactElement {
  const ref = useRef<WhisperrApi | null>(null);
  if (ref.current === null) {
    if (client) {
      ref.current = client;
    } else {
      const opts = options ?? (apiKey ? { apiKey } : undefined);
      if (!opts) {
        throw new Error("WhisperrProvider requires `client`, `options`, or `apiKey`.");
      }
      ref.current = new WhisperrClient(opts);
    }
  }
  return createElement(WhisperrContext.Provider, { value: ref.current }, children);
}

/** Access the Whisperr client. Throws if used outside <WhisperrProvider>. */
export function useWhisperr(): WhisperrApi {
  const value = useContext(WhisperrContext);
  if (!value) {
    throw new Error("useWhisperr must be used within a <WhisperrProvider>.");
  }
  return value;
}

/**
 * The client from the nearest <WhisperrProvider>, else the Whisperr.init()
 * singleton, else null. Never throws — for helpers that work with or without
 * a provider.
 */
export function useWhisperrClient(): WhisperrApi | null {
  return useContext(WhisperrContext) ?? Whisperr.instance;
}

/**
 * Forwards a push token from your messaging library to Whisperr whenever it
 * changes. Pass whatever your push setup produces — an FCM registration token
 * (`@react-native-firebase/messaging`), an expo-notifications token object, or
 * `{ token, kind, pushEnv }`; null/undefined while the token is still loading.
 *
 * ```tsx
 * const [token, setToken] = useState<string | null>(null);
 * useEffect(() => {
 *   messaging().getToken().then(setToken);
 *   return messaging().onTokenRefresh(setToken);
 * }, []);
 * useWhisperrPushToken(token);
 * ```
 */
export function useWhisperrPushToken(token: PushTokenInput | null | undefined): void {
  const whisperr = useWhisperr();
  // Objects are compared by content, so an inline `{ token, kind }` literal
  // does not re-run the effect on every render.
  const key = token == null ? null : typeof token === "string" ? token : JSON.stringify(token);
  useEffect(() => {
    if (token) whisperr.setPushToken(token);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [whisperr, key]);
}
