import { resolveAppInfo, type AppInfo } from "./app-info.js";
import {
  APP_BACKGROUNDED,
  APP_INSTALLED,
  APP_OPENED,
  APP_UPDATED,
  automaticProperties,
  detectVersionChange,
  extractPushOpened,
  parseStoredAppVersion,
  DEFAULT_PUSH_ACTION,
  PUSH_OPENED,
  PUSH_PERMISSION_CHANGED,
  PUSH_RECEIVED,
  SCREEN_VIEWED,
  SDK_NAME,
} from "./autocapture.js";
import { ASYNC_STORAGE_PACKAGE, loadDefaultStorage } from "./default-storage.js";
import { deviceTraits } from "./device.js";
import { addErrorSink } from "./errors.js";
import {
  currentAppState,
  currentOS,
  currentOSInfo,
  initialURL,
  onAppStateChange,
  onOpenURL,
  type AppStateStatus,
} from "./lifecycle.js";
import { readPermission, requestPermission } from "./push-authorization.js";
import { detectPushEnvironment, type PushEnvironmentInfo } from "./push-environment.js";
import {
  isPushPermissionStatus,
  isPushPermissionWireStatus,
  normalizePushToken,
  PERMISSION_WIRE_STATUS,
  permissionAllowsPush,
  pushChannel,
  pushMeta,
  registrationFromMeta,
  type PushPermissionWireStatus,
  type PushRegistration,
} from "./push.js";
import { DurableQueue } from "./queue.js";
import { isDevBuild, LIB_VERSION, monotonicNow, nowISO, Session, uuid } from "./runtime.js";
import {
  APP_CRASHED,
  APP_ERROR,
  ERROR_KINDS,
  errorFingerprint,
  errorName,
  linkSignal,
  stackFrames,
  strongerSignal,
  type ErrorKind,
  type LaunchSignal,
} from "./signals.js";
import { MemoryStorage, SafeStorage } from "./storage.js";
import { Transport, type SendOutcome } from "./transport.js";
import type {
  IdentifyOp,
  IdentifyParams,
  PushAuthorizationOptions,
  PushOpenedOptions,
  PushPermissionStatus,
  PushReceivedOptions,
  PushTokenInput,
  QueuedOp,
  TrackErrorOptions,
  TrackOp,
  WhisperrApi,
  WhisperrChannel,
  WhisperrError,
  WhisperrOptions,
  WhisperrPushOpen,
} from "./types.js";

/** React Native's development flag (undefined outside Metro). */
declare const __DEV__: boolean | undefined;

const DEFAULT_BASE = "https://api.whisperr.net";
const SNAKE_CASE = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;

const ANON_KEY = "whisperr.anon_id";
const USER_KEY = "whisperr.user_id";
const OPTOUT_KEY = "whisperr.optout";
const PUSH_KEY = "whisperr.last_push";
/** "1" while events went out under the current anonymous handle and no identify has claimed it. */
const ANON_USED_KEY = "whisperr.anon_used";
/** The app version/build seen at the last launch — drives app_installed / app_updated. */
const APP_VERSION_KEY = "whisperr.app_version";
/** whisperr_message_ids already reported as push_opened (most recent last). */
const PUSH_OPENED_KEY = "whisperr.push_opened";
/** The device's notification permission (a PermissionRecord). */
const PERMISSION_KEY = "whisperr.push_permission";
/** The notification permission the SDK last read from the OS (automaticPushPermission). */
const PERMISSION_OS_KEY = "whisperr.push_permission_os";
/** whisperr_message_ids already reported as push_received (most recent last). */
const PUSH_RECEIVED_KEY = "whisperr.push_received";
/** The language the user picked in the app (setAppLanguage). */
const APP_LANGUAGE_KEY = "whisperr.app_language";
/** The restore record: `{ userId, traits, at }` of the last full identify delivered (24-hour throttle). */
const RESTORE_RECORD_KEY = "whisperr.restore_record";
const MAX_REMEMBERED_PUSH_IDS = 100;
/** A restore identify is skipped when the same traits reached the server this recently. */
const RESTORE_THROTTLE_MS = 24 * 60 * 60 * 1000;
/** The same push token is sent again at most this often (at launch). */
const PUSH_REREGISTER_MS = 7 * 24 * 60 * 60 * 1000;
/** An open this soon after the client start, with no background since, is a cold start. */
const COLD_START_WINDOW_MS = 10_000;
/** `{ running, session_id, screen, app_version }` while the app is in the foreground (unclean-shutdown flag). */
const RUN_KEY = "whisperr.run_state";
/** `{ at, session_id, screen, app_version }` of the last fatal JS error. */
const FATAL_KEY = "whisperr.last_fatal";
const DEFAULT_LAUNCH_WINDOW_MS = 1500;
/** A link resolves the launch source after this short grace, so a push tap that arrives with it still wins. */
const LINK_GRACE_MS = 250;
const MAX_ERRORS_PER_SESSION = 20;
const CRASH_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Event types that are not the app's own `track()` events (they never count in `event_count`). */
const RESERVED_EVENTS = new Set([
  APP_INSTALLED,
  APP_UPDATED,
  APP_OPENED,
  APP_BACKGROUNDED,
  SCREEN_VIEWED,
  PUSH_OPENED,
  PUSH_RECEIVED,
  PUSH_PERMISSION_CHANGED,
  APP_ERROR,
  APP_CRASHED,
]);

/** An `app_opened` held while its launch source may still arrive. */
interface PendingOpen {
  properties: Record<string, unknown>;
  /** Wall-clock time of the foreground (occurred_at). */
  at: number;
  /** Monotonic deadline of the attribution window. */
  deadline: number;
  signal: LaunchSignal | null;
  timer: ReturnType<typeof setTimeout> | null;
}

/** What one foreground visit did, reported on app_backgrounded. */
interface VisitCounters {
  screens: number;
  uniqueScreens: Set<string>;
  events: number;
  errors: number;
}

function newVisit(): VisitCounters {
  return { screens: 0, uniqueScreens: new Set(), events: 0, errors: 0 };
}

/** The run-state and last-fatal records (both optional fields). */
interface RunRecord {
  running?: boolean;
  at?: number;
  session_id?: string;
  screen?: string;
  app_version?: string;
}

/** Who a push token or an identify is for: the user, or (before login) the device's anonymous handle. */
type Subject = { userId: string } | { anonymousId: string };

/** The last push token sent from this device, and for whom. Persisted as PUSH_KEY. */
interface PushPair {
  userId?: string;
  anonymousId?: string;
  token: string;
  meta?: string;
  /** When it was last sent (ms). Absent in pairs SDK 0.4.x persisted. */
  sentAt?: number;
}

/** One dev warning per process when no durable storage is available. */
let warnedMemoryOnly = false;
/**
 * Every key an SDK version before lifecycle events (0.2.x) could have
 * persisted. Any of them present means the app ran before: a missing version
 * record is then an upgrade from an older SDK, never a fresh install.
 */
const PRIOR_STATE_KEYS = [
  ANON_KEY,
  USER_KEY,
  OPTOUT_KEY,
  PUSH_KEY,
  "whisperr.queue.v1",
  "whisperr.session",
];

export class WhisperrClient implements WhisperrApi {
  private readonly storage: SafeStorage;
  private readonly queue: DurableQueue;
  private readonly transport: Transport;
  private readonly session: Session;

  private readonly flushAt: number;
  private readonly maxBatchSize: number;
  private readonly maxRetries: number;
  private readonly debug: boolean;
  private readonly warnedDropStatuses = new Set<number>();
  private readonly disabled: boolean;
  private readonly onError?: (error: WhisperrError) => void;

  private userId: string | null = null;
  private anonId = "";
  /** Events went out under the current anonymous handle; the next identify promotes it. */
  private anonUsed = false;
  /** reset() ran before init resolved — the persisted anon_used flag is stale. */
  private anonRotatedBeforeInit = false;
  /** The device had SDK state before this launch (so a missing version record is not an install). */
  private hadPriorState = false;
  private readonly priorState: Promise<boolean>;
  /** The last-sent pair an earlier launch persisted, read before this launch can write one. */
  private readonly launchPush: Promise<string | null>;
  /** The app language an earlier launch persisted, read before this launch can write one. */
  private readonly launchLanguage: Promise<string | null>;
  /** setAppLanguage(): the language the user picked; null when unset. */
  private appLanguage: string | null = null;
  /** setAppLanguage() ran before init resolved — init keeps this value. */
  private appLanguageTouched = false;
  /** The restore record: the last full identify delivered (restore-identify throttle). */
  private restoreRecord: RestoreRecord | null = null;
  /** WhisperrOptions.clientAppId. */
  private readonly clientAppId?: string;
  /** What the runtime tells about push (read once, on the first token). */
  private pushEnvironment: PushEnvironmentInfo | null = null;
  private initialized = false;
  /**
   * Token captured before identify() (attached to the next identify), or held
   * back while the reported permission is `denied` (sent when it comes back).
   */
  private pendingPushToken: PushRegistration | null = null;
  /**
   * Last push token delivered, per user — dedups refresh storms, opts out
   * rotations. Persisted (PUSH_KEY) alongside the identity so every-launch
   * getToken() wiring stays a no-op and a post-restart rotation still retires
   * the stale token.
   */
  private lastPush: PushPair | null = null;
  /** The device's notification permission; null until the app reports one. */
  private permission: PermissionRecord | null = null;
  /** Read the OS permission by itself (automaticPushPermission). */
  private readonly autoPermission: boolean;
  private readonly permissionReader: WhisperrOptions["pushPermissionReader"];
  /** The permission last read from the OS (persisted as PERMISSION_OS_KEY); null before the first read. */
  private osPermission: PushPermissionStatus | null = null;
  /** The automatic read in flight, and whether another was asked for meanwhile. */
  private permissionRead: Promise<void> | null = null;
  private permissionReread = false;
  /** optOut() ran (persisted as OPTOUT_KEY). Only queued push opt-outs are sent. */
  private optedOut = false;
  private closed = false;
  /** identify()/reset() ran before init resolved — don't adopt the persisted user. */
  private identityTouched = false;
  /** reset() ran before init resolved — don't restore the persisted push pair. */
  private pushCleared = false;
  private drainChain: Promise<void> = Promise.resolve();
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private removeLifecycle: () => void = () => {};
  private readonly initPromise: Promise<void>;

  // ---- automatic lifecycle events ----
  private readonly autocapture: boolean;
  private readonly flushOnBackground: boolean;
  /** Install / update detection needs a record that survives restarts. */
  private readonly durableStorage: boolean;
  private readonly appInfo: AppInfo;
  /** Lifecycle handling runs in order, after init, with the timestamps captured at the transition. */
  private lifecycleChain: Promise<void> = Promise.resolve();
  /** When the current foreground period started (monotonic ms); null while in the background. */
  private foregroundSince: number | null = null;
  /** WhisperrOptions.captureErrors. */
  private readonly captureErrors: boolean;
  /** WhisperrOptions.captureUnhandledRejections (only with captureErrors). */
  private readonly captureRejections: boolean;
  /** app_crashed needs the foreground flag the lifecycle writes. */
  private readonly crashTracking: boolean;
  private readonly launchWindowMs: number;
  /** The run-state and last-fatal records of the previous process, read before this one writes. */
  private readonly launchRun: Promise<string | null>;
  private readonly launchFatal: Promise<string | null>;
  /** The run-state flag is set (this process is in the foreground). */
  private running = false;
  /** app_updated was sent this launch: the next app_opened is the first after the update. */
  private firstAfterUpdate = false;
  private pendingOpen: PendingOpen | null = null;
  /** Launch signals that arrived before their foreground (monotonic ms). */
  private earlySignals: Array<{ signal: LaunchSignal; at: number }> = [];
  private visit: VisitCounters = newVisit();
  /** The last screen_viewed name (app_error screen_name, crashed_screen_name). */
  private lastScreen: string | null = null;
  /** app_error caps: the session they count for, its fingerprints, and how many went out. */
  private errorSessionId: string | null = null;
  private errorFingerprints = new Set<string>();
  private errorsSent = 0;
  private removeErrorSink: () => void = () => {};
  private removeLinking: () => void = () => {};
  /** A foreground was seen in this process — the next app_opened is a warm start. */
  private sawForeground = false;

  // ---- push_opened / push_received dedup ----
  private readonly openedThisLaunch: string[] = [];
  private readonly persistedOpened: RememberedIds;
  private readonly receivedThisLaunch = new Set<string>();
  private readonly persistedReceived: RememberedIds;
  /** When this client started (cold-start detection for push_opened). */
  private readonly startedAt = Date.now();
  /** The app went to the background since this client started. */
  private sawBackground = false;

  constructor(options: WhisperrOptions) {
    const baseUrl = (options.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "");
    this.flushAt = options.flushAt ?? 20;
    this.maxBatchSize = Math.min(options.maxBatchSize ?? 500, 500);
    this.maxRetries = options.maxRetries ?? 6;
    this.debug = options.debug ?? false;
    this.onError = options.onError;
    this.disabled = !!options.disabled;
    this.autocapture = !this.disabled && (options.trackAppLifecycleEvents ?? true);
    this.flushOnBackground = options.flushOnAppBackground ?? true;
    // Automatic error capture is an automatic event: trackAppLifecycleEvents: false stops it too.
    this.captureErrors = this.autocapture && (options.captureErrors ?? true);
    this.captureRejections = this.captureErrors && options.captureUnhandledRejections === true;
    // The unclean-shutdown flag follows the automatic-events switch only.
    this.crashTracking = this.autocapture;
    this.launchWindowMs = Math.max(0, options.launchSourceWindowMs ?? DEFAULT_LAUNCH_WINDOW_MS);
    this.autoPermission = !this.disabled && (options.automaticPushPermission ?? true);
    this.permissionReader = options.pushPermissionReader;
    // Manual screen(), push_opened and push_permission_changed carry these
    // too, so they resolve even with the automatic events off.
    this.appInfo = this.disabled ? {} : resolveAppInfo({ version: options.appVersion, build: options.appBuild });
    const clientAppId = typeof options.clientAppId === "string" ? options.clientAppId.trim() : "";
    if (clientAppId) this.clientAppId = clientAppId;

    // A passed adapter wins; else AsyncStorage when the app has it; else memory.
    const durable = options.storage ?? (this.disabled ? undefined : loadDefaultStorage());
    this.durableStorage = !!durable;
    if (!durable && !this.disabled) this.warnMemoryOnly();
    this.storage = new SafeStorage(durable ?? new MemoryStorage());
    // Snapshot "did the app run before?" now — before identify() / track() in
    // this launch tick can write user_id or session and fake prior state.
    this.priorState = Promise.all(PRIOR_STATE_KEYS.map((key) => this.storage.get(key))).then((values) =>
      values.some((v) => v !== null),
    );
    this.launchPush = this.storage.get(PUSH_KEY);
    this.launchLanguage = this.storage.get(APP_LANGUAGE_KEY);
    this.launchRun = this.storage.get(RUN_KEY);
    this.launchFatal = this.storage.get(FATAL_KEY);
    this.persistedOpened = new RememberedIds(this.storage, PUSH_OPENED_KEY);
    this.persistedReceived = new RememberedIds(this.storage, PUSH_RECEIVED_KEY);
    this.queue = new DurableQueue(this.storage, options.maxQueueSize ?? 1000);
    this.session = new Session();
    this.transport = new Transport(baseUrl, options.apiKey, options.requestTimeoutMs ?? 10000, this.debug);

    this.initPromise = this.disabled ? Promise.resolve() : this.init();

    if (!this.disabled) {
      this.startTimer(options.flushIntervalMs ?? 10000);
      if (this.autocapture) {
        const launchedAt = Date.now();
        const launchedMono = monotonicNow();
        const initialState = currentAppState();
        void this.runLifecycle(() => this.captureLaunch(initialState, launchedAt, launchedMono));
        // Links (custom scheme, universal/app links, widget and shortcut links) for launch_source.
        void initialURL().then((url) => {
          if (url) this.noteLaunchURL(url);
        });
        this.removeLinking = onOpenURL((url) => this.noteLaunchURL(url));
      }
      if (this.captureErrors) {
        this.removeErrorSink = addErrorSink(
          { captureUncaught: (error, fatal) => this.captureUncaught(error, fatal) },
          { rejections: this.captureRejections },
        );
      }
      if (this.autocapture || this.flushOnBackground || this.autoPermission) {
        this.removeLifecycle = onAppStateChange((state) => this.handleAppState(state));
      }
      // The permission at start, unless the process launched in the
      // background (headless JS): then the first move to "active" reads it.
      const launchState = currentAppState();
      if (launchState === undefined || launchState === "active" || launchState === "unknown") {
        this.autoReadPermission();
      }
      // Drain anything left over from a previous launch (while opted out:
      // a push opt-out that did not reach the server yet).
      void this.initPromise.then(() => {
        if (!this.closed && this.queue.size > 0) void this.drainQueue();
      });
    }
  }

  get ready(): boolean {
    return !this.muted && !this.closed;
  }

  /** Opted out or disabled: capture is a no-op. */
  private get muted(): boolean {
    return this.disabled || this.optedOut;
  }

  get pendingCount(): number {
    return this.queue.size;
  }

  identify(externalUserId: string, params: IdentifyParams = {}): void {
    if (this.muted || this.closed || !externalUserId) return;
    this.identityTouched = true; // also skips this launch's restore identify
    this.userId = externalUserId;
    void this.storage.set(USER_KEY, externalUserId);

    // The device's known token rides along: one buffered by setPushToken()
    // before init, or one registered under this device's anonymous handle
    // before login (whisperr-spec: identify attaches the known token).
    // A token held back while notifications are denied stays held back.
    const denied = this.permission?.status === "denied";
    let known = denied ? null : this.pendingPushToken;
    if (!known && !denied && this.initialized) {
      const anonymous = this.pairFor({ anonymousId: this.anonId });
      if (anonymous) known = registrationFromMeta(anonymous.token, anonymous.meta);
    }
    // A push token supplied to identify() rotates like setPushToken(): if it
    // differs from the last token this client sent for this user, opt the old
    // one out in the same body so it isn't stranded opted-in.
    const channels = this.withPushRotation(
      externalUserId,
      buildChannels(params, known, (reg) => this.withPushDefaults(reg)),
    );
    // Mark the last-sent pair BEFORE enqueue so an overflow-evicted registration
    // clears the mark (mark-on-delivery), never stranding a token opted-out.
    this.rememberPushChannel(externalUserId, channels);
    // Anonymous → identified: when events (or an anonymous identify) already
    // went out under this device's anonymous handle, the identify carries it
    // so the server promotes that anonymous user into this one. Before init
    // we cannot know yet — init settles it (resolveAnonymous).
    let anonymousId: string | undefined;
    let resolveAnonymous: boolean | undefined;
    if (!this.initialized) {
      resolveAnonymous = true;
    } else if (this.anonUsed || this.anonymousIdentifyQueued()) {
      anonymousId = this.anonId;
      this.setAnonUsed(false);
    }
    this.enqueue({
      kind: "identify",
      externalUserId,
      ...(anonymousId ? { anonymousId } : {}),
      ...(resolveAnonymous ? { resolveAnonymous } : {}),
      traits: this.identifyTraits(params.traits),
      restoreTraits: this.restoreTraits(),
      preferredChannel: params.preferredChannel,
      channels,
      occurredAt: nowISO(),
    });
    if (!denied) this.pendingPushToken = null;
    // Pre-login events still queued go out under this user directly.
    this.queue.backfillIdentity(externalUserId, this.anonId || undefined);
    void this.drainQueue();
  }

  setAppLanguage(tag: string | null): void {
    if (this.disabled || this.closed) return;
    if (tag === null || tag === undefined) {
      this.appLanguage = null;
      this.appLanguageTouched = true;
      void this.storage.remove(APP_LANGUAGE_KEY);
      return;
    }
    const language = normalizeAppLanguage(tag);
    if (!language) {
      this.log(`setAppLanguage(): "${String(tag)}" is not a BCP 47 language tag — ignored`);
      return;
    }
    if (this.initialized && language === this.appLanguage) return; // already stored and sent
    this.appLanguage = language;
    this.appLanguageTouched = true;
    void this.storage.set(APP_LANGUAGE_KEY, language);
    // Before init the subject is not known yet; init sends it (unless stored already).
    if (this.initialized) this.sendAppLanguage(language);
  }

  setPushToken(token: PushTokenInput): void {
    if (this.muted || this.closed) return;
    const reg = normalizePushToken(token);
    if (reg) this.registerPushToken(this.withPushDefaults(reg));
  }

  setPushPermission(status: PushPermissionStatus): void {
    if (this.muted || this.closed) return;
    if (!isPushPermissionStatus(status)) {
      this.log(`setPushPermission(): unknown status "${String(status)}" — ignored`);
      return;
    }
    // Decide after init: the persisted record makes a repeated report a no-op
    // across restarts.
    if (this.initialized) this.applyPermission(status);
    else void this.initPromise.then(() => this.applyPermission(status));
  }

  async requestPushAuthorization(options: PushAuthorizationOptions = {}): Promise<PushPermissionStatus | null> {
    if (this.disabled || this.closed) return null;
    const status = await requestPermission(options);
    if (!status) {
      this.log(
        "requestPushAuthorization(): no permission API found — install expo-notifications or @react-native-firebase/messaging, or call setPushPermission() yourself",
      );
      return null;
    }
    await this.initPromise;
    // The answer is what the OS now says.
    if (!this.muted && !this.closed) this.setOSPermission(status);
    this.setPushPermission(status);
    return status;
  }

  async refreshPushPermission(): Promise<PushPermissionStatus | null> {
    if (this.disabled || this.closed) return null;
    await this.initPromise;
    if (this.muted || this.closed) return null;
    const status = await this.readOSPermission();
    if (!status) {
      this.log(
        "refreshPushPermission(): could not read the permission — install expo-notifications or @react-native-firebase/messaging, pass pushPermissionReader, or call setPushPermission() yourself",
      );
      return null;
    }
    if (this.muted || this.closed) return null;
    this.setOSPermission(status);
    this.applyPermission(status);
    return status;
  }

  track(eventType: string, properties?: Record<string, unknown>, context?: Record<string, unknown>): void {
    if (this.muted || this.closed || !eventType) return;
    const type = eventType.trim();
    if (!type) return;
    if (!SNAKE_CASE.test(type)) {
      this.emit({ type: "dropped", message: `invalid event_type "${type}" — expected snake_case` });
      this.log(`invalid event_type "${type}" — event was not queued`);
      return;
    }
    if (type === SCREEN_VIEWED) {
      this.visit.screens++;
      const screenName = properties?.screen_name;
      if (typeof screenName === "string") this.visit.uniqueScreens.add(screenName);
    } else if (!RESERVED_EVENTS.has(type)) {
      this.visit.events++;
    }
    this.enqueueTrack(type, properties, context, nowISO());
  }

  screen(name: string, properties?: Record<string, unknown>): void {
    const screenName = typeof name === "string" ? name.trim() : "";
    if (!screenName) {
      this.log("screen() needs a screen name — event was not queued");
      return;
    }
    if (!this.muted && !this.closed) {
      this.lastScreen = screenName;
      if (this.running) this.writeRunState();
    }
    this.track(SCREEN_VIEWED, { ...automaticProperties(this.appInfo), ...properties, screen_name: screenName });
  }

  trackError(error: unknown, options: TrackErrorOptions = {}): void {
    const kind = ERROR_KINDS.includes(options.kind as ErrorKind) ? (options.kind as ErrorKind) : "handled";
    this.recordError(error, kind, false, cleanString(options.screen));
  }

  trackPushOpened(data: unknown, options: PushOpenedOptions = {}): WhisperrPushOpen | null {
    const extracted = extractPushOpened(data);
    if (!extracted) {
      this.log("trackPushOpened(): no whisperr_message_id in the payload — not a Whisperr push, ignored");
      return null;
    }
    const explicitAction = cleanString(options.actionId);
    const payload: WhisperrPushOpen = explicitAction ? { ...extracted, actionId: explicitAction } : extracted;
    // The app routes on the result even when nothing is sent.
    if (this.muted || this.closed) return payload;
    const { messageId, deepLink } = payload;
    // Cold start: getLastNotificationResponseAsync / getInitialNotification and
    // the response listener can both report the same tap — and the cold-start
    // getter keeps answering it on later launches. Report each message once.
    if (this.openedThisLaunch.includes(messageId)) return payload;
    this.openedThisLaunch.push(messageId);
    const occurredAt = nowISO();
    const coldStart =
      typeof options.coldStart === "boolean"
        ? options.coldStart
        : !this.sawBackground && Date.now() - this.startedAt < COLD_START_WINDOW_MS;
    // After the launch handling, so the app_opened this tap resolves goes out first.
    void this.runLifecycle(() => {
      if (this.muted || this.closed || this.persistedOpened.has(messageId)) return;
      this.noteLaunchSignal({ source: "push", properties: { whisperr_message_id: messageId.slice(0, 128) } });
      this.enqueueTrack(
        PUSH_OPENED,
        {
          ...automaticProperties(this.appInfo),
          whisperr_message_id: messageId,
          ...(deepLink ? { deep_link: deepLink } : {}),
          action_id: payload.actionId ?? DEFAULT_PUSH_ACTION,
          cold_start: coldStart,
        },
        undefined,
        occurredAt,
      );
      // Mark the id as reported only once the queue write holding the event
      // has landed: a kill in between re-reports the open next launch rather
      // than losing it.
      this.persistedOpened.add(messageId, this.queue.settle());
      void this.drainQueue();
    });
    return payload;
  }

  trackPushReceived(data: unknown, options: PushReceivedOptions = {}): WhisperrPushOpen | null {
    const payload = extractPushOpened(data);
    if (!payload) {
      this.log("trackPushReceived(): no whisperr_message_id in the payload — not a Whisperr push, ignored");
      return null;
    }
    // An automatic event: the off switch (trackAppLifecycleEvents: false) stops it.
    if (this.muted || this.closed || !this.autocapture) return payload;
    const { messageId } = payload;
    if (this.receivedThisLaunch.has(messageId)) return payload;
    this.receivedThisLaunch.add(messageId);
    const foreground = typeof options.foreground === "boolean" ? options.foreground : currentAppState() === "active";
    const source = options.source ?? (foreground ? "foreground" : undefined);
    const occurredAt = nowISO();
    void this.initPromise.then(() => {
      if (this.muted || this.closed || this.persistedReceived.has(messageId)) return;
      this.enqueueTrack(
        PUSH_RECEIVED,
        {
          ...automaticProperties(this.appInfo),
          whisperr_message_id: messageId,
          foreground,
          ...(source ? { source } : {}),
        },
        undefined,
        occurredAt,
      );
      this.persistedReceived.add(messageId, this.queue.settle());
    });
    return payload;
  }

  reset(): void {
    if (this.closed) return;
    const wasInitialized = this.initialized;
    if (!wasInitialized) {
      // The previous handle is still being read from storage. Settle what was
      // captured before this logout now so none of it can attach to the next
      // person: identifies promote nothing, anonymous events get a one-off handle.
      this.queue.resolveIdentifyPromotions(undefined);
      this.queue.stampAnonymousId(uuid());
      this.anonRotatedBeforeInit = true;
      // Init then moves the persisted pair's token to the new handle.
      this.pushCleared = true;
    }
    this.identityTouched = true;
    const last = wasInitialized ? this.lastPush : null;
    this.userId = null;
    this.forgetLastPush();
    this.setRestoreRecord(null);
    // The next user gets a fresh push_permission_changed. The permission itself
    // is the device's, so a denied permission still holds tokens back.
    if (this.permission) this.setPermission({ status: this.permission.status });
    // (1) The token leaves the old user (or the old anonymous handle).
    if (last && !this.muted) {
      this.enqueue(subjectIdentify(pairSubject(last), { channels: [optOutChannel(last.token)] }));
    }
    // (2) A fresh anonymous identity (a UUID v4, per the spec).
    this.anonId = uuid();
    this.setAnonUsed(false);
    void this.storage.remove(USER_KEY);
    void this.storage.set(ANON_KEY, this.anonId);
    // (3) The device's token moves to the new handle (held while denied).
    if (wasInitialized && !this.muted) {
      const reg = this.pendingPushToken ?? (last ? registrationFromMeta(last.token, last.meta) : null);
      if (reg) this.registerPushToken(reg);
    }
    if (last) void this.drainQueue();
    // The next user's report: reset() cleared the status sent, so the read sends it.
    this.autoReadPermission();
  }

  optIn(): void {
    if (this.closed || this.disabled) return; // `disabled` is a hard off switch
    this.optedOut = false;
    void this.storage.remove(OPTOUT_KEY);
  }

  optOut(): void {
    if (this.closed || this.optedOut) return; // a second call must not drop the queued opt-out
    this.optedOut = true;
    this.pendingPushToken = null;
    this.queue.rewrite(pushRetirement);
    this.setRestoreRecord(null);
    void this.storage.set(OPTOUT_KEY, "1");
    // Before init the last-sent pair is not restored yet; init sends it.
    if (this.initialized) this.queuePushOptOut();
  }

  flush(): Promise<void> {
    this.finishOpen(); // a held app_opened goes out with what is known
    return this.drainQueue();
  }

  private async drainQueue(): Promise<void> {
    if (this.closed) return;
    // Serialize drains and guarantee that awaiting flush() waits for a drain
    // pass that runs AFTER this call — so `await whisperr.flush()` before logout
    // actually delivers everything queued, even if a background flush is mid-send.
    const next = this.drainChain.then(() => this.drain()).catch(() => {});
    this.drainChain = next;
    await next;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.lifecycleChain; // queue lifecycle events still in flight, then deliver them
    await this.flush();
    this.closed = true;
    this.removeErrorSink();
    this.removeLinking();
    // The run-state flag stays: a process that ends in the foreground did not shut down cleanly.
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = null;
    this.removeLifecycle();
    this.removeLifecycle = () => {};
    await this.queue.settle();
  }

  // ---- internals ----

  private async init(): Promise<void> {
    this.hadPriorState = await this.priorState;
    if (await this.storage.get(OPTOUT_KEY)) this.optedOut = true;

    const anon = await this.storage.get(ANON_KEY);
    const persistedUser = await this.storage.get(USER_KEY);
    if (this.anonId === "") {
      // Handles minted by SDK 0.2.x look like "anon_<uuid>"; they stay valid
      // (1–128 chars), so an existing visitor keeps their handle.
      this.anonId = anon ?? uuid();
      if (!anon) void this.storage.set(ANON_KEY, this.anonId);
    }
    if (!this.anonRotatedBeforeInit && (await this.storage.get(ANON_USED_KEY)) === "1") {
      this.anonUsed = true;
    }

    if (persistedUser && !this.identityTouched) this.userId = persistedUser;

    // Restore the last-sent pair so the every-launch getToken() re-send dedups
    // and a post-restart rotation still opts out the old token. This must NOT
    // be gated on identify() having run: apps call identify(user) in the same
    // launch tick as construction, before init resolves. Restoring after
    // identify() is safe because setPushToken only opts out / dedups against a
    // pair whose subject matches the current one. Only reset() invalidates it
    // (init then moves its token), and a fresher pair already set in memory (a
    // setPushToken that raced init) is never clobbered.
    const launchPair = parseLastPush(await this.launchPush);
    if (!this.pushCleared && !this.lastPush && launchPair) this.lastPush = launchPair;

    const storedLanguage = normalizeAppLanguage(await this.launchLanguage);
    if (!this.appLanguageTouched) this.appLanguage = storedLanguage;
    // reset() / optOut() before init deleted the record; a later read must not revive it.
    if (!this.identityTouched && !this.optedOut) {
      this.restoreRecord = parseRestoreRecord(await this.storage.get(RESTORE_RECORD_KEY));
    }

    // The permission is reported through setPushPermission(), which waits for
    // init, so the stored value is always the latest one at this point.
    const storedPermission = parsePermissionRecord(await this.storage.get(PERMISSION_KEY));
    const storedOS = await this.storage.get(PERMISSION_OS_KEY);
    if (this.osPermission === null && isPushPermissionStatus(storedOS)) this.osPermission = storedOS;
    if (storedPermission) {
      // reset() before init: the next report is a fresh one.
      if (this.pushCleared) this.setPermission({ status: storedPermission.status });
      else this.permission = storedPermission;
    }

    await this.persistedOpened.load();
    await this.persistedReceived.load();
    await this.queue.restore();

    if (this.optedOut) {
      // Drop anything captured before the opt-out was read; keep push
      // opt-outs that have not reached the server.
      this.queue.rewrite(pushRetirement);
      this.pendingPushToken = null;
      // SDK 0.4.x opted out locally only and kept the last-sent pair. Only a
      // pair from an earlier launch counts: one identify() marked this launch
      // before the opt-out was read never reached the server.
      this.lastPush = this.pushCleared ? null : launchPair;
      this.queuePushOptOut();
      this.initialized = true;
      return;
    }

    // identify() calls made before init carry the stored app language too.
    const language = this.appLanguage;
    if (language) {
      this.queue.rewrite((op) => {
        if (op.kind !== "identify" || !op.resolveAnonymous || !op.restoreTraits) return op;
        const traits = op.traits && "app_language" in op.traits ? op.traits : { ...op.traits, app_language: language };
        return { ...op, traits, restoreTraits: { ...op.restoreTraits, app_language: language } };
      });
    }
    // Ops captured before we knew who the user is (this launch, before init)
    // now attribute to the restored identity…
    if (this.userId) this.queue.backfillIdentity(this.userId, this.anonId);
    // …and the rest — this launch's or a previous one's — go out under the
    // device's anonymous handle.
    this.queue.stampAnonymousId(this.anonId);
    // identify() calls made before init: the first one promotes the handle if
    // events (or an anonymous identify) already went out under it.
    const promote = this.anonUsed || this.anonymousIdentifyQueued();
    if (this.queue.resolveIdentifyPromotions(promote ? this.anonId : undefined)) {
      this.setAnonUsed(false);
    }
    this.initialized = true;

    // C1: a stored user is identified again at start (it carries the language).
    const restored = persistedUser && !this.identityTouched ? this.queueRestoreIdentify(persistedUser) : false;
    // C2: a language set before init that differs from the stored one.
    if (!restored && this.appLanguageTouched && this.appLanguage && this.appLanguage !== storedLanguage) {
      this.sendAppLanguage(this.appLanguage);
    }
    this.settlePushAtLaunch(this.pushCleared ? launchPair : null);
  }

  /**
   * The restore identify (whisperr-spec: identify at every app start): one per
   * process, skipped when the same traits reached the server for this user
   * less than 24 hours ago. Returns true when it was queued.
   */
  private queueRestoreIdentify(userId: string): boolean {
    const traits = this.restoreTraits();
    const record = this.restoreRecord;
    const age = record ? Date.now() - record.at : Number.POSITIVE_INFINITY;
    if (record && record.userId === userId && sameTraits(record.traits, traits) && age >= 0 && age < RESTORE_THROTTLE_MS) {
      return false;
    }
    // An earlier start's restore identify still waits in the queue (offline): it says the same.
    const queued = this.queue.all.some(
      (op) =>
        op.kind === "identify" &&
        op.externalUserId === userId &&
        !!op.restoreTraits &&
        !op.channels?.length &&
        sameTraits(op.restoreTraits, traits),
    );
    if (queued) return false;
    this.enqueue({
      kind: "identify",
      externalUserId: userId,
      anonymousId: this.anonId,
      ...(Object.keys(traits).length ? { traits } : {}),
      restoreTraits: traits,
      occurredAt: nowISO(),
    });
    this.setAnonUsed(false);
    return true;
  }

  /** Queues `{ subject, traits: { app_language } }`: a partial or an anonymous identify. */
  private sendAppLanguage(language: string): void {
    if (this.muted || this.closed) return;
    const op = subjectIdentify(this.subject(), { traits: { app_language: language } });
    // A delivered language update for a user refreshes the restore record.
    this.enqueue(op.externalUserId ? { ...op, languageUpdate: true } : op);
    void this.drainQueue();
  }

  /** What init does with push tokens once the subject is known. */
  private settlePushAtLaunch(pairBeforeReset: PushPair | null): void {
    if (this.pushCleared) {
      // reset() ran before init: the persisted pair's token moves from its old
      // subject to the current one (the new anonymous handle, or a user that
      // identify() set since).
      if (pairBeforeReset) {
        this.enqueue(subjectIdentify(pairSubject(pairBeforeReset), { channels: [optOutChannel(pairBeforeReset.token)] }));
        void this.drainQueue();
      }
      const reg =
        this.pendingPushToken ??
        (pairBeforeReset ? registrationFromMeta(pairBeforeReset.token, pairBeforeReset.meta) : null);
      if (reg) this.registerPushToken(reg);
      return;
    }
    // A token captured before init now goes to the restored user, or before
    // login to the anonymous handle.
    if (this.pendingPushToken) {
      this.registerPushToken(this.pendingPushToken);
      return;
    }
    // A token registered before login while identify() raced init: the user takes it.
    const pair = this.lastPush;
    if (this.userId && pair && !pair.userId && pair.anonymousId === this.anonId) {
      this.registerPushToken(registrationFromMeta(pair.token, pair.meta));
      return;
    }
    // Re-registration: the same token goes out again once every 7 days.
    const current = this.pairFor(this.subject());
    if (current && !isFresh(current.sentAt)) this.registerPushToken(registrationFromMeta(current.token, current.meta));
  }

  // ---- push token + permission ----

  private registerPushToken(reg: PushRegistration): void {
    // Held, not sent: before init (the restored last-sent pair and permission
    // decide it then) and while notifications are off (the next allowed
    // report sends it). Before login it goes to the anonymous handle.
    if (!this.initialized || this.permission?.status === "denied") {
      this.pendingPushToken = reg;
      return;
    }
    this.pendingPushToken = null; // the token is handled here, sent or deduped
    const subject = this.subject();
    const last = this.pairFor(subject);
    const sameToken = !!last && last.token === reg.token;
    // Refresh storm / every-launch re-send: same token, nothing new to say —
    // unless the last send is 7 days old (re-registration). A token with less
    // metadata never downgrades a registration that carried more.
    const covered = !!last && sameToken && metaCovers(last.meta, reg);
    if (covered && isFresh(last.sentAt)) return;
    const send = covered && last ? { ...registrationFromMeta(last.token, last.meta), ...definedFields(reg) } : reg;
    const channels: WhisperrChannel[] = [];
    // Rotation: retire the token this client previously registered.
    if (last && !sameToken) channels.push(optOutChannel(last.token));
    channels.push(pushChannel(send, true));
    // Mark BEFORE enqueue so an overflow-evicted registration clears the mark.
    this.setLastPush(subject, send.token, pushMeta(send) || last?.meta);
    this.enqueue(subjectIdentify(subject, { channels }));
    void this.drainQueue();
  }

  private applyPermission(status: PushPermissionStatus): void {
    if (this.muted || this.closed) return;
    const wire = PERMISSION_WIRE_STATUS[status];
    const previous = this.permission?.sent;
    if (previous === wire && this.permission?.status === status) return; // every-launch / every-foreground report
    // Mark BEFORE enqueue so a dropped or evicted event clears the mark.
    this.setPermission({ status, sent: wire });
    if (previous !== wire) {
      this.enqueueTrack(
        PUSH_PERMISSION_CHANGED,
        {
          ...automaticProperties(this.appInfo),
          status: wire,
          ...(previous ? { previous_status: previous } : {}),
        },
        undefined,
        nowISO(),
      );
    }
    const subject = this.subject();
    const channels = this.permissionChannels(status, subject);
    if (channels.length) this.enqueue(subjectIdentify(subject, { channels }));
    void this.drainQueue();
  }

  /**
   * The push channel changes a permission report causes: `denied` opts the
   * registered token out and holds it; an allowed status registers a held token.
   */
  private permissionChannels(status: PushPermissionStatus, subject: Subject): WhisperrChannel[] {
    const last = this.pairFor(subject);
    if (status === "denied") {
      if (!last) return [];
      if (!this.pendingPushToken) this.pendingPushToken = registrationFromMeta(last.token, last.meta);
      this.forgetLastPush();
      return [optOutChannel(last.token)];
    }
    if (!permissionAllowsPush(status) || !this.pendingPushToken) return [];
    const reg = this.pendingPushToken;
    this.pendingPushToken = null;
    if (last && last.token === reg.token) return [];
    const channels: WhisperrChannel[] = [];
    if (last) channels.push(optOutChannel(last.token));
    channels.push(pushChannel(reg, true));
    this.setLastPush(subject, reg.token, pushMeta(reg) || undefined);
    return channels;
  }

  private setPermission(record: PermissionRecord): void {
    this.permission = record;
    void this.storage.set(PERMISSION_KEY, JSON.stringify(record));
  }

  private setOSPermission(status: PushPermissionStatus): void {
    if (this.osPermission === status) return;
    this.osPermission = status;
    void this.storage.set(PERMISSION_OS_KEY, status);
  }

  /** The OS permission from pushPermissionReader or an installed peer; undefined when unknown. */
  private async readOSPermission(): Promise<PushPermissionStatus | undefined> {
    try {
      const status = this.permissionReader ? await this.permissionReader() : await readPermission();
      return isPushPermissionStatus(status) ? status : undefined;
    } catch (error) {
      this.log(`push permission read failed: ${String(error)}`);
      return undefined;
    }
  }

  /**
   * automaticPushPermission: reads the OS permission and reports it when it
   * differs from the last read, or when nothing was sent since install or
   * reset(). A status the app set with setPushPermission() therefore stands
   * until the OS setting changes. One read at a time; a read asked for while
   * one runs follows it.
   */
  private autoReadPermission(): void {
    if (!this.autoPermission || this.closed) return;
    if (this.permissionRead) {
      this.permissionReread = true;
      return;
    }
    this.permissionRead = (async () => {
      await this.initPromise;
      if (this.muted || this.closed) return;
      const status = await this.readOSPermission();
      if (!status || this.muted || this.closed) return;
      const report = status !== this.osPermission || !this.permission?.sent;
      this.setOSPermission(status);
      if (report) this.applyPermission(status);
    })()
      .catch(() => {})
      .finally(() => {
        this.permissionRead = null;
        if (this.permissionReread) {
          this.permissionReread = false;
          this.autoReadPermission();
        }
      });
  }

  /**
   * optOut() tells the server about this device: when this client holds a
   * last-sent pair, one identify opts that token out under the pair's
   * subject, which is not always the current one (identify() without
   * reset()). It survives a restart until delivered. The pair is forgotten,
   * so after optIn() the next setPushToken() registers the token again.
   */
  private queuePushOptOut(): void {
    const last = this.lastPush;
    this.forgetLastPush();
    if (!last) return;
    this.enqueue(subjectIdentify(pairSubject(last), { channels: [optOutChannel(last.token)] }));
    void this.drainQueue();
  }

  /** The current subject: the user, else (before login) the anonymous handle. */
  private subject(): Subject {
    return this.userId ? { userId: this.userId } : { anonymousId: this.anonId };
  }

  /** The last-sent pair when it belongs to `subject`. */
  private pairFor(subject: Subject): PushPair | null {
    const last = this.lastPush;
    if (!last) return null;
    if ("userId" in subject) return last.userId === subject.userId ? last : null;
    return !last.userId && last.anonymousId === subject.anonymousId ? last : null;
  }

  /** An anonymous identify of the current handle waits in the queue. */
  private anonymousIdentifyQueued(): boolean {
    return this.queue.all.some((op) => op.kind === "identify" && !op.externalUserId && op.anonymousId === this.anonId);
  }

  /** Traits of a full identify: device defaults, the stored app language, then the caller's. */
  private identifyTraits(traits: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    const merged = withDeviceTraits(traits);
    if (!this.appLanguage || (traits && "app_language" in traits)) return merged;
    return { ...merged, app_language: this.appLanguage };
  }

  /** The restore traits: the device defaults and the stored app language. */
  private restoreTraits(): Record<string, unknown> {
    return { ...deviceTraits(), ...(this.appLanguage ? { app_language: this.appLanguage } : {}) };
  }

  /**
   * Fills the token fields the caller left out from what the runtime knows
   * (whisperr-spec contract v2): `platform` always, `client_app_id`,
   * `provider_project` (not for APNs tokens) and `push_env` (APNs only).
   */
  private withPushDefaults(reg: PushRegistration): PushRegistration {
    const env = (this.pushEnvironment ??= detectPushEnvironment());
    const platform = reg.platform ?? env.platform;
    const clientAppId = reg.clientAppId ?? this.clientAppId ?? env.clientAppId;
    const providerProject =
      reg.providerProject ?? (reg.kind && reg.kind !== "apns" ? env.providerProject(reg.kind) : undefined);
    const pushEnv = reg.pushEnv ?? (reg.kind === "apns" ? env.pushEnv : undefined);
    return {
      ...reg,
      ...(platform ? { platform } : {}),
      ...(clientAppId ? { clientAppId } : {}),
      ...(providerProject ? { providerProject } : {}),
      ...(pushEnv ? { pushEnv } : {}),
    };
  }

  // ---- automatic lifecycle events ----

  /** Runs lifecycle handling in order, after init, even while opted out (state must stay true). */
  private runLifecycle(step: () => Promise<void> | void): Promise<void> {
    const next = this.lifecycleChain
      .then(() => this.initPromise)
      .then(() => (this.closed ? undefined : step()))
      .catch(() => {});
    this.lifecycleChain = next;
    return next;
  }

  private handleAppState(state: AppStateStatus): void {
    if (this.closed) return;
    const at = Date.now();
    const mono = monotonicNow();
    if (state === "background") this.sawBackground = true;
    const queued = this.autocapture
      ? this.runLifecycle(() => this.captureTransition(state, at, mono))
      : Promise.resolve();
    if (this.flushOnBackground && (state === "background" || state === "inactive")) {
      // After app_backgrounded is queued, so the last foreground period ships now.
      void queued.then(() => this.drainQueue());
    }
    // Back in the foreground, or back from a system dialog such as the
    // permission prompt (iOS: inactive → active; Android: background → active).
    if (state === "active") this.autoReadPermission();
  }

  private async captureLaunch(
    initialState: AppStateStatus | undefined,
    launchedAt: number,
    launchedMono: number,
  ): Promise<void> {
    if (this.durableStorage) await this.captureInstallOrUpdate(launchedAt);
    // The previous process's crash, before this launch's app_opened.
    await this.captureCrash(launchedAt);
    // A launch into the background (headless JS, background fetch) is not an
    // open; the first move to "active" reports the cold start instead.
    if (initialState === undefined || initialState === "active" || initialState === "unknown") {
      this.captureTransition("active", launchedAt, launchedMono);
    }
  }

  private captureTransition(state: AppStateStatus, at: number, mono: number): void {
    if (state === "active") {
      this.markRunning();
      if (this.foregroundSince !== null) return; // already in the foreground
      this.foregroundSince = mono;
      const coldStart = !this.sawForeground;
      this.sawForeground = true;
      this.holdOpen(coldStart, at, mono);
    } else if (state === "background") {
      this.clearRunning();
      if (this.foregroundSince === null) return;
      this.finishOpen(); // backgrounded inside the window: send what is known
      const foregroundMs = Math.max(0, Math.round(mono - this.foregroundSince));
      this.foregroundSince = null;
      const visit = this.visit;
      this.visit = newVisit();
      this.captureAutomatic(
        APP_BACKGROUNDED,
        {
          foreground_ms: foregroundMs,
          session_id: this.session.current(),
          screen_count: visit.screens,
          unique_screen_count: visit.uniqueScreens.size,
          event_count: visit.events,
          error_count: visit.errors,
        },
        at,
      );
    } else if (state === "inactive") {
      // Not a transition of its own (iOS passes through it for Control Center,
      // calls and the app switcher), but a swipe-kill from the app switcher
      // ends here, so the unclean-shutdown flag is cleared; "active" sets it again.
      this.clearRunning();
    }
  }

  // ---- launch source ----

  /** Starts the attribution window for an app_opened. */
  private holdOpen(coldStart: boolean, at: number, mono: number): void {
    const properties: Record<string, unknown> = { cold_start: coldStart };
    if (this.firstAfterUpdate) {
      properties.first_after_update = true;
      this.firstAfterUpdate = false;
    }
    let signal: LaunchSignal | null = null;
    for (const early of this.earlySignals) {
      if (mono - early.at <= this.launchWindowMs) signal = strongerSignal(signal, early.signal);
    }
    this.earlySignals = [];
    this.pendingOpen = { properties, at, deadline: mono + this.launchWindowMs, signal, timer: null };
    if (this.launchWindowMs === 0 || signal?.source === "push") this.finishOpen();
    else this.scheduleOpen(signal ? LINK_GRACE_MS : this.launchWindowMs);
  }

  private scheduleOpen(ms: number): void {
    const pending = this.pendingOpen;
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    const wait = Math.max(0, Math.min(ms, pending.deadline - monotonicNow()));
    pending.timer = setTimeout(() => this.finishOpen(), wait);
    (pending.timer as unknown as { unref?: () => void }).unref?.();
  }

  /** Sends the held app_opened with the strongest launch signal seen (else `direct`). */
  private finishOpen(): void {
    const pending = this.pendingOpen;
    if (!pending) return;
    this.pendingOpen = null;
    if (pending.timer) clearTimeout(pending.timer);
    const signal = pending.signal;
    this.captureAutomatic(
      APP_OPENED,
      { ...pending.properties, launch_source: signal?.source ?? "direct", ...signal?.properties },
      pending.at,
    );
  }

  private noteLaunchURL(url: string): void {
    const signal = linkSignal(url);
    if (signal) this.noteLaunchSignal(signal);
  }

  /**
   * A push tap or a link: it sets the launch source of the held app_opened,
   * or of the next one when it arrives just before its foreground. One while
   * the app is already in the foreground is not a launch.
   */
  private noteLaunchSignal(signal: LaunchSignal): void {
    if (this.closed || !this.autocapture) return;
    const pending = this.pendingOpen;
    if (pending) {
      pending.signal = strongerSignal(pending.signal, signal);
      if (pending.signal.source === "push") this.finishOpen();
      else this.scheduleOpen(LINK_GRACE_MS);
      return;
    }
    if (this.foregroundSince !== null) return;
    this.earlySignals = [...this.earlySignals.slice(-4), { signal, at: monotonicNow() }];
  }

  // ---- errors and crashes ----

  /** From the global handler: an uncaught JS error (`fatal`: the app is about to terminate). */
  private captureUncaught(error: unknown, fatal: boolean): void {
    if (this.closed) return;
    // The app is about to terminate: an app_opened still waiting for its source goes out now.
    if (fatal) this.finishOpen();
    if (fatal && this.crashTracking) {
      // Best effort: the process may end before the write lands; the run-state flag still reports it.
      const record: RunRecord = {
        at: Date.now(),
        session_id: this.session.current(),
        ...(this.lastScreen ? { screen: this.lastScreen } : {}),
        ...(this.appInfo.version ? { app_version: this.appInfo.version } : {}),
      };
      void this.storage.set(FATAL_KEY, JSON.stringify(record));
    }
    this.recordError(error, "js", fatal);
  }

  private recordError(error: unknown, kind: ErrorKind, fatal: boolean, screen?: string): void {
    if (this.muted || this.closed) return;
    this.visit.errors++; // the true total, including what the caps drop
    const sessionId = this.session.current();
    if (sessionId !== this.errorSessionId) {
      this.errorSessionId = sessionId;
      this.errorFingerprints = new Set();
      this.errorsSent = 0;
    }
    const name = errorName(error);
    let stack: unknown;
    try {
      stack = (error as { stack?: unknown } | null)?.stack;
    } catch {
      stack = undefined;
    }
    const fingerprint = errorFingerprint(name, stackFrames(stack));
    if (this.errorFingerprints.has(fingerprint) || this.errorsSent >= MAX_ERRORS_PER_SESSION) return;
    this.errorFingerprints.add(fingerprint);
    this.errorsSent++;
    const screenName = screen ?? this.lastScreen;
    // Batched like any event: an error never forces a flush of its own.
    this.enqueue({
      kind: "track",
      eventType: APP_ERROR,
      externalUserId: this.userId,
      ...(!this.userId && this.anonId ? { anonymousId: this.anonId } : {}),
      properties: {
        ...automaticProperties(this.appInfo),
        error_kind: kind,
        fatal,
        error_name: name,
        fingerprint,
        ...(screenName ? { screen_name: screenName } : {}),
        session_id: sessionId,
      },
      context: this.baseContext(),
      occurredAt: nowISO(),
      messageId: uuid(),
    });
  }

  /** app_crashed for the previous process, from its run-state flag and last-fatal record. */
  private async captureCrash(launchedAt: number): Promise<void> {
    const run = parseRunRecord(await this.launchRun);
    const fatal = parseRunRecord(await this.launchFatal);
    if (run) void this.storage.remove(RUN_KEY);
    if (fatal) void this.storage.remove(FATAL_KEY);
    if (!this.crashTracking || isDevBuild()) return; // a debug build's red box and reloads are not crashes
    const record = fatal ?? (run?.running ? run : null);
    if (!record) return;
    const crashedAt = fatal?.at;
    const occurredAt =
      typeof crashedAt === "number" && crashedAt <= launchedAt && launchedAt - crashedAt < CRASH_MAX_AGE_MS
        ? crashedAt
        : launchedAt;
    this.captureAutomatic(
      APP_CRASHED,
      {
        crash_kind: fatal ? "crash" : "abnormal_exit",
        detected_by: fatal ? "js_fatal" : "unclean_shutdown",
        ...(record.app_version ? { crashed_app_version: record.app_version } : {}),
        ...(record.session_id ? { crashed_session_id: record.session_id } : {}),
        ...(record.screen ? { crashed_screen_name: record.screen } : {}),
        foreground: fatal ? !!run?.running : true,
      },
      occurredAt,
    );
  }

  /** Sets the unclean-shutdown flag: the app is in the foreground. */
  private markRunning(): void {
    if (!this.crashTracking) return;
    this.running = true;
    this.writeRunState();
  }

  private writeRunState(): void {
    const record: RunRecord = {
      running: true,
      session_id: this.session.current(),
      ...(this.lastScreen ? { screen: this.lastScreen } : {}),
      ...(this.appInfo.version ? { app_version: this.appInfo.version } : {}),
    };
    void this.storage.set(RUN_KEY, JSON.stringify(record));
  }

  private clearRunning(): void {
    if (!this.running) return;
    this.running = false;
    void this.storage.remove(RUN_KEY);
  }

  private async captureInstallOrUpdate(launchedAt: number): Promise<void> {
    const stored = parseStoredAppVersion(await this.storage.get(APP_VERSION_KEY));
    const change = detectVersionChange(stored, this.appInfo, this.hadPriorState);
    const record = {
      ...((this.appInfo.version ?? stored?.version) ? { version: this.appInfo.version ?? stored?.version } : {}),
      ...((this.appInfo.build ?? stored?.build) ? { build: this.appInfo.build ?? stored?.build } : {}),
    };
    // Recorded even while opted out, so a later opt-in never reports a stale install/update.
    if (!stored || stored.version !== record.version || stored.build !== record.build) {
      void this.storage.set(APP_VERSION_KEY, JSON.stringify(record));
    }
    if (change?.kind === "installed") {
      this.captureAutomatic(APP_INSTALLED, {}, launchedAt);
    } else if (change?.kind === "updated") {
      this.firstAfterUpdate = true;
      const previous: Record<string, string> = {};
      if (change.previous.version) previous.previous_version = change.previous.version;
      if (change.previous.build) previous.previous_build = change.previous.build;
      this.captureAutomatic(APP_UPDATED, previous, launchedAt);
    }
  }

  private captureAutomatic(eventType: string, properties: Record<string, unknown>, atMs: number): void {
    if (this.muted || this.closed) return;
    this.enqueueTrack(eventType, { ...automaticProperties(this.appInfo), ...properties }, undefined, new Date(atMs).toISOString());
  }

  /** Enqueues an already-validated track op. */
  private enqueueTrack(
    eventType: string,
    properties: Record<string, unknown> | undefined,
    context: Record<string, unknown> | undefined,
    occurredAt: string,
  ): void {
    this.enqueue({
      kind: "track",
      eventType,
      externalUserId: this.userId, // null before identify(): sent under the anonymous handle
      // Unset only before init resolves; init stamps the handle it reads.
      ...(!this.userId && this.anonId ? { anonymousId: this.anonId } : {}),
      properties,
      context: { ...this.baseContext(), ...context },
      occurredAt,
      messageId: uuid(),
    });
    if (this.queue.size >= this.flushAt) void this.drainQueue();
  }

  private setAnonUsed(used: boolean): void {
    if (this.anonUsed === used) return;
    this.anonUsed = used;
    void (used ? this.storage.set(ANON_USED_KEY, "1") : this.storage.remove(ANON_USED_KEY));
  }

  /** Records the opted-in push channel (if any) that an identify just sent. */
  private rememberPushChannel(userId: string, channels: WhisperrChannel[] | undefined): void {
    const push = channels?.filter((c) => c.type === "push" && c.optedIn !== false).pop();
    if (push) this.setLastPush({ userId }, push.address, pushMeta(push) || undefined);
  }

  /**
   * If `channels` registers a new opted-in push token that differs from the
   * last one this client sent for `userId`, prepend an opt-out of the old token
   * so a token supplied via identify() rotates exactly like setPushToken().
   */
  private withPushRotation(
    userId: string,
    channels: WhisperrChannel[] | undefined,
  ): WhisperrChannel[] | undefined {
    if (!channels) return channels;
    const newPush = channels.filter((c) => c.type === "push" && c.optedIn !== false).pop();
    if (!newPush) return channels;
    const last = this.pairFor({ userId })?.token ?? null;
    if (!last || last === newPush.address) return channels;
    if (channels.some((c) => c.type === "push" && c.address === last)) return channels;
    return [{ type: "push", address: last, optedIn: false }, ...channels];
  }

  /**
   * A dropped (4xx) or overflow-evicted op never reached the server, so the
   * (user, token) pair it would have registered must not stay marked as
   * delivered — otherwise a single rejection wedges that token opted-out of
   * every future setPushToken. Clears lastPush when a discarded op carried the
   * currently-marked token.
   */
  private forgetPushMark(discarded: readonly QueuedOp[]): void {
    // A permission event that never shipped: the last status sent is the one before it.
    const permission = this.permission;
    const lost = discarded.find(
      (op) => op.kind === "track" && op.eventType === PUSH_PERMISSION_CHANGED && op.properties?.status === permission?.sent,
    );
    if (permission?.sent && lost?.kind === "track") {
      const before = lost.properties?.previous_status;
      this.setPermission({ status: permission.status, ...(isPushPermissionWireStatus(before) ? { sent: before } : {}) });
    }
    const last = this.lastPush;
    if (!last) return;
    for (const op of discarded) {
      if (op.kind !== "identify" || !opIsFor(op, last)) continue;
      const carried = op.channels?.some(
        (c) => c.type === "push" && c.optedIn !== false && c.address === last.token,
      );
      if (carried) {
        this.forgetLastPush();
        return;
      }
    }
  }

  /** Updates the last-sent (subject, token) pair and persists it (write-behind). */
  private setLastPush(subject: Subject, token: string, meta?: string): void {
    this.lastPush = { ...subject, token, ...(meta ? { meta } : {}), sentAt: Date.now() };
    void this.storage.set(PUSH_KEY, JSON.stringify(this.lastPush));
  }

  private forgetLastPush(): void {
    this.lastPush = null;
    void this.storage.remove(PUSH_KEY);
  }

  /** Sends the queue in order. While opted out it holds only push opt-outs. */
  private async drain(): Promise<void> {
    await this.initPromise;

    let retries = 0;
    while (this.queue.size > 0) {
      const ops = this.queue.all;
      const front = ops[0]!;

      let outcome: SendOutcome;
      let count: number;
      if (front.kind === "identify") {
        // An anonymous identify writes to the current handle: the next
        // identify must carry it so the server promotes that user.
        if (!front.externalUserId && front.anonymousId === this.anonId) this.setAnonUsed(true);
        outcome = await this.transport.sendIdentify(front);
        count = 1;
      } else {
        const batch = this.takeTrackBatch(ops);
        // Events are about to go out under the current anonymous handle: the
        // next identify must carry it so the server promotes them.
        if (batch.some((op) => op.externalUserId === null && op.anonymousId === this.anonId)) {
          this.setAnonUsed(true);
        }
        outcome = await this.transport.sendBatch(batch);
        count = batch.length;
      }
      // optOut() replaced the queue while this request was in flight.
      if (this.queue.all[0] !== front) continue;

      if (outcome.result === "ok") {
        if (front.kind === "identify" && front.externalUserId) this.recordDelivery(front, front.externalUserId);
        this.queue.removeFront(count);
        retries = 0;
        continue;
      }
      if (outcome.result === "drop") {
        this.forgetPushMark(ops.slice(0, count)); // registration rejected — let it re-send
        this.queue.removeFront(count);
        retries = 0;
        this.emit({ type: "dropped", message: `dropped ${count} event(s) — rejected by server`, status: outcome.status });
        this.warnDropped(front.kind === "identify" ? "an identify request" : `${count} event(s)`, outcome.status);
        continue;
      }
      if (outcome.result === "auth") {
        this.emit({ type: "auth", message: "delivery paused — API key rejected", status: 401 });
        break; // keep queue for a later attempt
      }
      // retry
      if (++retries > this.maxRetries) {
        this.emit({ type: "retry_exhausted", message: "delivery failed after retries; will retry on next flush" });
        break;
      }
      await delay(retryDelay(retries, outcome.retryAfterMs));
    }
  }

  private enqueue(op: QueuedOp): void {
    const evicted = this.queue.enqueue(op);
    if (evicted.length > 0) {
      this.forgetPushMark(evicted); // an evicted registration never shipped
      this.emit({ type: "dropped", message: `queue overflow — dropped ${evicted.length} oldest event(s)` });
    }
  }

  private takeTrackBatch(ops: readonly QueuedOp[]): TrackOp[] {
    const batch: TrackOp[] = [];
    for (const op of ops) {
      if (op.kind !== "track") break;
      // Init stamps every anonymous op; the fallback only guards a hand-edited queue.
      if (!op.externalUserId && !op.anonymousId) op.anonymousId = this.anonId;
      batch.push(op);
      if (batch.length >= this.maxBatchSize) break;
    }
    return batch;
  }

  /**
   * The context every event carries. `app_version`, `app_build`, `platform`,
   * `sdk_name` and `sdk_version` are the version keys of whisperr-spec (a
   * value the runtime cannot provide is left out). Never `locale`: the server
   * reads `context.locale` as the message language of that event.
   */
  private baseContext(): Record<string, unknown> {
    const ctx: Record<string, unknown> = {
      library: { name: SDK_NAME, version: LIB_VERSION },
      session_id: this.session.current(),
    };
    const os = currentOS();
    if (os) ctx.os = os;
    if (this.appInfo.version) ctx.app_version = this.appInfo.version;
    if (this.appInfo.build) ctx.app_build = this.appInfo.build;
    const platform = currentOSInfo().platform;
    if (platform) ctx.platform = platform;
    ctx.sdk_name = SDK_NAME;
    ctx.sdk_version = LIB_VERSION;
    return ctx;
  }

  /**
   * The restore record after a 2xx: a full identify stores its user, the
   * restore traits it was built with, and the time; a delivered language
   * update for the same user changes only `app_language`.
   */
  private recordDelivery(op: IdentifyOp, userId: string): void {
    if (this.optedOut) return;
    if (op.restoreTraits) {
      this.setRestoreRecord({ userId, traits: { ...op.restoreTraits }, at: Date.now() });
      return;
    }
    const record = this.restoreRecord;
    const language = op.traits?.app_language;
    if (op.languageUpdate && record && record.userId === userId && typeof language === "string") {
      this.setRestoreRecord({ ...record, traits: { ...record.traits, app_language: language } });
    }
  }

  private setRestoreRecord(record: RestoreRecord | null): void {
    this.restoreRecord = record;
    void (record
      ? this.storage.set(RESTORE_RECORD_KEY, JSON.stringify(record))
      : this.storage.remove(RESTORE_RECORD_KEY));
  }

  private warnMemoryOnly(): void {
    if (warnedMemoryOnly) return;
    const dev = typeof __DEV__ !== "undefined" && __DEV__;
    if (!dev && !this.debug) return;
    warnedMemoryOnly = true;
    if (typeof console !== "undefined") {
      // eslint-disable-next-line no-console
      console.warn(
        `[whisperr] no storage: the user id and the queue are kept in memory only. Install ${ASYNC_STORAGE_PACKAGE} (the SDK uses it automatically) or pass \`storage\`.`,
      );
    }
  }

  private startTimer(intervalMs: number): void {
    if (intervalMs <= 0) return;
    this.flushTimer = setInterval(() => void this.drainQueue(), intervalMs);
    // Don't keep a Node-like host process alive (tests, RN debugging in Node).
    (this.flushTimer as unknown as { unref?: () => void }).unref?.();
  }

  /**
   * A rejected request is gone for good, so say so even with debug off: once
   * per status code per client, so a misconfigured app does not flood the
   * console. With debug on, every drop is logged.
   */
  private warnDropped(what: string, status: number): void {
    const first = !this.warnedDropStatuses.has(status);
    if (!first && !this.debug) return;
    this.warnedDropStatuses.add(status);
    if (typeof console === "undefined") return;
    const later = this.debug ? "" : " Later rejections with this status are reported through onError, or here with debug on.";
    // eslint-disable-next-line no-console
    console.warn(`[whisperr] dropped ${what}: the server rejected the request with ${status}.${later}`);
  }

  private emit(error: WhisperrError): void {
    try {
      this.onError?.(error);
    } catch {
      /* host callback threw — ignore */
    }
  }

  private log(message: string): void {
    if (this.debug && typeof console !== "undefined") {
      // eslint-disable-next-line no-console
      console.warn(`[whisperr] ${message}`);
    }
  }
}

/**
 * The device's notification permission, persisted under PERMISSION_KEY.
 * `status` is the last one the app reported; it holds push tokens back while
 * `denied`. `sent` is the last status sent as push_permission_changed from
 * this device: a report sends the event only when it differs, and reset()
 * clears it.
 */
interface PermissionRecord {
  status: PushPermissionStatus;
  sent?: PushPermissionWireStatus;
}

/**
 * `op` cut down to the push tokens it opts out (a rotation, a denied
 * permission, an earlier optOut()), or null when it retires none. optOut()
 * keeps these, so a token retired before the opt-out stays retired.
 */
function pushRetirement(op: QueuedOp): IdentifyOp | null {
  if (op.kind !== "identify") return null;
  const retired = op.channels?.filter((c) => c.type === "push" && c.optedIn === false) ?? [];
  if (!retired.length) return null;
  const subject: Subject | null = op.externalUserId
    ? { userId: op.externalUserId }
    : op.anonymousId
      ? { anonymousId: op.anonymousId }
      : null;
  if (!subject) return null;
  return { ...subjectIdentify(subject, { channels: retired }), occurredAt: op.occurredAt };
}

/** An identify for `subject`: a partial identify for a user, an anonymous identify for a handle. */
function subjectIdentify(
  subject: Subject,
  fields: { channels?: WhisperrChannel[]; traits?: Record<string, unknown> },
): IdentifyOp {
  return {
    kind: "identify",
    ...("userId" in subject ? { externalUserId: subject.userId } : { anonymousId: subject.anonymousId }),
    ...fields,
    occurredAt: nowISO(),
  };
}

function pairSubject(pair: PushPair): Subject {
  return pair.userId ? { userId: pair.userId } : { anonymousId: pair.anonymousId ?? "" };
}

/** The identify `op` is addressed to the pair's subject. */
function opIsFor(op: IdentifyOp, pair: PushPair): boolean {
  if (op.externalUserId) return op.externalUserId === pair.userId;
  return !pair.userId && !!op.anonymousId && op.anonymousId === pair.anonymousId;
}

/** Every field `reg` sets equals the one in the stored metadata signature. */
function metaCovers(meta: string | undefined, reg: PushRegistration): boolean {
  const stored = registrationFromMeta(reg.token, meta);
  return (["kind", "platform", "pushEnv", "clientAppId", "providerProject"] as const).every(
    (field) => !reg[field] || reg[field] === stored[field],
  );
}

function definedFields(reg: PushRegistration): Partial<PushRegistration> {
  return Object.fromEntries(Object.entries(reg).filter(([, v]) => v !== undefined && v !== ""));
}

function optOutChannel(token: string): WhisperrChannel {
  return { type: "push", address: token, optedIn: false };
}

/** A pair sent less than 7 days ago. A pair without `sentAt` (SDK 0.4.x) is due. */
function isFresh(sentAt: number | undefined): boolean {
  if (sentAt === undefined) return false;
  const age = Date.now() - sentAt;
  return age >= 0 && age < PUSH_REREGISTER_MS;
}

/** SDK 0.4.x stored `{ userId, token, meta }`; 0.5 adds `anonymousId` and `sentAt`. */
function parseLastPush(raw: string | null): PushPair | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as {
      userId?: unknown;
      anonymousId?: unknown;
      token?: unknown;
      meta?: unknown;
      sentAt?: unknown;
    };
    if (typeof parsed.token !== "string" || !parsed.token) return null;
    const subject =
      typeof parsed.userId === "string" && parsed.userId
        ? { userId: parsed.userId }
        : typeof parsed.anonymousId === "string" && parsed.anonymousId
          ? { anonymousId: parsed.anonymousId }
          : null;
    if (!subject) return null;
    return {
      ...subject,
      token: parsed.token,
      ...(typeof parsed.meta === "string" && parsed.meta ? { meta: parsed.meta } : {}),
      ...(typeof parsed.sentAt === "number" && Number.isFinite(parsed.sentAt) ? { sentAt: parsed.sentAt } : {}),
    };
  } catch {
    return null; // corrupt payload — discard
  }
}

/** The restore record (whisperr-spec: Restore identify at start → 24-hour throttle). */
interface RestoreRecord {
  userId: string;
  /** The restore traits (device defaults + app_language) the delivered identify was built with. */
  traits: Record<string, unknown>;
  /** When it was delivered (wall clock, ms). */
  at: number;
}

function parseRestoreRecord(raw: string | null): RestoreRecord | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { userId?: unknown; traits?: unknown; at?: unknown };
    const traits = parsed.traits;
    if (
      typeof parsed.userId !== "string" ||
      typeof parsed.at !== "number" ||
      !traits ||
      typeof traits !== "object" ||
      Array.isArray(traits)
    ) {
      return null;
    }
    return { userId: parsed.userId, traits: traits as Record<string, unknown>, at: parsed.at };
  } catch {
    return null; // corrupt payload — send the restore identify
  }
}

/** Equal restore traits: the same keys with the same values. */
function sameTraits(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const stable = (t: Record<string, unknown>) => JSON.stringify(Object.keys(t).sort().map((k) => [k, t[k]]));
  return stable(a) === stable(b);
}

const LANGUAGE_TAG = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;

/** A BCP 47 tag with `_` read as `-` (`pt_BR` → `pt-BR`), or null when invalid. */
export function normalizeAppLanguage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const tag = value.trim().replace(/_/g, "-");
  if (!LANGUAGE_TAG.test(tag) || tag.toLowerCase() === "und" || tag.length > 35) return null;
  return tag;
}

function cleanString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim();
  return v || undefined;
}

/**
 * whisperr_message_ids already reported (push_opened / push_received), most
 * recent last, persisted so a repeated report is a no-op across restarts.
 */
class RememberedIds {
  private ids = new Set<string>();

  constructor(
    private readonly storage: SafeStorage,
    private readonly key: string,
  ) {}

  async load(): Promise<void> {
    const raw = await this.storage.get(this.key);
    if (!raw) return;
    try {
      const ids = JSON.parse(raw) as unknown;
      if (Array.isArray(ids)) for (const id of ids) if (typeof id === "string") this.ids.add(id);
    } catch {
      /* corrupt payload — discard */
    }
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }

  /** Adds `id`; persists once `after` (the queue write holding the event) has landed. */
  add(id: string, after: Promise<void>): void {
    this.ids.add(id);
    const remembered = [...this.ids].slice(-MAX_REMEMBERED_PUSH_IDS);
    this.ids = new Set(remembered);
    void after.then(() => this.storage.set(this.key, JSON.stringify(remembered)));
  }
}

function parseRunRecord(raw: string | null): RunRecord | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return null;
    const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
    const record: RunRecord = {};
    if (parsed.running === true) record.running = true;
    if (typeof parsed.at === "number" && Number.isFinite(parsed.at)) record.at = parsed.at;
    if (str(parsed.session_id)) record.session_id = str(parsed.session_id);
    if (str(parsed.screen)) record.screen = str(parsed.screen);
    if (str(parsed.app_version)) record.app_version = str(parsed.app_version);
    return record;
  } catch {
    return null; // corrupt payload — discard
  }
}

/** SDK 0.4.x stored `{ status, sentFor }` and never sent the event, so it parses as not sent. */
function parsePermissionRecord(raw: string | null): PermissionRecord | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { status?: unknown; sent?: unknown };
    if (!isPushPermissionStatus(parsed.status)) return null;
    const sent = isPushPermissionWireStatus(parsed.sent) ? { sent: parsed.sent } : {};
    return { status: parsed.status, ...sent };
  } catch {
    return null; // corrupt payload — discard
  }
}

/** Keys the engine reads for the user's zone; any of them supplied means "don't default `timezone`". */
const TIMEZONE_KEYS = ["timezone", "time_zone", "tz"];

/**
 * Fills the reserved `timezone` / `locale` traits from the device unless the
 * caller supplied them — caller values always win, and a key the runtime
 * cannot provide is simply absent (see whisperr-spec → Reserved trait keys).
 * Only full identify() calls get defaults; setPushToken()'s partial identify
 * stays traits-free by contract.
 */
function withDeviceTraits(traits: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const defaults: Record<string, unknown> = deviceTraits();
  if (traits && TIMEZONE_KEYS.some((k) => k in traits)) delete defaults.timezone;
  const merged = { ...defaults, ...traits };
  return Object.keys(merged).length ? merged : undefined;
}

function buildChannels(
  params: IdentifyParams,
  pendingPushToken: PushRegistration | null,
  withDefaults: (reg: PushRegistration) => PushRegistration,
): WhisperrChannel[] | undefined {
  const out: WhisperrChannel[] = [];
  if (params.channels && params.channels.length) {
    out.push(...params.channels);
  } else {
    // Email and phone: no verification is claimed on the caller's behalf, and
    // consent only when the caller passes emailOptedIn (opted_in stays off the
    // wire otherwise). Pass an explicit channel to set the rest.
    if (params.email) {
      out.push({
        type: "email",
        address: params.email,
        ...(typeof params.emailOptedIn === "boolean" ? { optedIn: params.emailOptedIn } : {}),
      });
    }
    if (params.phone) out.push({ type: "sms", address: params.phone });
    const push = normalizePushToken(params.pushToken);
    if (push) out.push(pushChannel(withDefaults(push), true));
  }
  // A token buffered by setPushToken() rides along unless the caller supplied
  // its own push channel.
  if (pendingPushToken && !out.some((c) => c.type === "push")) {
    out.push(pushChannel(pendingPushToken, true));
  }
  return out.length ? out : undefined;
}

/** A server-sent Retry-After (already capped) wins over exponential backoff; both get jitter. */
function retryDelay(attempt: number, retryAfterMs?: number): number {
  const base = retryAfterMs ?? Math.min(30000, 1000 * 2 ** attempt);
  return base + Math.floor(Math.random() * 250);
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
