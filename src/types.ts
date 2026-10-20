/** Public types for the Whisperr React Native SDK. */

export interface WhisperrChannel {
  /** "email" | "sms" | "push" | custom. */
  type: string;
  /** The address/token for the channel (email address, phone, push token). */
  address: string;
  /**
   * Whether the user has opted in to this channel. On an email channel, `true`
   * also sends `consent_source: "user"` (the end user's own consent).
   */
  optedIn?: boolean;
  /** Whether the address is verified. */
  verified?: boolean;
  /** Push only: the token type. Sent as `kind`. */
  kind?: PushTokenKind;
  /** Push only: the OS family of the device. Sent as `platform`. */
  platform?: PushPlatform;
  /** Push only: the APNs environment of the token. Sent as `push_env`. */
  pushEnv?: PushEnvironment;
  /** Push only: the iOS bundle id or Android package name. Sent as `client_app_id`. */
  clientAppId?: string;
  /** Push only: the Firebase project id, EAS project id, or OneSignal app id. Sent as `provider_project`. */
  providerProject?: string;
}

/**
 * The type of a push token. It tells the server which provider can send to it.
 *
 * - `expo` — an Expo push token (`ExponentPushToken[…]`), sent through Expo's push service
 * - `fcm` — a Firebase Cloud Messaging registration token
 * - `apns` — a raw APNs device token (hex)
 * - `onesignal_sub` — a OneSignal subscription id
 */
export type PushTokenKind = "fcm" | "apns" | "expo" | "onesignal_sub";

/** The OS family a push token belongs to. */
export type PushPlatform = "ios" | "android" | "web" | "macos" | "windows" | "linux";

/** The APNs environment of an `apns` token: debug builds get `sandbox` tokens. */
export type PushEnvironment = "production" | "sandbox";

/** A push token with what the app knows about it. Unknown fields stay unset. */
export interface PushTokenRegistration {
  token: string;
  /**
   * The token type. When unset, an Expo token (`ExponentPushToken[…]`) is sent
   * as `expo`; any other token is sent without a kind and the server infers it.
   */
  kind?: PushTokenKind;
  /** Defaults to the OS the app runs on (`Platform.OS`). */
  platform?: PushPlatform;
  /** APNs tokens only. The SDK never guesses it. */
  pushEnv?: PushEnvironment;
  /**
   * The iOS bundle id or Android package name of the app that owns the token.
   * Defaults to `WhisperrOptions.clientAppId`, then to what `expo-application`
   * or `react-native-device-info` reports.
   */
  clientAppId?: string;
  /**
   * The project the token belongs to at the push provider: the Firebase
   * project id (FCM), the EAS project id (Expo), or the OneSignal app id.
   * The server uses it to catch a token from the wrong project before a send.
   * Defaults to what the runtime knows: the EAS project id (`expo-constants`)
   * for Expo tokens, the Firebase project id (`@react-native-firebase/app`)
   * for FCM tokens.
   */
  providerProject?: string;
}

/**
 * The token object `expo-notifications` returns: `getExpoPushTokenAsync()`
 * gives `{ type: "expo", data }`, `getDevicePushTokenAsync()` gives
 * `{ type: "ios" | "android", data }` (an APNs or FCM token).
 */
export interface ExpoNotificationsPushToken {
  type: string;
  data: unknown;
}

/** Everything setPushToken() accepts. */
export type PushTokenInput = string | PushTokenRegistration | ExpoNotificationsPushToken;

/**
 * The notification permission the OS reports for this app.
 *
 * - `granted` — notifications show
 * - `provisional` — iOS quiet delivery (to Notification Center only)
 * - `denied` — the user turned notifications off
 * - `undetermined` — the app has not asked yet
 */
export type PushPermissionStatus = "granted" | "provisional" | "denied" | "undetermined";

/** A Whisperr push the user opened. */
export interface WhisperrPushOpen {
  /** The `whisperr_message_id` from the push data. */
  messageId: string;
  /** The deep link from the push data (`whisperr_deep_link` or `deep_link`), if any. */
  deepLink?: string;
  /**
   * The action the user picked: `"default"` for a tap on the notification
   * itself, else the button (action) id. Read from an expo-notifications
   * response, or from `PushOpenedOptions.actionId`.
   */
  actionId?: string;
}

/** What the app knows about a notification open. Unknown values stay unset. */
export interface PushOpenedOptions {
  /** The button (action) id. Default: read from the payload, else `"default"`. */
  actionId?: string;
  /**
   * True when the tap launched the app from a killed state. Default: true when
   * the open comes within 10 seconds of the client start and the app was not in
   * the background since.
   */
  coldStart?: boolean;
}

/** Where a push receipt was seen. */
export type PushReceivedSource = "foreground" | "nse" | "android_service" | "expo_task";

/** What the app knows about a received push. */
export interface PushReceivedOptions {
  /** The app was in the foreground. Default: `AppState.currentState === "active"`. */
  foreground?: boolean;
  /** Default: `"foreground"` when `foreground` is true. */
  source?: PushReceivedSource;
}

/** Options for requestPushAuthorization(). */
export interface PushAuthorizationOptions {
  /**
   * iOS: ask for provisional (quiet) delivery. iOS shows no prompt; the
   * notifications go to Notification Center only. Default false.
   */
  provisional?: boolean;
}

export interface IdentifyParams {
  /**
   * Arbitrary traits (plan, signup_date, …). Merged server-side. The reserved
   * keys `timezone` (IANA name) and `locale` (BCP 47) are filled in from the
   * device unless you supply them — your values always win.
   */
  traits?: Record<string, unknown>;
  /**
   * Convenience: expands to an email channel. `verified` is never sent.
   * `opted_in` is sent only when you pass `emailOptedIn`.
   *
   * Whether Whisperr may email an address that the app sends depends on the
   * app's answer in Whisperr to "Does your signup get permission to email
   * users?":
   * - Yes: the address is opted in unless you pass `emailOptedIn: false`.
   * - Per user: the address is opted in only when you pass `emailOptedIn: true`.
   * - No, or not answered: the address stays pending until your backend
   *   confirms it with the server key.
   *
   * With "Require a server key" on (the stricter mode), only your backend can
   * opt an address in, whatever the app sends. An opt-out (`false`) counts
   * with any key.
   */
  email?: string;
  /**
   * The user's email consent on the `email` shortcut's channel. `true` sends
   * `opted_in: true` with `consent_source: "user"`; `false` sends
   * `opted_in: false`. Leave it out to send no consent claim. Ignored without
   * `email` or when `channels` is given. See `email` for how Whisperr uses it.
   */
  emailOptedIn?: boolean;
  /** Convenience: expands to an SMS channel. Claims no consent and no verification. */
  phone?: string;
  /**
   * Convenience: expands to an opted-in push channel. Accepts the same forms as
   * setPushToken() (a token string, a `{ token, kind, … }` object, or an
   * expo-notifications token object).
   */
  pushToken?: PushTokenInput;
  /** Preferred outreach channel. */
  preferredChannel?: "email" | "sms" | "push";
  /** Full control over channels (overrides the shortcuts when provided). */
  channels?: WhisperrChannel[];
}

/**
 * Anything with the AsyncStorage contract. Pass
 * `@react-native-async-storage/async-storage` directly, an
 * `expo-sqlite/kv-store` handle, or a thin adapter over MMKV — sync return
 * values are fine too.
 */
export interface WhisperrStorage {
  getItem(key: string): Promise<string | null> | string | null;
  setItem(key: string, value: string): Promise<void> | void;
  removeItem(key: string): Promise<void> | void;
}

export interface WhisperrOptions {
  /** Publishable ingestion key (wpk_…). Required. Never ship a server key (wrk_…) in an app. */
  apiKey: string;
  /** Ingestion base URL. Defaults to https://api.whisperr.net. */
  baseUrl?: string;
  /**
   * Durable storage for the queue + identity so events survive app restarts.
   * Default: `@react-native-async-storage/async-storage` when the app has it
   * installed. Pass any WhisperrStorage adapter (MMKV, expo-sqlite kv-store)
   * to use that instead. With neither, the SDK works memory-only: the user id
   * and events queued at a crash or kill are lost, and it warns once in
   * development.
   */
  storage?: WhisperrStorage;
  /** Flush when this many sendable events are queued. Default 20. */
  flushAt?: number;
  /** Flush at least this often (ms). Default 10000. */
  flushIntervalMs?: number;
  /** Flush when the app moves to the background. Default true. */
  flushOnAppBackground?: boolean;
  /** Max events held in the queue; oldest drop on overflow. Default 1000. */
  maxQueueSize?: number;
  /** Max events per batch request (hard backend cap is 500). Default 500. */
  maxBatchSize?: number;
  /** Disable all network + capture (no-op client). Default false. */
  disabled?: boolean;
  /** Verbose logging to the console. Default false. */
  debug?: boolean;
  /** Per-request timeout (ms). Default 10000. */
  requestTimeoutMs?: number;
  /** Max consecutive retries before backing off a drain. Default 6. */
  maxRetries?: number;
  /** Called when delivery fails (auth/drop/retries exhausted). For observability. */
  onError?: (error: WhisperrError) => void;
  /**
   * Track app_installed, app_updated, app_opened, and app_backgrounded
   * automatically (via AppState). Default true. Install / update detection
   * needs durable `storage`; without it only opened / backgrounded are sent.
   */
  trackAppLifecycleEvents?: boolean;
  /**
   * The app's version (e.g. "2.4.1"). Optional: when absent the SDK reads it
   * from `expo-application` or `react-native-device-info` if your app already
   * has one of them installed, else leaves `app_version` out.
   */
  appVersion?: string;
  /** The app's build number (e.g. "241"). Same fallback as `appVersion`. */
  appBuild?: string;
  /**
   * The iOS bundle id or Android package name, sent with push tokens as
   * `client_app_id`. Default: read from `expo-application` or
   * `react-native-device-info` when installed.
   */
  clientAppId?: string;
  /**
   * Capture uncaught JS errors (`app_error`, through React Native's global
   * error handler, chained to the one installed before it). Default true.
   * `trackAppLifecycleEvents: false` also turns it off. `trackError()` works
   * either way. Error events carry the error's type and a fingerprint, never
   * its message or stack.
   */
  captureErrors?: boolean;
  /**
   * Also report unhandled promise rejections as `app_error` (release builds on
   * Hermes). Default false: Hermes keeps one rejection tracker per app, so
   * turning this on replaces the one Sentry, Bugsnag or another tool set, and
   * Whisperr cannot pass rejections on to it. Turn it on only when no other
   * tool tracks rejections.
   */
  captureUnhandledRejections?: boolean;
  /**
   * How long `app_opened` waits (ms) for its launch source: a push tap, a
   * link, or a widget/shortcut link. It goes out sooner when a source
   * resolves, the app goes to the background, or you call flush(). Default 1500.
   */
  launchSourceWindowMs?: number;
  /**
   * Report the OS notification permission by itself (`push_permission_changed`),
   * so the app does not have to call setPushPermission(). Default true. The
   * SDK reads it, without a prompt, after start, each time the app becomes
   * active (which includes the moment the app's own permission prompt
   * closes), and after reset(). It reads through `pushPermissionReader`, else
   * `expo-notifications` or `@react-native-firebase/messaging` when the app
   * has one; with neither it reads nothing.
   *
   * An automatic read reports only when the OS answer differs from the last
   * one the SDK read, or when nothing was sent yet (a new install, after
   * reset()). So a status the app sets with setPushPermission() stands until
   * the OS setting itself changes. Nothing is read while opted out. Set false
   * to report only through setPushPermission().
   */
  automaticPushPermission?: boolean;
  /**
   * Reads the OS notification permission for `automaticPushPermission` and
   * refreshPushPermission(), for apps that use another package (for example
   * `react-native-permissions` or `@notifee/react-native`). Return null or
   * undefined when it cannot tell. Default: `expo-notifications`, then
   * `@react-native-firebase/messaging`.
   */
  pushPermissionReader?: () =>
    | Promise<PushPermissionStatus | null | undefined>
    | PushPermissionStatus
    | null
    | undefined;
}

/** `error_kind` of an `app_error`. */
export type WhisperrErrorKind = "js" | "dart" | "native" | "handled" | "network" | "screen";

export interface TrackErrorOptions {
  /** The screen the error happened on. Default: the last screen_viewed. */
  screen?: string;
  /** Default `"handled"`. Use `"network"` for a failed request, `"screen"` for an error screen. */
  kind?: WhisperrErrorKind;
}

export interface WhisperrError {
  type: "auth" | "dropped" | "retry_exhausted";
  message: string;
  status?: number;
}

/** The public client surface. */
export interface WhisperrApi {
  identify(externalUserId: string, params?: IdentifyParams): void;
  /**
   * Sets the language the user picked in your app (BCP 47, for example `de`
   * or `pt-BR`; `_` is read as `-`). It is not the device locale: Whisperr
   * writes messages in this language. The SDK persists it and sends it with
   * every identify (a `traits.app_language` you pass wins). A new value is sent
   * at once: as a partial identify for the current user, or before login as an
   * anonymous identify. `null` clears the stored value (the server keeps the
   * last value sent). An invalid tag is ignored.
   */
  setAppLanguage(tag: string | null): void;
  /**
   * Captures the device push token. With a known user it re-identifies the push
   * channel immediately — a rotated token opts out the previous one; a repeated
   * token is a no-op for 7 days, then it is sent again (re-registration). The
   * last-sent (subject, token) pair is persisted, so both hold across app
   * restarts. Before identify() it goes out at once in an anonymous identify
   * (`anonymous_id` + the push channel); the next identify() carries it.
   * reset() moves it to the new anonymous id.
   *
   * - A string sends no kind; the server infers it.
   * - `{ token, kind?, platform?, pushEnv?, clientAppId?, providerProject? }`
   *   also sends the token fields. An Expo token gets `kind: "expo"`.
   * - `platform` (always), `client_app_id`, and `provider_project` (not for
   *   APNs) default to what the runtime knows.
   * - An expo-notifications token object (`getExpoPushTokenAsync()` /
   *   `getDevicePushTokenAsync()`) is mapped to `expo`, `apns`, or `fcm`.
   *
   * While the last reported permission (setPushPermission) is `denied`, the
   * token is held back and sent when the permission comes back.
   */
  setPushToken(token: PushTokenInput): void;
  /**
   * Reports the OS notification permission. Safe to call on every launch and
   * every foreground: a repeated status is a no-op, also across restarts.
   *
   * A new status sends the event `push_permission_changed` with `status`
   * (`authorized`, `provisional`, `denied`, `not_determined`) and
   * `previous_status`, the last status sent from this device. Before
   * identify() it goes out under the anonymous handle. `denied` also opts out
   * the push token this client registered, so the engine stops choosing push
   * for this device; `granted` / `provisional` registers it again.
   *
   * With `automaticPushPermission` (default) the SDK reports the OS value by
   * itself; a status set here stands until the OS setting changes.
   */
  setPushPermission(status: PushPermissionStatus): void;
  /**
   * Shows the OS notification prompt (or, with `provisional`, asks iOS for
   * quiet delivery without a prompt) and reports the answer through
   * setPushPermission(). Uses `expo-notifications` or
   * `@react-native-firebase/messaging`, whichever the app has. Resolves to the
   * status, or null when neither package is installed. Never throws.
   */
  requestPushAuthorization(options?: PushAuthorizationOptions): Promise<PushPermissionStatus | null>;
  /**
   * Reads the OS notification permission now (no prompt) and reports it
   * through setPushPermission(). The SDK already does this after start and
   * each time the app becomes active (`automaticPushPermission`); call it
   * right after your own permission prompt if you want it at once. Resolves
   * to the status read, or null when no reader is available, while opted out,
   * or when the read fails. Never throws.
   */
  refreshPushPermission(): Promise<PushPermissionStatus | null>;
  track(eventType: string, properties?: Record<string, unknown>, context?: Record<string, unknown>): void;
  /** Tracks `screen_viewed` with `{ screen_name: name }`. Wire it to your navigator. */
  screen(name: string, properties?: Record<string, unknown>): void;
  /**
   * Records that the user opened a push notification. Pass the notification
   * data (or the whole expo-notifications response / Firebase RemoteMessage):
   * the SDK reads `whisperr_message_id` (and `deep_link`, if present) and sends
   * `push_opened` once per message — repeated calls for the same message are
   * ignored, also across app restarts. A push without `whisperr_message_id`
   * did not come from Whisperr and is ignored.
   *
   * Returns the message id and deep link (for your router) whenever the payload
   * is a Whisperr push — also for a repeated tap or while opted out, which send
   * nothing. Returns null for other pushes.
   */
  trackPushOpened(data: unknown, options?: PushOpenedOptions): WhisperrPushOpen | null;
  /**
   * Records that a Whisperr push reached the device (`push_received`, with
   * `whisperr_message_id`, `foreground`, and `source`). Wire it to your
   * foreground notification listener. Once per message, also across restarts.
   * A push without `whisperr_message_id` is ignored. It is an automatic event:
   * `trackAppLifecycleEvents: false` stops it. It does not count as user
   * activity.
   */
  trackPushReceived(data: unknown, options?: PushReceivedOptions): WhisperrPushOpen | null;
  /**
   * Records an error your code handled (`app_error`, `error_kind: "handled"`
   * unless you pass `kind`). Only the error's type (`error.name`, or `name`
   * of a plain object such as `{ name: "HTTP_503" }`) and a fingerprint of
   * its top stack frames are sent, never the message. At most one per
   * fingerprint and 20 per session.
   */
  trackError(error: unknown, options?: TrackErrorOptions): void;
  /**
   * Sends everything queued. Also ends a pending launch-source wait, so a
   * held `app_opened` goes out first.
   */
  flush(): Promise<void>;
  reset(): void;
  /** Resumes capture after optOut(). The next setPushToken() registers the token again. */
  optIn(): void;
  /**
   * Stops capture: the queue and any buffered push token are dropped, and
   * nothing is queued or sent until optIn(). Persisted across restarts and
   * reset(). When this device registered a push token, one identify opts that
   * token out on the server first, under the user the token was registered
   * for (not always the current user). Push opt-outs already queued are kept
   * and go before it. Email, SMS, and the user's other devices keep their
   * state.
   */
  optOut(): void;
  /** Flushes, stops timers, and detaches listeners. The client is unusable afterward. */
  close(): Promise<void>;
  /** Events currently queued (buffered + sendable). */
  readonly pendingCount: number;
  /** True while the client captures events (not disabled/opted-out/closed). */
  readonly ready: boolean;
}

// ---- internal wire/queue shapes ----

export interface IdentifyOp {
  kind: "identify";
  /** Unset for an anonymous identify (sent under `anonymousId` only). */
  externalUserId?: string;
  /**
   * With `externalUserId`: the anonymous handle this identify promotes. Without
   * it: the handle this anonymous identify writes to. Sent as `anonymous_id`.
   */
  anonymousId?: string;
  /**
   * Set on a full identify (identify() or the restore identify): the restore
   * traits (device defaults + app_language) it was built with. After a 2xx
   * they become the restore record (24-hour throttle).
   */
  restoreTraits?: Record<string, unknown>;
  /** A setAppLanguage() partial identify: after a 2xx it updates the restore record's app_language. */
  languageUpdate?: boolean;
  /**
   * Set when identify() ran before the persisted anonymous state was read:
   * the promotion decision is made once init resolves.
   */
  resolveAnonymous?: boolean;
  traits?: Record<string, unknown>;
  preferredChannel?: string;
  channels?: WhisperrChannel[];
  occurredAt: string;
}

export interface TrackOp {
  kind: "track";
  eventType: string;
  /** null for an anonymous visitor: the event is sent under `anonymousId`. */
  externalUserId: string | null;
  /** The device's anonymous handle when the event was captured (unset only before init). */
  anonymousId?: string;
  properties?: Record<string, unknown>;
  context?: Record<string, unknown>;
  occurredAt: string;
  /** Idempotency key — lets the backend dedup retries / restart resends. */
  messageId: string;
}

export type QueuedOp = IdentifyOp | TrackOp;
