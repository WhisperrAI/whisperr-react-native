/**
 * Notification taps: track `push_opened` and hand the deep link to the app's
 * router — for the tap that launched the app (cold start) and for taps while
 * it runs.
 */
import * as Notifications from "expo-notifications";
import { useEffect, useRef, useState } from "react";
import {
  parseWhisperrPush,
  useWhisperrClient,
  Whisperr,
  type WhisperrApi,
  type WhisperrPushOpen,
} from "@whisperr/react-native";

/** A tap on a Whisperr notification. */
export interface WhisperrNotificationOpen extends WhisperrPushOpen {
  /** The full expo-notifications response, for anything else the app needs. */
  response: Notifications.NotificationResponse;
}

export interface NotificationOpenOptions {
  /** The client to report to. Default: the nearest <WhisperrProvider>, else the `Whisperr.init()` singleton. */
  client?: WhisperrApi | null;
}

/** iOS sends this when the user dismisses a notification of a category with a custom dismiss action. */
const IOS_DISMISS_ACTION = "com.apple.UNNotificationDismissActionIdentifier";

/**
 * Notification ids already handled in this JS context. Module-level, so a
 * remounted hook (Fast Refresh, a navigator re-render) never routes twice.
 */
const handled = new Set<string>();

/**
 * Calls `onOpen` once for each tap on a Whisperr notification: first for the
 * tap that launched the app (if any), then for every later tap. Each tap also
 * sends `push_opened` (once per message, across restarts). Taps on other
 * notifications are ignored. Returns an unsubscribe.
 */
export function subscribeToWhisperrNotificationOpens(
  onOpen: (open: WhisperrNotificationOpen) => void,
  options: NotificationOpenOptions = {},
): () => void {
  let active = true;
  const handle = (response: Notifications.NotificationResponse | null | undefined): void => {
    if (!active || !response?.notification) return;
    if (response.actionIdentifier === IOS_DISMISS_ACTION) return;
    const id = response.notification.request?.identifier;
    if (id) {
      if (handled.has(id)) return;
      handled.add(id);
    }
    const client = options.client ?? Whisperr.instance;
    const open = client ? client.trackPushOpened(response) : parseWhisperrPush(response);
    if (!open) return;
    try {
      onOpen({ ...open, response });
    } catch {
      /* a throwing router callback must not break later taps */
    }
  };

  // Cold start: the tap that launched the app.
  Notifications.getLastNotificationResponseAsync()
    .then(handle)
    .catch(() => {});
  // Taps while the app is in the foreground or the background.
  const subscription = Notifications.addNotificationResponseReceivedListener(handle);
  return () => {
    active = false;
    subscription.remove();
  };
}

/**
 * Tracks taps on Whisperr notifications and returns the latest one, with its
 * deep link, for your router. Covers the cold start.
 *
 * ```tsx
 * // app/_layout.tsx (expo-router)
 * const open = useWhisperrNotificationResponse();
 * useEffect(() => {
 *   if (open?.deepLink) router.push(toHref(open.deepLink));
 * }, [open]);
 * ```
 *
 * Pass `onOpen` to act on each tap directly instead of through state.
 */
export function useWhisperrNotificationResponse(
  options: NotificationOpenOptions & { onOpen?: (open: WhisperrNotificationOpen) => void } = {},
): WhisperrNotificationOpen | null {
  const contextClient = useWhisperrClient();
  const client = options.client ?? contextClient;
  const [open, setOpen] = useState<WhisperrNotificationOpen | null>(null);
  const onOpenRef = useRef(options.onOpen);
  onOpenRef.current = options.onOpen;

  useEffect(
    () =>
      subscribeToWhisperrNotificationOpens(
        (next) => {
          setOpen(next);
          onOpenRef.current?.(next);
        },
        { client },
      ),
    [client],
  );
  return open;
}

/**
 * Turns a Whisperr deep link into an expo-router href: `myapp://offers/annual`
 * and `https://example.com/offers/annual` become `/offers/annual` (query and
 * hash kept); a path stays as is. Pass `scheme` to accept only your own
 * custom scheme: other schemes then return null.
 */
export function deepLinkToHref(deepLink: string, scheme?: string): string | null {
  const link = deepLink.trim();
  if (!link) return null;
  if (link.startsWith("/")) return link;
  const match = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(.*)$/i.exec(link);
  if (!match) return null;
  const [, linkScheme = "", host = "", path = "", rest = ""] = match;
  const lowerScheme = linkScheme.toLowerCase();
  if (lowerScheme === "http" || lowerScheme === "https") {
    if (scheme) return null;
    return `${path || "/"}${rest}`;
  }
  if (scheme && lowerScheme !== scheme.toLowerCase()) return null;
  // In `myapp://offers/annual` the first segment parses as the host.
  const route = `/${[host, path.replace(/^\/+/, "")].filter(Boolean).join("/")}`;
  return `${route}${rest}`;
}

/** Test hook: forget handled notification ids. */
export function __resetHandledNotifications(): void {
  handled.clear();
}
