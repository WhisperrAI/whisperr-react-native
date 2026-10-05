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
  /** Convenience: expands to an opted-in push channel. */
  pushToken?: string;
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
   * Captures the device push token (FCM registration token / hex APNs token).
   * With a known user it re-identifies the push channel immediately — a rotated
   * token opts out the previous one; a repeated token is a no-op. The last-sent
   * (user, token) pair is persisted through the storage adapter, so both hold
   * across app restarts. Before identify() it is buffered in memory and
   * attached to the next identify().
   */
  setPushToken(token: string): void;
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
   */
  trackPushOpened(data: unknown): void;
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
