/**
 * Notification taps: track `push_opened` and hand the deep link to the app's
 * router — for the tap that launched the app (cold start) and for taps while
 * it runs.
 */
import * as Notifications from "expo-notifications";
import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
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
  /**
   * After a Whisperr notification response is handled, clear it from
   * expo-notifications (`clearLastNotificationResponse`), so the cold-start
   * getter does not answer the same tap again on the next launch. Default true.
   */
  clearLastResponse?: boolean;
}

export interface NotificationReceiptOptions {
  /** The client to report to. Default: the `Whisperr.init()` singleton. */
  client?: WhisperrApi | null;
}

/** iOS sends this when the user dismisses a notification of a category with a custom dismiss action. */
const IOS_DISMISS_ACTION = "com.apple.UNNotificationDismissActionIdentifier";

/**
 * Notification ids and whisperr_message_ids already handled in this JS
 * context. Module-level, so a remounted hook (Fast Refresh, a navigator
 * re-render) never routes twice.
 */
const handled = new Set<string>();
/** The cold-start getter ran in this JS context: only its first answer can be the launch tap. */
let coldStartChecked = false;

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
  const handle = (response: Notifications.NotificationResponse | null | undefined, coldStart?: boolean): void => {
    if (!active || !response?.notification) return;
    if (response.actionIdentifier === IOS_DISMISS_ACTION) return;
    const id = response.notification.request?.identifier;
    const parsed = parseWhisperrPush(response);
    const messageKey = parsed ? `whisperr:${parsed.messageId}` : undefined;
    if ((id && handled.has(id)) || (messageKey && handled.has(messageKey))) return;
    if (id) handled.add(id);
    if (messageKey) handled.add(messageKey);
    if (!parsed) return; // not a Whisperr notification: leave it to the app
    const client = options.client ?? Whisperr.instance;
    const open = client
      ? client.trackPushOpened(response, typeof coldStart === "boolean" ? { coldStart } : {})
      : parsed;
    // The cold-start getter keeps answering the last response on every later
    // launch until it is cleared: clear it, so the tap is not routed again.
    if (options.clearLastResponse !== false) clearLastResponse();
    if (!open) return;
    try {
      onOpen({ ...open, response });
    } catch {
      /* a throwing router callback must not break later taps */
    }
  };

  // Cold start: the tap that launched the app. Only the first subscription in
  // this JS context can see it; a later answer is a tap handled before.
  const coldStart = !coldStartChecked && AppState.currentState !== "background";
  coldStartChecked = true;
  Notifications.getLastNotificationResponseAsync()
    .then((response) => handle(response, coldStart ? true : undefined))
    .catch(() => {});
  // Taps while the app is in the foreground or the background.
  const subscription = Notifications.addNotificationResponseReceivedListener((response) => handle(response, false));
  return () => {
    active = false;
    subscription.remove();
  };
}

/**
 * Sends `push_received` for each Whisperr notification that arrives while the
 * app is in the foreground (expo-notifications `addNotificationReceivedListener`),
 * once per message. Background receipts are not reported. `push_received` is
 * an automatic event: the client's `trackAppLifecycleEvents: false` stops it.
 * Returns an unsubscribe. useWhisperrNotificationResponse() calls it for you.
 */
export function subscribeToWhisperrNotificationReceipts(options: NotificationReceiptOptions = {}): () => void {
  const subscription = Notifications.addNotificationReceivedListener((notification) => {
    if (AppState.currentState !== "active") return;
    const client = options.client ?? Whisperr.instance;
    client?.trackPushReceived(notification, { foreground: true, source: "foreground" });
  });
  return () => subscription.remove();
}

function clearLastResponse(): void {
  const api = Notifications as unknown as {
    clearLastNotificationResponse?: () => void;
    clearLastNotificationResponseAsync?: () => Promise<void>;
  };
  try {
    if (typeof api.clearLastNotificationResponse === "function") api.clearLastNotificationResponse();
    else if (typeof api.clearLastNotificationResponseAsync === "function") {
      void api.clearLastNotificationResponseAsync().catch(() => {});
    }
  } catch {
    /* older expo-notifications: the in-memory dedupe still holds */
  }
}

/**
 * Tracks taps on Whisperr notifications and returns the latest one, with its
 * deep link, for your router. Covers the cold start. Also sends
 * `push_received` for Whisperr notifications that arrive in the foreground.
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
  options: NotificationOpenOptions & {
    onOpen?: (open: WhisperrNotificationOpen) => void;
    /** Also send `push_received` for Whisperr notifications that arrive in the foreground. Default true. */
    trackReceived?: boolean;
  } = {},
): WhisperrNotificationOpen | null {
  const contextClient = useWhisperrClient();
  const client = options.client ?? contextClient;
  const clearLast = options.clearLastResponse;
  const trackReceived = options.trackReceived !== false;
  const [open, setOpen] = useState<WhisperrNotificationOpen | null>(null);
  const onOpenRef = useRef(options.onOpen);
  onOpenRef.current = options.onOpen;

  useEffect(() => {
    const stopOpens = subscribeToWhisperrNotificationOpens(
      (next) => {
        setOpen(next);
        onOpenRef.current?.(next);
      },
      { client, ...(clearLast === undefined ? {} : { clearLastResponse: clearLast }) },
    );
    const stopReceipts = trackReceived ? subscribeToWhisperrNotificationReceipts({ client }) : () => {};
    return () => {
      stopOpens();
      stopReceipts();
    };
  }, [client, clearLast, trackReceived]);
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

/** Test hook: forget handled notification ids and the cold-start check. */
export function __resetHandledNotifications(): void {
  handled.clear();
  coldStartChecked = false;
}
