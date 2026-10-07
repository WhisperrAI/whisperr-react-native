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
  PUSH_OPENED,
  PUSH_PERMISSION_CHANGED,
  SCREEN_VIEWED,
} from "./autocapture.js";
import { deviceTraits } from "./device.js";
import { currentAppState, currentOS, onAppStateChange, type AppStateStatus } from "./lifecycle.js";
import {
  isPushPermissionStatus,
  isPushPermissionWireStatus,
  normalizePushToken,
  PERMISSION_WIRE_STATUS,
  permissionAllowsPush,
  pushChannel,
  pushMeta,
  type PushPermissionWireStatus,
  type PushRegistration,
} from "./push.js";
import { DurableQueue } from "./queue.js";
import { LIB_VERSION, nowISO, Session, uuid } from "./runtime.js";
import { MemoryStorage, SafeStorage } from "./storage.js";
import { Transport, type SendOutcome } from "./transport.js";
import type {
  IdentifyOp,
  IdentifyParams,
  PushPermissionStatus,
  PushTokenInput,
  QueuedOp,
  TrackOp,
  WhisperrApi,
  WhisperrChannel,
  WhisperrError,
  WhisperrOptions,
  WhisperrPushOpen,
} from "./types.js";

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
const MAX_REMEMBERED_PUSH_OPENS = 100;
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
  private lastPush: { userId: string; token: string; meta?: string } | null = null;
  /** The device's notification permission; null until the app reports one. */
  private permission: PermissionRecord | null = null;
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
  /** When the current foreground period started; null while in the background. */
  private foregroundSince: number | null = null;
  /** A foreground was seen in this process — the next app_opened is a warm start. */
  private sawForeground = false;

  // ---- push_opened dedup ----
  private readonly openedThisLaunch: string[] = [];
  private persistedOpened = new Set<string>();

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
    this.durableStorage = !!options.storage;
    // Manual screen(), push_opened and push_permission_changed carry these
    // too, so they resolve even with the automatic events off.
    this.appInfo = this.disabled ? {} : resolveAppInfo({ version: options.appVersion, build: options.appBuild });

    if (!options.storage) {
      this.log("no `storage` provided — the queue is memory-only. Pass AsyncStorage to survive app restarts.");
    }
    this.storage = new SafeStorage(options.storage ?? new MemoryStorage());
    // Snapshot "did the app run before?" now — before identify() / track() in
    // this launch tick can write user_id or session and fake prior state.
    this.priorState = Promise.all(PRIOR_STATE_KEYS.map((key) => this.storage.get(key))).then((values) =>
      values.some((v) => v !== null),
    );
    this.queue = new DurableQueue(this.storage, options.maxQueueSize ?? 1000);
    this.session = new Session(this.storage);
    this.transport = new Transport(baseUrl, options.apiKey, options.requestTimeoutMs ?? 10000, this.debug);

    this.initPromise = this.disabled ? Promise.resolve() : this.init();

    if (!this.disabled) {
      this.startTimer(options.flushIntervalMs ?? 10000);
      if (this.autocapture) {
        const launchedAt = Date.now();
        const initialState = currentAppState();
        void this.runLifecycle(() => this.captureLaunch(initialState, launchedAt));
      }
      if (this.autocapture || this.flushOnBackground) {
        this.removeLifecycle = onAppStateChange((state) => this.handleAppState(state));
      }
      // Drain anything left over from a previous launch (while opted out:
      // a push opt-out that did not reach the server yet).
      void this.initPromise.then(() => {
        if (!this.closed && this.queue.size > 0) void this.flush();
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
    this.identityTouched = true;
    this.userId = externalUserId;
    void this.storage.set(USER_KEY, externalUserId);

    // A push token supplied to identify() rotates like setPushToken(): if it
    // differs from the last token this client sent for this user, opt the old
    // one out in the same body so it isn't stranded opted-in.
    // A token held back while notifications are denied stays held back.
    const pending = this.permission?.status === "denied" ? null : this.pendingPushToken;
    const channels = this.withPushRotation(externalUserId, buildChannels(params, pending));
    // Mark the last-sent pair BEFORE enqueue so an overflow-evicted registration
    // clears the mark (mark-on-delivery), never stranding a token opted-out.
    this.rememberPushChannel(externalUserId, channels);
    // Anonymous → identified: when events already went out under this
    // device's anonymous handle, the identify carries it so the server
    // promotes that anonymous user into this one. Before init we cannot know
    // yet — init settles it (resolveAnonymous).
    let anonymousId: string | undefined;
    let resolveAnonymous: boolean | undefined;
    if (!this.initialized) {
      resolveAnonymous = true;
    } else if (this.anonUsed) {
      anonymousId = this.anonId;
      this.setAnonUsed(false);
    }
    this.enqueue({
      kind: "identify",
      externalUserId,
      ...(anonymousId ? { anonymousId } : {}),
      ...(resolveAnonymous ? { resolveAnonymous } : {}),
      traits: withDeviceTraits(params.traits),
      preferredChannel: params.preferredChannel,
      channels,
      occurredAt: nowISO(),
    });
    if (pending) this.pendingPushToken = null;
    // Pre-login events still queued go out under this user directly.
    this.queue.backfillIdentity(externalUserId, this.anonId || undefined);
    void this.flush();
  }

  setPushToken(token: PushTokenInput): void {
    if (this.muted || this.closed) return;
    const reg = normalizePushToken(token);
    if (reg) this.registerPushToken(reg);
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

  track(eventType: string, properties?: Record<string, unknown>, context?: Record<string, unknown>): void {
    if (this.muted || this.closed || !eventType) return;
    const type = eventType.trim();
    if (!type) return;
    if (!SNAKE_CASE.test(type)) {
      this.emit({ type: "dropped", message: `invalid event_type "${type}" — expected snake_case` });
      this.log(`invalid event_type "${type}" — event was not queued`);
      return;
    }
    this.enqueueTrack(type, properties, context, nowISO());
  }

  screen(name: string, properties?: Record<string, unknown>): void {
    const screenName = typeof name === "string" ? name.trim() : "";
    if (!screenName) {
      this.log("screen() needs a screen name — event was not queued");
      return;
    }
    this.track(SCREEN_VIEWED, { ...automaticProperties(this.appInfo), ...properties, screen_name: screenName });
  }

  trackPushOpened(data: unknown): WhisperrPushOpen | null {
    const payload = extractPushOpened(data);
    if (!payload) {
      this.log("trackPushOpened(): no whisperr_message_id in the payload — not a Whisperr push, ignored");
      return null;
    }
    // The app routes on the result even when nothing is sent.
    if (this.muted || this.closed) return payload;
    const { messageId, deepLink } = payload;
    // Cold start: getLastNotificationResponseAsync / getInitialNotification and
    // the response listener can both report the same tap — and the cold-start
    // getter keeps answering it on later launches. Report each message once.
    if (this.openedThisLaunch.includes(messageId)) return payload;
    this.openedThisLaunch.push(messageId);
    const occurredAt = nowISO();
    void this.initPromise.then(() => {
      if (this.muted || this.closed || this.persistedOpened.has(messageId)) return;
      this.enqueueTrack(
        PUSH_OPENED,
        {
          ...automaticProperties(this.appInfo),
          whisperr_message_id: messageId,
          ...(deepLink ? { deep_link: deepLink } : {}),
        },
        undefined,
        occurredAt,
      );
      this.persistedOpened.add(messageId);
      const remembered = [...this.persistedOpened].slice(-MAX_REMEMBERED_PUSH_OPENS);
      this.persistedOpened = new Set(remembered);
      // Mark the id as reported only once the queue write holding the event
      // has landed: a kill in between re-reports the open next launch rather
      // than losing it.
      void this.queue.settle().then(() => this.storage.set(PUSH_OPENED_KEY, JSON.stringify(remembered)));
      void this.flush();
    });
    return payload;
  }

  reset(): void {
    if (this.closed) return;
    if (!this.initialized) {
      // The previous handle is still being read from storage. Settle what was
      // captured before this logout now so none of it can attach to the next
      // person: identifies promote nothing, anonymous events get a one-off handle.
      this.queue.resolveIdentifyPromotions(undefined);
      this.queue.stampAnonymousId(uuid());
      this.anonRotatedBeforeInit = true;
    }
    this.identityTouched = true;
    this.pushCleared = true; // don't let a still-pending init restore the pair
    this.userId = null;
    this.pendingPushToken = null;
    this.lastPush = null;
    // The next user gets a fresh push_permission_changed. The permission itself
    // is the device's, so a denied permission still holds tokens back.
    if (this.permission) this.setPermission({ status: this.permission.status });
    this.anonId = uuid(); // fresh anonymous identity (a UUID v4, per the spec)
    this.setAnonUsed(false);
    void this.storage.remove(USER_KEY);
    void this.storage.remove(PUSH_KEY);
    void this.storage.set(ANON_KEY, this.anonId);
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
    void this.storage.set(OPTOUT_KEY, "1");
    // Before init the last-sent pair is not restored yet; init sends it.
    if (this.initialized) this.queuePushOptOut();
  }

  async flush(): Promise<void> {
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

    // Restore the last-sent (user, token) pair so the every-launch getToken()
    // re-send dedups and a post-restart rotation still opts out the old token.
    // This must NOT be gated on identify() having run: apps call identify(user)
    // in the same launch tick as construction, before init resolves, and
    // skipping the restore then left lastPush null — so a post-restart rotation
    // sent no opt-out and same-token dedup was defeated (identify spam every
    // launch). Restoring after identify() is safe because setPushToken only
    // opts out / dedups against a pair whose user matches the current user, so
    // a pair from a prior user is ignored on use. Only reset() invalidates it,
    // and a fresher pair already set in memory (a setPushToken that raced init)
    // is never clobbered.
    if (!this.pushCleared && !this.lastPush) {
      const rawPush = await this.storage.get(PUSH_KEY);
      if (rawPush && !this.lastPush) {
        try {
          const parsed = JSON.parse(rawPush) as { userId?: unknown; token?: unknown; meta?: unknown };
          if (typeof parsed.userId === "string" && typeof parsed.token === "string") {
            this.lastPush = {
              userId: parsed.userId,
              token: parsed.token,
              ...(typeof parsed.meta === "string" && parsed.meta ? { meta: parsed.meta } : {}),
            };
          }
        } catch {
          /* corrupt payload — discard */
        }
      }
    }

    // The permission is reported through setPushPermission(), which waits for
    // init, so the stored value is always the latest one at this point.
    const storedPermission = parsePermissionRecord(await this.storage.get(PERMISSION_KEY));
    if (storedPermission) {
      // reset() before init: the next report is a fresh one.
      if (this.pushCleared) this.setPermission({ status: storedPermission.status });
      else this.permission = storedPermission;
    }

    const rawOpened = await this.storage.get(PUSH_OPENED_KEY);
    if (rawOpened) {
      try {
        const ids = JSON.parse(rawOpened) as unknown;
        if (Array.isArray(ids)) {
          for (const id of ids) if (typeof id === "string") this.persistedOpened.add(id);
        }
      } catch {
        /* corrupt payload — discard */
      }
    }

    await this.session.restore();
    await this.queue.restore();

    if (this.optedOut) {
      // Drop anything captured before the opt-out was read; keep push
      // opt-outs that have not reached the server.
      this.queue.rewrite(pushRetirement);
      this.pendingPushToken = null;
      // SDK 0.4.x opted out locally only and kept the last-sent pair.
      this.queuePushOptOut();
      this.initialized = true;
      return;
    }

    // Ops captured before we knew who the user is (this launch, before init)
    // now attribute to the restored identity…
    if (this.userId) this.queue.backfillIdentity(this.userId, this.anonId);
    // …and the rest — this launch's or a previous one's — go out under the
    // device's anonymous handle.
    this.queue.stampAnonymousId(this.anonId);
    // identify() calls made before init: the first one promotes the handle if
    // events already went out under it.
    if (this.queue.resolveIdentifyPromotions(this.anonUsed ? this.anonId : undefined)) {
      this.setAnonUsed(false);
    }
    this.initialized = true;
    // A token captured before the persisted identity was restored (common when
    // the messaging lib fires at startup) now attributes to the restored user.
    if (this.userId && this.pendingPushToken) this.registerPushToken(this.pendingPushToken);
  }

  // ---- push token + permission ----

  private registerPushToken(reg: PushRegistration): void {
    // Held, not sent: before init (the restored last-sent pair and permission
    // decide it then), before we know the user (the next identify() takes it),
    // and while notifications are off (the next allowed report sends it).
    if (!this.initialized || !this.userId || this.permission?.status === "denied") {
      this.pendingPushToken = reg;
      return;
    }
    this.pendingPushToken = null; // the token is handled here, sent or deduped
    const last = this.lastPush && this.lastPush.userId === this.userId ? this.lastPush : null;
    const meta = pushMeta(reg);
    // Refresh storm / every-launch re-send: same token, nothing new to say.
    // A bare token never downgrades a registration that carried metadata.
    if (last && last.token === reg.token && (meta === "" || meta === (last.meta ?? ""))) return;
    const channels: WhisperrChannel[] = [];
    // Rotation: retire the token this client previously registered.
    if (last && last.token !== reg.token) channels.push({ type: "push", address: last.token, optedIn: false });
    channels.push(pushChannel(reg, true));
    // Mark BEFORE enqueue so an overflow-evicted registration clears the mark.
    this.setLastPush(this.userId, reg.token, meta || last?.meta);
    this.enqueue({
      kind: "identify",
      externalUserId: this.userId,
      channels,
      occurredAt: nowISO(),
    });
    void this.flush();
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
    const userId = this.userId;
    const channels = userId ? this.permissionChannels(status, userId) : [];
    if (userId && channels.length) {
      this.enqueue({ kind: "identify", externalUserId: userId, channels, occurredAt: nowISO() });
    }
    void this.flush();
  }

  /**
   * The push channel changes a permission report causes: `denied` opts the
   * registered token out and holds it; an allowed status registers a held token.
   */
  private permissionChannels(status: PushPermissionStatus, userId: string): WhisperrChannel[] {
    const last = this.lastPush && this.lastPush.userId === userId ? this.lastPush : null;
    if (status === "denied") {
      if (!last) return [];
      if (!this.pendingPushToken) this.pendingPushToken = registrationFromMeta(last.token, last.meta);
      this.forgetLastPush();
      return [{ type: "push", address: last.token, optedIn: false }];
    }
    if (!permissionAllowsPush(status) || !this.pendingPushToken) return [];
    const reg = this.pendingPushToken;
    this.pendingPushToken = null;
    if (last && last.token === reg.token) return [];
    const channels: WhisperrChannel[] = [];
    if (last) channels.push({ type: "push", address: last.token, optedIn: false });
    channels.push(pushChannel(reg, true));
    this.setLastPush(userId, reg.token, pushMeta(reg) || undefined);
    return channels;
  }

  private setPermission(record: PermissionRecord): void {
    this.permission = record;
    void this.storage.set(PERMISSION_KEY, JSON.stringify(record));
  }

  /**
   * optOut() tells the server about this device: when this client holds a
   * last-sent pair, one partial identify opts that token out under the pair's
   * user, who is not always the current one (identify() without reset()). It
   * survives a restart until delivered. The pair is forgotten, so after
   * optIn() the next setPushToken() registers the token again.
   */
  private queuePushOptOut(): void {
    const last = this.lastPush;
    if (!last) return;
    this.forgetLastPush();
    this.enqueue({
      kind: "identify",
      externalUserId: last.userId,
      channels: [{ type: "push", address: last.token, optedIn: false }],
      occurredAt: nowISO(),
    });
    void this.flush();
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
    const queued = this.autocapture ? this.runLifecycle(() => this.captureTransition(state, at)) : Promise.resolve();
    if (this.flushOnBackground && (state === "background" || state === "inactive")) {
      // After app_backgrounded is queued, so the last foreground period ships now.
      void queued.then(() => this.flush());
    }
  }

  private async captureLaunch(initialState: AppStateStatus | undefined, launchedAt: number): Promise<void> {
    if (this.durableStorage) await this.captureInstallOrUpdate(launchedAt);
    // A launch into the background (headless JS, background fetch) is not an
    // open; the first move to "active" reports the cold start instead.
    if (initialState === undefined || initialState === "active" || initialState === "unknown") {
      this.captureTransition("active", launchedAt);
    }
  }

  private captureTransition(state: AppStateStatus, at: number): void {
    if (state === "active") {
      if (this.foregroundSince !== null) return; // already in the foreground
      this.foregroundSince = at;
      const coldStart = !this.sawForeground;
      this.sawForeground = true;
      this.captureAutomatic(APP_OPENED, { cold_start: coldStart }, at);
    } else if (state === "background") {
      if (this.foregroundSince === null) return;
      const foregroundMs = Math.max(0, at - this.foregroundSince);
      this.foregroundSince = null;
      this.captureAutomatic(APP_BACKGROUNDED, { foreground_ms: foregroundMs }, at);
    }
    // "inactive" is not a transition of its own: iOS passes through it for
    // Control Center, incoming calls, and the app switcher.
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
    if (this.queue.size >= this.flushAt) void this.flush();
  }

  private setAnonUsed(used: boolean): void {
    if (this.anonUsed === used) return;
    this.anonUsed = used;
    void (used ? this.storage.set(ANON_USED_KEY, "1") : this.storage.remove(ANON_USED_KEY));
  }

  /** Records the opted-in push channel (if any) that an identify just sent. */
  private rememberPushChannel(userId: string, channels: WhisperrChannel[] | undefined): void {
    const push = channels?.filter((c) => c.type === "push" && c.optedIn !== false).pop();
    if (push) this.setLastPush(userId, push.address, pushMeta(push) || undefined);
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
    const last = this.lastPush && this.lastPush.userId === userId ? this.lastPush.token : null;
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
      if (op.kind !== "identify" || op.externalUserId !== last.userId) continue;
      const carried = op.channels?.some(
        (c) => c.type === "push" && c.optedIn !== false && c.address === last.token,
      );
      if (carried) {
        this.forgetLastPush();
        return;
      }
    }
  }

  /** Updates the last-sent (user, token) pair and persists it (write-behind). */
  private setLastPush(userId: string, token: string, meta?: string): void {
    this.lastPush = { userId, token, ...(meta ? { meta } : {}) };
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
      const { result } = outcome;
      // optOut() replaced the queue while this request was in flight.
      if (this.queue.all[0] !== front) continue;

      if (result === "ok") {
        this.queue.removeFront(count);
        retries = 0;
        continue;
      }
      if (result === "drop") {
        this.forgetPushMark(ops.slice(0, count)); // registration rejected — let it re-send
        this.queue.removeFront(count);
        retries = 0;
        this.emit({ type: "dropped", message: `dropped ${count} event(s) — rejected by server` });
        continue;
      }
      if (result === "auth") {
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

  private baseContext(): Record<string, unknown> {
    const ctx: Record<string, unknown> = {
      library: { name: "whisperr-react-native", version: LIB_VERSION },
      session_id: this.session.current(),
    };
    const os = currentOS();
    if (os) ctx.os = os;
    return ctx;
  }

  private startTimer(intervalMs: number): void {
    if (intervalMs <= 0) return;
    this.flushTimer = setInterval(() => void this.flush(), intervalMs);
    // Don't keep a Node-like host process alive (tests, RN debugging in Node).
    (this.flushTimer as unknown as { unref?: () => void }).unref?.();
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
  return { kind: "identify", externalUserId: op.externalUserId, channels: retired, occurredAt: op.occurredAt };
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

function buildChannels(params: IdentifyParams, pendingPushToken: PushRegistration | null): WhisperrChannel[] | undefined {
  const out: WhisperrChannel[] = [];
  if (params.channels && params.channels.length) {
    out.push(...params.channels);
  } else {
    // Email: no consent and no verification are claimed on the caller's behalf
    // (opted_in / verified stay off the wire). Pass an explicit channel to set them.
    if (params.email) out.push({ type: "email", address: params.email });
    if (params.phone) out.push({ type: "sms", address: params.phone, optedIn: true });
    const push = normalizePushToken(params.pushToken);
    if (push) out.push(pushChannel(push, true));
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

/** Rebuilds a registration from a persisted metadata signature (see pushMeta). */
function registrationFromMeta(token: string, meta: string | undefined): PushRegistration {
  const [kind, platform, pushEnv] = (meta ?? "").split("|");
  return {
    token,
    ...(kind ? { kind: kind as PushRegistration["kind"] } : {}),
    ...(platform ? { platform: platform as PushRegistration["platform"] } : {}),
    ...(pushEnv ? { pushEnv: pushEnv as PushRegistration["pushEnv"] } : {}),
  };
}
