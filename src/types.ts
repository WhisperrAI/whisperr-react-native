/** Public types for the Whisperr React Native SDK. */

export interface WhisperrChannel {
  /** "email" | "sms" | "push" | custom. */
  type: string;
  /** The address/token for the channel (email address, phone, push token). */
  address: string;
  /** Whether the user has opted in to this channel. */
  optedIn?: boolean;
  /** Whether the address is verified. */
  verified?: boolean;
  /** Push only: the token type. Sent as `kind`. */
  kind?: PushTokenKind;
  /** Push only: the OS family of the device. Sent as `platform`. */
  platform?: PushPlatform;
  /** Push only: the APNs environment of the token. Sent as `push_env`. */
  pushEnv?: PushEnvironment;
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
}

export interface IdentifyParams {
  /**
   * Arbitrary traits (plan, signup_date, …). Merged server-side. The reserved
   * keys `timezone` (IANA name) and `locale` (BCP 47) are filled in from the
   * device unless you supply them — your values always win.
   */
  traits?: Record<string, unknown>;
  /**
   * Convenience: expands to an email channel. The SDK asserts no consent and no
   * verification for it — `opted_in` and `verified` are left off the wire. Pass
   * an explicit channel (`channels`) when you hold that consent.
   */
  email?: string;
  /** Convenience: expands to an opted-in SMS channel. */
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
  /** App ingestion key (wrk_…). Required. */
  apiKey: string;
  /** Ingestion base URL. Defaults to https://api.whisperr.net. */
  baseUrl?: string;
  /**
   * Durable storage for the queue + identity so events survive app restarts.
   * Pass AsyncStorage (or any WhisperrStorage adapter). Without it the SDK is
   * fully functional but memory-only: events queued at crash/kill are lost.
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
   * Captures the device push token. With a known user it re-identifies the push
   * channel immediately — a rotated token opts out the previous one; a repeated
   * token is a no-op. The last-sent (user, token) pair is persisted through the
   * storage adapter, so both hold across app restarts. Before identify() it is
   * buffered in memory and attached to the next identify().
   *
   * - A string sends the token only; the server infers its kind.
   * - `{ token, kind?, platform?, pushEnv? }` also sends the token type. An Expo
   *   token gets `kind: "expo"`, and `platform` defaults to `Platform.OS`.
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
   * The status goes to the user as the trait `push_permission`. `denied` also
   * opts out the push token this client registered, so the engine stops
   * choosing push for this device; `granted` / `provisional` registers it again.
   * Before identify() the status is attached to the next identify().
   */
  setPushPermission(status: PushPermissionStatus): void;
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
  trackPushOpened(data: unknown): WhisperrPushOpen | null;
  flush(): Promise<void>;
  reset(): void;
  optIn(): void;
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
  externalUserId: string;
  /** The anonymous handle this identify promotes (sent as `anonymous_id`). */
  anonymousId?: string;
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
